package channel

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/ondahq/onda/apps/worker/internal/clock"
)

// APNs HTTP/2 클라이언트 (PRD-04 4.2). 크리덴셜 = p8 + Key ID + Team ID + Bundle ID.
// JWT는 50분 캐시 (Apple 권장 20~60분).
type apnsCredential struct {
	P8          string `json:"p8"`
	KeyID       string `json:"key_id"`
	TeamID      string `json:"team_id"`
	BundleID    string `json:"bundle_id"`
	Environment string `json:"environment"` // production | sandbox
}

const apnsJWTTTL = 50 * time.Minute

type apnsJWTEntry struct {
	token    string
	issuedAt time.Time
}

type apnsClient struct {
	http *http.Client // Go 기본 Transport가 ALPN으로 HTTP/2 협상
	clk  clock.Clock

	mu   sync.Mutex
	jwts map[string]apnsJWTEntry // key: team+keyID
}

func newAPNSClient(httpClient *http.Client, clk clock.Clock) *apnsClient {
	return &apnsClient{http: httpClient, clk: clk, jwts: map[string]apnsJWTEntry{}}
}

func (a *apnsClient) host(cred *apnsCredential) string {
	if cred.Environment == "sandbox" {
		return "https://api.sandbox.push.apple.com"
	}
	return "https://api.push.apple.com"
}

// jwt는 ES256 provider token을 만들거나 캐시에서 꺼낸다.
func (a *apnsClient) jwt(cred *apnsCredential) (string, error) {
	cacheKey := cred.TeamID + "/" + cred.KeyID
	now := a.clk.Now()

	a.mu.Lock()
	entry, ok := a.jwts[cacheKey]
	a.mu.Unlock()
	if ok && now.Sub(entry.issuedAt) < apnsJWTTTL {
		return entry.token, nil
	}

	block, _ := pem.Decode([]byte(cred.P8))
	if block == nil {
		return "", NewSendError(FailureCredentialAuth, "p8 PEM 디코드 실패")
	}
	keyAny, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return "", NewSendError(FailureCredentialAuth, "p8 키 파싱 실패: %v", err)
	}
	ecKey, ok2 := keyAny.(*ecdsa.PrivateKey)
	if !ok2 {
		return "", NewSendError(FailureCredentialAuth, "p8이 ECDSA 키가 아님")
	}

	token, err := signES256(ecKey, cred.KeyID, cred.TeamID, now)
	if err != nil {
		return "", NewSendError(FailureCredentialAuth, "JWT 서명 실패: %v", err)
	}
	a.mu.Lock()
	a.jwts[cacheKey] = apnsJWTEntry{token: token, issuedAt: now}
	a.mu.Unlock()
	return token, nil
}

// signES256 — APNs provider token: header {alg:ES256, kid}, claims {iss, iat}
func signES256(key *ecdsa.PrivateKey, keyID, teamID string, now time.Time) (string, error) {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	signing := enc(map[string]string{"alg": "ES256", "kid": keyID}) + "." +
		enc(map[string]any{"iss": teamID, "iat": now.Unix()})

	digest := sha256.Sum256([]byte(signing))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		return "", err
	}
	// JOSE 포맷: r||s 각 32바이트 고정 길이
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// send는 APNs 단건 전송. 반환: apns-id.
// apnsPayload는 공통 계약(R-01)의 APNs payload를 만든다 — iOS는 userInfo["onda"]["message_id"]를 읽는다.
// aps.mutable-content=1로 NSE 실행(도달 수신·리치 콘텐츠). 사용자 커스텀 data는 최상위(userInfo) 유지.
func apnsPayload(content *PushContent) map[string]any {
	onda := map[string]any{"message_id": content.MessageID}
	if content.DeepLink != "" {
		onda["deep_link"] = content.DeepLink
	}
	if content.ImageURL != "" {
		onda["image_url"] = content.ImageURL
	}
	if len(content.Data) > 0 {
		// iOS PushPayload.parse는 onda["data"]를 중첩 딕셔너리로 읽는다 (공통 계약 R-01).
		d := make(map[string]any, len(content.Data))
		for k, v := range content.Data {
			d[k] = v
		}
		onda["data"] = d
	}
	return map[string]any{
		"aps": map[string]any{
			"alert":           map[string]string{"title": content.Title, "body": content.Body},
			"mutable-content": 1,
		},
		"onda": onda,
	}
}

func (a *apnsClient) send(ctx context.Context, cred *apnsCredential, deviceToken string, content *PushContent) (string, error) {
	token, err := a.jwt(cred)
	if err != nil {
		return "", err
	}
	body, _ := json.Marshal(apnsPayload(content))

	url := fmt.Sprintf("%s/3/device/%s", a.host(cred), deviceToken)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("apns-topic", cred.BundleID)
	req.Header.Set("apns-push-type", "alert")

	res, err := a.http.Do(req)
	if err != nil {
		return "", NewSendError(FailureRetryable, "APNs 요청 실패: %v", err)
	}
	defer res.Body.Close()
	resBody, _ := io.ReadAll(io.LimitReader(res.Body, 8<<10))

	if res.StatusCode == http.StatusOK {
		return res.Header.Get("apns-id"), nil
	}
	return "", classifyAPNSError(res.StatusCode, resBody, parseRetryAfter(res.Header.Get("Retry-After")))
}

func classifyAPNSError(status int, body []byte, retryAfter time.Duration) *SendError {
	var errRes struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(body, &errRes)
	detail := fmt.Sprintf("HTTP %d %s", status, errRes.Reason)

	switch {
	case status == http.StatusGone, // 410 Unregistered
		errRes.Reason == "BadDeviceToken", errRes.Reason == "Unregistered",
		errRes.Reason == "DeviceTokenNotForTopic":
		return NewSendError(FailureInvalidTarget, "%s", detail)
	case errRes.Reason == "InvalidProviderToken", errRes.Reason == "ExpiredProviderToken",
		status == http.StatusForbidden:
		return NewSendError(FailureCredentialAuth, "%s", detail)
	case status == http.StatusTooManyRequests:
		return NewRateLimitError(retryAfter, "%s", detail)
	case status == http.StatusBadRequest:
		return NewSendError(FailurePermanentContent, "%s", detail)
	default:
		return NewSendError(FailureRetryable, "%s", detail)
	}
}
