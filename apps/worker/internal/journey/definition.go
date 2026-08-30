// Package journey — 오케스트레이션 엔진 (PRD-03, DEV-sub-03).
// 상태머신·스케줄러·outbox 릴레이. 단발 캠페인 = 1노드 blast 저니.
package journey

import "encoding/json"

// Definition — packages/journey-model과 동형 구조 (불변 버전 스냅샷의 파싱 대상).
type Definition struct {
	Entry    Entry    `json:"entry"`
	Nodes    []Node   `json:"nodes"`
	Exit     Exit     `json:"exit"`
	Settings Settings `json:"settings"`
}

type Entry struct {
	Type         string `json:"type"` // blast | trigger
	SegmentID    string `json:"segment_id,omitempty"`
	TriggerEvent string `json:"trigger_event,omitempty"`
}

type Node struct {
	Type string `json:"type"` // message | delay
	// message
	Push *PushContent `json:"push,omitempty"`
	// delay
	DurationSeconds int64 `json:"duration_seconds,omitempty"`
}

type PushContent struct {
	Title    string `json:"title"`
	Body     string `json:"body"`
	ImageURL string `json:"image_url,omitempty"`
	DeepLink string `json:"deep_link,omitempty"`
}

type Exit struct {
	ConversionEvent string `json:"conversion_event,omitempty"`
}

type Settings struct {
	Category string          `json:"category"` // marketing | transactional
	Reentry  json.RawMessage `json:"reentry,omitempty"`
}

func ParseDefinition(raw []byte) (*Definition, error) {
	var d Definition
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	return &d, nil
}
