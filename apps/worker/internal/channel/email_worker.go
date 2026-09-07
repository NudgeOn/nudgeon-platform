package channel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/dlq"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/metrics"
	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

const zeroUUID = "00000000-0000-0000-0000-000000000000"

// emailKeyPrefix — Redis 멱등 키 네임스페이스. 이관 전과 같은 값이라
// 배포 경계에서 인플라이트 발송의 리스·백오프 상태가 그대로 이어진다.
const emailKeyPrefix = "send:email"

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

// EmailJob — SendLoop이 한 건을 처리하는 동안 들고 다니는 상태.
type EmailJob struct {
	P         SendEmailPayload
	MessageID string
}

// EmailWorker — send.email의 SendHandler. 멱등·리스·백오프·DLQ·message_log 적재는
// SendLoop이 맡고, 이 타입은 이메일 채널에서만 다른 부분을 구현한다:
// 크리덴셜 선택(발송기 지정/폴백), 플러그인 호출, 오류 분류, 로그 행.
//
// 이관 전에는 250줄짜리 상태기계를 push Worker와 따로 들고 있었고, 그 사본에는
// DLQ 경로와 리스 소유 토큰이 없었다. 재시도가 소진되면 envelope이 사라졌다.
type EmailWorker struct {
	pg        emailStore
	plugin    ChannelPlugin
	masterKey []byte
	logger    *slog.Logger
}

// emailStore — 핸들러가 PG에 요구하는 두 가지: 크리덴셜 조회와 DLQ 적재.
// *pgxpool.Pool이 만족하며, 테스트는 가짜 저장소를 주입한다.
type emailStore interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func NewEmailWorker(pg emailStore, plugin ChannelPlugin, masterKey []byte, logger *slog.Logger) *EmailWorker {
	return &EmailWorker{pg: pg, plugin: plugin, masterKey: masterKey, logger: logger}
}

var _ SendHandler[*EmailJob] = (*EmailWorker)(nil)

func (w *EmailWorker) KeyPrefix() string { return emailKeyPrefix }

func (w *EmailWorker) Parse(env *libqueue.Envelope) (*EmailJob, string, string, bool) {
	var p SendEmailPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.IdempotencyKey == "" || p.Content.Email == nil {
		w.logger.Warn("send.email payload 불량 — skip", "err", err, "msg_id", env.ID)
		return nil, "", "", false
	}
	messageID := p.MessageID
	if messageID == "" {
		messageID = uuid.NewString()
	}
	return &EmailJob{P: p, MessageID: messageID}, p.IdempotencyKey, messageID, true
}

