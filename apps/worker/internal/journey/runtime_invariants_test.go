package journey

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/google/uuid"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/ingest"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/segment"
)

func TestRuntimeABStableAcrossVersionsAndArrayOrder(t *testing.T) {
	ab := Node{ID: "experiment", Type: "ab_split", Variants: []Variant{{ID: "a", Label: "A", Weight: 40}, {ID: "b", Label: "B", Weight: 60}}}
	def := testGraph([]Node{ab, testMessage("message", "same")}, []Edge{testEdge("experiment", "a", "message"), testEdge("experiment", "b", "message"), testEdge("message", "next", "")}, "experiment")
	f := newRuntimeFixture(t, def)
	first := f.admit("first", 1)
	f.tick()
	_, chosen, _ := f.execution(first, 0)
	f.tick()
	def.Nodes = []Node{def.Nodes[1], ab}
	def.Nodes[1].Variants = []Variant{ab.Variants[1], ab.Variants[0]}
	f.exec(`INSERT INTO journey_versions(journey_id,version,definition) VALUES($1,2,$2)`, f.journey, f.definitionJSON(def))
	f.exec(`UPDATE journeys SET active_version=2 WHERE tenant_id=$1 AND id=$2`, f.tenant, f.journey)
	f.clk.Advance(time.Second)
	second := f.admit("second", 2)
	f.tick()
	if status, port, _ := f.execution(second, 1); status != "resolved" || port != chosen {
		t.Fatalf("assignment changed across version/order: %s→%s", chosen, port)
	}
	f.tick()
	if f.count("journey_outbox") != 2 {
		t.Fatal("A/B reentry lost its message")
	}
}

func TestRuntimeAudienceBatchIsScopedAndReplaySafe(t *testing.T) {
	for _, schemaVersion := range []int{1, 2} {
		t.Run(strconv.Itoa(schemaVersion), func(t *testing.T) {
			def := messageGraph()
			def.SchemaVersion = schemaVersion
			if schemaVersion == 1 {
				def.StartNodeID = nil
				def.Edges = nil
			}
			f := newRuntimeFixture(t, def)
			f.receipt("before-entry", f.clk.Now().Add(-time.Second), true)
			unknown := uuid.NewString()
			audience := uuid.NewString()
			for i := 0; i < 2; i++ {
				if err := f.s.enterAudiencePage(f.ctx, f.tenant, f.app, f.journey, 1, []string{unknown, f.user, f.user}, audience); err != nil {
					t.Fatal(err)
				}
			}
			if f.count("journey_states") != 1 {
				t.Fatal("batch duplicated customers or included unknown user")
			}
			var entryID *string
			var seq *int64
			if err := f.pg.QueryRow(f.ctx, `SELECT entry_id,entry_seq FROM journey_states WHERE tenant_id=$1`, f.tenant).Scan(&entryID, &seq); err != nil {
				t.Fatal(err)
			}
			if schemaVersion == 1 && (entryID != nil || seq != nil) {
				t.Fatal("v1 admission identity changed")
			}
			if schemaVersion == 2 && (entryID == nil || seq == nil || *seq != 1) {
				t.Fatal("v2 admission missed receipt fence")
			}
		})
	}
}

func TestRuntimeSameJourneyCustomersEvaluateConcurrently(t *testing.T) {
	f := newRuntimeFixture(t, branchGraph(true))
	f.admit("first", 1)
	other := uuid.NewString()
	f.exec(`INSERT INTO users(id,tenant_id,app_id,custom_attrs) VALUES($1,$2,$3,'{"score":12}')`, other, f.tenant, f.app)
	if err := f.s.enterUser(f.ctx, f.tenant, f.app, f.journey, 1, other, "second", "blast"); err != nil {
		t.Fatal(err)
	}
	claims, err := f.s.claimDue(f.ctx)
	if err != nil || len(claims) != 2 {
		t.Fatalf("claims %d: %v", len(claims), err)
	}
	started, release := make(chan struct{}, 2), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	f.s.eventLookup = func(ctx context.Context, _ eventQuery) (bool, error) {
		started <- struct{}{}
		select {
		case <-release:
			return true, nil
		case <-ctx.Done():
			return false, ctx.Err()
		}
	}
	errCh := make(chan error, 2)
	for i := range claims {
		go func(c claimedState) { errCh <- f.s.executeNode(f.ctx, &c) }(claims[i])
	}
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			once.Do(func() { close(release) })
			for range claims {
				<-errCh
			}
			t.Fatal("journey read lock serialized independent customers")
		}
	}
	once.Do(func() { close(release) })
	for range claims {
		if err := <-errCh; err != nil {
			t.Fatal(err)
		}
	}
}

