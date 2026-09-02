package channel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/ondahq/onda/apps/worker/internal/clock"
	"github.com/ondahq/onda/apps/worker/internal/metrics"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

const zeroUUID = "00000000-0000-0000-0000-000000000000"

// SendEmailPayload — send.email 스트림 payload. content.email은 {{ }} 치환 완료된 최종 본문.
type SendEmailPayload struct {
	IdempotencyKey string `json:"idempotency_key"`
	MessageID      string `json:"message_id"`
	UserID         string `json:"user_id"`
	Email          string `json:"email"`    // 수신 이메일 주소
	Provider       string `json:"provider"` // email_smtp | email_nhn | email_resend (미지정=활성 발송기 폴백)
	Content        struct {
		Email *EmailContent `json:"email"`
	} `json:"content"`
	Category       string  `json:"category"`
	JourneyID      *string `json:"journey_id"`
	JourneyVersion *int    `json:"journey_version"`
	NodeIndex      *int    `json:"node_index"`
	CampaignRef    *string `json:"campaign_ref"`
}

// EmailWorker — channel(email) 역할: send.email 소비 → 멱등 → 복호화 → SMTP 전송 → message_log(channel='email').
// 멱등·백오프·재전달 계약은 push Worker와 동일(리스→커밋, retryable은 미ACK로 reclaim 재시도).
type EmailWorker struct {
	queue       *libqueue.Consumer
	rdb         redis.Cmdable
	pg          *pgxpool.Pool
	ch          driver.Conn
	plugin      ChannelPlugin
	masterKey   []byte
	clk         clock.Clock
	logger      *slog.Logger
	lastReclaim time.Time
}

func NewEmailWorker(queue *libqueue.Consumer, rdb redis.Cmdable, pg *pgxpool.Pool, ch driver.Conn,
	plugin ChannelPlugin, masterKey []byte, clk clock.Clock, logger *slog.Logger) *EmailWorker {
	return &EmailWorker{queue: queue, rdb: rdb, pg: pg, ch: ch, plugin: plugin,
		masterKey: masterKey, clk: clk, logger: logger}
}

func (w *EmailWorker) Run(ctx context.Context) error {
	if err := w.queue.EnsureGroup(ctx); err != nil {
		return err
	}
	w.logger.Info("email 워커 시작")
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
				msgs = append(msgs, reclaimed...)
			}
		}
		if len(msgs) == 0 {
			continue
		}
		logRows := make([][]any, 0, len(msgs))
		ackIDs := make([]string, 0, len(msgs))
		for _, m := range msgs {
			row, retry := w.handleOne(ctx, &m)
			if row != nil {
				logRows = append(logRows, row)
			}
			if !retry {
				ackIDs = append(ackIDs, m.StreamID)
			}
		}
		if err := w.flushLog(ctx, logRows); err != nil {
			w.logger.Error("message_log(email) 적재 실패 — 재시도", "err", err)
			time.Sleep(time.Second)
			continue
		}
		if err := w.queue.Ack(ctx, ackIDs...); err != nil {
			w.logger.Error("ack 실패", "err", err)
		}
	}
}

