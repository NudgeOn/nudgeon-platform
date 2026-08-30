package libqueue

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func setup(t *testing.T) (redis.Cmdable, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return rdb, mr
}

func validEnvelope() *Envelope {
	return &Envelope{
		ID:         "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		Type:       "ingest.batch",
		SchemaVer:  1,
		TenantID:   "11111111-1111-4111-8111-111111111111",
		AppID:      "22222222-2222-4222-8222-222222222222",
		OccurredAt: time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC),
		TraceID:    "trace-1",
		Payload:    json.RawMessage(`{"endpoint":"track","request_id":"44444444-4444-4444-8444-444444444444"}`),
	}
}

func TestPublishAndFetch(t *testing.T) {
	rdb, _ := setup(t)
	ctx := context.Background()

	consumer := NewConsumer(rdb, StreamIngest, GroupIngest, "w1")
	if err := consumer.EnsureGroup(ctx); err != nil {
		t.Fatalf("EnsureGroup: %v", err)
	}

	producer := NewProducer(rdb, 0)
	env := validEnvelope()
	if _, err := producer.Publish(ctx, StreamIngest, env); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	msgs, err := consumer.Fetch(ctx, 10, 0)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("메시지 1건 기대, %d건", len(msgs))
	}
	got := msgs[0].Envelope
	if got.ID != env.ID || got.Type != env.Type || got.TenantID != env.TenantID {
		t.Errorf("envelope 왕복 불일치: %+v", got)
	}
	if string(got.Payload) != string(env.Payload) {
		t.Errorf("payload 불일치: %s", got.Payload)
	}

	if err := consumer.Ack(ctx, msgs[0].StreamID); err != nil {
		t.Fatalf("Ack: %v", err)
	}
	// Ack 후 재fetch 시 새 메시지 없음
	again, err := consumer.Fetch(ctx, 10, 0)
	if err != nil {
		t.Fatalf("Fetch(2): %v", err)
	}
	if len(again) != 0 {
		t.Errorf("Ack 후 0건 기대, %d건", len(again))
	}
}

func TestPublishRejectsInvalidEnvelope(t *testing.T) {
	rdb, _ := setup(t)
	producer := NewProducer(rdb, 0)

	env := validEnvelope()
	env.TenantID = ""
	if _, err := producer.Publish(context.Background(), StreamIngest, env); err == nil {
		t.Fatal("tenant_id 누락 envelope이 발행됨 — 거부 기대")
	}
}

func TestReclaimIdlePending(t *testing.T) {
	rdb, mr := setup(t)
	ctx := context.Background()

	crashed := NewConsumer(rdb, StreamIngest, GroupIngest, "crashed")
	if err := crashed.EnsureGroup(ctx); err != nil {
		t.Fatalf("EnsureGroup: %v", err)
	}
	producer := NewProducer(rdb, 0)
	if _, err := producer.Publish(ctx, StreamIngest, validEnvelope()); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// crashed 소비자가 읽고 Ack 없이 죽음
	msgs, err := crashed.Fetch(ctx, 10, 0)
	if err != nil || len(msgs) != 1 {
		t.Fatalf("사전 Fetch 실패: %v (%d건)", err, len(msgs))
	}

	// miniredis는 pending idle에 FastForward를 반영하지 않으므로 minIdle=0으로
	// XAUTOCLAIM 경로 자체를 검증한다 (idle 30s 임계는 실 Redis 통합 테스트에서 확인 — S3).
	_ = mr
	rescuer := NewConsumer(rdb, StreamIngest, GroupIngest, "rescuer")
	reclaimed, err := rescuer.Reclaim(ctx, 0, 10)
	if err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if len(reclaimed) != 1 {
		t.Fatalf("회수 1건 기대, %d건", len(reclaimed))
	}
	if reclaimed[0].Envelope.ID != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" {
		t.Errorf("회수 메시지 불일치: %+v", reclaimed[0].Envelope)
	}
}

func TestFetchSkipsPoisonEntries(t *testing.T) {
	rdb, mr := setup(t)
	ctx := context.Background()

	consumer := NewConsumer(rdb, StreamIngest, GroupIngest, "w1")
	if err := consumer.EnsureGroup(ctx); err != nil {
		t.Fatalf("EnsureGroup: %v", err)
	}
	// libqueue를 우회한 이물질 엔트리 (필드명 다름)
	mr.XAdd(StreamIngest, "*", []string{"garbage", "not-json"})
	producer := NewProducer(rdb, 0)
	if _, err := producer.Publish(ctx, StreamIngest, validEnvelope()); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	msgs, err := consumer.Fetch(ctx, 10, 0)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("정상 1건만 기대, %d건", len(msgs))
	}
}
