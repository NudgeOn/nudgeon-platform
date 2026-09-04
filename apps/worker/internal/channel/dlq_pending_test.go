package channel

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/dlq"
	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

type controlledDLQStore struct {
	err   error
	calls int
	ids   []string
}

func (s *controlledDLQStore) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	s.calls++
	s.ids = append(s.ids, args[8].(string))
	return pgconn.NewCommandTag("INSERT 0 1"), s.err
}

type retryHandler struct {
	store            dlq.Execer
	sends, terminals int
}

func (h *retryHandler) KeyPrefix() string { return "send" }
func (h *retryHandler) Parse(*libqueue.Envelope) (string, string, string, bool) {
	return "job", "idem-1", "mid-1", true
}
func (h *retryHandler) Resolve(context.Context, *libqueue.Envelope, string) (Credentials, bool, error) {
	return Credentials{}, true, nil
}
func (h *retryHandler) Send(context.Context, *libqueue.Envelope, string, Credentials) (string, error) {
	h.sends++
	return "", NewSendError(FailureRetryable, "synthetic provider failure")
}
func (h *retryHandler) Classify(error) FailureClass { return FailureRetryable }
func (h *retryHandler) OnTerminal(context.Context, *libqueue.Envelope, string, SendOutcome) {
	h.terminals++
}
func (h *retryHandler) Row(_ *libqueue.Envelope, _ string, o SendOutcome) []any {
	row := make([]any, 16)
	row[2], row[11], row[12], row[14] = o.MessageID, o.Status, o.FailureClass, o.At
	return row
}
func (h *retryHandler) DLQ(ctx context.Context, env *libqueue.Envelope, _ string, o SendOutcome) error {
	if h.store == nil {
		return errors.New("missing test DLQ store")
	}
	return dlq.Insert(ctx, h.store, dlq.Entry{TenantID: env.TenantID, AppID: env.AppID, IdempotencyKey: "idem-1", FailureID: o.FailureID})
}

func TestDLQPersistenceFailureResumesWithoutResending(t *testing.T) {
	for _, mode := range []string{"push", "sendloop"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			w, mr, fk := newTestWorker(t, NewSendError(FailureRetryable, "5xx"))
			failedAt := fk.Now()
			store := &controlledDLQStore{err: errors.New("database write denied")}
			w.dlqStore = store
			h := &retryHandler{store: store}
			loop := NewSendLoop[string]("test", h, nil, w.rdb, nil, w.clk, w.logger)
			handle := w.handleOne
			sends := func() int { return w.plugin.(*mockPlugin).sends }
			if mode == "sendloop" {
				handle = loop.handleOne
				sends = func() int { return h.sends }
			}
			mr.Set("send:attempts:t1:idem-1", "4")
			for i := 0; i < 3; i++ {
				row, retry := handle(ctx, testMsg())
				if row != nil || !retry {
					t.Fatalf("attempt %d authorized terminal/ACK: row=%v retry=%v", i, row, retry)
				}
			}
			if sends() != 1 || h.terminals != 0 || store.calls != 3 {
				t.Fatalf("sends=%d terminals=%d writes=%d", sends(), h.terminals, store.calls)
			}
			raw, _ := mr.Get("send:idem:t1:idem-1")
			if !strings.HasPrefix(raw, statusDLQPending) || mr.TTL("send:idem:t1:idem-1") != 0 {
				t.Fatal("pending marker missing or expires")
			}
			for _, id := range store.ids {
				if id == "" || id != store.ids[0] {
					t.Fatal("failure cycle changed during retry")
				}
			}
			store.err = nil
			fk.Advance(time.Hour)
			row, retry := handle(ctx, testMsg())
			if retry || row[11] != "failed" || sends() != 1 {
				t.Fatalf("recovery row=%v retry=%v sends=%d", row, retry, sends())
			}
			if row[14] != failedAt {
				t.Fatalf("recovery changed the original failure time: %v", row[14])
			}
			if mr.Exists("send:attempts:t1:idem-1") {
				t.Fatal("attempt counter not cleared after successful commit")
			}
			if value, _ := mr.Get("send:idem:t1:idem-1"); value != "failed|retryable_exhausted" {
				t.Fatalf("state=%s", value)
			}
			if _, retry := handle(ctx, testMsg()); retry || sends() != 1 || store.calls != 4 {
				t.Fatal("terminal redelivery resent or rewrote DLQ")
			}
		})
	}
}