func (w *EmailWorker) handleOne(ctx context.Context, m *libqueue.Message) ([]any, bool) {
	env := &m.Envelope
	var p SendEmailPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.IdempotencyKey == "" || p.Content.Email == nil {
		w.logger.Warn("send.email payload 불량 — skip", "err", err, "msg_id", env.ID)
		return nil, false
	}
	messageID := p.MessageID
	if messageID == "" {
		messageID = uuid.NewString()
	}
	now := w.clk.Now()
	base := func(status, class, detail string) []any {
		return w.logRow(env.TenantID, env.AppID, &p, messageID, status, class, detail, "", now)
	}
	// sentRow — 전송 성공(및 재전달 시 재기록) 행. provider_message_id로 공급자 콜백과 조인.
	sentRow := func(providerID, detail string) []any {
		return w.logRow(env.TenantID, env.AppID, &p, messageID, "sent", "", detail, providerID, now)
	}

	idemKey := fmt.Sprintf("send:email:idem:%s:%s", env.TenantID, p.IdempotencyKey)
	attemptsKey := fmt.Sprintf("send:email:attempts:%s:%s", env.TenantID, p.IdempotencyKey)
	retryAtKey := fmt.Sprintf("send:email:retryat:%s:%s", env.TenantID, p.IdempotencyKey)

	commitFailed := func(class string) {
		w.rdb.Set(ctx, idemKey, statusFailed+"|"+class, idemCommitTTL)
		w.rdb.Del(ctx, attemptsKey, retryAtKey)
	}
	retryFail := func(class, detail string, retryAfter time.Duration) ([]any, bool) {
		n, err := w.rdb.Incr(ctx, attemptsKey).Result()
		if err == nil {
			w.rdb.Expire(ctx, attemptsKey, idemCommitTTL)
		}
		if err != nil || n >= maxSendAttempts {
			w.rdb.Set(ctx, idemKey, statusFailed+"|"+class+"_exhausted", idemCommitTTL)
			w.rdb.Del(ctx, attemptsKey, retryAtKey)
			metrics.ChannelSends.WithLabelValues("failed").Inc()
			return base("failed", class+"_exhausted", detail), false
		}
		delay := retryAfter
		if delay <= 0 {
			delay = backoff(int(n))
		}
		w.rdb.Set(ctx, retryAtKey, now.Add(delay).Unix(), idemCommitTTL)
		w.rdb.Del(ctx, idemKey)
		return nil, true
	}

	if ts, err := w.rdb.Get(ctx, retryAtKey).Int64(); err == nil && now.Unix() < ts {
		return nil, true
	}
	acquired, err := w.rdb.SetNX(ctx, idemKey, statusProcessing, idemLeaseTTL).Result()
	if err != nil {
		w.logger.Error("멱등 선점 실패", "err", err)
		return nil, true
	}
	if !acquired {
		val, _ := w.rdb.Get(ctx, idemKey).Result()
		switch {
		case strings.HasPrefix(val, statusSent+"|"):
			providerID := strings.TrimPrefix(val, statusSent+"|")
			metrics.ChannelSends.WithLabelValues("duplicate").Inc()
			return sentRow(providerID, "provider_id="+providerID), false
		case strings.HasPrefix(val, statusFailed+"|"):
			return base("failed", strings.TrimPrefix(val, statusFailed+"|"), ""), false
		default:
			metrics.ChannelSends.WithLabelValues("duplicate").Inc()
			return base("duplicate", "", ""), false
		}
	}

	creds, ok, err := w.emailCredential(ctx, env.AppID, p.Provider)
	if err != nil {
		return retryFail("retryable", "크리덴셜 조회 오류: "+err.Error(), 0)
	}
	if !ok {
		commitFailed("credential_missing")
		return base("failed", "credential_missing", "이메일 발송기(email_*) 크리덴셜 미등록/미검증"), false
	}

	p.Content.Email.MessageID = messageID
	res, sendErr := w.plugin.Send(ctx, SendRequest{
		IdempotencyKey: p.IdempotencyKey,
		Target:         Target{Token: p.Email},
		Content:        MessageContent{Email: p.Content.Email},
		Credentials:    creds,
	})
	if sendErr == nil {
		w.rdb.Set(ctx, idemKey, statusSent+"|"+res.ProviderID, idemCommitTTL)
		w.rdb.Del(ctx, attemptsKey, retryAtKey)
		metrics.ChannelSends.WithLabelValues("sent").Inc()
		return sentRow(res.ProviderID, ""), false
	}

	class := w.plugin.ClassifyError(sendErr)
	switch class {
	case FailureInvalidTarget, FailurePermanentContent:
		commitFailed(class.String())
		metrics.ChannelSends.WithLabelValues("failed").Inc()
		return base("failed", class.String(), sendErr.Error()), false
	case FailureRateLimited:
		return retryFail("rate_limited", sendErr.Error(), RetryAfterOf(sendErr))
	default: // Retryable, CredentialAuth(일시 취급)
		return retryFail("retryable", sendErr.Error(), 0)
	}
}

// emailCredential — verified 이메일 공급자 크리덴셜 복호화(요청당 조회 — 이메일 볼륨 낮음).
// 앱이 설정한 email_* 공급자(email_smtp/email_nhn/email_resend) 중 최근 검증된 것을 선택하고 kind를 실어
// 플러그인이 공급자별로 분기하도록 한다.
// provider 지정 시 그 발송기만, 미지정 시 최근 검증된 활성 발송기로 폴백.
func (w *EmailWorker) emailCredential(ctx context.Context, appID, provider string) (Credentials, bool, error) {
	var kind string
	var ciphertext, dekWrapped []byte
	var err error
	if isEmailProvider(provider) {
		err = w.pg.QueryRow(ctx, `
			SELECT kind::text, ciphertext, dek_wrapped FROM credentials
			 WHERE app_id = $1 AND kind = $2 AND status = 'verified'`, appID, provider).
			Scan(&kind, &ciphertext, &dekWrapped)
	} else {
		err = w.pg.QueryRow(ctx, `
			SELECT kind::text, ciphertext, dek_wrapped FROM credentials
			 WHERE app_id = $1 AND kind IN ('email_smtp','email_nhn','email_resend') AND status = 'verified'
			 ORDER BY last_verified_at DESC NULLS LAST LIMIT 1`, appID).
			Scan(&kind, &ciphertext, &dekWrapped)
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Credentials{}, false, nil
		}
		return Credentials{}, false, err
	}
	plain, err := DecryptEnvelope(w.masterKey, ciphertext, dekWrapped)
	if err != nil {
		return Credentials{}, false, err
	}
	return Credentials{Kind: kind, JSON: plain}, true, nil
}

// logRow — message_log 행. providerID는 sent 행에서만 채운다(그 외 ”).
func (w *EmailWorker) logRow(tenantID, appID string, p *SendEmailPayload, messageID, status, class, detail, providerID string, at time.Time) []any {
	journeyID := zeroUUID
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
	userID := p.UserID
	if userID == "" {
		userID = zeroUUID
	}
	return []any{
		tenantID, appID, messageID, p.IdempotencyKey,
		journeyID, version, node, campaignRef,
		userID, zeroUUID, "email", status, class, detail, at, providerID,
	}
}

func (w *EmailWorker) flushLog(ctx context.Context, rows [][]any) error {
	if len(rows) == 0 {
		return nil
	}
	batch, err := w.ch.PrepareBatch(ctx, `
		INSERT INTO message_log (tenant_id, app_id, message_id, idempotency_key,
			journey_id, journey_version, node_index, campaign_ref,
			user_id, device_id, channel, status, failure_class, failure_detail, sent_at,
			provider_message_id)`)
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
