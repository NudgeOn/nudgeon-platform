// Package lifecycle — message.lifecycle.v1 소비자. 커넥터 동기 결과·공급자 콜백(Resend 웹훅 등)·
// SDK 시스템 이벤트가 stream:message.lifecycle로 수렴하며, 이를 ClickHouse message_lifecycle
// (채널 중립 발송 원장)에 append한다. 계약: packages/queue-schemas/schemas/message.lifecycle.v1.schema.json.
package lifecycle

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"

	"github.com/ondahq/onda/apps/worker/internal/clock"
	"github.com/ondahq/onda/apps/worker/internal/metrics"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

const (
	zeroUUID      = "00000000-0000-0000-0000-000000000000"
	fetchCount    = 200
	fetchBlock    = time.Second
	reclaimIdle   = 30 * time.Second
	reclaimPeriod = 10 * time.Second
)

// Payload — message.lifecycle.v1 payload의 Go 표현. 선택 필드는 포인터(null 허용).
type Payload struct {
	MessageID         string  `json:"message_id"`
	IdempotencyKey    string  `json:"idempotency_key"`
	Status            string  `json:"status"`
	OccurredAt        string  `json:"occurred_at"`
	Source            string  `json:"source"`
	Channel           string  `json:"channel"`
	ConnectorID       string  `json:"connector_id"`
	ProviderMessageID *string `json:"provider_message_id"`
	UserID            *string `json:"user_id"`
	EndpointID        *string `json:"endpoint_id"`
	FailureClass      *string `json:"failure_class"`
	FailureDetail     *string `json:"failure_detail"`
	FallbackIndex     *int    `json:"fallback_index"`
	Attempt           *int    `json:"attempt"`
	Cost              *struct {
		Currency string  `json:"currency"`
		Amount   float64 `json:"amount"`
	} `json:"cost"`
	ClickRef *string `json:"click_ref"`
}

var validStatus = map[string]bool{
	"accepted": true, "sent": true, "delivered": true, "opened": true,
	"clicked": true, "failed": true, "unsubscribed": true, "bounced": true,
}

var validSource = map[string]bool{
	"engine": true, "connector": true, "provider_callback": true, "sdk": true,
}

var connectorIDRe = regexp.MustCompile(`^[a-z][a-z0-9_]{1,63}$`)

// insertSQL — message_lifecycle 컬럼 순서. BuildRow의 값 순서와 1:1.
const insertSQL = `INSERT INTO message_lifecycle (tenant_id, app_id, message_id, status, occurred_at,
	source, channel, connector_id, provider_message_id, user_id, endpoint_id,
	failure_class, failure_detail, fallback_index, attempt, cost_currency, cost_amount, click_ref, received_at)`

// BuildRow — envelope + payload → message_lifecycle 행. 필수 필드·enum·UUID 검증 실패 시 오류(호출자는 skip+ack).
// null → zero UUID / ” / 0 (message_log 관례와 동일).
func BuildRow(env *libqueue.Envelope, raw json.RawMessage, receivedAt time.Time) ([]any, error) {
	var p Payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("payload 파싱: %w", err)
	}
	if _, err := uuid.Parse(env.TenantID); err != nil {
		return nil, fmt.Errorf("envelope tenant_id UUID 아님: %q", env.TenantID)
	}
	if _, err := uuid.Parse(env.AppID); err != nil {
		return nil, fmt.Errorf("envelope app_id UUID 아님: %q", env.AppID)
	}
	if _, err := uuid.Parse(p.MessageID); err != nil {
		return nil, fmt.Errorf("message_id UUID 아님: %q", p.MessageID)
	}
	if !validStatus[p.Status] {
		return nil, fmt.Errorf("status 불명: %q", p.Status)
	}
	if !validSource[p.Source] {
		return nil, fmt.Errorf("source 불명: %q", p.Source)
	}
	if p.Channel == "" {
		return nil, fmt.Errorf("channel 누락")
	}
	if !connectorIDRe.MatchString(p.ConnectorID) {
		return nil, fmt.Errorf("connector_id 형식 오류: %q", p.ConnectorID)
	}
	occurredAt, err := time.Parse(time.RFC3339Nano, p.OccurredAt)
	if err != nil {
		return nil, fmt.Errorf("occurred_at RFC3339 아님: %q", p.OccurredAt)
	}
	userID, err := optUUID(p.UserID, "user_id")
	if err != nil {
		return nil, err
	}
	endpointID, err := optUUID(p.EndpointID, "endpoint_id")
	if err != nil {
		return nil, err
	}
	costCurrency, costAmount := "", float64(0)
	if p.Cost != nil {
		costCurrency, costAmount = p.Cost.Currency, p.Cost.Amount
	}
	return []any{
		env.TenantID, env.AppID, p.MessageID, p.Status, occurredAt.UTC(),
		p.Source, p.Channel, p.ConnectorID, optStr(p.ProviderMessageID), userID, endpointID,
		optStr(p.FailureClass), optStr(p.FailureDetail), optUint8(p.FallbackIndex), optUint8(p.Attempt),
		costCurrency, costAmount, optStr(p.ClickRef), receivedAt.UTC(),
	}, nil
}

func optStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// optUint8 — null/음수 → 0, 255 초과는 255로 클램프(행 유실보다 포화가 낫다).
func optUint8(n *int) uint8 {
	if n == nil || *n < 0 {
		return 0
	}
	if *n > 255 {
		return 255
	}
	return uint8(*n)
}

func optUUID(s *string, field string) (string, error) {
	if s == nil || *s == "" {
		return zeroUUID, nil
	}
	if _, err := uuid.Parse(*s); err != nil {
		return "", fmt.Errorf("%s UUID 아님: %q", field, *s)
	}
	return *s, nil
}

// Consumer — channel 역할과 함께 기동. stream:message.lifecycle(cg:lifecycle) → message_lifecycle 배치 적재.
// 리스→커밋 계약: 적재 성공 시에만 ACK(불량 payload는 skip 후 ACK), 적재 실패는 미ACK → reclaim 재시도.
type Consumer struct {
	queue       *libqueue.Consumer
	ch          driver.Conn
	clk         clock.Clock
	logger      *slog.Logger
	lastReclaim time.Time
}

func NewConsumer(queue *libqueue.Consumer, ch driver.Conn, clk clock.Clock, logger *slog.Logger) *Consumer {
	return &Consumer{queue: queue, ch: ch, clk: clk, logger: logger}
}

func (c *Consumer) Run(ctx context.Context) error {
	if err := c.queue.EnsureGroup(ctx); err != nil {
		return err
	}
	c.logger.Info("lifecycle 소비자 시작")
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		msgs, err := c.queue.Fetch(ctx, fetchCount, fetchBlock)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			c.logger.Error("fetch 실패", "err", err)
			time.Sleep(time.Second)
			continue
		}
		if c.clk.Now().Sub(c.lastReclaim) > reclaimPeriod {
			c.lastReclaim = c.clk.Now()
			if reclaimed, err := c.queue.Reclaim(ctx, reclaimIdle, fetchCount); err == nil && len(reclaimed) > 0 {
				msgs = append(msgs, reclaimed...)
			}
		}
		if len(msgs) == 0 {
			continue
		}
		rows, ackIDs := c.buildRows(msgs)
		if err := c.flush(ctx, rows); err != nil {
			c.logger.Error("message_lifecycle 적재 실패 — 재시도", "err", err)
			metrics.BatchErrors.WithLabelValues("lifecycle").Inc()
			time.Sleep(time.Second)
			continue
		}
		if err := c.queue.Ack(ctx, ackIDs...); err != nil {
			c.logger.Error("ack 실패", "err", err)
		}
	}
}

// buildRows — 배치의 각 메시지를 행으로. 불량은 로그 후 skip(ACK 대상에는 포함 — 재처리 무의미).
func (c *Consumer) buildRows(msgs []libqueue.Message) ([][]any, []string) {
	now := c.clk.Now()
	rows := make([][]any, 0, len(msgs))
	ackIDs := make([]string, 0, len(msgs))
	for i := range msgs {
		m := &msgs[i]
		ackIDs = append(ackIDs, m.StreamID)
		row, err := BuildRow(&m.Envelope, m.Envelope.Payload, now)
		if err != nil {
			c.logger.Warn("message.lifecycle payload 불량 — skip", "err", err, "msg_id", m.Envelope.ID)
			metrics.LifecycleEvents.WithLabelValues("invalid").Inc()
			continue
		}
		metrics.LifecycleEvents.WithLabelValues(row[3].(string)).Inc()
		rows = append(rows, row)
	}
	return rows, ackIDs
}

func (c *Consumer) flush(ctx context.Context, rows [][]any) error {
	if len(rows) == 0 {
		return nil
	}
	batch, err := c.ch.PrepareBatch(ctx, insertSQL)
	if err != nil {
		return err
	}
	defer func() { _ = batch.Close() }()
	for _, r := range rows {
		if err := batch.Append(r...); err != nil {
			return err
		}
	}
	return batch.Send()
}
