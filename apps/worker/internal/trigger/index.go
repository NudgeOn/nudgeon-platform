// Package trigger — 트리거 매처 (PRD-03 3장). 정규화 이벤트를 구독해
// 이벤트 트리거 저니 진입(O-4)과 conversion 이탈(O-5)을 처리한다.
package trigger

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// entryRule — 활성 저니의 트리거 진입 설정
type entryRule struct {
	JourneyID    string
	Version      int
	TriggerEvent string
	Reentry      string // never | always | after_days
	ReentryDays  int
}

// exitRule — conversion 이탈 설정
type exitRule struct {
	JourneyID       string
	ConversionEvent string
}

// activeIndex — (app_id, event_name) → 규칙. 주기적으로 PG에서 갱신.
type activeIndex struct {
	mu      sync.RWMutex
	entries map[string][]entryRule // key: appID\x00eventName
	exits   map[string][]exitRule
}

func newActiveIndex() *activeIndex {
	return &activeIndex{entries: map[string][]entryRule{}, exits: map[string][]exitRule{}}
}

func indexKey(appID, eventName string) string { return appID + "\x00" + eventName }

func (idx *activeIndex) entryRules(appID, eventName string) []entryRule {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	return idx.entries[indexKey(appID, eventName)]
}

func (idx *activeIndex) exitRules(appID, eventName string) []exitRule {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	return idx.exits[indexKey(appID, eventName)]
}

type journeyDef struct {
	Entry struct {
		Type         string `json:"type"`
		TriggerEvent string `json:"trigger_event"`
	} `json:"entry"`
	Exit struct {
		ConversionEvent string `json:"conversion_event"`
	} `json:"exit"`
	Settings struct {
		Reentry json.RawMessage `json:"reentry"`
	} `json:"settings"`
}

// parseReentry는 "never" | "always" | {"after_days":N}를 (mode, days)로 해석.
func parseReentry(raw json.RawMessage) (string, int) {
	if len(raw) == 0 {
		return "never", 0
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, 0
	}
	var obj struct {
		AfterDays int `json:"after_days"`
	}
	if json.Unmarshal(raw, &obj) == nil && obj.AfterDays > 0 {
		return "after_days", obj.AfterDays
	}
	return "never", 0
}

// reload는 활성 저니의 트리거/이탈 설정을 PG에서 읽어 인덱스를 재구축한다.
func (idx *activeIndex) reload(ctx context.Context, pg *pgxpool.Pool) error {
	rows, err := pg.Query(ctx, `
		SELECT j.id, j.app_id, j.active_version, v.definition
		  FROM journeys j
		  JOIN journey_versions v ON v.journey_id = j.id AND v.version = j.active_version
		 WHERE j.status = 'active' AND j.active_version IS NOT NULL`)
	if err != nil {
		return err
	}
	defer rows.Close()

	entries := map[string][]entryRule{}
	exits := map[string][]exitRule{}
	for rows.Next() {
		var journeyID, appID string
		var version int
		var rawDef []byte
		if err := rows.Scan(&journeyID, &appID, &version, &rawDef); err != nil {
			return err
		}
		var def journeyDef
		if json.Unmarshal(rawDef, &def) != nil {
			continue
		}
		if def.Entry.Type == "trigger" && def.Entry.TriggerEvent != "" {
			mode, days := parseReentry(def.Settings.Reentry)
			k := indexKey(appID, def.Entry.TriggerEvent)
			entries[k] = append(entries[k], entryRule{
				JourneyID: journeyID, Version: version, TriggerEvent: def.Entry.TriggerEvent,
				Reentry: mode, ReentryDays: days,
			})
		}
		if def.Exit.ConversionEvent != "" {
			k := indexKey(appID, def.Exit.ConversionEvent)
			exits[k] = append(exits[k], exitRule{
				JourneyID: journeyID, ConversionEvent: def.Exit.ConversionEvent,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	idx.mu.Lock()
	idx.entries = entries
	idx.exits = exits
	idx.mu.Unlock()
	return nil
}

const reloadInterval = 10 * time.Second
