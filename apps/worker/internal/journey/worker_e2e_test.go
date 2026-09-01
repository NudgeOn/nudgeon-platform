package journey

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/google/uuid"
	"github.com/ondahq/onda/apps/worker/internal/channel"
	"github.com/ondahq/onda/apps/worker/internal/clock"
	"github.com/ondahq/onda/apps/worker/internal/ingest"
	"github.com/ondahq/onda/apps/worker/internal/segment"
	"github.com/ondahq/onda/apps/worker/internal/trigger"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
	"github.com/redis/go-redis/v9"
)

type recordingChannel struct {
	mu       sync.Mutex
	requests []channel.SendRequest
}

func (*recordingChannel) Kind() channel.ChannelKind                                      { return channel.KindPush }
func (*recordingChannel) TargetType() channel.TargetType                                 { return channel.TargetDeviceToken }
func (*recordingChannel) ValidateCredentials(context.Context, channel.Credentials) error { return nil }
func (p *recordingChannel) Send(_ context.Context, req channel.SendRequest) (channel.SendResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.requests = append(p.requests, req)
	return channel.SendResult{ProviderID: "local-fake-transport"}, nil
}
func (*recordingChannel) ClassifyError(err error) channel.FailureClass { return channel.Classify(err) }
func (*recordingChannel) HandleCallback(context.Context, []byte) ([]channel.DeliveryUpdate, error) {
	return nil, nil
}
func (p *recordingChannel) calls() []channel.SendRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]channel.SendRequest(nil), p.requests...)
}

type testLogWriter struct{ t *testing.T }

func (w testLogWriter) Write(p []byte) (int, error) { w.t.Log(string(p)); return len(p), nil }

