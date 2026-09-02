package channel

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ondahq/onda/apps/worker/internal/clock"
)

func resendCredJSON(t *testing.T, base string) []byte {
	t.Helper()
	raw, err := json.Marshal(resendCred{
		APIKey: "re_test_123", FromEmail: "hello@onda.io", FromName: "Onda", BaseURL: base,
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func resendSend(t *testing.T, base string) (SendResult, error) {
	t.Helper()
	p := NewEmailPlugin(clock.Real{})
	return p.Send(context.Background(), SendRequest{
		Target: Target{Token: "to@example.com"},
		Content: MessageContent{Email: &EmailContent{
			Subject: "안녕 {{name}}", HTML: "<b>hi</b>", MessageID: "mid-42",
		}},
		Credentials: Credentials{Kind: credEmailResend, JSON: resendCredJSON(t, base)},
	})
}

// 발송 요청 형식(메서드·경로·Bearer·Idempotency-Key·본문 헤더/태그)과 성공 응답 파싱을 검증한다.
func TestResendSendRequestShape(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotIdem, gotCT string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotIdem = r.Header.Get("Idempotency-Key")
		gotCT = r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"}`))
	}))
	defer srv.Close()

	res, err := resendSend(t, srv.URL)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if res.ProviderID != "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" {
		t.Errorf("providerID=%q", res.ProviderID)
	}
	if gotMethod != http.MethodPost || gotPath != "/emails" {
		t.Errorf("method/path=%s %s", gotMethod, gotPath)
	}
	if gotAuth != "Bearer re_test_123" {
		t.Errorf("Authorization=%q", gotAuth)
	}
	if gotIdem != "mid-42" {
		t.Errorf("Idempotency-Key=%q want mid-42", gotIdem)
	}
	if gotCT != "application/json" {
		t.Errorf("content-type=%q", gotCT)
	}
	if gotBody["from"] != "Onda <hello@onda.io>" || gotBody["subject"] != "안녕 {{name}}" || gotBody["html"] != "<b>hi</b>" {
		t.Errorf("body mismatch: %v", gotBody)
	}
	to, _ := gotBody["to"].([]any)
	if len(to) != 1 || to[0] != "to@example.com" {
		t.Errorf("to=%v", gotBody["to"])
	}
	hdrs, _ := gotBody["headers"].(map[string]any)
	if hdrs["X-Onda-Message-Id"] != "mid-42" {
		t.Errorf("headers=%v", gotBody["headers"])
	}
	tags, _ := gotBody["tags"].([]any)
	if len(tags) != 1 {
		t.Fatalf("tags=%v", gotBody["tags"])
	}
	tag0 := tags[0].(map[string]any)
	if tag0["name"] != "onda_message_id" || tag0["value"] != "mid-42" {
		t.Errorf("tag=%v", tag0)
	}
}

// from_name 없으면 from은 이메일만.
func TestResendFromWithoutName(t *testing.T) {
	c := &resendCred{FromEmail: "a@b.io"}
	if c.from() != "a@b.io" {
		t.Errorf("from=%q", c.from())
	}
	if c.fromDomain() != "b.io" {
		t.Errorf("domain=%q", c.fromDomain())
	}
}

// 필수값 누락 → credential_auth.
func TestResendCredMissing(t *testing.T) {
	_, err := parseResendCred(Credentials{Kind: credEmailResend, JSON: []byte(`{"from_email":"a@b.io"}`)})
	if Classify(err) != FailureCredentialAuth {
		t.Fatalf("class=%v (err=%v)", Classify(err), err)
	}
	_, err = parseResendCred(Credentials{Kind: credEmailResend, JSON: []byte(`{"api_key":"re_x"}`)})
	if Classify(err) != FailureCredentialAuth {
		t.Fatalf("class=%v (err=%v)", Classify(err), err)
	}
}

