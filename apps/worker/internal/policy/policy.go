// Package policy — 발송 정책 판정 (PRD-03 6장). quiet hours·frequency cap·카테고리.
// 오케스트레이션(스케줄러)과 fan-out이 동일 판정을 쓰도록 이 패키지가 단일 출처다 (IT-7).
// 카테고리 transactional은 opt-out·quiet hours·frequency cap을 모두 우회한다 (PRD-03 6.3).
package policy

import (
	"encoding/json"
	"fmt"
	"time"
)

type Category string

const (
	Marketing     Category = "marketing"
	Transactional Category = "transactional"
)

// QuietHours 설정 (앱 timezone 기준).
type QuietHours struct {
	Enabled bool   `json:"enabled"`
	Start   string `json:"start"`  // "HH:MM"
	End     string `json:"end"`    // "HH:MM"
	Policy  string `json:"policy"` // delay_until_open | skip
}

type FrequencyCap struct {
	Enabled   bool `json:"enabled"`
	MaxPer24h int  `json:"max_per_24h"`
}

// Action — quiet hours 판정 결과
type Action int

const (
	ActionSend  Action = iota // 발송 진행
	ActionSkip                 // 발송 생략 (사유 로그)
	ActionDelay                // 다음 허용 시각까지 대기
)

// QuietDecision — quiet hours 판정
type QuietDecision struct {
	Action    Action
	DelayUntil time.Time // ActionDelay일 때 다음 발송 허용 시각 (UTC)
}

// EvaluateQuietHours는 카테고리·앱 설정·현재 시각으로 quiet hours를 판정한다.
//   - transactional: 항상 Send (규제 예외 — PRD-03 6.3)
//   - 비활성: 항상 Send
//   - 조용시간 내: policy에 따라 Delay(다음 open까지) 또는 Skip
func EvaluateQuietHours(cat Category, qh QuietHours, tz *time.Location, now time.Time) (QuietDecision, error) {
	if cat == Transactional || !qh.Enabled {
		return QuietDecision{Action: ActionSend}, nil
	}
	startMin, err := parseHHMM(qh.Start)
	if err != nil {
		return QuietDecision{}, fmt.Errorf("quiet start: %w", err)
	}
	endMin, err := parseHHMM(qh.End)
	if err != nil {
		return QuietDecision{}, fmt.Errorf("quiet end: %w", err)
	}

	local := now.In(tz)
	nowMin := local.Hour()*60 + local.Minute()

	if !inQuietWindow(nowMin, startMin, endMin) {
		return QuietDecision{Action: ActionSend}, nil
	}
	if qh.Policy == "skip" {
		return QuietDecision{Action: ActionSkip}, nil
	}
	// delay_until_open: 오늘/내일의 end 시각(로컬)을 UTC로
	openAt := nextOpen(local, endMin, tz)
	return QuietDecision{Action: ActionDelay, DelayUntil: openAt.UTC()}, nil
}

// inQuietWindow는 [start, end) 조용시간 창에 nowMin이 드는지 판정한다.
// 야간창(21:00~08:00)처럼 자정을 넘는 경우(start>end)를 처리한다.
func inQuietWindow(nowMin, startMin, endMin int) bool {
	if startMin == endMin {
		return false // 빈 창
	}
	if startMin < endMin {
		// 같은 날 안의 창 (예: 01:00~06:00)
		return nowMin >= startMin && nowMin < endMin
	}
	// 자정을 넘는 창 (예: 21:00~08:00): [start,24:00) ∪ [00:00,end)
	return nowMin >= startMin || nowMin < endMin
}

// nextOpen은 조용시간 종료(발송 허용) 시각을 로컬 기준으로 계산한다.
func nextOpen(local time.Time, endMin int, tz *time.Location) time.Time {
	endHour, endM := endMin/60, endMin%60
	candidate := time.Date(local.Year(), local.Month(), local.Day(), endHour, endM, 0, 0, tz)
	if !candidate.After(local) {
		candidate = candidate.AddDate(0, 0, 1)
	}
	return candidate
}

func parseHHMM(s string) (int, error) {
	var h, m int
	if _, err := fmt.Sscanf(s, "%d:%d", &h, &m); err != nil {
		return 0, err
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, fmt.Errorf("범위 밖 시각: %s", s)
	}
	return h*60 + m, nil
}

// ParseQuietHours / ParseFrequencyCap — jsonb 컬럼 파싱 헬퍼
func ParseQuietHours(raw []byte) (QuietHours, error) {
	var qh QuietHours
	err := json.Unmarshal(raw, &qh)
	return qh, err
}

func ParseFrequencyCap(raw []byte) (FrequencyCap, error) {
	var fc FrequencyCap
	err := json.Unmarshal(raw, &fc)
	return fc, err
}
