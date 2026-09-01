package channel

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Verifier — unverified 크리덴셜을 폴링해 실검증하고 상태를 갱신한다 (C-1의 비동기 구현).
// 콘솔은 등록 후 상태를 폴링(5s)해 결과를 표시한다 (DEV-sub-06 실시간성 원칙).
type Verifier struct {
	pg        *pgxpool.Pool
	plugins   map[string]ChannelPlugin // 크리덴셜 kind → 검증 플러그인 (push_fcm/push_apns/email_smtp)
	masterKey []byte
	logger    *slog.Logger
	interval  time.Duration
}

func NewVerifier(pg *pgxpool.Pool, plugins map[string]ChannelPlugin, masterKey []byte, logger *slog.Logger) *Verifier {
	return &Verifier{pg: pg, plugins: plugins, masterKey: masterKey, logger: logger, interval: 5 * time.Second}
}

func (v *Verifier) Run(ctx context.Context) error {
	ticker := time.NewTicker(v.interval)
	defer ticker.Stop()
	v.logger.Info("credential verifier 시작")
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := v.sweep(ctx); err != nil && ctx.Err() == nil {
				v.logger.Error("verifier sweep 실패", "err", err)
			}
		}
	}
}

func (v *Verifier) sweep(ctx context.Context) error {
	rows, err := v.pg.Query(ctx, `
		SELECT id, kind, ciphertext, dek_wrapped FROM credentials
		 WHERE status = 'unverified' ORDER BY updated_at LIMIT 10`)
	if err != nil {
		return err
	}
	var creds []pendingCred
	for rows.Next() {
		var c pendingCred
		if err := rows.Scan(&c.id, &c.kind, &c.ciphertext, &c.dekWrapped); err != nil {
			rows.Close()
			return err
		}
		creds = append(creds, c)
	}
	rows.Close()

	for _, c := range creds {
		status, detail := v.judge(ctx, &c)
		if status == "" {
			continue // 일시 오류 — unverified 유지, 다음 sweep에서 재시도
		}
		if _, err := v.pg.Exec(ctx, `
			UPDATE credentials SET status = $2::credential_status, status_detail = NULLIF($3, ''),
			       last_verified_at = CASE WHEN $2::text = 'verified' THEN now() ELSE last_verified_at END,
			       updated_at = now()
			 WHERE id = $1`, c.id, status, detail); err != nil {
			return err
		}
		v.logger.Info("크리덴셜 검증", "id", c.id, "kind", c.kind, "status", status, "detail", detail)
	}
	return nil
}

type pendingCred struct {
	id, kind               string
	ciphertext, dekWrapped []byte
}

// judge — dry-run 결과 판정. 반환 status가 빈 문자열이면 판정 유보(재시도).
//   - 인증 오류(401/403/키 파싱) → error
//   - 무효 토큰 오류(InvalidTarget/PermanentContent) → verified (인증은 통과했다는 증거)
//   - 네트워크/5xx/429 → 유보
func (v *Verifier) judge(ctx context.Context, c *pendingCred) (status, detail string) {
	plain, err := DecryptEnvelope(v.masterKey, c.ciphertext, c.dekWrapped)
	if err != nil {
		return "error", "복호화 실패 — 마스터키 불일치 가능: " + err.Error()
	}
	plugin, ok := v.plugins[c.kind]
	if !ok {
		return "error", "지원하지 않는 크리덴셜 kind: " + c.kind
	}
	vctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	err = plugin.ValidateCredentials(vctx, Credentials{Kind: c.kind, JSON: plain})
	if err == nil {
		return "verified", ""
	}
	switch Classify(err) {
	case FailureCredentialAuth:
		return "error", err.Error()
	case FailureInvalidTarget, FailurePermanentContent:
		return "verified", ""
	default: // Retryable, RateLimited
		v.logger.Warn("검증 일시 오류 — 재시도 예정", "id", c.id, "err", err)
		return "", ""
	}
}