// Real PG + Redis Streams + ClickHouse, with only the provider transport fake.
// API acceptance/activation have separate integration suites; this begins at the
// durable receipt/outbox boundary and runs the actual worker role constructors.
func TestWorkerEndToEndGraphThroughRealStores(t *testing.T) {
	redisURL, chURL := os.Getenv("ONDA_JOURNEY_TEST_REDIS_URL"), os.Getenv("ONDA_JOURNEY_TEST_CLICKHOUSE_URL")
	if redisURL == "" || chURL == "" {
		t.Skip("set explicit Redis and ClickHouse integration URLs")
	}
	def := testGraph([]Node{
		{ID: "condition", Type: "branch", Condition: &segment.DSL{Version: 1, Operator: "AND", Groups: []segment.Group{{Operator: "AND", Conditions: []segment.Condition{
			{Type: "attribute", Key: "score", Op: "gte", Value: json.RawMessage(`10`)}, {Type: "event", Event: "signup", Op: "performed"},
		}}}}},
		{ID: "wait", Type: "event_wait", EventName: "purchase", TimeoutSeconds: 20},
		{ID: "experiment", Type: "ab_split", Variants: []Variant{{ID: "a", Label: "A", Weight: 55}, {ID: "b", Label: "B", Weight: 45}}},
		testMessage("a-message", "A message"), testMessage("b-message", "B message"), testMessage("fallback", "fallback"),
	}, []Edge{testEdge("condition", "true", "wait"), testEdge("condition", "false", "fallback"),
		testEdge("wait", "matched", "experiment"), testEdge("wait", "timeout", "fallback"),
		testEdge("experiment", "a", "a-message"), testEdge("experiment", "b", "b-message"),
		testEdge("a-message", "next", ""), testEdge("b-message", "next", ""), testEdge("fallback", "next", "")}, "condition")
	def.Entry = Entry{Type: "trigger", TriggerEvent: "signup"}
	f := newRuntimeFixture(t, def)
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	if opts.DB == 0 {
		t.Fatal("E2E requires a dedicated nonzero Redis database")
	}
	rdb := redis.NewClient(opts)
	if size, err := rdb.DBSize(ctx).Result(); err != nil || size != 0 {
		rdb.Close()
		t.Fatalf("dedicated Redis database must be empty: %d %v", size, err)
	}
	t.Cleanup(func() {
		cleanupCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		// This logical database was empty and reserved for this test. Never FLUSHALL.
		iter := rdb.Scan(cleanupCtx, 0, "*", 100).Iterator()
		for iter.Next(cleanupCtx) {
			if err := rdb.Del(cleanupCtx, iter.Val()).Err(); err != nil {
				t.Errorf("Redis test cleanup: %v", err)
			}
		}
		_ = rdb.Close()
	})
	chOpts, err := clickhouse.ParseDSN(chURL)
	if err != nil {
		t.Fatal(err)
	}
	ch, err := clickhouse.Open(chOpts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ch.Close() })
	if err := ch.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(testLogWriter{t}, nil))
	clk := clock.Real{}
	producer := libqueue.NewProducer(rdb, 0)
	consumer := func(stream, group string) *libqueue.Consumer {
		return libqueue.NewConsumer(rdb, stream, group, "e2e-"+uuid.NewString())
	}
	f.s = NewScheduler(consumer(libqueue.StreamJourneyEntry, libqueue.GroupScheduler), producer, f.pg, ch, rdb, clk, "e2e-scheduler", logger)
	ingestor := ingest.NewConsumer(consumer(libqueue.StreamIngest, libqueue.GroupIngest), producer, ingest.NewDeduper(rdb), f.pg, ch, clk, logger)
	matcher := trigger.NewMatcher(consumer(libqueue.StreamEvents, libqueue.GroupTriggerMatcher), producer, rdb, f.pg, clk, logger)
	matcher.SetRuntime(f.s)
	plugin := &recordingChannel{}
	master, dek := make([]byte, 32), make([]byte, 32)
	if _, err := rand.Read(master); err != nil {
		t.Fatal(err)
	}
	if _, err := rand.Read(dek); err != nil {
		t.Fatal(err)
	}
	f.exec(`INSERT INTO credentials(tenant_id,app_id,kind,ciphertext,dek_wrapped,status)
		VALUES($1,$2,'push_fcm',$3,$4,'verified')`, f.tenant, f.app, sealE2E(t, dek, []byte(`{"local_test":true}`)), sealE2E(t, master, dek))
	sender := channel.NewWorker(consumer(libqueue.StreamSendPush, libqueue.GroupChannel), rdb, f.pg, ch, plugin, master, clk, logger)
	var wg sync.WaitGroup
	workerErrors := make(chan error, 6)
	for _, run := range []func(context.Context) error{ingestor.Run, matcher.Run, f.s.RunEntryConsumer, f.s.RunTick, f.s.RunRelay, sender.Run} {
		wg.Add(1)
		go func(run func(context.Context) error) {
			defer wg.Done()
			err := run(ctx)
			if ctx.Err() == nil && err != nil {
				workerErrors <- err
			}
		}(run)
	}
	defer func() {
		cancel()
		wg.Wait()
		close(workerErrors)
		for err := range workerErrors {
			t.Errorf("worker: %v", err)
		}
	}()
	acceptE2EReceipt(t, f, "signup")
	eventuallyE2E(t, ctx, "wait registration", func() bool {
		var count int
		err := f.pg.QueryRow(ctx, `SELECT count(*) FROM journey_node_executions WHERE tenant_id=$1 AND node_id='wait' AND status='waiting'`, f.tenant).Scan(&count)
		return err == nil && count == 1
	})
	acceptE2EReceipt(t, f, "purchase")
	eventuallyE2E(t, ctx, "channel message_log", func() bool {
		var count uint64
		err := ch.QueryRow(ctx, `SELECT count() FROM message_log WHERE tenant_id=toUUID(?) AND app_id=toUUID(?) AND status='sent'`, f.tenant, f.app).Scan(&count)
		return err == nil && count == 1
	})
	requests := plugin.calls()
	if len(requests) != 1 {
		t.Fatalf("provider call count=%d", len(requests))
	}
	if requests[0].Content.Push.Title == "fallback" {
		t.Fatal("a required condition or wait fell through")
	}
	messageID := requests[0].Content.Push.Data["onda.message_id"]
	if _, err := uuid.Parse(messageID); err != nil {
		t.Fatalf("stable message_id missing: %q", messageID)
	}
	var completed, projected, matched, executionCount int
	if err := f.pg.QueryRow(ctx, `SELECT count(*) FROM journey_states WHERE tenant_id=$1 AND status='completed'`, f.tenant).Scan(&completed); err != nil {
		t.Fatal(err)
	}
	if err := f.pg.QueryRow(ctx, `SELECT count(*) FILTER(WHERE projected_at IS NOT NULL),count(*) FILTER(WHERE matched_at IS NOT NULL) FROM event_receipts WHERE tenant_id=$1`, f.tenant).Scan(&projected, &matched); err != nil {
		t.Fatal(err)
	}
	if err := f.pg.QueryRow(ctx, `SELECT count(*) FROM journey_node_executions WHERE tenant_id=$1 AND status='resolved'`, f.tenant).Scan(&executionCount); err != nil {
		t.Fatal(err)
	}
	if completed != 1 || projected != 2 || matched != 2 || executionCount != 4 {
		t.Fatalf("incomplete execution: states=%d receipts=%d/%d nodes=%d", completed, projected, matched, executionCount)
	}
	var chMessageID string
	if err := ch.QueryRow(ctx, `SELECT toString(message_id) FROM message_log WHERE tenant_id=toUUID(?) AND app_id=toUUID(?) AND status='sent' LIMIT 1`, f.tenant, f.app).Scan(&chMessageID); err != nil {
		t.Fatal(err)
	}
	if chMessageID != messageID {
		t.Fatalf("provider/log message ID differs: %s %s", messageID, chMessageID)
	}
	// Simulate the publish-before-mark crash. The actual channel consumer handles
	// the repeated send while the fake provider is still called exactly once.
	f.exec(`UPDATE journey_outbox SET published_at=NULL WHERE tenant_id=$1 AND stream='stream:send.push'`, f.tenant)
	eventuallyE2E(t, ctx, "duplicate send acknowledgment", func() bool {
		var count uint64
		err := ch.QueryRow(ctx, `SELECT count() FROM message_log WHERE tenant_id=toUUID(?) AND app_id=toUUID(?) AND status='duplicate'`, f.tenant, f.app).Scan(&count)
		return err == nil && count > 0
	})
	if len(plugin.calls()) != 1 {
		t.Fatal("relay replay reached the provider again")
	}
	t.Logf("verified receipt→projection→normalized→condition→wait→A/B→send→message_log; tenant=%s, message_id=%s", f.tenant, messageID)
}

