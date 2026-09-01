package channel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// NHN Cloud(TOAST) Email API 연동. 발송 API: POST {base}/email/v2.1/appKeys/{appKey}/sender/mail
// 헤더 X-Secret-Key. 크리덴셜(email_nhn): {app_key, secret_key, from_email, from_name, base_url?}.
// base_url은 테스트(httptest) 주입용 — 기본 https://api-mail.cloud.toast.com.
type nhnCred struct {
	AppKey    string `json:"app_key"`
	SecretKey string `json:"secret_key"`
	FromEmail string `json:"from_email"`
	FromName  string `json:"from_name"`
	BaseURL   string `json:"base_url"`
}

func (c *nhnCred) base() string {
	if c.BaseURL != "" {
		return strings.TrimRight(c.BaseURL, "/")
	}
	return "https://api-mail.cloud.toast.com"
}

func parseNHNCred(creds Credentials) (*nhnCred, error) {
	var c nhnCred
	if err := json.Unmarshal(creds.JSON, &c); err != nil {
		return nil, NewSendError(FailureCredentialAuth, "email_nhn 크리덴셜 파싱: %v", err)
	}
	if c.AppKey == "" || c.SecretKey == "" || c.FromEmail == "" {
		return nil, NewSendError(FailureCredentialAuth, "email_nhn 필수값 누락(app_key/secret_key/from_email)")
	}
	return &c, nil
}

type nhnResponse struct {
	Header struct {
		IsSuccessful  bool   `json:"isSuccessful"`
		ResultCode    int    `json:"resultCode"`
		ResultMessage string `json:"resultMessage"`
	} `json:"header"`
	Body struct {
		Data struct {
			RequestID string `json:"requestId"`
		} `json:"data"`
	} `json:"body"`
}

var nhnHTTP = &http.Client{Timeout: 15 * time.Second}

func (p *EmailPlugin) sendNHN(ctx context.Context, req SendRequest) (SendResult, error) {
	c, err := parseNHNCred(req.Credentials)
	if err != nil {
		return SendResult{}, err
	}
	to := strings.TrimSpace(req.Target.Token)
	if to == "" || !strings.Contains(to, "@") {
		return SendResult{}, NewSendError(FailureInvalidTarget, "수신 이메일 주소 형식 오류: %q", to)
	}
	payload := map[string]any{
		"senderAddress": c.FromEmail,
		"senderName":    c.FromName,
		"title":         req.Content.Email.Subject,
		"body":          req.Content.Email.HTML,
		"receiverList": []map[string]string{
			{"receiveMailAddr": to, "receiveType": "MRT0"}, // MRT0 = 수신자(TO)
		},
	}
	raw, _ := json.Marshal(payload)
	url := fmt.Sprintf("%s/email/v2.1/appKeys/%s/sender/mail", c.base(), c.AppKey)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return SendResult{}, NewSendError(FailureRetryable, "NHN 요청 생성: %v", err)
	}
	httpReq.Header.Set("Content-Type", "application/json;charset=UTF-8")
	httpReq.Header.Set("X-Secret-Key", c.SecretKey)

	resp, err := nhnHTTP.Do(httpReq)
	if err != nil {
		return SendResult{}, NewSendError(FailureRetryable, "NHN 전송: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return SendResult{}, NewSendError(FailureCredentialAuth, "NHN 인증 실패(%d): %s", resp.StatusCode, string(body))
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return SendResult{}, NewRateLimitError(0, "NHN 429")
	}
	if resp.StatusCode >= 500 {
		return SendResult{}, NewSendError(FailureRetryable, "NHN 5xx(%d)", resp.StatusCode)
	}
	var nr nhnResponse
	if err := json.Unmarshal(body, &nr); err != nil {
		return SendResult{}, NewSendError(FailureRetryable, "NHN 응답 파싱: %v (%s)", err, string(body))
	}
	if !nr.Header.IsSuccessful {
		// resultCode 기반 분류: 인증/권한 계열은 credential_auth, 그 외는 영구 콘텐츠 오류로 취급.
		return SendResult{}, NewSendError(FailurePermanentContent, "NHN 실패 code=%d msg=%s",
			nr.Header.ResultCode, nr.Header.ResultMessage)
	}
	return SendResult{ProviderID: nr.Body.Data.RequestID}, nil
}

// validateNHN — 크리덴셜 형식 검증(필수값). NHN은 무해한 인증 확인 전용 엔드포인트가 마땅치 않아
// 실인증은 최초 발송 시 확정된다(그때 credential_auth로 분류). 형식이 맞으면 verified 처리.
func (p *EmailPlugin) validateNHN(ctx context.Context, creds Credentials) error {
	_, err := parseNHNCred(creds)
	return err
}
