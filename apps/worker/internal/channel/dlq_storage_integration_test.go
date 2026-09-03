package channel

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/dlq"
	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

const storageTenant = "00000000-0000-4000-8000-000000000001"
const storageApp = "00000000-0000-4000-8000-000000000002"

type storageHandler struct {
	pg        dlq.Execer
	plugin    *mockPlugin
	idem, mid string
	terminals int
}

func (h *storageHandler) KeyPrefix() string { return "send:message" }
func (h *storageHandler) Parse(*libqueue.Envelope) (string, string, string, bool) {
	return "job", h.idem, h.mid, true
}
func (h *storageHandler) Resolve(context.Context, *libqueue.Envelope, string) (Credentials, bool, error) {
	return Credentials{}, true, nil
}
func (h *storageHandler) Send(ctx context.Context, _ *libqueue.Envelope, _ string, _ Credentials) (string, error) {
	r, err := h.plugin.Send(ctx, SendRequest{})
	return r.ProviderID, err
}
func (h *storageHandler) Classify(err error) FailureClass { return Classify(err) }
func (h *storageHandler) OnTerminal(context.Context, *libqueue.Envelope, string, SendOutcome) {
	h.terminals++
}
func (h *storageHandler) Row(_ *libqueue.Envelope, _ string, out SendOutcome) []any {
	row := make([]any, 16)
	row[2], row[11] = out.MessageID, out.Status
	return row
}
func (h *storageHandler) DLQ(ctx context.Context, env *libqueue.Envelope, _ string, out SendOutcome) error {
	raw, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return dlq.Insert(ctx, h.pg, dlq.Entry{TenantID: env.TenantID, AppID: env.AppID, IdempotencyKey: h.idem,
		MessageID: out.MessageID, FailureID: out.FailureID, FailureClass: out.FailureClass, FailureDetail: out.FailureDetail, Attempts: out.Attempts, Envelope: raw})
}

// PostgreSQL commits, but the caller sees a transport error: a retry must not
// create a new failure cycle or invalidate an operator's resolution.
type lostReplyStore struct {
	dlq.Execer
	lose bool
}

func (s *lostReplyStore) Exec(ctx context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	tag, err := s.Execer.Exec(ctx, query, args...)
	if err == nil && s.lose {
		s.lose = false
		return tag, errors.New("synthetic reply lost after PG commit")
	}
	return tag, err
}

