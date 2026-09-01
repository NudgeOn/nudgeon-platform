// Package channel — 채널 플러그인 인터페이스 (PRD-04 2.2 확정 계약).
// v1.5의 알림톡·SMS·이메일이 엔진 수정 없이 꽂히는 지점이므로 시그니처를 함부로 바꾸지 않는다.
package channel

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type ChannelKind string

const (
	KindPush  ChannelKind = "push"  // FCM+APNs 통합 (플랫폼으로 분기)
	KindEmail ChannelKind = "email" // SMTP 이메일
)

type TargetType string

const (
	TargetDeviceToken TargetType = "device_token"
	TargetPhone       TargetType = "phone"
	TargetEmail       TargetType = "email"
)

// FailureClass — 재시도 정책의 근거 (PRD-04 4.3)
type FailureClass int

const (
	FailureNone FailureClass = iota
	FailureRetryable
	FailureRateLimited
	FailurePermanentContent
	FailureInvalidTarget
	// FailureCredentialAuth: 401/403 — 크리덴셜 error 전환 + 앱 발송 정지 트리거 (PRD-04 3장)
	FailureCredentialAuth
)

func (f FailureClass) String() string {
	switch f {
	case FailureRetryable:
		return "retryable"
	case FailureRateLimited:
		return "rate_limited"
	case FailurePermanentContent:
		return "permanent_content"
	case FailureInvalidTarget:
		return "invalid_target"
	case FailureCredentialAuth:
		return "credential_auth"
	default:
		return ""
	}
}

// Credentials — 복호화된 크리덴셜 (발송 워커 런타임에서만 존재)
type Credentials struct {
	Kind string // push_fcm | push_apns
	JSON []byte // 복호화된 payload
}

type Target struct {
	Token    string
	Platform string // ios | android
}

type PushContent struct {
	Title    string            `json:"title"`
	Body     string            `json:"body"`
	ImageURL string            `json:"image_url,omitempty"`
	DeepLink string            `json:"deep_link,omitempty"`
	Data     map[string]string `json:"data,omitempty"`
	// Silent — 무음(백그라운드) 푸시. 사용자 노출 없이 앱 삭제 감지용 ping.
	// FCM: data-only + silent=1(SDK가 표시 생략), APNs: content-available:1 + push-type=background(무음).
	Silent bool `json:"silent,omitempty"`
	// MessageID — 발송 안정 ID. 워커가 렌더 직전 설정. FCM data["message_id"] / APNs onda.message_id로 방출.
	MessageID string `json:"-"`
}

// EmailContent — 렌더 완료된 이메일 본문. {{ }} 개인화는 발송 전(API/스케줄러)에서 치환된다.
type EmailContent struct {
	Subject   string `json:"subject"`
	HTML      string `json:"html"`
	MessageID string `json:"-"`
}

type MessageContent struct {
	Push  *PushContent
	Email *EmailContent
}

type SendOptions struct {
	TTL         time.Duration
	CollapseKey string
}

type SendRequest struct {
	IdempotencyKey string
	Target         Target
	Content        MessageContent
	Credentials    Credentials
	Options        SendOptions
}

type SendResult struct {
	ProviderID string // FCM message name / APNs apns-id
}

type DeliveryUpdate struct {
	ProviderID string
	Status     string
}

// ChannelPlugin — PRD-04 2.2 인터페이스.
type ChannelPlugin interface {
	Kind() ChannelKind
	TargetType() TargetType
	// 크리덴셜 등록 시 실검증 (C-1)
	ValidateCredentials(ctx context.Context, creds Credentials) error
	// 단건 발송. idempotency 선점은 워커 계층 책임.
	Send(ctx context.Context, req SendRequest) (SendResult, error)
	// 오류 → 실패 분류 (재시도 정책 근거)
	ClassifyError(err error) FailureClass
	// 비동기 결과 수신 채널용 (Push는 no-op)
	HandleCallback(ctx context.Context, raw []byte) ([]DeliveryUpdate, error)
}

// SendError — 플러그인이 분류를 실어 반환하는 오류.
type SendError struct {
	Class  FailureClass
	Detail string
	// RetryAfter — 429 등에서 공급자가 지정한 재시도 대기 시간(0이면 미지정 → 지수 백오프).
	RetryAfter time.Duration
}

func (e *SendError) Error() string { return fmt.Sprintf("%s: %s", e.Class, e.Detail) }

func NewSendError(class FailureClass, format string, args ...any) *SendError {
	return &SendError{Class: class, Detail: fmt.Sprintf(format, args...)}
}

// NewRateLimitError — 429 전용. Retry-After를 실어 백오프에 반영한다.
func NewRateLimitError(retryAfter time.Duration, format string, args ...any) *SendError {
	return &SendError{Class: FailureRateLimited, Detail: fmt.Sprintf(format, args...), RetryAfter: retryAfter}
}

// Classify는 SendError면 그 분류를, 아니면 Retryable(네트워크 등)을 돌려준다.
func Classify(err error) FailureClass {
	if err == nil {
		return FailureNone
	}
	var se *SendError
	if errors.As(err, &se) {
		return se.Class
	}
	return FailureRetryable
}

// RetryAfterOf는 SendError의 Retry-After를 돌려준다(없으면 0).
func RetryAfterOf(err error) time.Duration {
	var se *SendError
	if errors.As(err, &se) {
		return se.RetryAfter
	}
	return 0
}

// parseRetryAfter는 HTTP Retry-After 헤더(초 또는 HTTP-date)를 Duration으로 파싱한다.
func parseRetryAfter(v string) time.Duration {
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(strings.TrimSpace(v)); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}