func sealE2E(t *testing.T, key, plain []byte) []byte {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	return gcm.Seal(nonce, nonce, plain, nil)
}

func acceptE2EReceipt(t *testing.T, f *runtimeFixture, event string) {
	t.Helper()
	tx, err := f.pg.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	seq, err := f.s.lockCustomer(f.ctx, tx, f.tenant, f.app, f.user)
	if err != nil {
		t.Fatal(err)
	}
	seq++
	var now time.Time
	if err := tx.QueryRow(f.ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	if _, err := tx.Exec(f.ctx, `UPDATE event_customer_cursors SET last_seq=$4,updated_at=$5 WHERE tenant_id=$1 AND app_id=$2 AND user_id=$3`, f.tenant, f.app, f.user, seq, now); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(f.ctx, `INSERT INTO event_receipts(tenant_id,app_id,insert_id,user_id,event_name,receipt_seq,received_at,properties,client_ts)
		VALUES($1,$2,$3,$4,$5,$6,$7,'{}',$7)`, f.tenant, f.app, id, f.user, event, seq, now); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(ingest.IngestBatchPayload{Endpoint: "track", RequestID: id, Events: []ingest.TrackEvent{{InsertID: id, UserID: f.user, Event: event, ReceiptSeq: strconv.FormatInt(seq, 10), ReceivedAt: now, ServerTS: now, ClientTS: now, Properties: json.RawMessage(`{}`)}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(f.ctx, `INSERT INTO journey_outbox(tenant_id,app_id,stream,idempotency_key,payload)
		VALUES($1,$2,'stream:ingest',$3,$4)`, f.tenant, f.app, "event.ingest:"+id, payload); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
}

func eventuallyE2E(t *testing.T, ctx context.Context, label string, ready func() bool) {
	t.Helper()
	ticker := time.NewTicker(40 * time.Millisecond)
	defer ticker.Stop()
	for {
		if ready() {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal(fmt.Sprintf("timed out waiting for %s", label))
		case <-ticker.C:
		}
	}
}
