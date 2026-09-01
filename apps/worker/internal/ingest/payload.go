package ingest

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// IngestBatchPayload — packages/queue-schemas/schemas/ingest.batch.schema.json의 Go 표현.
type IngestBatchPayload struct {
	Endpoint   string             `json:"endpoint"`
	RequestID  string             `json:"request_id"`
	APIKeyID   string             `json:"api_key_id,omitempty"`
	Device     *DeviceInfo        `json:"device,omitempty"`
	Events     []TrackEvent       `json:"events,omitempty"`
	Identify   *IdentifyPayload   `json:"identify,omitempty"`
	Attributes []AttrUpdate       `json:"attributes,omitempty"`
	Token      *TokenPayload      `json:"token,omitempty"`
	UserDelete *UserDeletePayload `json:"user_delete,omitempty"`
	// R-03: SDK 수신 동의 변경·로그아웃(토큰 소유권 해제)의 서버 동기화.
	Subscription *SubscriptionPayload `json:"subscription,omitempty"`
	Logout       *LogoutPayload       `json:"logout,omitempty"`
}

// SubscriptionPayload — 수신 동의 변경(setPushOptIn) 서버 반영. state: opted_in|unsubscribed.
type SubscriptionPayload struct {
	AnonID     *string `json:"anon_id"`
	ExternalID *string `json:"external_id"`
	Channel    string  `json:"channel"` // push (v1.5+ 알림톡·SMS)
	State      string  `json:"state"`   // opted_in | unsubscribed
}

// LogoutPayload — 로그아웃/reset 시 디바이스 토큰 분리(이후 이전 사용자 대상 발송 차단).
type LogoutPayload struct {
	DeviceID string `json:"device_id"`
}

type IdentifyPayload struct {
	ExternalID string         `json:"external_id"`
	AnonID     *string        `json:"anon_id"`
	Attributes map[string]any `json:"attributes,omitempty"`
}

type AttrUpdate struct {
	ExternalID string         `json:"external_id"`
	Attributes map[string]any `json:"attributes"`
}

type TokenPayload struct {
	PushToken    string  `json:"push_token"`
	OSPermission string  `json:"os_permission,omitempty"`
	AnonID       *string `json:"anon_id"`
	ExternalID   *string `json:"external_id"`
}

type UserDeletePayload struct {
	ExternalID string `json:"external_id"`
}

type DeviceInfo struct {
	DeviceID   string `json:"device_id"`
	Platform   string `json:"platform"`
	AppVersion string `json:"app_version,omitempty"`
	OSVersion  string `json:"os_version,omitempty"`
	Model      string `json:"model,omitempty"`
	Locale     string `json:"locale,omitempty"`
}

type TrackEvent struct {
	InsertID   string          `json:"insert_id"`
	UserID     string          `json:"user_id,omitempty"`
	ReceiptSeq string          `json:"receipt_seq,omitempty"`
	ReceivedAt time.Time       `json:"received_at,omitempty"`
	AnonID     *string         `json:"anon_id"`
	ExternalID *string         `json:"external_id"`
	Event      string          `json:"event"`
	Properties json.RawMessage `json:"properties"`
	ClientTS   time.Time       `json:"client_ts"`
	ServerTS   time.Time       `json:"server_ts"`
}

// ParsePayload는 envelope payload를 파싱·기본 검증한다.
func ParsePayload(raw json.RawMessage) (*IngestBatchPayload, error) {
	var p IngestBatchPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("ingest payload 파싱: %w", err)
	}
	if p.Endpoint == "" || p.RequestID == "" {
		return nil, fmt.Errorf("ingest payload: endpoint/request_id 누락")
	}
	for i := range p.Events {
		e := &p.Events[i]
		e.InsertID = strings.ToLower(e.InsertID)
		if e.InsertID == "" || e.Event == "" {
			return nil, fmt.Errorf("ingest payload: events[%d] insert_id/event 누락", i)
		}
		if e.AnonID == nil && e.ExternalID == nil && e.UserID == "" {
			return nil, fmt.Errorf("ingest payload: events[%d] 식별자 누락", i)
		}
		if e.UserID != "" && (e.ReceiptSeq == "" || e.ReceivedAt.IsZero()) {
			return nil, fmt.Errorf("ingest payload: events[%d] durable receipt 누락", i)
		}
		if e.ReceiptSeq != "" {
			seq, err := strconv.ParseInt(e.ReceiptSeq, 10, 64)
			if err != nil || seq <= 0 || e.UserID == "" || e.ReceivedAt.IsZero() {
				return nil, fmt.Errorf("ingest payload: events[%d] receipt 순서/식별자 오류", i)
			}
		}
	}
	switch p.Endpoint {
	case "identify":
		if p.Identify == nil || p.Identify.ExternalID == "" {
			return nil, fmt.Errorf("identify payload: external_id 누락")
		}
	case "attributes":
		if len(p.Attributes) == 0 {
			return nil, fmt.Errorf("attributes payload: updates 누락")
		}
	case "devices_token":
		if p.Token == nil || p.Token.PushToken == "" || p.Device == nil {
			return nil, fmt.Errorf("devices_token payload: token/device 누락")
		}
		if p.Token.AnonID == nil && p.Token.ExternalID == nil {
			return nil, fmt.Errorf("devices_token payload: 식별자 누락")
		}
	case "user_delete":
		if p.UserDelete == nil || p.UserDelete.ExternalID == "" {
			return nil, fmt.Errorf("user_delete payload: external_id 누락")
		}
	}
	return &p, nil
}
