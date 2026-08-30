package channel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/ondahq/onda/apps/worker/internal/clock"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

// SendPushPayload — packages/queue-schemas/schemas/send.push.schema.json의 Go 표현.
type SendPushPayload struct {
	IdempotencyKey string       `json:"idempotency_key"`
	UserID         string       `json:"user_id"`
	DeviceID       string       `json:"device_id"`
	PushToken      string       `json:"push_token"`
	Platform       string       `json:"platform"`
	Content        struct {
		Push *PushContent `json:"push"`
	} `json:"content"`
	Category       string  `json:"category"`
	JourneyID      *string `json:"journey_id"`
	JourneyVersion *int    `json:"journey_version"`
	NodeIndex      *int    `json:"node_index"`
	CampaignRef    *string `json:"campaign_ref"`
}

const (
	idemTTL       = 7 * 24 * time.Hour // 멱등 선점 7d (sub-04)
	credCacheTTL  = 10 * time.Minute   // 워커 메모리 복호 캐시 (sub-04)
	sendFetch     = 100
	sendBlock     = time.Second
	sendReclaim   = 30 * time.Second
	reclaimPeriod = 10 * time.Second
)

type cachedCred struct {
	creds    Credentials
	loadedAt time.Time
	found    bool
}

// Worker — channel 역할: send.push 소비 → 멱등 → 복호화 → 전송 → message_log.
// TODO(S4): 지수 백오프 재시도 큐, (tenant,app,channel) 파티션 공정 스케줄링, quiet hours·cap 정책 검사.
type Worker struct {
	queue     *libqueue.Consumer
	rdb       redis.Cmdable
	pg        *pgxpool.Pool
	ch        driver.Conn
	plugin    ChannelPlugin
	masterKey []byte
	clk       clock.Clock
	logger    *slog.Logger

	credMu    sync.Mutex
	credCache map[string]cachedCred // key: appID+kind
	lastReclaim time.Time
}

func NewWorker(
	queue *libqueue.Consumer,
	rdb redis.Cmdable,
	pg *pgxpool.Pool,
	ch driver.Conn,
	plugin ChannelPlugin,
	masterKey []byte,
	clk clock.Clock,
	logger *slog.Logger,
) *Worker {
	return &Worker{
		queue: queue, rdb: rdb, pg: pg, ch: ch, plugin: plugin,
		masterKey: masterKey, clk: clk, logger: logger,
		credCache: map[string]cachedCred{},
	}
}

func (w *Worker) Run(ctx context.Context) error {
	if err := w.queue.EnsureGroup(ctx); err != nil {
		return err
	}
	w.logger.Info("channel 워커 시작")
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		msgs, err := w.queue.Fetch(ctx, sendFetch, sendBlock)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			w.logger.Error("fetch 실패", "err", err)
			time.Sleep(time.Second)
			continue
		}
		if w.clk.Now().Sub(w.lastReclaim) > reclaimPeriod {
			w.lastReclaim = w.clk.Now()
			if reclaimed, err := w.queue.Reclaim(ctx, sendReclaim, sendFetch); err == nil && len(reclaimed) > 0 {
				w.logger.Info("pending 회수", "count", len(reclaimed))
				msgs = append(msgs, reclaimed...)
			}
		}
		if len(msgs) == 0 {
			continue
		}

		logRows := make([][]any, 0, len(msgs))
		ackIDs := make([]string, 0, len(msgs))
		for _, m := range msgs {
			row := w.handleOne(ctx, &m)
			if row != nil {
				logRows = append(logRows, row)
			}
			ackIDs = append(ackIDs, m.StreamID)
		}
		if err := w.flushLog(ctx, logRows); err != nil {
			w.logger.Error("message_log 적재 실패 — 재시도", "err", err)
			time.Sleep(time.Second)
			continue // ack 없이 재처리 (멱등 선점이 실전송 중복을 막는다)
		}
		if err := w.queue.Ack(ctx, ackIDs...); err != nil {
			w.logger.Error("ack 실패", "err", err)
		}
	}
}

