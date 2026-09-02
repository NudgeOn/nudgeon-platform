package channel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
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

// SendPushPayload — packages/queue-schemas/schemas/send.push.schema.json의 Go 표현.
type SendPushPayload struct {
	IdempotencyKey string `json:"idempotency_key"`
	MessageID      string `json:"message_id"` // 발송 시점 생성 안정 ID (재검증 F)
	UserID         string `json:"user_id"`
	DeviceID       string `json:"device_id"`
	PushToken      string `json:"push_token"`
	Platform       string `json:"platform"`
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
	// idemCommitTTL — 종결(전송 완료/영구 실패) 후 유지하는 멱등 클레임 7d (sub-04).
	idemCommitTTL = 7 * 24 * time.Hour
	// idemLeaseTTL — 처리 중 임시 선점(리스). sendReclaim보다 짧아야 크래시-전-전송 시
	// 리스 만료 후 재클레임되어 재전송된다(유실 방지). 종결 시 idemCommitTTL로 연장.
	idemLeaseTTL = 20 * time.Second
	// maxSendAttempts — retryable/429 재시도 상한. 초과 시 send_dlq에 적재(재처리 가능 DLQ).
	maxSendAttempts = 5
	backoffBase     = 30 * time.Second // 지수 백오프 base (Retry-After 미지정 시)
	backoffCap      = 15 * time.Minute
	credCacheTTL    = 10 * time.Minute // 워커 메모리 복호 캐시 (sub-04)
	sendFetch       = 100
	sendBlock       = time.Second
	sendReclaim     = 30 * time.Second
	reclaimPeriod   = 10 * time.Second
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

	credMu      sync.Mutex
	credCache   map[string]cachedCred // key: appID+kind
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
			row, retry := w.handleOne(ctx, &m)
			if row != nil {
				logRows = append(logRows, row)
			}
			// retryable(일시 실패)은 ACK하지 않는다 → pending으로 남아 reclaim(≈30s)이
			// 재전달 → 자연 백오프 재시도. 종결(전송/영구실패/중복/소진)만 ACK.
			if !retry {
				ackIDs = append(ackIDs, m.StreamID)
			}
		}
		if err := w.flushLog(ctx, logRows); err != nil {
			w.logger.Error("message_log 적재 실패 — 재시도", "err", err)
			time.Sleep(time.Second)
			continue // ack 없이 재처리 (멱등 커밋이 실전송 중복을 막는다)
		}
		if err := w.queue.Ack(ctx, ackIDs...); err != nil {
			w.logger.Error("ack 실패", "err", err)
		}
	}
}

