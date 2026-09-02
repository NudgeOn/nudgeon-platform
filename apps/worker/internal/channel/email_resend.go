package channel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Resend(https://resend.com) Email API 연동. 발송: POST {base}/emails (Bearer api_key, Idempotency-Key).
// 크리덴셜(email_resend): {api_key, from_email, from_name?, webhook_secret?, base_url?}.
// webhook_secret은 API 측 콜백(svix 서명) 검증용 — 워커는 사용하지 않는다.
// base_url은 테스트(httptest) 주입용 — 기본 https://api.resend.com.
type resendCred struct {
	APIKey        string `json:"api_key"`
	FromEmail     string `json:"from_email"`
	FromName      string `json:"from_name"`
	WebhookSecret string `json:"webhook_secret"`
	BaseURL       string `json:"base_url"`
}

const resendDefaultBase = "https://api.resend.com"

func (c *resendCred) base() string {
	if c.BaseURL != "" {
		return strings.TrimRight(c.BaseURL, "/")
	}
	return resendDefaultBase
}

// from — "Name <email>" 또는 email. Resend는 이 형식을 그대로 수용한다.
func (c *resendCred) from() string {
	if c.FromName != "" {
		return fmt.Sprintf("%s <%s>", c.FromName, c.FromEmail)
	}
	return c.FromEmail
}

// fromDomain — from_email의 @ 뒤 도메인(소문자). 도메인 검증(ValidateCredentials)에 사용.
func (c *resendCred) fromDomain() string {
	at := strings.LastIndex(c.FromEmail, "@")
	if at < 0 || at == len(c.FromEmail)-1 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(c.FromEmail[at+1:]))
}

func parseResendCred(creds Credentials) (*resendCred, error) {
	var c resendCred
	if err := json.Unmarshal(creds.JSON, &c); err != nil {
		return nil, NewSendError(FailureCredentialAuth, "email_resend 크리덴셜 파싱: %v", err)
	}
	if c.APIKey == "" || c.FromEmail == "" {
		return nil, NewSendError(FailureCredentialAuth, "email_resend 필수값 누락(api_key/from_email)")
	}
	return &c, nil
}

// resendError — Resend 오류 응답 {"statusCode":422,"name":"validation_error","message":"..."}.
type resendError struct {
	StatusCode int    `json:"statusCode"`
	Name       string `json:"name"`
	Message    string `json:"message"`
}

func parseResendError(body []byte) resendError {
	var e resendError
	_ = json.Unmarshal(body, &e)
	if e.Message == "" {
		e.Message = strings.TrimSpace(string(body))
	}
	return e
}

var resendHTTP = &http.Client{Timeout: 15 * time.Second}

// resendRecipientErr — 400/422 메시지가 수신자(to) 문제를 가리키는지. `to`는 단어 경계로만 매치
// (token/into 등 오탐 방지), recipient/email address는 부분 문자열.
var resendRecipientErr = regexp.MustCompile(`(?i)(\bto\b|recipient|email address)`)

// resendAuthErr — 키·권한 문제를 가리키는 메시지. Resend는 잘못된 API 키에 401이 아니라
// 400 {"name":"validation_error","message":"API key is invalid"}를 반환하므로 상태코드만으로는
// 인증 실패를 구분할 수 없다. 이를 permanent_content로 두면 검증기(judge)가 "인증은 통과"로 읽어
// 잘못된 키를 verified로 표시하고, 발송에서도 크리덴셜 정지 경로를 타지 않는다.
var resendAuthErr = regexp.MustCompile(`(?i)(api[ _-]?key|unauthor|forbidden|restricted|permission)`)