func TestDLQStoragePostgresRedis(t *testing.T) {
	adminURL, writerURL, redisURL, project := os.Getenv("DLQ_TEST_DATABASE_URL"), os.Getenv("DLQ_STORAGE_WRITER_URL"), os.Getenv("DLQ_STORAGE_REDIS_URL"), os.Getenv("DLQ_STORAGE_QA_PROJECT")
	if writerURL == "" || redisURL == "" || project == "" {
		t.Skip("use tests/ops/dlq-storage/run.mjs with an isolated PG/Redis")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	writer, err := pgxpool.New(ctx, writerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	ro, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(ro)
	defer rdb.Close()
	var name string
	if err := admin.QueryRow(ctx, "SELECT name FROM tenants WHERE id=$1", storageTenant).Scan(&name); err != nil || name != "DLQ STORAGE LOCAL QA" {
		t.Fatal("not the isolated fixture database")
	}
	if value, err := rdb.Get(ctx, "dlq-storage-qa-project").Result(); err != nil || value != project {
		t.Fatal("not the isolated fixture Redis")
	}
	permission := func(grant bool) {
		query := "REVOKE INSERT ON send_dlq FROM dlq_writer"
		if grant {
			query = "GRANT INSERT ON send_dlq TO dlq_writer"
		}
		if _, err := admin.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	defer permission(true)

	for _, mode := range []string{"push", "sendloop"} {
		for _, fault := range []string{"insert-denied", "committed-reply-lost"} {
			t.Run(mode+"/"+fault, func(t *testing.T) {
				permission(true)
				idem, mid := uuid.NewString(), uuid.NewString()
				prefix, stream, group, envType := "send", libqueue.StreamSendPush, libqueue.GroupChannel, "send.push"
				if mode == "sendloop" {
					prefix, stream, group, envType = "send:message", libqueue.StreamSendMessage, libqueue.GroupChannelMessage, "send.message.v1"
				}
				key := prefix + ":idem:" + storageTenant + ":" + idem
				attemptKey := prefix + ":attempts:" + storageTenant + ":" + idem
				plugin := &mockPlugin{sendErr: NewSendError(FailureRetryable, "synthetic final send failure")}
				store := &lostReplyStore{Execer: writer, lose: fault == "committed-reply-lost"}
				logger := slog.New(slog.NewTextHandler(io.Discard, nil))
				clk := clock.Real{}
				makeHandler := func() func(context.Context, *libqueue.Message) ([]any, bool) {
					if mode == "sendloop" {
						h := &storageHandler{pg: store, plugin: plugin, idem: idem, mid: mid}
						return NewSendLoop[string]("storage-qa", h, nil, rdb, nil, clk, logger).handleOne
					}
					w := NewWorker(nil, rdb, writer, nil, plugin, nil, clk, logger)
					w.dlqStore = store
					w.storeCredCache(storageApp+"/push_fcm", Credentials{Kind: "push_fcm", JSON: []byte("{}")}, true, clk.Now())
					return w.handleOne
				}
				queue := libqueue.NewConsumer(rdb, stream, group, "before-"+idem)
				if err := queue.EnsureGroup(ctx); err != nil {
					t.Fatal(err)
				}
				message := testMsg()
				var payload SendPushPayload
				if err := json.Unmarshal(message.Envelope.Payload, &payload); err != nil {
					t.Fatal(err)
				}
				payload.IdempotencyKey, payload.MessageID = idem, mid
				body, _ := json.Marshal(payload)
				env := libqueue.Envelope{ID: uuid.NewString(), Type: envType, SchemaVer: 1, TenantID: storageTenant, AppID: storageApp, OccurredAt: clk.Now(), TraceID: uuid.NewString(), Payload: body}
				if err := rdb.Set(ctx, attemptKey, 4, 0).Err(); err != nil {
					t.Fatal(err)
				}
				if _, err := libqueue.NewProducer(rdb, 0).Publish(ctx, stream, &env); err != nil {
					t.Fatal(err)
				}
				messages, err := queue.Fetch(ctx, 10, 0)
				if err != nil || len(messages) != 1 {
					t.Fatalf("fetch=%d err=%v", len(messages), err)
				}
				logged := 0
				flush := func(_ context.Context, rows [][]any) error { logged += len(rows); return nil } // Not ClickHouse verification.
				if fault == "insert-denied" {
					permission(false)
				}
				if err := processSendBatch(ctx, messages, makeHandler(), flush, queue.Ack); err != nil {
					t.Fatal(err)
				}
				if logged != 0 || plugin.sends != 1 {
					t.Fatalf("premature terminal log=%d sends=%d", logged, plugin.sends)
				}
				raw, err := rdb.Get(ctx, key).Result()
				if err != nil || !strings.HasPrefix(raw, statusDLQPending) {
					t.Fatal("missing persistent DLQ marker")
				}
				if ttl, _ := rdb.TTL(ctx, key).Result(); ttl != -1 {
					t.Fatalf("pending TTL=%v", ttl)
				}
				var count int
				if err := admin.QueryRow(ctx, "SELECT count(*) FROM send_dlq WHERE tenant_id=$1 AND idempotency_key=$2", storageTenant, idem).Scan(&count); err != nil {
					t.Fatal(err)
				}
				expected := 0
				if fault == "committed-reply-lost" {
					expected = 1
				}
				if count != expected {
					t.Fatalf("initial rows=%d expected=%d", count, expected)
				}
				var created time.Time
				var rowID string
				if fault == "committed-reply-lost" {
					if err := admin.QueryRow(ctx, "SELECT id,created_at FROM send_dlq WHERE tenant_id=$1 AND idempotency_key=$2", storageTenant, idem).Scan(&rowID, &created); err != nil {
						t.Fatal(err)
					}
					if err := dlq.Resolve(ctx, admin, storageTenant, rowID, created, "synthetic disposition verified"); err != nil {
						t.Fatal(err)
					}
				}
				// Reclaim with min-idle 0 deliberately accelerates consumer replacement.
				restartedQueue := libqueue.NewConsumer(rdb, stream, group, "after-"+idem)
				reclaimed, err := restartedQueue.Reclaim(ctx, 0, 10)
				if err != nil || len(reclaimed) != 1 {
					t.Fatalf("lost original pending: %d %v", len(reclaimed), err)
				}
				if fault == "insert-denied" {
					if err := processSendBatch(ctx, reclaimed, makeHandler(), flush, restartedQueue.Ack); err != nil {
						t.Fatal(err)
					}
					if logged != 0 || plugin.sends != 1 {
						t.Fatal("retry during DB outage resent or completed")
					}
					reclaimed, err = restartedQueue.Reclaim(ctx, 0, 10)
					if err != nil || len(reclaimed) != 1 {
						t.Fatal("pending disappeared during repeated failure")
					}
				}
				permission(true)
				plugin.sendErr = nil // Recovery must still never call the provider.
				if err := processSendBatch(ctx, reclaimed, makeHandler(), flush, restartedQueue.Ack); err != nil {
					t.Fatal(err)
				}
				if logged != 1 || plugin.sends != 1 {
					t.Fatalf("recovery log=%d sends=%d", logged, plugin.sends)
				}
				if pending, err := restartedQueue.Reclaim(ctx, 0, 10); err != nil || len(pending) != 0 {
					t.Fatal("successful persistence not ACKed")
				}
				if err := admin.QueryRow(ctx, "SELECT count(*) FROM send_dlq WHERE tenant_id=$1 AND idempotency_key=$2", storageTenant, idem).Scan(&count); err != nil || count != 1 {
					t.Fatalf("final rows=%d err=%v", count, err)
				}
				if fault == "committed-reply-lost" {
					var unchanged bool
					if err := admin.QueryRow(ctx, "SELECT created_at=$3 AND resolved_at IS NOT NULL FROM send_dlq WHERE tenant_id=$1 AND idempotency_key=$2", storageTenant, idem, created).Scan(&unchanged); err != nil || !unchanged {
						t.Fatal("same-cycle retry changed/resurrected a resolved failure")
					}
				}
				if _, err := libqueue.NewProducer(rdb, 0).Publish(ctx, stream, &env); err != nil {
					t.Fatal(err)
				}
				duplicate, err := restartedQueue.Fetch(ctx, 10, 0)
				if err != nil || len(duplicate) != 1 {
					t.Fatal("duplicate fixture fetch failed")
				}
				if err := processSendBatch(ctx, duplicate, makeHandler(), flush, restartedQueue.Ack); err != nil {
					t.Fatal(err)
				}
				if plugin.sends != 1 {
					t.Fatal("terminal redelivery resent")
				}
				t.Logf("real PG/Redis: fault=%s pending retained; restart -> DLQ rows=1; provider calls=1; ACK after persistence", fault)
			})
		}
	}
}
