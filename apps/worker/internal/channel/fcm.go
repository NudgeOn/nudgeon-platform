package channel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// FCM HTTP v1 클라이언트 (PRD-04 4.2). 크리덴셜 = 서비스 계정 JSON.
type fcmCredential struct {
	ServiceAccount json.RawMessage `json:"service_account"`
}

type fcmServiceAccount struct {
	ProjectID string `json:"project_id"`
}

const fcmScope = "https://www.googleapis.com/auth/firebase.messaging"

// fcmClient — 크리덴셜별 TokenSource 캐시 (oauth2가 토큰 자체 갱신을 관리)
type fcmClient struct {
	http *http.Client

	mu      sync.Mutex
	sources map[string]oauth2.TokenSource // key: 크리덴셜 지문(SA client_email+project)
}

func newFCMClient(httpClient *http.Client) *fcmClient {
	return &fcmClient{http: httpClient, sources: map[string]oauth2.TokenSource{}}
}

func (f *fcmClient) tokenSource(ctx context.Context, saJSON []byte) (oauth2.TokenSource, string, error) {
	var sa fcmServiceAccount
	if err := json.Unmarshal(saJSON, &sa); err != nil || sa.ProjectID == "" {
		return nil, "", NewSendError(FailureCredentialAuth, "서비스 계정 JSON에 project_id 없음")
	}
	key := string(saJSON[:min(128, len(saJSON))]) + sa.ProjectID
	f.mu.Lock()
	defer f.mu.Unlock()
	if ts, ok := f.sources[key]; ok {
		return ts, sa.ProjectID, nil
	}
	cfg, err := google.JWTConfigFromJSON(saJSON, fcmScope)
	if err != nil {
		return nil, "", NewSendError(FailureCredentialAuth, "서비스 계정 JSON 파싱 실패: %v", err)
	}
	ts := cfg.TokenSource(context.WithoutCancel(ctx))
	f.sources[key] = ts
	return ts, sa.ProjectID, nil
}

// send는 FCM v1 단건 전송. validateOnly=true면 dry-run (크리덴셜 검증용).
func (f *fcmClient) send(ctx context.Context, saJSON []byte, token string, content *PushContent, validateOnly bool) (string, error) {
	ts, projectID, err := f.tokenSource(ctx, saJSON)
	if err != nil {
		return "", err
	}
	accessToken, err := ts.Token()
	if err != nil {
		return "", NewSendError(FailureCredentialAuth, "FCM OAuth 토큰 발급 실패: %v", err)
	}

	msg := map[string]any{
		"message": map[string]any{
			"token":   token,
			"data":    fcmData(content),
			"android": map[string]any{"priority": "high"},
		},
		"validate_only": validateOnly,
	}
	body, _ := json.Marshal(msg)
	url := fmt.Sprintf("https://fcm.googleapis.com/v1/projects/%s/messages:send", projectID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken.AccessToken)
	req.Header.Set("Content-Type", "application/json")

	res, err := f.http.Do(req)
	if err != nil {
		return "", NewSendError(FailureRetryable, "FCM 요청 실패: %v", err)
	}
	defer res.Body.Close()
	resBody, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))

	if res.StatusCode == http.StatusOK {
		var ok struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(resBody, &ok)
		return ok.Name, nil
	}
	return "", classifyFCMError(res.StatusCode, resBody, parseRetryAfter(res.Header.Get("Retry-After")))
}

// fcmData는 공통 계약(R-01)의 FCM 평면 data 맵을 만든다 — Android SDK PushPayload.parse가 읽는 키.
// data-only(알림 블록 없음) → onMessageReceived가 항상 호출돼 SDK가 message_id 포착·자동 표시.
func fcmData(content *PushContent) map[string]string {
	data := map[string]string{
		"message_id": content.MessageID,
		"title":      content.Title,
		"body":       content.Body,
	}
	if content.DeepLink != "" {
		data["deep_link"] = content.DeepLink
	}
	if content.ImageURL != "" {
		data["image_url"] = content.ImageURL
	}
	if len(content.Data) > 0 {
		b, _ := json.Marshal(content.Data)
		data["data"] = string(b) // 사용자 커스텀 속성 — SDK가 data["data"]를 JSON 파싱
	}
	if content.Silent {
		data["silent"] = "1" // SDK는 표시를 생략(무음 삭제 감지 ping) — data-only라 배송 시 UNREGISTERED로 삭제 판정
	}
	return data
}

func classifyFCMError(status int, body []byte, retryAfter time.Duration) *SendError {
	var errRes struct {
		Error struct {
			Status  string `json:"status"`
			Message string `json:"message"`
			Details []struct {
				Type      string `json:"@type"`
				ErrorCode string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &errRes)
	fcmCode := ""
	for _, d := range errRes.Error.Details {
		if d.ErrorCode != "" {
			fcmCode = d.ErrorCode
		}
	}
	detail := fmt.Sprintf("HTTP %d %s %s (%s)", status, errRes.Error.Status, errRes.Error.Message, fcmCode)

	switch {
	case fcmCode == "UNREGISTERED" || status == http.StatusNotFound:
		return NewSendError(FailureInvalidTarget, "%s", detail)
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return NewSendError(FailureCredentialAuth, "%s", detail)
	case status == http.StatusTooManyRequests:
		return NewRateLimitError(retryAfter, "%s", detail)
	case status == http.StatusBadRequest:
		return NewSendError(FailurePermanentContent, "%s", detail)
	default:
		return NewSendError(FailureRetryable, "%s", detail)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