func (p *EmailPlugin) sendResend(ctx context.Context, req SendRequest) (SendResult, error) {
	c, err := parseResendCred(req.Credentials)
	if err != nil {
		return SendResult{}, err
	}
	to := strings.TrimSpace(req.Target.Token)
	if to == "" || !strings.Contains(to, "@") {
		return SendResult{}, NewSendError(FailureInvalidTarget, "수신 이메일 주소 형식 오류: %q", to)
	}
	e := req.Content.Email
	payload := map[string]any{
		"from":    c.from(),
		"to":      []string{to},
		"subject": e.Subject,
		"html":    e.HTML,
	}
	if e.MessageID != "" {
		// message_id를 헤더·태그로 실어 웹훅(email.delivered/opened/clicked …)에서 message_lifecycle 조인.
		payload["headers"] = map[string]string{"X-Onda-Message-Id": e.MessageID}
		payload["tags"] = []map[string]string{{"name": "onda_message_id", "value": e.MessageID}}
	}
	raw, _ := json.Marshal(payload)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base()+"/emails", bytes.NewReader(raw))
	if err != nil {
		return SendResult{}, NewSendError(FailureRetryable, "Resend 요청 생성: %v", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+c.APIKey)
	httpReq.Header.Set("Content-Type", "application/json")
	if e.MessageID != "" {
		httpReq.Header.Set("Idempotency-Key", e.MessageID) // 공급자 측 중복 발송 차단(at-least-once 재시도 보강)
	}

	resp, err := resendHTTP.Do(httpReq)
	if err != nil {
		return SendResult{}, NewSendError(FailureRetryable, "Resend 전송: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated {
		var ok struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(body, &ok); err != nil {
			return SendResult{}, NewSendError(FailureRetryable, "Resend 응답 파싱: %v (%s)", err, string(body))
		}
		return SendResult{ProviderID: ok.ID}, nil
	}
	return SendResult{}, classifyResend(resp, body)
}

// classifyResend — Resend HTTP 오류 → 실패 분류.
//
//	401/403           → credential_auth
//	429               → rate_limited (Retry-After 반영)
//	400/422           → 메시지가 수신자(to/recipient/email address) 언급 시 invalid_target, 그 외 permanent_content
//	그 외 4xx         → permanent_content
//	5xx               → retryable
func classifyResend(resp *http.Response, body []byte) error {
	code := resp.StatusCode
	re := parseResendError(body)
	switch {
	case code == http.StatusUnauthorized || code == http.StatusForbidden:
		return NewSendError(FailureCredentialAuth, "Resend 인증 실패(%d): %s", code, re.Message)
	case code == http.StatusTooManyRequests:
		return NewRateLimitError(parseRetryAfter(resp.Header.Get("Retry-After")), "Resend 429: %s", re.Message)
	case code >= 400 && code < 500 && resendAuthErr.MatchString(re.Message):
		return NewSendError(FailureCredentialAuth, "Resend 인증 실패(%d) %s: %s", code, re.Name, re.Message)
	case code == http.StatusBadRequest || code == http.StatusUnprocessableEntity:
		if resendRecipientErr.MatchString(re.Message) {
			return NewSendError(FailureInvalidTarget, "Resend %d %s: %s", code, re.Name, re.Message)
		}
		return NewSendError(FailurePermanentContent, "Resend %d %s: %s", code, re.Name, re.Message)
	case code >= 500:
		return NewSendError(FailureRetryable, "Resend 5xx(%d): %s", code, re.Message)
	default:
		return NewSendError(FailurePermanentContent, "Resend %d %s: %s", code, re.Name, re.Message)
	}
}

// validateResend — GET {base}/domains로 API 키 실검증 + from_email 도메인이 verified인지 확인(C-1).
func (p *EmailPlugin) validateResend(ctx context.Context, creds Credentials) error {
	c, err := parseResendCred(creds)
	if err != nil {
		return err
	}
	domain := c.fromDomain()
	if domain == "" {
		return NewSendError(FailureCredentialAuth, "from_email 형식 오류: %q", c.FromEmail)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base()+"/domains", nil)
	if err != nil {
		return NewSendError(FailureRetryable, "Resend 요청 생성: %v", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+c.APIKey)
	resp, err := resendHTTP.Do(httpReq)
	if err != nil {
		return NewSendError(FailureRetryable, "Resend 도메인 조회: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return classifyResend(resp, body)
	}
	var list struct {
		Data []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return NewSendError(FailureRetryable, "Resend 도메인 응답 파싱: %v", err)
	}
	for _, d := range list.Data {
		if strings.ToLower(strings.TrimSpace(d.Name)) != domain {
			continue
		}
		if strings.EqualFold(d.Status, "verified") {
			return nil
		}
		return NewSendError(FailureCredentialAuth, "발신 도메인 미인증(status=%s): %s", d.Status, domain)
	}
	return NewSendError(FailureCredentialAuth, "발신 도메인이 Resend에 등록되지 않음: %s", domain)
}
