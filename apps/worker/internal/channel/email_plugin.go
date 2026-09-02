package channel

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strings"
	"time"

	"github.com/ondahq/onda/apps/worker/internal/clock"
)

// EmailPlugin — SMTP 이메일 채널 (PRD-04 확장). 자체호스팅 우선: 표준 SMTP(STARTTLS/implicit TLS/plaintext).
// 크리덴셜(email_smtp): {host, port, username, password, from_email, from_name, security}.
// security: "starttls"(기본, 587) | "tls"(implicit, 465) | "none"(dev/MailHog 1025).
type EmailPlugin struct{ clk clock.Clock }

func NewEmailPlugin(clk clock.Clock) *EmailPlugin { return &EmailPlugin{clk: clk} }

type smtpCred struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Username  string `json:"username"`
	Password  string `json:"password"`
	FromEmail string `json:"from_email"`
	FromName  string `json:"from_name"`
	Security  string `json:"security"` // starttls | tls | none
}

func (p *EmailPlugin) Kind() ChannelKind      { return KindEmail }
func (p *EmailPlugin) TargetType() TargetType { return TargetEmail }

// 이메일 크리덴셜 kind → 공급자 라우팅. SMTP(범용·AWS SES SMTP 포함) / NHN Cloud Email API / Resend.
// AWS SES는 email-smtp.{region}.amazonaws.com SMTP로 email_smtp에서 바로 동작(콘솔 프리셋).
const (
	credEmailSMTP   = "email_smtp"
	credEmailNHN    = "email_nhn"
	credEmailResend = "email_resend"
)

// isEmailProvider — send.email payload의 provider 지정값이 알려진 이메일 발송기 kind인지.
func isEmailProvider(kind string) bool {
	return kind == credEmailSMTP || kind == credEmailNHN || kind == credEmailResend
}

func parseSMTPCred(creds Credentials) (*smtpCred, error) {
	var c smtpCred
	if err := json.Unmarshal(creds.JSON, &c); err != nil {
		return nil, NewSendError(FailureCredentialAuth, "email_smtp 크리덴셜 파싱: %v", err)
	}
	if c.Host == "" || c.Port == 0 || c.FromEmail == "" {
		return nil, NewSendError(FailureCredentialAuth, "email_smtp 필수값 누락(host/port/from_email)")
	}
	if c.Security == "" {
		c.Security = "starttls"
	}
	return &c, nil
}

func (p *EmailPlugin) ValidateCredentials(ctx context.Context, creds Credentials) error {
	switch creds.Kind {
	case credEmailNHN:
		return p.validateNHN(ctx, creds)
	case credEmailResend:
		return p.validateResend(ctx, creds)
	default:
		return p.validateSMTP(ctx, creds)
	}
}

func (p *EmailPlugin) validateSMTP(ctx context.Context, creds Credentials) error {
	c, err := parseSMTPCred(creds)
	if err != nil {
		return err
	}
	// 실검증(C-1): 연결·(가능시)STARTTLS·AUTH·NOOP까지 수행 후 종료.
	client, err := p.dial(ctx, c)
	if err != nil {
		return err
	}
	defer client.Close()
	if err := p.maybeAuth(client, c); err != nil {
		return err
	}
	if err := client.Noop(); err != nil {
		return NewSendError(FailureRetryable, "SMTP NOOP: %v", err)
	}
	return nil
}

func (p *EmailPlugin) Send(ctx context.Context, req SendRequest) (SendResult, error) {
	if req.Content.Email == nil {
		return SendResult{}, NewSendError(FailurePermanentContent, "email content 없음")
	}
	switch req.Credentials.Kind {
	case credEmailNHN:
		return p.sendNHN(ctx, req)
	case credEmailResend:
		return p.sendResend(ctx, req)
	default:
		return p.sendSMTP(ctx, req)
	}
}

func (p *EmailPlugin) sendSMTP(ctx context.Context, req SendRequest) (SendResult, error) {
	c, err := parseSMTPCred(req.Credentials)
	if err != nil {
		return SendResult{}, err
	}
	if req.Content.Email == nil {
		return SendResult{}, NewSendError(FailurePermanentContent, "email content 없음")
	}
	to := strings.TrimSpace(req.Target.Token) // 이메일 채널의 Target.Token = 수신 이메일 주소
	if to == "" || !strings.Contains(to, "@") {
		return SendResult{}, NewSendError(FailureInvalidTarget, "수신 이메일 주소 형식 오류: %q", to)
	}
	msg := buildMIME(c, to, req.Content.Email)

	client, err := p.dial(ctx, c)
	if err != nil {
		return SendResult{}, err
	}
	defer client.Close()
	if err := p.maybeAuth(client, c); err != nil {
		return SendResult{}, err
	}
	if err := client.Mail(c.FromEmail); err != nil {
		return SendResult{}, classifySMTP(err)
	}
	if err := client.Rcpt(to); err != nil {
		return SendResult{}, classifySMTP(err) // 550 등 → invalid_target
	}
	wc, err := client.Data()
	if err != nil {
		return SendResult{}, classifySMTP(err)
	}
	if _, err := wc.Write(msg); err != nil {
		_ = wc.Close()
		return SendResult{}, NewSendError(FailureRetryable, "SMTP DATA write: %v", err)
	}
	if err := wc.Close(); err != nil {
		return SendResult{}, classifySMTP(err)
	}
	_ = client.Quit()
	// message-id 헤더를 ProviderID로 노출(도달/오픈 조인 X — SMTP는 콜백 없음).
	return SendResult{ProviderID: req.Content.Email.MessageID}, nil
}

