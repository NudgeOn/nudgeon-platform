package ops

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

// 실제 Redis에서 트림이 일어났을 때 XINFO가 판정에 필요한 값을 주는지 확인한다.
// 합성 구조체 단위 테스트만으로는 "Redis가 실제로 그렇게 응답한다"가 증명되지 않는다.
//
// 생산·소비는 libqueue를 경유한다(CLAUDE.md 규칙 2). 프로덕션과 같은 경로로 쌓인
// 스트림에서 탐지되는지를 봐야 의미가 있다. 트림(XTRIM)과 관측(XINFO)만 raw로 하는데,
// 트림은 Redis 고유 동작 자체가 검증 대상이고 XINFO는 큐 접근이 아니라 관측이다.
//
//	REDIS_URL=redis://localhost:6379 go test ./apps/worker/internal/ops/ -run RealRedis
func TestTrimLossOnRealRedis(t *testing.T) {
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("REDIS_URL 미설정 — 실 Redis 통합 테스트를 건너뛴다")
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatalf("REDIS_URL 파싱: %v", err)
	}
	rdb := redis.NewClient(opts)
	defer rdb.Close()

	ctx := context.Background()
	stream := fmt.Sprintf("test:trim:%d", os.Getpid())
	group := "cg:test"
	t.Cleanup(func() { rdb.Del(ctx, stream) })

	consumer := libqueue.NewConsumer(rdb, stream, group, "c1")
	if err := consumer.EnsureGroup(ctx); err != nil {
		t.Fatalf("EnsureGroup: %v", err)
	}

	// 1) libqueue로 20건 발행 — 프로덕션과 같은 경로.
	producer := libqueue.NewProducer(rdb, 0)
	for i := 0; i < 20; i++ {
		env := &libqueue.Envelope{
			ID:   fmt.Sprintf("00000000-0000-4000-8000-%012d", i),
			Type: "test.trim", SchemaVer: 1,
			TenantID:   "00000000-0000-4000-8000-000000000001",
			AppID:      "00000000-0000-4000-8000-000000000002",
			OccurredAt: time.Unix(1_700_000_000, 0).UTC(),
			TraceID:    "trace-1",
			Payload:    []byte(`{}`),
		}
		if _, err := producer.Publish(ctx, stream, env); err != nil {
			t.Fatalf("Publish %d: %v", i, err)
		}
	}

	// 2) 5건만 소비한다. 나머지 15건은 미소비 상태다.
	msgs, err := consumer.Fetch(ctx, 5, -1)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(msgs) != 5 {
		t.Fatalf("가져온 메시지 %d건, 5건이어야 한다", len(msgs))
	}

	// 트림 전에는 유실이 아니어야 한다 — 밀림과 유실을 구분하는지 확인.
	if before := statFor(ctx, t, rdb, stream, group); before.TrimLoss {
		t.Fatal("트림 전인데 유실로 판정했다")
	}

	// 3) MAXLEN 3으로 강제 트림. 미소비 15건 중 대부분이 사라진다.
	if err := rdb.XTrimMaxLen(ctx, stream, 3).Err(); err != nil {
		t.Fatalf("XTRIM: %v", err)
	}

	after := statFor(ctx, t, rdb, stream, group)
	if !after.TrimLoss {
		t.Fatalf("실제 트림을 탐지하지 못했다: length=%d added=%d read=%d",
			after.Length, after.EntriesAdded, after.EntriesRead)
	}
	// 20 추가 - 5 소비 - 3 잔존 = 12건이 미소비 상태로 사라졌다.
	if after.UnreadTrimmed != 12 {
		t.Fatalf("UnreadTrimmed=%d, want 12", after.UnreadTrimmed)
	}
	t.Logf("탐지됨 — length=%d added=%d read=%d unread_trimmed=%d",
		after.Length, after.EntriesAdded, after.EntriesRead, after.UnreadTrimmed)
}

func statFor(ctx context.Context, t *testing.T, rdb redis.Cmdable, stream, group string) QueueStat {
	t.Helper()
	info, err := rdb.XInfoStream(ctx, stream).Result()
	if err != nil {
		t.Fatalf("XINFO STREAM: %v", err)
	}
	groups, err := rdb.XInfoGroups(ctx, stream).Result()
	if err != nil {
		t.Fatalf("XINFO GROUPS: %v", err)
	}
	for _, g := range groups {
		if g.Name == group {
			return buildStat(stream, group, info, g, 3)
		}
	}
	t.Fatalf("그룹 %s를 찾지 못했다", group)
	return QueueStat{}
}
