package journey

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/ondahq/onda/apps/worker/internal/segment"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

func branchGraph(event bool) Definition {
	conditions := []segment.Condition{{Type: "attribute", Key: "score", Op: "gte", Value: json.RawMessage(`10`)}}
	if event {
		conditions = append(conditions, segment.Condition{Type: "event", Event: "purchase", Op: "performed"})
	}
	branch := Node{ID: "branch", Type: "branch", Condition: &segment.DSL{Version: 1, Operator: "AND", Groups: []segment.Group{{Operator: "AND", Conditions: conditions}}}}
	return testGraph([]Node{branch, testMessage("yes", "yes"), testMessage("no", "no")},
		[]Edge{testEdge("branch", "true", "yes"), testEdge("branch", "false", "no"), testEdge("yes", "next", ""), testEdge("no", "next", "")}, "branch")
}

func TestRuntimeBranchSnapshotSurvivesHistoryFailure(t *testing.T) {
	f := newRuntimeFixture(t, branchGraph(true))
	id := f.admit("source-1", 1)
	attempts := 0
	var cutoff time.Time
	f.s.eventLookup = func(_ context.Context, q eventQuery) (bool, error) {
		attempts++
		if attempts == 1 {
			cutoff = q.Until
			return false, errors.New("ClickHouse unavailable")
		}
		if !cutoff.Equal(q.Until) {
			return false, errors.New("retry changed the condition cutoff")
		}
		return true, nil
	}
	f.tick()
	if status, port, retries := f.execution(id, 0); status != "retrying" || port != "" || retries != 1 {
		t.Fatalf("dependency failure must not select false: %s %s %d", status, port, retries)
	}
	f.exec(`UPDATE users SET custom_attrs='{"score":0}' WHERE tenant_id=$1 AND id=$2`, f.tenant, f.user)
	f.clk.Advance(time.Second)
	f.tick()
	if status, port, _ := f.execution(id, 0); status != "resolved" || port != "true" {
		t.Fatalf("expected captured score=12: %s %s", status, port)
	}
	f.tick()
	if status, _ := f.state(id); status != "completed" {
		t.Fatal(status)
	}
	var title string
	if err := f.pg.QueryRow(f.ctx, `SELECT payload->'content'->'push'->>'title' FROM journey_outbox WHERE tenant_id=$1`, f.tenant).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "yes" {
		t.Fatalf("wrong branch message %s", title)
	}
}

func TestRuntimeConditionFailureExhaustsWithoutFalseRoute(t *testing.T) {
	f := newRuntimeFixture(t, branchGraph(true))
	f.exec(`UPDATE users SET custom_attrs='{"score":0}' WHERE tenant_id=$1 AND id=$2`, f.tenant, f.user)
	id := f.admit("source-1", 1)
	f.s.eventLookup = func(context.Context, eventQuery) (bool, error) { return false, errors.New("history timeout") }
	for i := 0; i < nodeMaxAttempts; i++ {
		f.tick()
		f.clk.Advance(time.Minute)
	}
	if status, node := f.state(id); status != "failed" || node != 0 {
		t.Fatalf("state=%s node=%d", status, node)
	}
	if status, port, retry := f.execution(id, 0); status != "failed" || port != "" || retry != nodeMaxAttempts {
		t.Fatalf("record=%s %s %d", status, port, retry)
	}
	if f.count("journey_outbox") != 0 {
		t.Fatal("failed evaluation enqueued a message")
	}
}

func TestRuntimeBranchFalseAndNonzeroStart(t *testing.T) {
	def := branchGraph(false)
	// Start node is deliberately not array index zero. Both exclusive paths merge.
	def.Nodes = []Node{testMessage("yes", "merged"), def.Nodes[0]}
	def.Edges = []Edge{testEdge("branch", "true", "yes"), testEdge("branch", "false", "yes"), testEdge("yes", "next", "")}
	f := newRuntimeFixture(t, def)
	f.exec(`UPDATE users SET custom_attrs='{"score":1}' WHERE tenant_id=$1 AND id=$2`, f.tenant, f.user)
	id := f.admit("source-1", 1)
	if _, node := f.state(id); node != 1 {
		t.Fatalf("start index=%d", node)
	}
	f.tick()
	f.tick()
	if _, port, _ := f.execution(id, 1); port != "false" {
		t.Fatal(port)
	}
	if f.count("journey_node_executions") != 2 || f.count("journey_outbox") != 1 {
		t.Fatal("exclusive merge executed more than once")
	}
}

func TestRuntimeEventWaitReceiptBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name           string
		receivedOffset time.Duration
		expected       string
		beforeStart    bool
	}{
		{"received-before-deadline-but-normalized-late", 9 * time.Second, "matched", false},
		{"exact-deadline", 10 * time.Second, "timeout", false},
		{"after-deadline", 11 * time.Second, "timeout", false},
		{"legacy-receipt-created-later-with-old-receive-time", -time.Second, "timeout", false},
		{"receipt-existed-before-wait", -time.Second, "timeout", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRuntimeFixture(t, waitGraph())
			start := f.clk.Now()
			if tc.beforeStart {
				f.receipt("purchase", start.Add(tc.receivedOffset), false)
			}
			id := f.admit("source-1", 1)
			f.tick()
			if !tc.beforeStart {
				f.receipt("purchase", start.Add(tc.receivedOffset), false)
			}
			f.clk.Advance(12 * time.Second)
			// No event consumer ran. The timeout path must still inspect durable receipts.
			f.tick()
			if status, port, _ := f.execution(id, 0); status != "resolved" || port != tc.expected {
				t.Fatalf("%s %s, wanted %s", status, port, tc.expected)
			}
			f.tick()
			if f.count("journey_outbox") != 1 {
				t.Fatal("wait resolution sent multiple paths")
			}
		})
	}
}

func TestRuntimeConversionWinsEventTimeoutAndOldClaim(t *testing.T) {
	def := waitGraph()
	def.Exit.ConversionEvent = "purchase"
	f := newRuntimeFixture(t, def)
	id := f.admit("source-1", 1)
	f.tick()
	f.clk.Advance(9 * time.Second)
	event := f.receipt("purchase", f.clk.Now(), true)
	f.clk.Advance(2 * time.Second)
	claims, err := f.s.claimDue(f.ctx)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claims: %v %v", claims, err)
	}
	var wg sync.WaitGroup
	errorsCh := make(chan error, 2)
	wg.Add(2)
	go func() { defer wg.Done(); errorsCh <- f.s.executeNode(f.ctx, &claims[0]) }()
	go func() { defer wg.Done(); errorsCh <- f.s.HandleEvent(f.ctx, event) }()
	wg.Wait()
	close(errorsCh)
	for err := range errorsCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	if status, _ := f.state(id); status != "exited" {
		t.Fatal(status)
	}
	if status, port, _ := f.execution(id, 0); status != "exited" || port != "" {
		t.Fatalf("conversion lost: %s %s", status, port)
	}
	f.s.failClaim(f.ctx, &claims[0], errors.New("late failure"))
	if status, _ := f.state(id); status != "exited" {
		t.Fatalf("stale failure overwrote exit: %s", status)
	}
	if f.count("journey_outbox") != 0 {
		t.Fatal("conversion enqueued a message")
	}
}

func TestRuntimePausedWaitUsesItsImmutableVersion(t *testing.T) {
	f := newRuntimeFixture(t, waitGraph())
	id := f.admit("source-1", 1)
	f.tick()
	f.exec(`UPDATE journeys SET status='paused' WHERE tenant_id=$1 AND id=$2`, f.tenant, f.journey)
	f.clk.Advance(2 * time.Second)
	event := f.receipt("purchase", f.clk.Now(), true)
	if err := f.s.HandleEvent(f.ctx, event); err != nil {
		t.Fatal(err)
	}
	if status, port, _ := f.execution(id, 0); status != "resolved" || port != "matched" {
		t.Fatalf("pause did not retain match: %s %s", status, port)
	}
	if status, index := f.state(id); status != "waiting" || index != 0 {
		t.Fatalf("paused cursor advanced: %s %d", status, index)
	}
	newDef := waitGraph()
	newDef.Nodes[0].EventName = "new-event"
	newDef.Nodes[1].Push.Title = "new-version"
	f.exec(`INSERT INTO journey_versions(journey_id,version,definition) VALUES($1,2,$2)`, f.journey, f.definitionJSON(newDef))
	f.exec(`UPDATE journeys SET active_version=2 WHERE tenant_id=$1 AND id=$2`, f.tenant, f.journey)
	f.tick()
	if f.count("journey_outbox") != 0 {
		t.Fatal("paused state sent")
	}
	f.exec(`UPDATE journeys SET status='active' WHERE tenant_id=$1 AND id=$2`, f.tenant, f.journey)
	f.tick()
	f.tick()
	var title string
	var version int
	if err := f.pg.QueryRow(f.ctx, `SELECT payload->'content'->'push'->>'title',(payload->>'journey_version')::int FROM journey_outbox WHERE tenant_id=$1`, f.tenant).Scan(&title, &version); err != nil {
		t.Fatal(err)
	}
	if title != "matched" || version != 1 {
		t.Fatalf("old execution read new definition: %s v%d", title, version)
	}
}

