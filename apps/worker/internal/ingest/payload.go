package ingest

import (
	"encoding/json"
	"fmt"
	"time"
)

// IngestBatchPayload — packages/queue-schemas/schemas/ingest.batch.schema.json의 Go 표현.
type IngestBatchPayload struct {
	Endpoint  string       `json:"endpoint"`
	RequestID string       `json:"request_id"`
	APIKeyID  string       `json:"api_key_id,omitempty"`
	Device    *DeviceInfo  `json:"device,omitempty"`
	Events    []TrackEvent `json:"events,omitempty"`
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
		if e.InsertID == "" || e.Event == "" {
			return nil, fmt.Errorf("ingest payload: events[%d] insert_id/event 누락", i)
		}
		if e.AnonID == nil && e.ExternalID == nil {
			return nil, fmt.Errorf("ingest payload: events[%d] 식별자 누락", i)
		}
	}
	return &p, nil
}