// Resolve — verified 이메일 발송기 크리덴셜 복호화(요청당 조회 — 이메일 볼륨 낮음).
// provider 지정 시 그 발송기만, 미지정 시 최근 검증된 활성 발송기로 폴백한다.
// found=false는 "설정이 안 됐다"이지 "장애"가 아니므로 재시도하지 않고 종결한다.
func (w *EmailWorker) Resolve(ctx context.Context, env *libqueue.Envelope, job *EmailJob) (Credentials, bool, error) {
	var kind string
	var ciphertext, dekWrapped []byte
	var err error
	if isEmailProvider(job.P.Provider) {
		err = w.pg.QueryRow(ctx, `
			SELECT kind::text, ciphertext, dek_wrapped FROM credentials
			 WHERE app_id = $1 AND kind = $2 AND status = 'verified'`, env.AppID, job.P.Provider).
			Scan(&kind, &ciphertext, &dekWrapped)
	} else {
		err = w.pg.QueryRow(ctx, `
			SELECT kind::text, ciphertext, dek_wrapped FROM credentials
			 WHERE app_id = $1 AND kind IN ('email_smtp','email_nhn','email_resend') AND status = 'verified'
			 ORDER BY last_verified_at DESC NULLS LAST LIMIT 1`, env.AppID).
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

func (w *EmailWorker) Send(ctx context.Context, _ *libqueue.Envelope, job *EmailJob, creds Credentials) (string, error) {
	job.P.Content.Email.MessageID = job.MessageID
	res, err := w.plugin.Send(ctx, SendRequest{
		IdempotencyKey: job.P.IdempotencyKey,
		Target:         Target{Token: job.P.Email},
		Content:        MessageContent{Email: job.P.Content.Email},
		Credentials:    creds,
	})
	if err != nil {
		return "", err
	}
	return res.ProviderID, nil
}

func (w *EmailWorker) Classify(err error) FailureClass { return w.plugin.ClassifyError(err) }

// OnTerminal — 이메일은 종결 부수효과가 없다. 도달·열림은 공급자 웹훅이
// message.lifecycle로 따로 올리고, 토큰 무효화 같은 개념도 없다.
// 지표는 SendLoop이 중앙에서 올리므로 여기서 세지 않는다(중복 계상 방지).
func (w *EmailWorker) OnTerminal(context.Context, *libqueue.Envelope, *EmailJob, SendOutcome) {}

// Row — message_log 행. provider_message_id는 sent 행에서만 채워진다(SendOutcome이 보장).
func (w *EmailWorker) Row(env *libqueue.Envelope, job *EmailJob, out SendOutcome) []any {
	p := job.P
	journeyID := zeroUUID
	if p.JourneyID != nil && *p.JourneyID != "" {
		journeyID = *p.JourneyID
	}
	version, node := uint32(0), uint16(0)
	if p.JourneyVersion != nil && *p.JourneyVersion > 0 {
		version = uint32(*p.JourneyVersion)
	}
	if p.NodeIndex != nil && *p.NodeIndex > 0 {
		node = uint16(*p.NodeIndex)
	}
	campaignRef := ""
	if p.CampaignRef != nil {
		campaignRef = *p.CampaignRef
	}
	detail := out.FailureDetail
	if out.Status == "failed" && out.FailureClass == "credential_missing" && detail == "" {
		detail = "이메일 발송기(email_*) 크리덴셜 미등록/미검증"
	}
	return []any{
		env.TenantID, env.AppID, job.MessageID, p.IdempotencyKey,
		journeyID, version, node, campaignRef,
		emailUUIDOrZero(p.UserID), zeroUUID, "email", out.Status, out.FailureClass, detail, out.At, out.ProviderID,
	}
}

// DLQ — 재시도 소진분을 send_dlq에 원본 envelope과 함께 적재한다. cmd/dlq가 재처리한다.
// 영속이 확인되기 전에는 nil을 돌려주지 않는다 — SendLoop은 그때까지 pending을 유지한다.
func (w *EmailWorker) DLQ(ctx context.Context, env *libqueue.Envelope, job *EmailJob, out SendOutcome) error {
	if w.pg == nil {
		return fmt.Errorf("DLQ database is not configured")
	}
	envJSON, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("DLQ envelope encoding failed: %w", err)
	}
	var mid any
	if _, err := uuid.Parse(job.MessageID); err == nil {
		mid = job.MessageID
	}
	written, err := dlq.Persist(ctx, w.pg, dlq.Entry{
		TenantID: env.TenantID, AppID: env.AppID, IdempotencyKey: job.P.IdempotencyKey,
		FailureID: out.FailureID, MessageID: mid,
		FailureClass: out.FailureClass, FailureDetail: out.FailureDetail,
		Attempts: out.Attempts, Envelope: envJSON,
	})
	if err != nil {
		return err
	}
	if written {
		metrics.ObserveDLQEntry(libqueue.StreamSendEmail, out.FailureClass)
	}
	return nil
}

// emailUUIDOrZero — message_log.user_id는 UUID 컬럼이다. 비UUID가 오면 행을 잃느니 zero로 적재한다.
func emailUUIDOrZero(s string) string {
	if s == "" {
		return zeroUUID
	}
	if _, err := uuid.Parse(s); err != nil {
		return zeroUUID
	}
	return s
}