func TestRuntimeReaperAndPauseFenceClaim(t *testing.T) {
	f := newRuntimeFixture(t, messageGraph())
	id := f.admit("source-1", 1)
	old, err := f.s.claimDue(f.ctx)
	if err != nil || len(old) != 1 {
		t.Fatalf("claims %v %v", old, err)
	}
	f.clk.Advance(claimReap + time.Second)
	if n, err := f.s.reapOnce(f.ctx); err != nil || n != 1 {
		t.Fatalf("reaper %d %v", n, err)
	}
	current, err := f.s.claimDue(f.ctx)
	if err != nil || len(current) != 1 {
		t.Fatal(err)
	}
	if err := f.s.executeNode(f.ctx, &old[0]); err != nil {
		t.Fatal(err)
	}
	if status, _ := f.state(id); status != "claimed" || f.count("journey_outbox") != 0 {
		t.Fatalf("old worker wrote: %s", status)
	}
	f.exec(`UPDATE journeys SET status='paused' WHERE tenant_id=$1 AND id=$2`, f.tenant, f.journey)
	if err := f.s.executeNode(f.ctx, &current[0]); err != nil {
		t.Fatal(err)
	}
	if status, _ := f.state(id); status != "waiting" || f.count("journey_outbox") != 0 {
		t.Fatalf("paused claim wrote: %s", status)
	}
	f.exec(`UPDATE journeys SET status='active' WHERE tenant_id=$1 AND id=$2`, f.tenant, f.journey)
	f.tick()
	if status, _ := f.state(id); status != "completed" || f.count("journey_outbox") != 1 {
		t.Fatalf("resume failed: %s", status)
	}
}

func TestRuntimeV2AdmissionAndSendIdempotency(t *testing.T) {
	f := newRuntimeFixture(t, messageGraph())
	secondDevice := uuid.NewString()
	f.exec(`INSERT INTO devices(id,tenant_id,app_id,user_id,platform,push_token,os_permission)
		VALUES($1,$2,$3,$4,'ios','other-token','granted')`, secondDevice, f.tenant, f.app, f.user)
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- f.s.enterUser(f.ctx, f.tenant, f.app, f.journey, 1, f.user, "source-1", "blast")
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if f.count("journey_states") != 1 {
		t.Fatal("duplicate concurrent admission")
	}
	f.tick()
	f.clk.Advance(time.Minute)
	f.admit("source-1", 1)
	if f.count("journey_states") != 1 {
		t.Fatal("completed entry replay created new state")
	}
	second := f.admit("source-2", 1)
	f.tick()
	if f.count("journey_states") != 2 || f.count("journey_outbox") != 4 {
		t.Fatal("new reentry was incorrectly deduplicated")
	}
	var distinct int
	if err := f.pg.QueryRow(f.ctx, `SELECT count(DISTINCT idempotency_key) FROM journey_outbox WHERE tenant_id=$1`, f.tenant).Scan(&distinct); err != nil {
		t.Fatal(err)
	}
	if distinct != 4 {
		t.Fatalf("device and state identities missing: %d", distinct)
	}
	var key string
	if err := f.pg.QueryRow(f.ctx, `SELECT idempotency_key FROM journey_outbox WHERE tenant_id=$1 AND idempotency_key LIKE $2 LIMIT 1`, f.tenant, "%:"+second).Scan(&key); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(key, "v2:") {
		t.Fatal(key)
	}
}

