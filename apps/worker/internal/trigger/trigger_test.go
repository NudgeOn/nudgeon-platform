package trigger

import (
	"encoding/json"
	"testing"
)

func TestParseReentry(t *testing.T) {
	cases := []struct {
		raw       string
		wantMode  string
		wantDays  int
	}{
		{`"never"`, "never", 0},
		{`"always"`, "always", 0},
		{`{"after_days":7}`, "after_days", 7},
		{``, "never", 0},
		{`{"after_days":0}`, "never", 0},
		{`"garbage"`, "garbage", 0}, // 문자열은 그대로 (canEnter의 default가 never로 처리)
	}
	for _, c := range cases {
		mode, days := parseReentry(json.RawMessage(c.raw))
		if mode != c.wantMode || days != c.wantDays {
			t.Errorf("parseReentry(%q) = (%q,%d), want (%q,%d)", c.raw, mode, days, c.wantMode, c.wantDays)
		}
	}
}

func TestActiveIndexLookup(t *testing.T) {
	idx := newActiveIndex()
	idx.entries[indexKey("app1", "signup")] = []entryRule{{JourneyID: "j1", Version: 1, TriggerEvent: "signup"}}
	idx.exits[indexKey("app1", "purchase")] = []exitRule{{JourneyID: "j1", ConversionEvent: "purchase"}}

	if got := idx.entryRules("app1", "signup"); len(got) != 1 || got[0].JourneyID != "j1" {
		t.Errorf("entryRules 조회 실패: %+v", got)
	}
	if got := idx.entryRules("app1", "other"); len(got) != 0 {
		t.Errorf("매칭 없는 이벤트는 빈 결과여야: %+v", got)
	}
	if got := idx.entryRules("app2", "signup"); len(got) != 0 {
		t.Errorf("다른 앱은 격리되어야: %+v", got)
	}
	if got := idx.exitRules("app1", "purchase"); len(got) != 1 {
		t.Errorf("exitRules 조회 실패: %+v", got)
	}
}
