package channel

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
)

// PushPlugin — FCM(android) + APNs(ios) 통합 Push 채널 (MVP 유일 실채널).
type PushPlugin struct {
	fcm  *fcmClient
	apns *apnsClient
}

func NewPushPlugin(clk clock.Clock) *PushPlugin {
	httpClient := &http.Client{Timeout: 10 * time.Second}
	return &PushPlugin{
		fcm:  newFCMClient(httpClient),
		apns: newAPNSClient(httpClient, clk),
	}
}

func (p *PushPlugin) Kind() ChannelKind                    { return KindPush }
func (p *PushPlugin) TargetType() TargetType               { return TargetDeviceToken }
func (p *PushPlugin) ClassifyError(err error) FailureClass { return Classify(err) }

// ValidateCredentials — C-1: 무효 크리덴셜은 구체 사유와 함께 거부.
//   - FCM: OAuth 토큰 발급 + validate_only dry-run.
//   - APNs: JWT 생성 + 무효 토큰 발송 (PRD-04 3장).
//
// dry-run 오류를 그대로 반환한다 — 판정(무효 토큰 오류 = 인증 성공의 증거,
// 네트워크 오류 = 재시도)은 호출자(Verifier)의 몫.
func (p *PushPlugin) ValidateCredentials(ctx context.Context, creds Credentials) error {
	switch creds.Kind {
	case "push_fcm":
		var c fcmCredential
		if err := json.Unmarshal(creds.JSON, &c); err != nil {
			return NewSendError(FailureCredentialAuth, "FCM 크리덴셜 JSON 파싱 실패: %v", err)
		}
		_, err := p.fcm.send(ctx, c.ServiceAccount, "nudgeon-credential-validation", &PushContent{Title: "t", Body: "b"}, true)
		return err

	case "push_apns":
		var c apnsCredential
		if err := json.Unmarshal(creds.JSON, &c); err != nil {
			return NewSendError(FailureCredentialAuth, "APNs 크리덴셜 JSON 파싱 실패: %v", err)
		}
		_, err := p.apns.send(ctx, &c, "0000000000000000000000000000000000000000000000000000000000000000", &PushContent{Title: "t", Body: "b"})
		return err

	default:
		return NewSendError(FailureCredentialAuth, "알 수 없는 크리덴셜 종류: %s", creds.Kind)
	}
}

func (p *PushPlugin) Send(ctx context.Context, req SendRequest) (SendResult, error) {
	if req.Content.Push == nil {
		return SendResult{}, NewSendError(FailurePermanentContent, "push 콘텐츠 블록 없음")
	}
	switch req.Target.Platform {
	case "android":
		var c fcmCredential
		if err := json.Unmarshal(req.Credentials.JSON, &c); err != nil {
			return SendResult{}, NewSendError(FailureCredentialAuth, "FCM 크리덴셜 파싱: %v", err)
		}
		id, err := p.fcm.send(ctx, c.ServiceAccount, req.Target.Token, req.Content.Push, false)
		return SendResult{ProviderID: id}, err

	case "ios":
		var c apnsCredential
		if err := json.Unmarshal(req.Credentials.JSON, &c); err != nil {
			return SendResult{}, NewSendError(FailureCredentialAuth, "APNs 크리덴셜 파싱: %v", err)
		}
		id, err := p.apns.send(ctx, &c, req.Target.Token, req.Content.Push)
		return SendResult{ProviderID: id}, err

	default:
		return SendResult{}, NewSendError(FailurePermanentContent, "알 수 없는 플랫폼: %s", req.Target.Platform)
	}
}

// HandleCallback — Push는 동기 응답 채널 (no-op). 알림톡(v1.5)이 실사용.
func (p *PushPlugin) HandleCallback(_ context.Context, _ []byte) ([]DeliveryUpdate, error) {
	return nil, nil
}
