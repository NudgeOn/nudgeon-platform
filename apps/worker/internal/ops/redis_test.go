package ops

import (
	"context"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

const testMarker = `dlq_pending|{"failure_id":"00000000-0000-4000-8000-000000000001","message_id":"synthetic","class":"retryable","attempts":5,"at":"2026-09-03T00:00:00Z"}`

type scanReply struct {
	keys   []string
	cursor uint64
}
type scanRedis struct {
	redis.Cmdable
	pages []scanReply
	calls int
}

func (r *scanRedis) Scan(ctx context.Context, cursor uint64, match string, count int64) *redis.ScanCmd {
	r.calls++
	cmd := redis.NewScanCmd(ctx, nil)
	page := r.pages[(r.calls-1)%len(r.pages)]
	cmd.SetVal(page.keys, page.cursor)
	return cmd
}

func redisFixture(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return mr, rdb
}

func TestPendingScanDuplicatesEmptyPagesLegacyAndReadOnly(t *testing.T) {
	mr, rdb := redisFixture(t)
	mr.Set("send:idem:tenant:push", testMarker)
	mr.Set("send:message:idem:tenant:message", strings.Replace(testMarker, "2026-09-03", "2026-09-02", 1))
	mr.Set("send:idem:tenant:terminal", "failed|retryable_exhausted")
	mr.Set("send:email:idem:tenant:email", "unrelated email value")
	r := &scanRedis{Cmdable: rdb, pages: []scanReply{
		{nil, 1},
		{[]string{"send:idem:tenant:push", "send:idem:tenant:push", "send:idem:tenant:terminal"}, 2},
		{[]string{"send:idem:tenant:push", "send:message:idem:tenant:message", "send:email:idem:tenant:email", "send:idem:vanished"}, 0},
	}}
	values, err := PendingSnapshot(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if values["push_pending_observed_count"] != 1 || values["message_pending_observed_count"] != 1 || r.calls != 3 {
		t.Fatal(values, r.calls)
	}
	if values["push_oldest_observed_timestamp_seconds"]-values["message_oldest_observed_timestamp_seconds"] != 86400 {
		t.Fatal(values)
	}
	if len(mr.Keys()) != 4 || mr.TTL("send:idem:tenant:push") != 0 {
		t.Fatal("observer mutated keys/TTL")
	}
	if raw, _ := mr.Get("send:idem:tenant:push"); raw != testMarker {
		t.Fatal("observer rewrote pending marker")
	}
}

func TestPendingScanBudgetsAndMalformedMarkersAreUnknown(t *testing.T) {
	for name, raw := range map[string]string{
		"json": "dlq_pending|broken", "too_large": "dlq_pending|" + strings.Repeat("x", markerLimit),
		"invalid_id":       strings.Replace(testMarker, "00000000-0000-4000-8000-000000000001", "invalid", 1),
		"invalid_time":     strings.Replace(testMarker, "2026-09-03T00:00:00Z", "0001-01-01T00:00:00Z", 1),
		"invalid_attempts": strings.Replace(testMarker, `"attempts":5`, `"attempts":4`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			mr, rdb := redisFixture(t)
			mr.Set("send:idem:tenant:bad", raw)
			if values, err := PendingSnapshot(context.Background(), rdb); err == nil || values != nil {
				t.Fatal("malformed marker accepted", values)
			}
		})
	}
	_, rdb := redisFixture(t)
	r := &scanRedis{Cmdable: rdb, pages: []scanReply{{nil, 1}}}
	if _, err := PendingSnapshot(context.Background(), r); err == nil || r.calls != scanCallsLimit {
		t.Fatal("unbounded scan", r.calls)
	}
	r = &scanRedis{Cmdable: rdb, pages: []scanReply{{make([]string, scanPageLimit+1), 0}}}
	if _, err := PendingSnapshot(context.Background(), r); err == nil {
		t.Fatal("oversize page accepted")
	}
	r = &scanRedis{Cmdable: rdb, pages: []scanReply{{[]string{"send:idem:" + strings.Repeat("x", 1024)}, 0}}}
	if _, err := PendingSnapshot(context.Background(), r); err == nil {
		t.Fatal("oversize key accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := PendingSnapshot(ctx, r); err == nil {
		t.Fatal("canceled scan accepted")
	}
}

type infoRedis struct {
	redis.Cmdable
	text string
}

func (r infoRedis) Info(ctx context.Context, sections ...string) *redis.StringCmd {
	cmd := redis.NewStringCmd(ctx)
	cmd.SetVal(r.text)
	return cmd
}
func TestRedisInfoDurabilityAndMissingFields(t *testing.T) {
	info := "used_memory:1024\r\nmaxmemory:65536\r\nevicted_keys:3\r\nmaxmemory_policy:noeviction\r\naof_enabled:1\r\naof_last_write_status:ok\r\n"
	values, err := RedisSnapshot(context.Background(), infoRedis{text: info})
	if err != nil || values["noeviction"] != 1 || values["aof_last_write_ok"] != 1 || values["evicted_keys_count"] != 3 {
		t.Fatal(values, err)
	}
	values, err = RedisSnapshot(context.Background(), infoRedis{text: strings.ReplaceAll(strings.ReplaceAll(info, "noeviction", "allkeys-lru"), "aof_enabled:1", "aof_enabled:0")})
	if err != nil || values["noeviction"] != 0 || values["aof_last_write_ok"] != 0 || values["aof_enabled"] != 0 {
		t.Fatal(values, err)
	}
	if _, err = RedisSnapshot(context.Background(), infoRedis{text: "used_memory:1024\n"}); err == nil {
		t.Fatal("partial INFO accepted")
	}
}
