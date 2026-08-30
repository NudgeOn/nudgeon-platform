package ingest

import (
	"testing"
	"time"
)

func TestInferAttrType(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  string
		ok    bool
	}{
		{"문자열", "hello", "string", true},
		{"RFC3339는 datetime", "2026-08-30T09:12:33+09:00", "datetime", true},
		{"날짜 비슷하지만 불완전하면 string", "2026-08-30", "string", true},
		{"숫자", float64(42), "number", true},
		{"불리언", true, "boolean", true},
		{"문자열 배열", []any{"a", "b"}, "string_array", true},
		{"빈 배열은 string_array", []any{}, "string_array", true},
		{"혼합 배열 거부", []any{"a", float64(1)}, "", false},
		{"중첩 객체 거부", map[string]any{"x": 1}, "", false},
	}
	for _, c := range cases {
		got, ok := InferAttrType(c.value)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: (%q,%v) 기대, (%q,%v) 반환", c.name, c.want, c.ok, got, ok)
		}
	}
}

func TestChangeRowSerialization(t *testing.T) {
	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	row := changeRow("t", "a", "u", "vip_level", float64(2), float64(3), "set", "server", at, "req")
	if row[4] != "2" || row[5] != "3" {
		t.Errorf("old/new JSON 직렬화 불일치: %v", row)
	}
	unset := changeRow("t", "a", "u", "email", "x@y.z", nil, "unset", "sdk", at, "req")
	if unset[5] != "" {
		t.Errorf("unset의 new_value는 빈 문자열: %v", unset[5])
	}
}
