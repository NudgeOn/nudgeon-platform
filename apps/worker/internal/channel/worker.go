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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/dlq"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/metrics"
	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
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

// pushKeyPrefix — Redis 멱등 키 네임스페이스. 이관 전(send:idem:…)과 같은 값이라
// 배포 경계에서 인플라이트 발송의 리스·백오프·DLQ 대기 상태가 그대로 이어진다.
const pushKeyPrefix = "send"

// 멱등 상태 값 (idemKey에 저장) — 리스 소유권·완료·실패를 구분해 결과를 보존한다 (R-02).
const (
	statusProcessing = "processing" // 임시 리스(처리 중)
	statusSent       = "sent"       // 전송 완료 (sent|<provider_id>)
	statusFailed     = "failed"     // 영구 실패 (failed|<class>)
)

type cachedCred struct {
	creds    Credentials
	loadedAt time.Time
	found    bool
}

// pushStore — 핸들러가 PG에 요구하는 것: 크리덴셜 조회, 토큰 invalid 반영, 크리덴셜 error 전환.
// *pgxpool.Pool이 만족하며, 테스트는 가짜 저장소를 주입한다.
type pushStore interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// PushJob — SendLoop이 한 건을 처리하는 동안 들고 다니는 상태.
type PushJob struct {
	P         SendPushPayload
	MessageID string
	Kind      string // push_fcm | push_apns — 플랫폼에서 결정된 크리덴셜 종류
}

// PushWorker — send.push의 SendHandler. 멱등·리스·백오프·DLQ·message_log 적재는
// SendLoop이 맡고, 이 타입은 푸시 채널에서만 다른 부분을 구현한다:
// 플랫폼별 크리덴셜(10분 메모리 캐시), 플러그인 호출, 오류 분류, 종결 부수효과
// (토큰 invalid·앱 삭제 기록·크리덴셜 error 전환), 로그 행.
//
// 이관 전에는 SendLoop과 같은 상태기계를 자체 사본으로 들고 있었다(480줄). email·message가
// 먼저 옮겨 갔고, push는 FCM/APNs 실단말 수신(M-1, 09-07)이 확인된 뒤 마지막으로 옮겼다.
type PushWorker struct {
	pg        pushStore
	dlqStore  dlq.Execer // Optional narrow dependency; defaults to pg.
	ch        driver.Conn
	plugin    ChannelPlugin
	masterKey []byte
	clk       clock.Clock
	logger    *slog.Logger

	credMu    sync.Mutex
	credCache map[string]cachedCred // key: appID+kind
}

func NewPushWorker(pg pushStore, ch driver.Conn, plugin ChannelPlugin, masterKey []byte,
	clk clock.Clock, logger *slog.Logger) *PushWorker {
	return &PushWorker{
		pg: pg, ch: ch, plugin: plugin, masterKey: masterKey, clk: clk, logger: logger,
		credCache: map[string]cachedCred{},
	}
}

var _ SendHandler[*PushJob] = (*PushWorker)(nil)

// Worker — channel 역할(send.push) 진입점. PushWorker를 SendLoop에 끼운 조합이며,
// 생성자 서명은 이관 전과 같다(cmd/worker·저니 E2E fixture가 그대로 쓴다).
// TODO(S4): (tenant,app,channel) 파티션 공정 스케줄링, quiet hours·cap 정책 검사.
type Worker struct {
	handler *PushWorker
	loop    *SendLoop[*PushJob]
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
	var store pushStore
	if pg != nil { // nil *pgxpool.Pool을 인터페이스에 넣으면 nil 검사가 무력화된다
		store = pg
	}
	h := NewPushWorker(store, ch, plugin, masterKey, clk, logger)
	return &Worker{handler: h, loop: NewSendLoop[*PushJob]("send.push", h, queue, rdb, ch, clk, logger)}
}

func (w *Worker) Run(ctx context.Context) error { return w.loop.Run(ctx) }

// handleOne — 테스트·진단용 단건 처리(SendLoop 위임).
func (w *Worker) handleOne(ctx context.Context, m *libqueue.Message) ([]any, bool) {
	return w.loop.handleOne(ctx, m)
}

func (w *PushWorker) KeyPrefix() string { return pushKeyPrefix }

func (w *PushWorker) Parse(env *libqueue.Envelope) (*PushJob, string, string, bool) {
	var p SendPushPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.IdempotencyKey == "" || p.Content.Push == nil {
		w.logger.Warn("send.push payload 불량 — skip", "err", err, "msg_id", env.ID)
		return nil, "", "", false
	}
	// 안정 message_id — 발송 시점 생성값을 그대로 사용(재시도에도 불변). 구(舊) 인플라이트 방어로 없으면 생성.
	messageID := p.MessageID
	if messageID == "" {
		messageID = uuid.NewString()
	}
	kind := "push_fcm"
	if p.Platform == "ios" {
		kind = "push_apns"
	}
	return &PushJob{P: p, MessageID: messageID, Kind: kind}, p.IdempotencyKey, messageID, true
}

// Resolve — 플랫폼에 맞는 verified 크리덴셜(10분 메모리 캐시). found=false는 "설정이 안 됐다"이지
// "장애"가 아니므로 SendLoop이 credential_missing으로 종결한다.
func (w *PushWorker) Resolve(ctx context.Context, env *libqueue.Envelope, job *PushJob) (Credentials, bool, error) {
	return w.credential(ctx, env.AppID, job.Kind)
}