func TestRuntimeProjectionPendingCannotSelectNotPerformed(t *testing.T) {
	def := branchGraph(true)
	def.Nodes[0].Condition.Groups[0].Conditions[1].Op = "not_performed"
	f := newRuntimeFixture(t, def)
	event := f.receipt("purchase", f.clk.Now().Add(-time.Second), false)
	id := f.admit("first", 1)
	lookups := 0
	f.s.eventLookup = func(context.Context, eventQuery) (bool, error) { lookups++; return true, nil }
	f.tick()
	if _, port, retries := f.execution(id, 0); port != "" || retries != 1 || lookups != 0 {
		t.Fatalf("projection gap evaluated as missing: %s %d %d", port, retries, lookups)
	}
	var p struct {
		InsertID string `json:"insert_id"`
	}
	_ = json.Unmarshal(event.Envelope.Payload, &p)
	f.exec(`UPDATE event_receipts SET projected_at=$3 WHERE tenant_id=$1 AND insert_id=$2`, f.tenant, p.InsertID, f.clk.Now())
	f.clk.Advance(time.Second)
	f.tick()
	if _, port, _ := f.execution(id, 0); port != "false" || lookups != 1 {
		t.Fatalf("performed event did not invalidate not_performed: %s", port)
	}
}

func TestRuntimeMergedAnonymousCustomerCannotResumeOldClaim(t *testing.T) {
	f := newRuntimeFixture(t, waitGraph())
	anonID, canonicalID := uuid.NewString(), uuid.NewString()
	f.exec(`UPDATE users SET anon_id=$3 WHERE tenant_id=$1 AND id=$2`, f.tenant, f.user, anonID)
	f.exec(`INSERT INTO users(id,tenant_id,app_id,external_id) VALUES($1,$2,$3,'canonical-customer')`, canonicalID, f.tenant, f.app)
	id := f.admit("anonymous-entry", 1)
	f.tick()
	f.clk.Advance(11 * time.Second)
	claims, err := f.s.claimDue(f.ctx)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claims=%d %v", len(claims), err)
	}
	userID, _, err := ingest.ProcessIdentify(f.ctx, f.pg, f.tenant, f.app, &ingest.IdentifyPayload{ExternalID: "canonical-customer", AnonID: &anonID}, uuid.NewString(), f.clk.Now())
	if err != nil || userID != canonicalID {
		t.Fatalf("identify=%s %v", userID, err)
	}
	if err := f.s.executeNode(f.ctx, &claims[0]); err != nil {
		t.Fatal(err)
	}
	f.user = canonicalID
	event := f.receipt("purchase", f.clk.Now(), true)
	if err := f.s.HandleEvent(f.ctx, event); err != nil {
		t.Fatal(err)
	}
	if status, _ := f.state(id); status != "exited" {
		t.Fatalf("merged claim resumed: %s", status)
	}
	var reason string
	if err := f.pg.QueryRow(f.ctx, `SELECT fail_reason FROM journey_states WHERE tenant_id=$1 AND id=$2`, f.tenant, id).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason != "identity_merged" {
		t.Fatalf("missing explicit merge reason: %s", reason)
	}
	if status, port, _ := f.execution(id, 0); status != "exited" || port != "" {
		t.Fatalf("merged wait resolved: %s %s", status, port)
	}
	if f.count("journey_outbox") != 0 {
		t.Fatal("merged old claim enqueued a message")
	}
}

func TestRuntimeBranchUsesCustomerSignupDate(t *testing.T) {
	def := branchGraph(false)
	def.Nodes[0].Condition.Groups[0].Conditions = []segment.Condition{{Type: "attribute", Key: "created_at", Op: "before", Value: json.RawMessage(`"2025-01-01"`)}}
	f := newRuntimeFixture(t, def)
	f.exec(`UPDATE users SET std_attrs='{"created_at":"2020-01-01"}' WHERE tenant_id=$1 AND id=$2`, f.tenant, f.user)
	id := f.admit("first", 1)
	f.tick()
	if _, port, _ := f.execution(id, 0); port != "true" {
		t.Fatalf("NudgeOn row creation replaced customer signup date: %s", port)
	}
}

func TestRuntimeReentryWaitDoesNotOverflow(t *testing.T) {
	f := newRuntimeFixture(t, messageGraph())
	f.admit("first", 1)
	f.tick()
	tx, err := f.pg.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	boundary := f.clk.Now().AddDate(0, 0, maxReentryDays)
	for _, test := range []struct {
		raw     string
		now     time.Time
		allowed bool
		invalid bool
	}{
		{`{"after_days":106751}`, boundary.Add(-time.Nanosecond), false, false},
		{`{"after_days":106751}`, boundary, true, false},
		{`{"after_days":106752}`, boundary, false, true},
		{`{"after_days":9007199254740991}`, boundary, false, true},
	} {
		allowed, err := canAdmit(f.ctx, tx, f.tenant, f.app, f.journey, f.user, json.RawMessage(test.raw), "trigger", test.now)
		if allowed != test.allowed || (err != nil) != test.invalid {
			t.Errorf("%s at %s: allowed=%v err=%v", test.raw, test.now, allowed, err)
		}
	}
}