// dial — security에 따라 연결. implicit TLS면 tls.Dial, 그 외엔 평문 연결 후 STARTTLS(가능시).
func (p *EmailPlugin) dial(ctx context.Context, c *smtpCred) (*smtp.Client, error) {
	addr := net.JoinHostPort(c.Host, fmt.Sprintf("%d", c.Port))
	d := net.Dialer{Timeout: 10 * time.Second}
	if c.Security == "tls" {
		conn, err := tls.DialWithDialer(&d, "tcp", addr, &tls.Config{ServerName: c.Host})
		if err != nil {
			return nil, NewSendError(FailureRetryable, "SMTP TLS 연결: %v", err)
		}
		client, err := smtp.NewClient(conn, c.Host)
		if err != nil {
			_ = conn.Close()
			return nil, NewSendError(FailureRetryable, "SMTP 클라이언트: %v", err)
		}
		return client, nil
	}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, NewSendError(FailureRetryable, "SMTP 연결: %v", err)
	}
	client, err := smtp.NewClient(conn, c.Host)
	if err != nil {
		_ = conn.Close()
		return nil, NewSendError(FailureRetryable, "SMTP 클라이언트: %v", err)
	}
	if c.Security != "none" {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: c.Host}); err != nil {
				_ = client.Close()
				return nil, NewSendError(FailureRetryable, "STARTTLS: %v", err)
			}
		}
	}
	return client, nil
}

func (p *EmailPlugin) maybeAuth(client *smtp.Client, c *smtpCred) error {
	if c.Username == "" {
		return nil // 인증 없는 릴레이(dev/내부 릴레이)
	}
	if ok, _ := client.Extension("AUTH"); !ok {
		return NewSendError(FailureCredentialAuth, "서버가 AUTH 미지원")
	}
	auth := smtp.PlainAuth("", c.Username, c.Password, c.Host)
	if err := client.Auth(auth); err != nil {
		return NewSendError(FailureCredentialAuth, "SMTP AUTH 실패: %v", err)
	}
	return nil
}

func (p *EmailPlugin) ClassifyError(err error) FailureClass { return Classify(err) }

func (p *EmailPlugin) HandleCallback(ctx context.Context, raw []byte) ([]DeliveryUpdate, error) {
	return nil, nil // SMTP는 동기 응답만 — 콜백 없음
}

// buildMIME — RFC5322 HTML 메일. 제목은 RFC2047(UTF-8) 인코딩, 본문은 text/html; charset=UTF-8.
func buildMIME(c *smtpCred, to string, e *EmailContent) []byte {
	from := c.FromEmail
	if c.FromName != "" {
		from = fmt.Sprintf("%s <%s>", mime.QEncoding.Encode("utf-8", c.FromName), c.FromEmail)
	}
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", e.Subject) + "\r\n")
	if e.MessageID != "" {
		b.WriteString("Message-ID: <" + e.MessageID + "@onda>\r\n")
	}
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("\r\n")
	b.WriteString(e.HTML)
	return []byte(b.String())
}

// classifySMTP — smtp.Client 오류를 재시도 분류로. 5xx는 영구, 특히 550/553/554는 대상 무효.
func classifySMTP(err error) error {
	if err == nil {
		return nil
	}
	// net/smtp는 *textproto.Error를 반환 — 메시지 선두 3자리 코드로 분류
	code := smtpCode(err.Error())
	switch {
	case code >= 500 && code < 600:
		if code == 550 || code == 551 || code == 553 || code == 554 {
			return NewSendError(FailureInvalidTarget, "SMTP %d: %v", code, err)
		}
		return NewSendError(FailurePermanentContent, "SMTP %d: %v", code, err)
	case code >= 400 && code < 500:
		return NewSendError(FailureRetryable, "SMTP %d: %v", code, err)
	default:
		return NewSendError(FailureRetryable, "SMTP: %v", err)
	}
}

// smtpCode — textproto.Error 메시지 선두 3자리 코드 추출(없으면 0).
func smtpCode(msg string) int {
	msg = strings.TrimSpace(msg)
	if len(msg) < 3 {
		return 0
	}
	var code int
	if _, err := fmt.Sscanf(msg[:3], "%d", &code); err != nil {
		return 0
	}
	return code
}
