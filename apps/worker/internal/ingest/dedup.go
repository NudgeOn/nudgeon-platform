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
//
// 유실 방지 계약(재검증 2026-08-31 A): dedup 마킹은 반드시 CH 영속 저장 성공 *후*에만
// 한다. 저장 전에 SET NX로 선점하면, 저장 실패 후 재처리에서 같은 이벤트가 "이미 처리됨"으로
// 걸러져 유실된다. 따라서 FilterUnseen(부수효과 없는 필터) + Mark(성공 후 등록)로 분리한다.
type Deduper struct {
	rdb redis.Cmdable
}

func NewDeduper(rdb redis.Cmdable) *Deduper {
	return &Deduper{rdb: rdb}
}

func dedupKey(tenantID, insertID string) string {
	return fmt.Sprintf("dedup:evt:%s:%s", tenantID, insertID)
}

// FilterUnseen은 아직 영속 저장되지 않은 이벤트만 돌려준다. 부수효과 없음.
//   - Redis에 이미 기록된(=저장 완료된) insert_id는 제외 (재처리 시 중복 방지, D-2)
//   - batchSeen으로 같은 배치 내 중복도 제거 (호출 간 공유되는 맵)
//
// 반환하는 markKeys는 flush 성공 후 Mark에 그대로 넘긴다.
func (d *Deduper) FilterUnseen(
	ctx context.Context,
	tenantID string,
	events []TrackEvent,
	batchSeen map[string]bool,
) (fresh []TrackEvent, markKeys []string, err error) {
	if len(events) == 0 {
		return nil, nil, nil
	}
	fresh = make([]TrackEvent, 0, len(events))
	for _, e := range events {
		key := dedupKey(tenantID, e.InsertID)
		if batchSeen[key] {
			continue // 같은 배치 내 중복
		}
		n, err := d.rdb.Exists(ctx, key).Result()
		if err != nil {
			return nil, nil, fmt.Errorf("dedup exists: %w", err)
		}
		if n > 0 {
			continue // 이미 영속 저장됨
		}
		batchSeen[key] = true
		fresh = append(fresh, e)
		markKeys = append(markKeys, key)
	}
	return fresh, markKeys, nil
}

// Mark는 CH 영속 저장 성공 후 insert_id를 dedup 윈도우에 등록한다 (SET NX EX 7d).
// 저장 성공 후에만 호출되므로, 저장 실패→재처리 경로에서 유실이 발생하지 않는다.
func (d *Deduper) Mark(ctx context.Context, keys []string) error {
	for _, k := range keys {
		if err := d.rdb.SetNX(ctx, k, 1, DedupWindow).Err(); err != nil {
			return fmt.Errorf("dedup mark: %w", err)
		}
	}
	return nil
}