func (w *PushWorker) Send(ctx context.Context, _ *libqueue.Envelope, job *PushJob, creds Credentials) (string, error) {
	job.P.Content.Push.MessageID = job.MessageID
	res, err := w.plugin.Send(ctx, SendRequest{
		IdempotencyKey: job.P.IdempotencyKey,
		Target:         Target{Token: job.P.PushToken, Platform: job.P.Platform},
		Content:        MessageContent{Push: job.P.Content.Push},
		Credentials:    creds,
	})
	if err != nil {
		return "", err
	}
	return res.ProviderID, nil
}

func (w *PushWorker) Classify(err error) FailureClass { return w.plugin.ClassifyError(err) }

// OnTerminal — 종결 부수효과. 영구 실패 중 두 클래스만 상태를 바꾼다:
//   - invalid_target: 토큰 피드백 루프 (C-5) — 즉시 invalid 반영 → 이후 발송·세그먼트 제외.
//     active→invalid 전이는 앱 삭제 신호(공급자 UNREGISTERED/410) → app_uninstalls에 기록.
//   - credential_auth: 조용한 전량 실패 방지 (C-8) — 크리덴셜 error 전환 → 콘솔 표면화.
//
// 지표는 SendLoop이 중앙에서 올리므로 여기서 세지 않는다(중복 계상 방지).
func (w *PushWorker) OnTerminal(ctx context.Context, env *libqueue.Envelope, job *PushJob, out SendOutcome) {
	if out.Status != "failed" || w.pg == nil {
		return
	}
	switch out.FailureClass {
	case FailureInvalidTarget.String():
		var duid, dpuid, dplat string
		err := w.pg.QueryRow(ctx, `
			UPDATE devices SET token_status = 'invalid', updated_at = now()
			 WHERE app_id = $1 AND push_token = $2 AND token_status = 'active'
			 RETURNING id, user_id, platform`, env.AppID, job.P.PushToken).Scan(&duid, &dpuid, &dplat)
		if err == nil {
			w.recordUninstall(ctx, env.TenantID, env.AppID, dpuid, duid, dplat)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			w.logger.Error("토큰 invalid 반영 실패", "err", err)
		}
	case FailureCredentialAuth.String():
		if _, err := w.pg.Exec(ctx, `
			UPDATE credentials SET status = 'error', status_detail = $3, updated_at = now()
			 WHERE app_id = $1 AND kind = $2`, env.AppID, job.Kind, out.FailureDetail); err != nil {
			w.logger.Error("크리덴셜 error 전환 실패", "err", err)
		}
		w.invalidateCredCache(env.AppID, job.Kind)
	}
}

// Row — message_log 행. provider_message_id는 sent 행에서만 채워진다(SendOutcome이 보장).
func (w *PushWorker) Row(env *libqueue.Envelope, job *PushJob, out SendOutcome) []any {
	p := job.P
	channel := "push_fcm"
	if p.Platform == "ios" {
		channel = "push_apns"
	}
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
	detail := out.FailureDetail
	if out.Status == "failed" && out.FailureClass == "credential_missing" {
		detail = fmt.Sprintf("%s 크리덴셜 미등록/미검증", job.Kind)
	}
	return []any{
		env.TenantID, env.AppID, out.MessageID, p.IdempotencyKey,
		journeyID, version, node, campaignRef,
		p.UserID, p.DeviceID, channel, out.Status, out.FailureClass, detail, out.At, out.ProviderID,
	}
}

// DLQ — 재시도 소진분을 send_dlq에 원본 envelope과 함께 적재한다(cmd/dlq로 replay 가능).
// 영속이 확인되기 전에는 nil을 돌려주지 않는다 — SendLoop은 그때까지 pending을 유지한다.
func (w *PushWorker) DLQ(ctx context.Context, env *libqueue.Envelope, job *PushJob, out SendOutcome) error {
	store := w.dlqStore
	if store == nil && w.pg != nil {
		store = w.pg
	}
	if store == nil {
		return errors.New("DLQ database is not configured")
	}
	envJSON, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("DLQ envelope encoding failed: %w", err)
	}
	var mid any
	if out.MessageID != "" {
		mid = out.MessageID
	}
	written, err := dlq.Persist(ctx, store, dlq.Entry{TenantID: env.TenantID, AppID: env.AppID, IdempotencyKey: job.P.IdempotencyKey,
		FailureID: out.FailureID, MessageID: mid, FailureClass: out.FailureClass, FailureDetail: out.FailureDetail, Attempts: out.Attempts, Envelope: envJSON})
	if err != nil {
		return err
	}
	if written {
		metrics.ObserveDLQEntry(libqueue.StreamSendPush, out.FailureClass)
	}
	return nil
}

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

func (w *PushWorker) credential(ctx context.Context, appID, kind string) (Credentials, bool, error) {
	cacheKey := appID + "/" + kind
	now := w.clk.Now()
	w.credMu.Lock()
	if c, ok := w.credCache[cacheKey]; ok && now.Sub(c.loadedAt) < credCacheTTL {
		w.credMu.Unlock()
		return c.creds, c.found, nil
	}
	w.credMu.Unlock()
	if w.pg == nil {
		return Credentials{}, false, errors.New("credential store is not configured")
	}

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

func (w *PushWorker) storeCredCache(key string, creds Credentials, found bool, at time.Time) {
	w.credMu.Lock()
	w.credCache[key] = cachedCred{creds: creds, found: found, loadedAt: at}
	w.credMu.Unlock()
}

func (w *PushWorker) invalidateCredCache(appID, kind string) {
	w.credMu.Lock()
	delete(w.credCache, appID+"/"+kind)
	w.credMu.Unlock()
}

// recordUninstall — active 토큰이 공급자 UNREGISTERED/410로 invalid 전이 시 앱 삭제 1건 기록.
func (w *PushWorker) recordUninstall(ctx context.Context, tenantID, appID, userID, deviceID, platform string) {
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
