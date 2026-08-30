package ingest

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// DedupWindow — insert_id 중복 제거 윈도우 7일 (PRD-01 Open Q3 확정, D-9).
const DedupWindow = 7 * 24 * time.Hour

// Deduper는 insert_id 기준 1차 중복 방어다 (2차는 CH ReplacingMergeTree).
type Deduper struct {
	rdb redis.Cmdable
}

func NewDeduper(rdb redis.Cmdable) *Deduper {
	return &Deduper{rdb: rdb}
}

// FilterNew는 처음 보는 이벤트만 돌려준다. SET NX EX 7d — at-least-once 재처리에도
// events 중복 0을 보장한다 (D-2).
func (d *Deduper) FilterNew(ctx context.Context, tenantID string, events []TrackEvent) ([]TrackEvent, error) {
	if len(events) == 0 {
		return nil, nil
	}
	fresh := make([]TrackEvent, 0, len(events))
	for _, e := range events {
		key := fmt.Sprintf("dedup:evt:%s:%s", tenantID, e.InsertID)
		ok, err := d.rdb.SetNX(ctx, key, 1, DedupWindow).Result()
		if err != nil {
			return nil, fmt.Errorf("dedup setnx: %w", err)
		}
		if ok {
			fresh = append(fresh, e)
		}
	}
	return fresh, nil
}
