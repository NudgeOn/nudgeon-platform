package policy

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// frequency cap 원자 검사+증가 (PRD-03 6.2).
// INCR 후 첫 증가면 24h 만료 설정. 결과가 max 초과면 초과분으로 판정하되
// 카운터는 이미 증가했으므로 초과 시 되돌린다(DECR) — 검사와 증가의 원자성 (IT-7 경합 방어).
const freqCapLua = `
local key = KEYS[1]
local maxv = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local n = redis.call('INCR', key)
if n == 1 then
  redis.call('EXPIRE', key, ttl)
end
if n > maxv then
  redis.call('DECR', key)
  return 0
end
return 1
`

// FreqCapChecker — Redis 기반 유저별 발송 빈도 제한.
type FreqCapChecker struct {
	rdb redis.Cmdable
}

func NewFreqCapChecker(rdb redis.Cmdable) *FreqCapChecker {
	return &FreqCapChecker{rdb: rdb}
}

// Allow는 카테고리·설정을 반영해 발송 허용 여부를 판정한다.
//   - transactional: 항상 허용(카운트도 하지 않음 — cap 대상 아님)
//   - 비활성: 항상 허용
//   - 활성: 원자적 검사+증가, max 초과 시 거부(카운터 미증가)
func (c *FreqCapChecker) Allow(ctx context.Context, cat Category, fc FrequencyCap, appID, userID string) (bool, error) {
	if cat == Transactional || !fc.Enabled {
		return true, nil
	}
	key := fmt.Sprintf("freqcap:%s:%s", appID, userID)
	res, err := c.rdb.Eval(ctx, freqCapLua, []string{key}, fc.MaxPer24h, int((24 * time.Hour).Seconds())).Result()
	if err != nil {
		return false, fmt.Errorf("freq cap eval: %w", err)
	}
	allowed, _ := res.(int64)
	return allowed == 1, nil
}
