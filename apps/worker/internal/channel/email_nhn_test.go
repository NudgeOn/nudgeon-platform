package channel

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
)

// NHN 발송 요청 형식(URL·헤더·본문)과 성공 응답 파싱을 httptest로 검증한다(실 NHN 없이).
func TestNHNSendRequestShape(t *testing.T) {
	var gotPath, gotSecret, gotCT string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotSecret = r.Header.Get("X-Secret-Key")
		gotCT = r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		_, _ = w.Write([]byte(`{"header":{"isSuccessful":true,"resultCode":0,"resultMessage":"SUCCESS"},"body":{"data":{"requestId":"req-123"}}}`))
	}))
	defer srv.Close()

	cred, _ := json.Marshal(nhnCred{
		AppKey: "APPKEY1", SecretKey: "SECRET1",
		FromEmail: "from@nudgeon.io", FromName: "NudgeOn", BaseURL: srv.URL,
	})
	p := NewEmailPlugin(clock.Real{})
	res, err := p.Send(context.Background(), SendRequest{
		Target:      Target{Token: "to@example.com"},
		Content:     MessageContent{Email: &EmailContent{Subject: "안녕 {{name}}", HTML: "<b>hi</b>"}},
		Credentials: Credentials{Kind: credEmailNHN, JSON: cred},
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if res.ProviderID != "req-123" {
		t.Errorf("providerID=%q want req-123", res.ProviderID)
	}
	if gotPath != "/email/v2.1/appKeys/APPKEY1/sender/mail" {
		t.Errorf("path=%q", gotPath)
	}
	if gotSecret != "SECRET1" {
		t.Errorf("X-Secret-Key=%q", gotSecret)
	}
	if gotCT != "application/json;charset=UTF-8" {
		t.Errorf("content-type=%q", gotCT)
	}
	if gotBody["senderAddress"] != "from@nudgeon.io" || gotBody["title"] != "안녕 {{name}}" {
		t.Errorf("body mismatch: %v", gotBody)
	}
	rl, ok := gotBody["receiverList"].([]any)
	if !ok || len(rl) != 1 {
		t.Fatalf("receiverList: %v", gotBody["receiverList"])
	}
	r0 := rl[0].(map[string]any)
	if r0["receiveMailAddr"] != "to@example.com" || r0["receiveType"] != "MRT0" {
		t.Errorf("receiver: %v", r0)
	}
}

// 인증 실패(401) → credential_auth 분류.
func TestNHNAuthFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`unauthorized`))
	}))
	defer srv.Close()
	cred, _ := json.Marshal(nhnCred{AppKey: "A", SecretKey: "bad", FromEmail: "f@nudgeon.io", BaseURL: srv.URL})
	p := NewEmailPlugin(clock.Real{})
	_, err := p.Send(context.Background(), SendRequest{
		Target:      Target{Token: "to@example.com"},
		Content:     MessageContent{Email: &EmailContent{Subject: "s", HTML: "h"}},
		Credentials: Credentials{Kind: credEmailNHN, JSON: cred},
	})
	if Classify(err) != FailureCredentialAuth {
		t.Fatalf("class=%v want credential_auth (err=%v)", Classify(err), err)
	}
}