// handleOne은 한 건을 처리하고 (message_log 행, retry 여부)를 돌려준다.
// retry=true면 호출자는 ACK하지 않아 reclaim이 재전달(자연 백오프) → 재시도한다.
// 멱등: 임시 리스로 선점 → 전송/영구실패 시 7d 커밋(재전송 차단), 일시실패 시 리스 해제(재시도 허용).
func (w *Worker) handleOne(ctx context.Context, m *libqueue.Message) ([]any, bool) {
	env := &m.Envelope
	var p SendPushPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.IdempotencyKey == "" || p.Content.Push == nil {
		w.logger.Warn("send.push payload 불량 — skip", "err", err, "msg_id", env.ID)
		return nil, false // 불량 payload는 재처리 무의미 → ACK
	}

	// 안정 message_id — 발송 시점 생성값을 그대로 사용(재시도에도 불변). 구(舊) 인플라이트 방어로 없으면 생성.
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

	idemKey := fmt.Sprintf("send:idem:%s:%s", env.TenantID, p.IdempotencyKey)
	attemptsKey := fmt.Sprintf("send:attempts:%s:%s", env.TenantID, p.IdempotencyKey)
	retryAtKey := fmt.Sprintf("send:retryat:%s:%s", env.TenantID, p.IdempotencyKey)

	// commitFailed — 영구 실패 종결(상태에 사유 기록, 재전송 차단).
	commitFailed := func(class string) {
		w.rdb.Set(ctx, idemKey, statusFailed+"|"+class, idemCommitTTL)
		w.rdb.Del(ctx, attemptsKey, retryAtKey)
	}
	// retryFail — 상한 내면 백오프 후 재시도(리스 해제), 초과면 DLQ 적재 후 종결.
	retryFail := func(class, detail string, retryAfter time.Duration) ([]any, bool) {
		n, err := w.rdb.Incr(ctx, attemptsKey).Result()
		if err == nil {
			w.rdb.Expire(ctx, attemptsKey, idemCommitTTL)
		}
		if err != nil || n >= maxSendAttempts {
			w.toDLQ(ctx, env, &p, messageID, class, detail, int(n))
			w.rdb.Set(ctx, idemKey, statusFailed+"|"+class+"_exhausted", idemCommitTTL)
			w.rdb.Del(ctx, attemptsKey, retryAtKey)
			metrics.ChannelSends.WithLabelValues("failed").Inc()
			return base("failed", class+"_exhausted", detail), false
		}
		delay := retryAfter // 429 Retry-After 우선
		if delay <= 0 {
			delay = backoff(int(n)) // 없으면 지수 백오프
		}
		w.rdb.Set(ctx, retryAtKey, now.Add(delay).Unix(), idemCommitTTL)
		w.rdb.Del(ctx, idemKey) // 리스 해제 → reclaim이 백오프 이후 재전달
		return nil, true
	}

	// 0) 백오프 대기 중이면 처리를 미룬다(리스 없이 → reclaim이 나중에 재전달). Retry-After/지수 백오프 준수.
	if ts, err := w.rdb.Get(ctx, retryAtKey).Int64(); err == nil && now.Unix() < ts {
		return nil, true
	}

	// 1) 멱등 선점 (processing 리스). 실패=이미 종결됐거나 처리 중.
	acquired, err := w.rdb.SetNX(ctx, idemKey, statusProcessing, idemLeaseTTL).Result()
	if err != nil {
		w.logger.Error("멱등 선점 실패", "err", err)
		return nil, true
	}
	if !acquired {
		// 상태를 읽어 전송 결과를 보존한다: sent였다면 CH 로그 flush 실패 후 재전달에도 sent 재기록(중복 전송 없음).
		val, _ := w.rdb.Get(ctx, idemKey).Result()
		switch {
		case strings.HasPrefix(val, statusSent+"|"):
			providerID := strings.TrimPrefix(val, statusSent+"|")
			metrics.ChannelSends.WithLabelValues("duplicate").Inc()
			return sentRow(providerID, "provider_id="+providerID), false
		case strings.HasPrefix(val, statusFailed+"|"):
			return base("failed", strings.TrimPrefix(val, statusFailed+"|"), ""), false
		default: // processing — 처리 중이거나 크래시 리스(만료 후 reclaim이 재획득). 이번 전달은 중복.
			metrics.ChannelSends.WithLabelValues("duplicate").Inc()
			return base("duplicate", "", ""), false
		}
	}

	// 2) 크리덴셜 해석 (verified만, 10분 캐시)
	kind := "push_fcm"
	if p.Platform == "ios" {
		kind = "push_apns"
	}
	creds, ok, err := w.credential(ctx, env.AppID, kind)
	if err != nil {
		return retryFail("retryable", "크리덴셜 조회 오류: "+err.Error(), 0)
	}
	if !ok {
		commitFailed("credential_missing")
		return base("failed", "credential_missing", fmt.Sprintf("%s 크리덴셜 미등록/미검증", kind)), false
	}

	// 3) 전송
	p.Content.Push.MessageID = messageID
	res, sendErr := w.plugin.Send(ctx, SendRequest{
		IdempotencyKey: p.IdempotencyKey,
		Target:         Target{Token: p.PushToken, Platform: p.Platform},
		Content:        MessageContent{Push: p.Content.Push},
		Credentials:    creds,
	})
	if sendErr == nil {
		// 결과(provider_id)를 상태에 보존 → 로그 flush 실패 후 재전달에도 sent 재기록 가능.
		w.rdb.Set(ctx, idemKey, statusSent+"|"+res.ProviderID, idemCommitTTL)
		w.rdb.Del(ctx, attemptsKey, retryAtKey)
		metrics.ChannelSends.WithLabelValues("sent").Inc()
		return sentRow(res.ProviderID, ""), false
	}

	class := w.plugin.ClassifyError(sendErr)
	switch class {
	case FailureInvalidTarget:
		// 토큰 피드백 루프 (C-5): 즉시 invalid 반영 → 이후 발송·세그먼트 제외.
		// active→invalid 전이는 앱 삭제 신호(공급자 UNREGISTERED/410) → app_uninstalls에 기록.
		var duid, dpuid, dplat string
		err := w.pg.QueryRow(ctx, `
			UPDATE devices SET token_status = 'invalid', updated_at = now()
			 WHERE app_id = $1 AND push_token = $2 AND token_status = 'active'
			 RETURNING id, user_id, platform`, env.AppID, p.PushToken).Scan(&duid, &dpuid, &dplat)
		if err == nil {
			w.recordUninstall(ctx, env.TenantID, env.AppID, dpuid, duid, dplat)
		} else if !errors.Is(err, pgx.ErrNoRows) {
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

	// 일시 실패(네트워크·5xx·429)만 재시도(429는 Retry-After 반영), 나머지는 종결.
	// 주의(결과 불명): 요청을 보낸 뒤 응답 전 네트워크 오류면 공급자가 이미 수신했을 수 있으나
	// 여기서는 retryable로 재시도한다 → at-least-once(드물게 중복 발송 가능). 정확-한-번은 공급자
	// 멱등키(FCM/APNs 지원 시) 연동으로 별도 강화 (R-02 잔여).
	if class == FailureRetryable || class == FailureRateLimited {
		return retryFail(class.String(), sendErr.Error(), RetryAfterOf(sendErr))
	}
	commitFailed(class.String())
	metrics.ChannelSends.WithLabelValues("failed").Inc()
	return base("failed", class.String(), sendErr.Error()), false
}

// 멱등 상태 값 (idemKey에 저장) — 리스 소유권·완료·실패를 구분해 결과를 보존한다 (R-02).
const (
	statusProcessing = "processing" // 임시 리스(처리 중)
	statusSent       = "sent"       // 전송 완료 (sent|<provider_id>)
	statusFailed     = "failed"     // 영구 실패 (failed|<class>)
)

// backoff는 지수 백오프(base*2^(attempt-1), cap)를 돌려준다.
func backoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	d := backoffBase << (attempt - 1)
	if d <= 0 || d > backoffCap {
		return backoffCap
	}
	return d
}

// toDLQ는 재시도 소진된 발송을 send_dlq에 적재한다(원본 envelope 포함 → cmd/dlq로 replay 가능).
func (w *Worker) toDLQ(ctx context.Context, env *libqueue.Envelope, p *SendPushPayload, messageID, class, detail string, attempts int) {
	if w.pg == nil {
		return // 단위 테스트 등 pg 미주입 시 스킵
	}
	envJSON, _ := json.Marshal(env)
	var mid any
	if messageID != "" {
		mid = messageID
	}
	if _, err := w.pg.Exec(ctx, `
		INSERT INTO send_dlq (tenant_id, app_id, idempotency_key, message_id,
			failure_class, failure_detail, attempts, envelope)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
			failure_class = EXCLUDED.failure_class, failure_detail = EXCLUDED.failure_detail,
			attempts = EXCLUDED.attempts, envelope = EXCLUDED.envelope,
			created_at = now(), replayed_at = NULL`,
		env.TenantID, env.AppID, p.IdempotencyKey, mid, class, detail, attempts, envJSON); err != nil {
		w.logger.Error("DLQ 적재 실패", "err", err, "idem", p.IdempotencyKey)
	}
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

// logRow — message_log 행. providerID는 sent 행에서만 채운다(그 외 ”).
func (w *Worker) logRow(tenantID, appID string, p *SendPushPayload, messageID, status, class, detail, providerID string, at time.Time) []any {
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
		tenantID, appID, messageID, p.IdempotencyKey,
		journeyID, version, node, campaignRef,
		p.UserID, p.DeviceID, channel, status, class, detail, at, providerID,
	}
}

// recordUninstall — active 토큰이 공급자 UNREGISTERED/410로 invalid 전이 시 앱 삭제 1건 기록.
func (w *Worker) recordUninstall(ctx context.Context, tenantID, appID, userID, deviceID, platform string) {
	if w.ch == nil {
		return
	}
	batch, err := w.ch.PrepareBatch(ctx, `INSERT INTO app_uninstalls
		(tenant_id, app_id, user_id, device_id, platform, detected_at)`)
	if err != nil {
		w.logger.Error("uninstall 기록 준비 실패", "err", err)
		return
	}
	if err := batch.Append(tenantID, appID, userID, deviceID, platform, w.clk.Now()); err != nil {
		w.logger.Error("uninstall 기록 append 실패", "err", err)
		return
	}
	if err := batch.Send(); err != nil {
		w.logger.Error("uninstall 기록 전송 실패", "err", err)
	}
}

func (w *Worker) flushLog(ctx context.Context, rows [][]any) error {
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
