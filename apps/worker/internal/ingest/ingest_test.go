package ingest

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func strp(s string) *string { return &s }

func TestParsePayload(t *testing.T) {
	valid := `{
		"endpoint":"track","request_id":"44444444-4444-4444-8444-444444444444",
		"device":{"device_id":"55555555-5555-4555-8555-555555555555","platform":"ios"},
		"events":[{"insert_id":"33333333-3333-4333-8333-333333333333","anon_id":"66666666-6666-4666-8666-666666666666",
		           "external_id":null,"event":"app_open","properties":{"a":1},
		           "client_ts":"2026-08-30T09:12:33.12+09:00","server_ts":"2026-08-30T00:12:34Z"}]
	}`
	p, err := ParsePayload(json.RawMessage(valid))
	if err != nil {
		t.Fatalf("유효 payload 거부: %v", err)
	}
	if p.Endpoint != "track" || len(p.Events) != 1 || p.Events[0].Event != "app_open" {
		t.Errorf("파싱 결과 불일치: %+v", p)
	}
	if p.Events[0].ServerTS.IsZero() {
		t.Error("server_ts 파싱 실패")
	}

	cases := map[string]string{
		"endpoint 누락":  `{"request_id":"r"}`,
		"식별자 누락":       `{"endpoint":"track","request_id":"r","events":[{"insert_id":"i","event":"e","client_ts":"2026-08-30T00:00:00Z"}]}`,
		"insert_id 누락": `{"endpoint":"track","request_id":"r","events":[{"anon_id":"a","event":"e","client_ts":"2026-08-30T00:00:00Z"}]}`,
	}
	for name, raw := range cases {
		if _, err := ParsePayload(json.RawMessage(raw)); err == nil {
			t.Errorf("%s: 거부 기대", name)
		}
	}
}

func TestDeduperFilterNew(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	d := NewDeduper(rdb)
	ctx := context.Background()

	events := []TrackEvent{
		{InsertID: "e1", AnonID: strp("a"), Event: "x"},
		{InsertID: "e2", AnonID: strp("a"), Event: "y"},
	}
	first, err := d.FilterNew(ctx, "tenant-1", events)
	if err != nil {
		t.Fatalf("FilterNew: %v", err)
	}
	if len(first) != 2 {
		t.Fatalf("첫 처리 2건 기대, %d건", len(first))
	}

	// 동일 배치 재전송 (D-2 시나리오) → 전부 걸러짐
	second, err := d.FilterNew(ctx, "tenant-1", events)
	if err != nil {
		t.Fatalf("FilterNew(2): %v", err)
	}
	if len(second) != 0 {
		t.Errorf("재전송 0건 기대, %d건", len(second))
	}

	// 다른 테넌트의 동일 insert_id는 별개
	other, err := d.FilterNew(ctx, "tenant-2", events[:1])
	if err != nil || len(other) != 1 {
		t.Errorf("테넌트 격리 실패: %v, %d건", err, len(other))
	}

	// 7일 윈도우 경과 후 재전송은 통과 (D-9: 중복 허용 명시)
	mr.FastForward(DedupWindow + 1)
	expired, err := d.FilterNew(ctx, "tenant-1", events[:1])
	if err != nil || len(expired) != 1 {
		t.Errorf("윈도우 경과 후 1건 기대: %v, %d건", err, len(expired))
	}
}
