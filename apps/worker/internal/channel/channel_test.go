package channel

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
)

// --- 봉투 복호화: TS(apps/api/src/crypto/envelope.ts)와 레이아웃 호환 검증 ---

func TestDecryptEnvelopeRoundtripWithGoSeal(t *testing.T) {
	// Go로 seal → Go로 open (레이아웃 자체 검증. TS 교차 호환은 E2E에서 확인)
	master := make([]byte, 32)
	dek := make([]byte, 32)
	if _, err := rand.Read(master); err != nil {
		t.Fatal(err)
	}
	if _, err := rand.Read(dek); err != nil {
		t.Fatal(err)
	}
	plaintext := []byte(`{"key_id":"ABC123"}`)

	ciphertext := sealForTest(t, dek, plaintext)
	dekWrapped := sealForTest(t, master, dek)

	got, err := DecryptEnvelope(master, ciphertext, dekWrapped)
	if err != nil {
		t.Fatalf("DecryptEnvelope: %v", err)
	}
	if string(got) != string(plaintext) {
		t.Errorf("왕복 불일치: %s", got)
	}

	// 잘못된 마스터키 → 실패
	wrong := make([]byte, 32)
	if _, err := DecryptEnvelope(wrong, ciphertext, dekWrapped); err == nil {
		t.Error("잘못된 마스터키로 복호화 성공 — 실패 기대")
	}
}

// sealForTest — crypto.go openSealed의 역연산 (nonce||ct||tag). TS seal과 동일 레이아웃.
func sealForTest(t *testing.T, key, plain []byte) []byte {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	return gcm.Seal(nonce, nonce, plain, nil)
}

// --- APNs ES256 JWT ---

func TestSignES256(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	token, err := signES256(key, "KEY123", "TEAM456", now)
	if err != nil {
		t.Fatalf("signES256: %v", err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT 3파트 기대: %d", len(parts))
	}
	headerJSON, _ := base64.RawURLEncoding.DecodeString(parts[0])
	var header map[string]string
	_ = json.Unmarshal(headerJSON, &header)
	if header["alg"] != "ES256" || header["kid"] != "KEY123" {
		t.Errorf("헤더 불일치: %v", header)
	}
	claimsJSON, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var claims map[string]any
	_ = json.Unmarshal(claimsJSON, &claims)
	if claims["iss"] != "TEAM456" || int64(claims["iat"].(float64)) != now.Unix() {
		t.Errorf("클레임 불일치: %v", claims)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	if len(sig) != 64 {
		t.Errorf("JOSE 서명 64바이트 기대: %d", len(sig))
	}
}

func TestAPNSJWTCache(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	p8 := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	cred := &apnsCredential{P8: p8, KeyID: "K", TeamID: "T", BundleID: "io.nudgeon.demo"}

	clk := &clock.Fake{Current: time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)}
	client := newAPNSClient(&http.Client{}, clk)

	t1, err := client.jwt(cred)
	if err != nil {
		t.Fatalf("jwt: %v", err)
	}
	t2, _ := client.jwt(cred)
	if t1 != t2 {
		t.Error("50분 내 재호출은 캐시 토큰이어야 함")
	}
	clk.Advance(51 * time.Minute)
	t3, _ := client.jwt(cred)
	if t1 == t3 {
		t.Error("50분 경과 후에는 새 토큰이어야 함")
	}
}

// --- 오류 분류 (C-4의 단위 수준) ---

func TestClassifyFCMError(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   FailureClass
	}{
		{404, `{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`, FailureInvalidTarget},
		{400, `{"error":{"status":"INVALID_ARGUMENT"}}`, FailurePermanentContent},
		{401, `{}`, FailureCredentialAuth},
		{403, `{}`, FailureCredentialAuth},
		{429, `{}`, FailureRateLimited},
		{500, `{}`, FailureRetryable},
		{503, `{}`, FailureRetryable},
	}
	for _, c := range cases {
		if got := classifyFCMError(c.status, []byte(c.body), 0).Class; got != c.want {
			t.Errorf("FCM %d: %v 기대, %v", c.status, c.want, got)
		}
	}
}

func TestClassifyAPNSError(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   FailureClass
	}{
		{400, `{"reason":"BadDeviceToken"}`, FailureInvalidTarget},
		{410, `{"reason":"Unregistered"}`, FailureInvalidTarget},
		{403, `{"reason":"InvalidProviderToken"}`, FailureCredentialAuth},
		{429, `{"reason":"TooManyRequests"}`, FailureRateLimited},
		{400, `{"reason":"PayloadTooLarge"}`, FailurePermanentContent},
		{500, `{"reason":"InternalServerError"}`, FailureRetryable},
	}
	for _, c := range cases {
		if got := classifyAPNSError(c.status, []byte(c.body), 0).Class; got != c.want {
			t.Errorf("APNs %d %s: %v 기대, %v", c.status, c.body, c.want, got)
		}
	}
}