// handleOne은 한 건을 처리하고 message_log 행을 돌려준다 (nil이면 기록 없음).
func (w *Worker) handleOne(ctx context.Context, m *libqueue.Message) []any {
	env := &m.Envelope
	var p SendPushPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.IdempotencyKey == "" || p.Content.Push == nil {
		w.logger.Warn("send.push payload 불량 — skip", "err", err, "msg_id", env.ID)
		return nil
	}

	now := w.clk.Now()
	base := func(status, class, detail string) []any {
		return w.logRow(env.TenantID, env.AppID, &p, status, class, detail, now)
	}

	// 1) 멱등 선점 (C-3): 선점 실패 = 이미 처리됨 → 실전송 없이 duplicate 기록
	idemKey := fmt.Sprintf("send:idem:%s:%s", env.TenantID, p.IdempotencyKey)
	acquired, err := w.rdb.SetNX(ctx, idemKey, 1, idemTTL).Result()
	if err != nil {
		w.logger.Error("멱등 선점 실패", "err", err)
		return base("failed", "retryable", "멱등 선점 오류: "+err.Error())
	}
	if !acquired {
		return base("duplicate", "", "")
	}

	// 2) 크리덴셜 해석 (verified만, 10분 캐시)
	kind := "push_fcm"
	if p.Platform == "ios" {
		kind = "push_apns"
	}
	creds, ok, err := w.credential(ctx, env.AppID, kind)
	if err != nil {
		return base("failed", "retryable", "크리덴셜 조회 오류: "+err.Error())
	}
	if !ok {
		return base("failed", "credential_missing", fmt.Sprintf("%s 크리덴셜 미등록/미검증", kind))
	}

	// 3) 전송
	_, sendErr := w.plugin.Send(ctx, SendRequest{
		IdempotencyKey: p.IdempotencyKey,
		Target:         Target{Token: p.PushToken, Platform: p.Platform},
		Content:        MessageContent{Push: p.Content.Push},
		Credentials:    creds,
	})
	if sendErr == nil {
		return base("sent", "", "")
	}

	class := w.plugin.ClassifyError(sendErr)
	switch class {
	case FailureInvalidTarget:
		// 토큰 피드백 루프 (C-5): 즉시 invalid 반영 → 이후 발송·세그먼트 제외
		if _, err := w.pg.Exec(ctx, `
			UPDATE devices SET token_status = 'invalid', updated_at = now()
			 WHERE app_id = $1 AND push_token = $2`, env.AppID, p.PushToken); err != nil {
			w.logger.Error("토큰 invalid 반영 실패", "err", err)
		}
	case FailureCredentialAuth:
		// 조용한 전량 실패 방지 (C-8 기반): 크리덴셜 error 전환 → 콘솔 표면화
		if _, err := w.pg.Exec(ctx, `
			UPDATE credentials SET status = 'error', status_detail = $3, updated_at = now()
			 WHERE app_id = $1 AND kind = $2`, env.AppID, kind, sendErr.Error()); err != nil {
			w.logger.Error("크리덴셜 error 전환 실패", "err", err)
		}
		w.invalidateCredCache(env.AppID, kind)
	}
	return base("failed", class.String(), sendErr.Error())
}

func (w *Worker) credential(ctx context.Context, appID, kind string) (Credentials, bool, error) {
	cacheKey := appID + "/" + kind
	now := w.clk.Now()
	w.credMu.Lock()
	if c, ok := w.credCache[cacheKey]; ok && now.Sub(c.loadedAt) < credCacheTTL {
		w.credMu.Unlock()
		return c.creds, c.found, nil
	}
	w.credMu.Unlock()

	var ciphertext, dekWrapped []byte
	err := w.pg.QueryRow(ctx, `
		SELECT ciphertext, dek_wrapped FROM credentials
		 WHERE app_id = $1 AND kind = $2 AND status = 'verified'`, appID, kind).
		Scan(&ciphertext, &dekWrapped)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			w.storeCredCache(cacheKey, Credentials{}, false, now)
			return Credentials{}, false, nil
		}
		return Credentials{}, false, err
	}
	plain, err := DecryptEnvelope(w.masterKey, ciphertext, dekWrapped)
	if err != nil {
		return Credentials{}, false, err
	}
	creds := Credentials{Kind: kind, JSON: plain}
	w.storeCredCache(cacheKey, creds, true, now)
	return creds, true, nil
}

func (w *Worker) storeCredCache(key string, creds Credentials, found bool, at time.Time) {
	w.credMu.Lock()
	w.credCache[key] = cachedCred{creds: creds, found: found, loadedAt: at}
	w.credMu.Unlock()
}

func (w *Worker) invalidateCredCache(appID, kind string) {
	w.credMu.Lock()
	delete(w.credCache, appID+"/"+kind)
	w.credMu.Unlock()
}

func (w *Worker) logRow(tenantID, appID string, p *SendPushPayload, status, class, detail string, at time.Time) []any {
	channel := "push_fcm"
	if p.Platform == "ios" {
		channel = "push_apns"
	}
	journeyID := "00000000-0000-0000-0000-000000000000"
	if p.JourneyID != nil {
		journeyID = *p.JourneyID
	}
	version, node := uint32(0), uint16(0)
	if p.JourneyVersion != nil {
		version = uint32(*p.JourneyVersion)
	}
	if p.NodeIndex != nil {
		node = uint16(*p.NodeIndex)
	}
	campaignRef := ""
	if p.CampaignRef != nil {
		campaignRef = *p.CampaignRef
	}
	return []any{
		tenantID, appID, uuid.NewString(), p.IdempotencyKey,
		journeyID, version, node, campaignRef,
		p.UserID, p.DeviceID, channel, status, class, detail, at,
	}
}

func (w *Worker) flushLog(ctx context.Context, rows [][]any) error {
	if len(rows) == 0 {
		return nil
	}
	batch, err := w.ch.PrepareBatch(ctx, `
		INSERT INTO message_log (tenant_id, app_id, message_id, idempotency_key,
			journey_id, journey_version, node_index, campaign_ref,
			user_id, device_id, channel, status, failure_class, failure_detail, sent_at)`)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if err := batch.Append(r...); err != nil {
			return err
		}
	}
	return batch.Send()
}