func TestDLQMissingDatabaseNeverAuthorizesACK(t *testing.T) {
	w, mr, _ := newTestWorker(t, NewSendError(FailureRetryable, "5xx"))
	mr.Set("send:attempts:t1:idem-1", "4")
	row, retry := w.handleOne(context.Background(), testMsg())
	if row != nil || !retry {
		t.Fatal("nil DB authorized ACK")
	}
}

func TestNonterminalStateNeverAuthorizesACK(t *testing.T) {
	for _, state := range []string{"processing", "processing|another-owner", "unknown", "dlq_pending|invalid-json"} {
		t.Run(state, func(t *testing.T) {
			w, mr, _ := newTestWorker(t, nil)
			mr.Set("send:idem:t1:idem-1", state)
			h := &retryHandler{}
			loop := NewSendLoop[string]("test", h, nil, w.rdb, nil, w.clk, w.logger)
			for _, handle := range []func(context.Context, *libqueue.Message) ([]any, bool){w.handleOne, loop.handleOne} {
				if row, retry := handle(context.Background(), testMsg()); row != nil || !retry {
					t.Fatal("nonterminal state authorized ACK")
				}
			}
			if w.plugin.(*mockPlugin).sends != 0 || h.sends != 0 {
				t.Fatal("nonterminal state resent")
			}
		})
	}
}

// The final INCR may succeed even if persisting the marker fails. Recover only
// the DLQ write after the processing lease expires, never send a sixth time.
func TestExhaustedCounterSkipsProvider(t *testing.T) {
	w, mr, _ := newTestWorker(t, nil)
	w.dlqStore = &controlledDLQStore{}
	mr.Set("send:attempts:t1:idem-1", "5")
	if row, retry := w.handleOne(context.Background(), testMsg()); retry || row == nil || w.plugin.(*mockPlugin).sends != 0 {
		t.Fatal("exhausted push sent again")
	}
	mr.Del("send:idem:t1:idem-1")
	mr.Set("send:attempts:t1:idem-1", "5")
	h := &retryHandler{store: &controlledDLQStore{}}
	loop := NewSendLoop[string]("test", h, nil, w.rdb, nil, w.clk, w.logger)
	if row, retry := loop.handleOne(context.Background(), testMsg()); retry || row == nil || h.sends != 0 {
		t.Fatal("exhausted send loop sent again")
	}
}

type failCommitRedis struct {
	redis.Cmdable
	fail bool
}

func (r *failCommitRedis) EvalSha(ctx context.Context, sha string, keys []string, args ...any) *redis.Cmd {
	if r.fail && sha == commitDLQ.Hash() {
		c := redis.NewCmd(ctx)
		c.SetErr(errors.New("synthetic Redis commit failure"))
		return c
	}
	return r.Cmdable.EvalSha(ctx, sha, keys, args...)
}
func (r *failCommitRedis) Eval(ctx context.Context, script string, keys []string, args ...any) *redis.Cmd {
	if r.fail && redis.NewScript(script).Hash() == commitDLQ.Hash() {
		c := redis.NewCmd(ctx)
		c.SetErr(errors.New("synthetic Redis commit failure"))
		return c
	}
	return r.Cmdable.Eval(ctx, script, keys, args...)
}

func TestRedisFinalizeFailureLeavesSameDLQCyclePending(t *testing.T) {
	w, mr, _ := newTestWorker(t, NewSendError(FailureRetryable, "5xx"))
	store := &controlledDLQStore{}
	w.dlqStore = store
	rdb := &failCommitRedis{Cmdable: w.rdb, fail: true}
	w.rdb = rdb
	mr.Set("send:attempts:t1:idem-1", "4")
	if row, retry := w.handleOne(context.Background(), testMsg()); row != nil || !retry {
		t.Fatal("Redis commit failure authorized ACK")
	}
	rdb.fail = false
	if row, retry := w.handleOne(context.Background(), testMsg()); row == nil || retry {
		t.Fatal("Redis commit recovery failed")
	}
	if len(store.ids) != 2 || store.ids[0] != store.ids[1] || w.plugin.(*mockPlugin).sends != 1 {
		t.Fatal("changed cycle or resend during Redis recovery")
	}
}