func TestRuntimeV1InFlightKeepsCursorAndKey(t *testing.T) {
	def := Definition{Nodes: []Node{{Type: "delay", DurationSeconds: 5}, testMessage("", "legacy")}, Settings: Settings{Category: "transactional"}}
	f := newRuntimeFixture(t, def)
	id := f.admit("ignored", 1)
	f.tick()
	if status, index := f.state(id); status != "waiting" || index != 1 {
		t.Fatalf("legacy delay changed: %s %d", status, index)
	}
	f.clk.Advance(5 * time.Second)
	f.tick()
	var key string
	if err := f.pg.QueryRow(f.ctx, `SELECT idempotency_key FROM journey_outbox WHERE tenant_id=$1`, f.tenant).Scan(&key); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("%s:1:%s:1:%s", f.journey, f.user, f.device)
	if key != want {
		t.Fatalf("legacy key changed: %s want %s", key, want)
	}
	if f.count("journey_node_executions") != 0 {
		t.Fatal("legacy states were rewritten as v2")
	}
}

func TestRuntimeBlastIgnoresTriggerReentryPolicy(t *testing.T) {
	def := messageGraph()
	def.Settings.Reentry = json.RawMessage(`"never"`)
	f := newRuntimeFixture(t, def)
	f.admit("blast:first", 1)
	f.tick()
	f.exec(`INSERT INTO journey_versions(journey_id,version,definition) VALUES($1,2,$2)`, f.journey, f.definitionJSON(def))
	f.exec(`UPDATE journeys SET active_version=2 WHERE tenant_id=$1 AND id=$2`, f.tenant, f.journey)
	f.clk.Advance(time.Second)
	f.admit("blast:second", 2)
	f.tick()
	if f.count("journey_states") != 2 || f.count("journey_outbox") != 2 {
		t.Fatal("trigger-only never policy suppressed a new blast")
	}
}

func TestRuntimeTriggerReceiptReplayAndQueuedConversion(t *testing.T) {
	def := messageGraph()
	def.Entry = Entry{Type: "trigger", TriggerEvent: "signup"}
	def.Exit.ConversionEvent = "purchase"
	f := newRuntimeFixture(t, def)
	event := f.receipt("signup", f.clk.Now(), true)
	for i := 0; i < 2; i++ {
		if err := f.s.HandleEvent(f.ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	if f.count("journey_outbox") != 1 {
		t.Fatal("receipt replay duplicated admission outbox")
	}
	var payload []byte
	if err := f.pg.QueryRow(f.ctx, `SELECT payload FROM journey_outbox WHERE tenant_id=$1`, f.tenant).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	entry := &libqueue.Message{Envelope: libqueue.Envelope{TenantID: f.tenant, AppID: f.app, Payload: payload}}
	f.clk.Advance(time.Second)
	f.receipt("purchase", f.clk.Now(), false)
	if err := f.s.handleEntry(f.ctx, entry); err != nil {
		t.Fatal(err)
	}
	if f.count("journey_states") != 0 {
		t.Fatal("queued trigger admitted after conversion")
	}
	f.clk.Advance(time.Minute)
	nextEvent := f.receipt("signup", f.clk.Now(), true)
	if err := f.s.HandleEvent(f.ctx, nextEvent); err != nil {
		t.Fatal(err)
	}
	if err := f.pg.QueryRow(f.ctx, `SELECT payload FROM journey_outbox WHERE tenant_id=$1 ORDER BY id DESC LIMIT 1`, f.tenant).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	entry.Envelope.Payload = payload
	if err := f.s.handleEntry(f.ctx, entry); err != nil {
		t.Fatal(err)
	}
	f.tick()
	if err := f.s.handleEntry(f.ctx, entry); err != nil {
		t.Fatal(err)
	}
	if f.count("journey_states") != 1 {
		t.Fatal("trigger replay reentered completed state")
	}
}

func TestRuntimeEventDoesNotCrossTenant(t *testing.T) {
	f := newRuntimeFixture(t, waitGraph())
	id := f.admit("source-1", 1)
	f.tick()
	event := f.receipt("purchase", f.clk.Now().Add(time.Second), true)
	event.Envelope.TenantID = uuid.NewString()
	if err := f.s.HandleEvent(f.ctx, event); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := f.execution(id, 0); status != "waiting" {
		t.Fatal(status)
	}
}