// HTTP 상태·본문 → 실패 분류 표.
func TestResendErrorClassification(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		body       string
		retryAfter string
		want       FailureClass
		wantRetry  time.Duration
	}{
		{"401", http.StatusUnauthorized, `{"statusCode":401,"name":"missing_api_key","message":"Missing API key"}`, "", FailureCredentialAuth, 0},
		{"403", http.StatusForbidden, `{"statusCode":403,"name":"restricted_api_key","message":"restricted"}`, "", FailureCredentialAuth, 0},
		{"429 retry-after", http.StatusTooManyRequests, `{"statusCode":429,"name":"rate_limit_exceeded","message":"Too many requests"}`, "7", FailureRateLimited, 7 * time.Second},
		{"429 no header", http.StatusTooManyRequests, `{}`, "", FailureRateLimited, 0},
		{"422 recipient(to)", http.StatusUnprocessableEntity, "{\"statusCode\":422,\"name\":\"validation_error\",\"message\":\"Invalid `to` field. The email address needs to follow the email@example.com format.\"}", "", FailureInvalidTarget, 0},
		{"422 recipient word", http.StatusUnprocessableEntity, `{"statusCode":422,"name":"validation_error","message":"Recipient is not allowed"}`, "", FailureInvalidTarget, 0},
		{"422 other", http.StatusUnprocessableEntity, `{"statusCode":422,"name":"validation_error","message":"The from domain is not verified"}`, "", FailurePermanentContent, 0},
		{"400 other (token 오탐 없음)", http.StatusBadRequest, `{"statusCode":400,"name":"validation_error","message":"Missing subject token into html"}`, "", FailurePermanentContent, 0},
		{"500", http.StatusInternalServerError, `{"statusCode":500,"name":"internal_server_error","message":"boom"}`, "", FailureRetryable, 0},
		{"503 non-json", http.StatusServiceUnavailable, `upstream unavailable`, "", FailureRetryable, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.retryAfter != "" {
					w.Header().Set("Retry-After", tc.retryAfter)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			_, err := resendSend(t, srv.URL)
			if err == nil {
				t.Fatal("오류 기대")
			}
			if got := Classify(err); got != tc.want {
				t.Fatalf("class=%v want %v (err=%v)", got, tc.want, err)
			}
			if got := RetryAfterOf(err); got != tc.wantRetry {
				t.Fatalf("retryAfter=%v want %v", got, tc.wantRetry)
			}
		})
	}
}

// 전송 계층 오류(연결 불가) → retryable.
func TestResendTransportError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	base := srv.URL
	srv.Close() // 즉시 닫아 연결 거부 유도
	_, err := resendSend(t, base)
	if Classify(err) != FailureRetryable {
		t.Fatalf("class=%v (err=%v)", Classify(err), err)
	}
}

// 수신 주소 형식 오류는 요청 전에 invalid_target.
func TestResendInvalidRecipientLocal(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer srv.Close()
	p := NewEmailPlugin(clock.Real{})
	_, err := p.Send(context.Background(), SendRequest{
		Target:      Target{Token: "not-an-email"},
		Content:     MessageContent{Email: &EmailContent{Subject: "s", HTML: "h"}},
		Credentials: Credentials{Kind: credEmailResend, JSON: resendCredJSON(t, srv.URL)},
	})
	if Classify(err) != FailureInvalidTarget || called {
		t.Fatalf("class=%v called=%v", Classify(err), called)
	}
}

// ValidateCredentials — GET /domains 기반 도메인 검증.
func TestResendValidateDomains(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		wantOK bool
		want   FailureClass
	}{
		{"verified", 200, `{"data":[{"id":"d1","name":"onda.io","status":"verified"},{"id":"d2","name":"x.io","status":"pending"}]}`, true, FailureNone},
		{"verified case-insensitive", 200, `{"data":[{"name":"ONDA.io","status":"verified"}]}`, true, FailureNone},
		{"unverified", 200, `{"data":[{"name":"onda.io","status":"pending"}]}`, false, FailureCredentialAuth},
		{"missing", 200, `{"data":[{"name":"other.io","status":"verified"}]}`, false, FailureCredentialAuth},
		{"401", 401, `{"statusCode":401,"name":"missing_api_key","message":"Missing API key"}`, false, FailureCredentialAuth},
		{"500", 500, `oops`, false, FailureRetryable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotMethod, gotPath, gotAuth string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod, gotPath, gotAuth = r.Method, r.URL.Path, r.Header.Get("Authorization")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			p := NewEmailPlugin(clock.Real{})
			err := p.ValidateCredentials(context.Background(), Credentials{Kind: credEmailResend, JSON: resendCredJSON(t, srv.URL)})
			if gotMethod != http.MethodGet || gotPath != "/domains" || gotAuth != "Bearer re_test_123" {
				t.Errorf("request=%s %s auth=%q", gotMethod, gotPath, gotAuth)
			}
			if tc.wantOK {
				if err != nil {
					t.Fatalf("검증 성공 기대, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("검증 실패 기대")
			}
			if got := Classify(err); got != tc.want {
				t.Fatalf("class=%v want %v (err=%v)", got, tc.want, err)
			}
		})
	}
}