func TestStaleLeaseCannotReplaceDLQState(t *testing.T) {
	w, mr, _ := newTestWorker(t, nil)
	mr.Set("send:idem:t1:idem-1", "processing|new-owner")
	_, err := beginDLQ(context.Background(), w.rdb, "send:idem:t1:idem-1", "processing|old-owner", pendingDLQ{MessageID: "mid", Class: "retryable", Attempts: 5, At: mustTime()})
	if !errors.Is(err, errDLQStateChanged) {
		t.Fatalf("err=%v", err)
	}
	if value, _ := mr.Get("send:idem:t1:idem-1"); value != "processing|new-owner" {
		t.Fatal("stale lease overwrote state")
	}
}

func TestPersistentDLQMarkerSurvivesOriginalLeaseTTL(t *testing.T) {
	w, mr, _ := newTestWorker(t, NewSendError(FailureRetryable, "5xx"))
	mr.Set("send:attempts:t1:idem-1", "4")
	_, _ = w.handleOne(context.Background(), testMsg())
	mr.FastForward(8 * 24 * time.Hour)
	if row, retry := w.handleOne(context.Background(), testMsg()); row != nil || !retry || w.plugin.(*mockPlugin).sends != 1 {
		t.Fatal("DLQ marker expired into a fresh send")
	}
}

func TestConcurrentDLQFinalizersHaveOneStateCommit(t *testing.T) {
	w, mr, _ := newTestWorker(t, nil)
	key := "send:idem:t1:idem-1"
	mr.Set(key, "processing|owner")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	raw, err := beginDLQ(ctx, w.rdb, key, "processing|owner", pendingDLQ{MessageID: "mid-1", Class: "retryable", Attempts: 5, At: mustTime()})
	if err != nil {
		t.Fatal(err)
	}
	entered, release, results := make(chan string, 2), make(chan struct{}), make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			_, err := finishDLQ(ctx, w.rdb, key, "attempts", "retryat", raw, func(p pendingDLQ) error {
				entered <- p.FailureID
				select {
				case <-release:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			})
			results <- err
		}()
	}
	ids := []string{}
	for len(ids) < 2 {
		select {
		case id := <-entered:
			ids = append(ids, id)
		case <-ctx.Done():
			t.Fatal("finalizers did not enter persistence")
		}
	}
	if ids[0] != ids[1] {
		t.Fatal("concurrent retry changed failure ID")
	}
	close(release)
	successes, changed := 0, 0
	for i := 0; i < 2; i++ {
		if err := <-results; err == nil {
			successes++
		} else if errors.Is(err, errDLQStateChanged) {
			changed++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || changed != 1 {
		t.Fatalf("commits=%d state-changed=%d", successes, changed)
	}
}

func TestSendBatchAcknowledgesOnlyDurablyCompletedWork(t *testing.T) {
	ctx := context.Background()
	messages := []libqueue.Message{{StreamID: "pending"}, {StreamID: "done"}}
	handle := func(_ context.Context, m *libqueue.Message) ([]any, bool) {
		if m.StreamID == "pending" {
			return nil, true
		}
		return []any{"failed"}, false
	}
	acked := []string{}
	ack := func(_ context.Context, ids ...string) error { acked = append(acked, ids...); return nil }
	flush := func(_ context.Context, rows [][]any) error {
		if len(rows) != 1 {
			t.Fatal("pending write produced terminal log")
		}
		return nil
	}
	if err := processSendBatch(ctx, messages, handle, flush, ack); err != nil {
		t.Fatal(err)
	}
	if len(acked) != 1 || acked[0] != "done" {
		t.Fatalf("ACKs=%v", acked)
	}
	acked = nil
	if err := processSendBatch(ctx, messages, handle, func(context.Context, [][]any) error { return errors.New("log sink unavailable") }, ack); err == nil || len(acked) != 0 {
		t.Fatal("log sink failure authorized ACK")
	}
}