func TestRuntimeClickHouseLookupTimeAndScope(t *testing.T) {
	dsn := os.Getenv("NUDGEON_JOURNEY_TEST_CLICKHOUSE_URL")
	if dsn == "" {
		t.Skip("set NUDGEON_JOURNEY_TEST_CLICKHOUSE_URL")
	}
	f := newRuntimeFixture(t, messageGraph())
	opts, err := clickhouse.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	ch, err := clickhouse.Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ch.Close() })
	f.s.ch = ch
	boundaryID := uuid.NewString()
	for _, e := range []struct {
		id, event string
		at        time.Time
	}{
		{uuid.NewString(), "old", f.clk.Now().Add(-31 * 24 * time.Hour)},
		{uuid.NewString(), "recent", f.clk.Now().Add(-time.Hour)},
		{boundaryID, "boundary", f.clk.Now()},
	} {
		err := ch.Exec(f.ctx, `INSERT INTO events(tenant_id,app_id,event_name,user_id,device_id,properties,client_ts,server_ts,insert_id)
			VALUES(?,?,?,?,?,'{}',?,?,?)`, f.tenant, f.app, e.event, f.user, f.device, e.at, e.at, e.id)
		if err != nil {
			t.Fatal(err)
		}
	}
	q := eventQuery{TenantID: f.tenant, AppID: f.app, UserID: f.user, Since: f.clk.Now().Add(-30 * 24 * time.Hour), Until: f.clk.Now(), BoundaryIDs: []string{}}
	for event, want := range map[string]bool{"old": false, "recent": true, "boundary": false, "absent": false} {
		q.Event = event
		got, err := f.s.lookupEvent(f.ctx, q)
		if err != nil || got != want {
			t.Fatalf("%s=%v want %v: %v", event, got, want, err)
		}
	}
	q.Event = "boundary"
	q.BoundaryIDs = []string{boundaryID}
	if got, err := f.s.lookupEvent(f.ctx, q); err != nil || !got {
		t.Fatalf("captured boundary receipt absent: %v %v", got, err)
	}
	q.TenantID = uuid.NewString()
	if got, err := f.s.lookupEvent(f.ctx, q); err != nil || got {
		t.Fatalf("CH tenant leak: %v %v", got, err)
	}
}

func TestDefinitionRejectsUnsupportedAndUnsafeGraphs(t *testing.T) {
	for name, mutate := range map[string]func(*Definition){
		"unknown schema":   func(d *Definition) { d.SchemaVersion = 3 },
		"missing port":     func(d *Definition) { d.Edges = d.Edges[:1] },
		"cycle":            func(d *Definition) { d.Edges[2].Target = &d.Nodes[0].ID },
		"duplicate id":     func(d *Definition) { d.Nodes[1].ID = d.Nodes[0].ID },
		"unknown target":   func(d *Definition) { s := "missing"; d.Edges[0].Target = &s },
		"infinite timeout": func(d *Definition) { d.Nodes[0].TimeoutSeconds = maxDurationSeconds + 1 },
		"infinite reentry": func(d *Definition) { d.Settings.Reentry = json.RawMessage(`{"after_days":106752}`) },
	} {
		t.Run(name, func(t *testing.T) {
			d := waitGraph()
			mutate(&d)
			raw, _ := json.Marshal(d)
			if _, err := ParseDefinition(raw); err == nil {
				t.Fatal("unsafe graph accepted")
			}
		})
	}
	for _, condition := range []segment.Condition{
		{Type: "event", Event: "purchase", Op: "count_gte"},
		{Type: "attribute", Key: "a", Op: "gt", Value: json.RawMessage(`"10"`)},
		{Type: "attribute", Key: "a", Op: "eq", Value: json.RawMessage(`null`)},
		{Type: "attribute", Key: "a", Op: "before", Value: json.RawMessage(`"not-a-date"`)},
		{Type: "attribute", Key: "a", Op: "in", Value: json.RawMessage(`[]`)},
	} {
		d := branchGraph(false)
		d.Nodes[0].Condition.Groups[0].Conditions = []segment.Condition{condition}
		raw, _ := json.Marshal(d)
		if _, err := ParseDefinition(raw); err == nil {
			t.Errorf("unsafe condition accepted: %+v", condition)
		}
	}
	if _, err := outboxType("stream:unknown"); err == nil {
		t.Fatal("unknown outbox stream was reinterpreted")
	}
}
