package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type mergeFixture struct {
	*receiptFixture
	anonymousID, anonID string
}

func newMergeFixture(t *testing.T) *mergeFixture {
	t.Helper()
	f := &mergeFixture{receiptFixture: newReceiptFixture(t), anonymousID: uuid.NewString(), anonID: uuid.NewString()}
	ctx := context.Background()
	// Version rows do not have a tenant column. Remove only this fixture's
	// immutable snapshots before the shared fixture removes its journeys.
	t.Cleanup(func() {
		if _, err := f.c.pg.Exec(ctx, `DELETE FROM journey_versions WHERE journey_id IN
			(SELECT id FROM journeys WHERE tenant_id=$1 AND app_id=$2)`, f.tenantID, f.appID); err != nil {
			t.Errorf("cleanup merge versions: %v", err)
		}
	})
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO users (id,tenant_id,app_id,anon_id,std_attrs)
		VALUES ($1,$2,$3,$4,'{"first_name":"Anonymous","country":"KR"}')`, f.anonymousID, f.tenantID, f.appID, f.anonID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO event_customer_cursors (tenant_id,app_id,user_id,last_seq)
		VALUES ($1,$2,$3,7)`, f.tenantID, f.appID, f.anonymousID); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *mergeFixture) state(t *testing.T, userID string, schema int, status, executionStatus string) string {
	t.Helper()
	ctx := context.Background()
	journeyID, stateID := uuid.NewString(), uuid.NewString()
	// Deliberately point the current journey version at the opposite schema.
	// Only the state's original snapshot may determine whether it is v2.
	otherSchema := 3 - schema
	definition := fmt.Sprintf(`{"schema_version":%d}`, schema)
	otherDefinition := fmt.Sprintf(`{"schema_version":%d}`, otherSchema)
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO journeys
		(id,tenant_id,app_id,name,status,active_version,draft_definition)
		VALUES ($1,$2,$3,$5,'paused',2,$4)`, journeyID, f.tenantID, f.appID, otherDefinition, "synthetic-merge-"+journeyID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO journey_versions (journey_id,version,definition)
		VALUES ($1,1,$2),($1,2,$3)`, journeyID, definition, otherDefinition); err != nil {
		t.Fatal(err)
	}
	var claimedBy, claimToken *string
	var claimedAt *time.Time
	now := f.clk.Now()
	if status == "claimed" {
		claimedBy, claimToken, claimedAt = strp("synthetic-worker"), strp(uuid.NewString()), &now
	}
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO journey_states
		(id,tenant_id,app_id,journey_id,journey_version,user_id,current_node,status,next_wake_at,claimed_by,claimed_at,claim_token,entered_at,updated_at)
		VALUES ($1,$2,$3,$4,1,$5,1,$6,$7,$8,$9,$10,$7,$7)`, stateID, f.tenantID, f.appID, journeyID, userID,
		status, now, claimedBy, claimedAt, claimToken); err != nil {
		t.Fatal(err)
	}
	if executionStatus != "" {
		if _, err := f.c.pg.Exec(ctx, `INSERT INTO journey_node_executions
			(state_id,node_id,node_index,tenant_id,app_id,journey_id,journey_version,user_id,status,arrived_at,wait_event,after_seq,deadline,context)
			VALUES ($1,'wait',1,$2,$3,$4,1,$5,$6,$7,'purchase',7,$8,'{"retained":"snapshot"}')`,
			stateID, f.tenantID, f.appID, journeyID, userID, executionStatus, now.Add(-time.Hour), now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO journey_node_executions
		(state_id,node_id,node_index,tenant_id,app_id,journey_id,journey_version,user_id,status,arrived_at,resolved_at,output_port)
		VALUES ($1,'previous',0,$2,$3,$4,1,$5,'resolved',$6,$6,'next')`,
		stateID, f.tenantID, f.appID, journeyID, userID, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	return stateID
}

func (f *mergeFixture) stateSnapshot(t *testing.T, stateID string) string {
	t.Helper()
	var result string
	err := f.c.pg.QueryRow(context.Background(), `SELECT jsonb_build_object('state',to_jsonb(s),
		'nodes',(SELECT jsonb_agg(n ORDER BY n.node_index) FROM journey_node_executions n
		 WHERE n.tenant_id=$1 AND n.app_id=$2 AND n.state_id=s.id))::text
		FROM journey_states s WHERE s.tenant_id=$1 AND s.app_id=$2 AND s.id=$3`, f.tenantID, f.appID, stateID).Scan(&result)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *mergeFixture) receiptSnapshot(t *testing.T) string {
	t.Helper()
	var result string
	err := f.c.pg.QueryRow(context.Background(), `SELECT jsonb_build_object(
		'receipts',(SELECT jsonb_agg(e ORDER BY e.user_id,e.receipt_seq) FROM event_receipts e WHERE e.tenant_id=$1 AND e.app_id=$2),
		'cursors',(SELECT jsonb_agg(c ORDER BY c.user_id) FROM event_customer_cursors c WHERE c.tenant_id=$1 AND c.app_id=$2))::text`,
		f.tenantID, f.appID).Scan(&result)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestIdentifyMergeExitsOnlyAnonymousV2AndPreservesReceipts(t *testing.T) {
	f := newMergeFixture(t)
	ctx := context.Background()
	f.receipt(t, "purchase", f.clk.Now())
	alias := *f.receiptFixture
	alias.userID = f.anonymousID
	alias.receipt(t, "purchase", f.clk.Now().Add(-time.Minute))
	beforeReceipts := f.receiptSnapshot(t)
	if _, err := f.c.pg.Exec(ctx, `UPDATE users SET std_attrs='{"first_name":"Known"}'
		WHERE tenant_id=$1 AND app_id=$2 AND id=$3`, f.tenantID, f.appID, f.userID); err != nil {
		t.Fatal(err)
	}
	deviceID := uuid.NewString()
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO devices (id,tenant_id,app_id,user_id,platform)
		VALUES ($1,$2,$3,$4,'ios')`, deviceID, f.tenantID, f.appID, f.anonymousID); err != nil {
		t.Fatal(err)
	}
	stopped := []string{
		f.state(t, f.anonymousID, 2, "waiting", "waiting"),
		f.state(t, f.anonymousID, 2, "claimed", "retrying"),
		f.state(t, f.anonymousID, 2, "active", "arrived"),
		f.state(t, f.anonymousID, 2, "active", ""),
	}
	unchanged := []string{
		f.state(t, f.userID, 2, "waiting", "waiting"),
		f.state(t, f.userID, 2, "claimed", "retrying"),
		f.state(t, f.anonymousID, 1, "waiting", "waiting"),
		f.state(t, f.anonymousID, 1, "claimed", "retrying"),
		f.state(t, f.anonymousID, 2, "completed", "resolved"),
		f.state(t, f.anonymousID, 2, "failed", "failed"),
	}
	before := map[string]string{}
	for _, stateID := range unchanged {
		before[stateID] = f.stateSnapshot(t, stateID)
	}
	identify := &IdentifyPayload{ExternalID: "synthetic-customer", AnonID: &f.anonID}
	finalID, _, err := ProcessIdentify(ctx, f.c.pg, f.tenantID, f.appID, identify, uuid.NewString(), f.clk.Now())
	if err != nil || finalID != f.userID {
		t.Fatalf("identify: %s %v", finalID, err)
	}
	for _, stateID := range stopped {
		var status, reason string
		var hasWakeOrClaim bool
		if err := f.c.pg.QueryRow(ctx, `SELECT status,fail_reason,
			(next_wake_at IS NOT NULL OR claimed_by IS NOT NULL OR claimed_at IS NOT NULL OR claim_token IS NOT NULL)
			FROM journey_states WHERE tenant_id=$1 AND app_id=$2 AND id=$3`, f.tenantID, f.appID, stateID).
			Scan(&status, &reason, &hasWakeOrClaim); err != nil {
			t.Fatal(err)
		}
		if status != "exited" || reason != "identity_merged" || hasWakeOrClaim {
			t.Fatalf("v2 anonymous execution not fenced: %s %s claim/wake=%v", status, reason, hasWakeOrClaim)
		}
		var invalid int
		if err := f.c.pg.QueryRow(ctx, `SELECT count(*) FROM journey_node_executions
			WHERE tenant_id=$1 AND app_id=$2 AND state_id=$3 AND (
			 (node_index=1 AND (status!='exited' OR failure_reason IS DISTINCT FROM 'identity_merged' OR resolved_at IS NULL)) OR
			 (node_index=0 AND (status!='resolved' OR output_port!='next' OR failure_reason IS NOT NULL)))`,
			f.tenantID, f.appID, stateID).Scan(&invalid); err != nil || invalid != 0 {
			t.Fatalf("node exit/history mismatch: %d %v", invalid, err)
		}
	}
	for _, stateID := range unchanged {
		if got := f.stateSnapshot(t, stateID); got != before[stateID] {
			t.Fatalf("canonical, v1, or terminal execution changed: %s", stateID)
		}
	}
	if got := f.receiptSnapshot(t); got != beforeReceipts {
		t.Fatal("merge changed immutable receipt identity/order/body or customer cursors")
	}
	var attrsJSON []byte
	var deviceOwner, aliasStatus, mergedInto string
	if err := f.c.pg.QueryRow(ctx, `SELECT std_attrs FROM users WHERE tenant_id=$1 AND app_id=$2 AND id=$3`,
		f.tenantID, f.appID, f.userID).Scan(&attrsJSON); err != nil {
		t.Fatal(err)
	}
	var attrs map[string]any
	if err := json.Unmarshal(attrsJSON, &attrs); err != nil || attrs["first_name"] != "Known" || attrs["country"] != "KR" {
		t.Fatalf("existing attribute merge precedence changed: %s %v", attrsJSON, err)
	}
	if err := f.c.pg.QueryRow(ctx, `SELECT user_id FROM devices WHERE tenant_id=$1 AND app_id=$2 AND id=$3`,
		f.tenantID, f.appID, deviceID).Scan(&deviceOwner); err != nil || deviceOwner != f.userID {
		t.Fatalf("device transfer changed: %s %v", deviceOwner, err)
	}
	if err := f.c.pg.QueryRow(ctx, `SELECT status,merged_into FROM users WHERE tenant_id=$1 AND app_id=$2 AND id=$3`,
		f.tenantID, f.appID, f.anonymousID).Scan(&aliasStatus, &mergedInto); err != nil || aliasStatus != "merged" || mergedInto != f.userID {
		t.Fatalf("alias tombstone changed: %s %s %v", aliasStatus, mergedInto, err)
	}
	firstExit := f.stateSnapshot(t, stopped[0])
	if _, _, err := ProcessIdentify(ctx, f.c.pg, f.tenantID, f.appID, identify, uuid.NewString(), f.clk.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if f.stateSnapshot(t, stopped[0]) != firstExit || f.receiptSnapshot(t) != beforeReceipts {
		t.Fatal("identify replay changed an exit or first receipt")
	}
}

func TestIdentifyPromotionPreservesAnonymousV2Execution(t *testing.T) {
	f := newMergeFixture(t)
	stateID := f.state(t, f.anonymousID, 2, "waiting", "waiting")
	before := f.stateSnapshot(t, stateID)
	finalID, _, err := ProcessIdentify(context.Background(), f.c.pg, f.tenantID, f.appID,
		&IdentifyPayload{ExternalID: "new-synthetic-customer", AnonID: &f.anonID}, uuid.NewString(), f.clk.Now())
	if err != nil || finalID != f.anonymousID || f.stateSnapshot(t, stateID) != before {
		t.Fatalf("same-profile promotion must preserve v2 execution: %s %v", finalID, err)
	}
}

func TestIdentifyWaitsForAllCursorsBeforeLockingProfiles(t *testing.T) {
	f := newMergeFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	blocker, err := f.c.pg.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	// Block the last cursor: identify may already own the first, but must not
	// own either profile row while it waits for the second cursor.
	lastID := f.userID
	if f.anonymousID > lastID {
		lastID = f.anonymousID
	}
	if err := lockCustomerCursor(ctx, blocker, f.tenantID, f.appID, lastID); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		_, _, err := ProcessIdentify(ctx, f.c.pg, f.tenantID, f.appID,
			&IdentifyPayload{ExternalID: "synthetic-customer", AnonID: &f.anonID}, uuid.NewString(), f.clk.Now())
		finished <- err
	}()
	waitForIdentifyLock(t, ctx, f, blocker, finished)
	rows, err := blocker.Query(ctx, `SELECT id FROM users WHERE tenant_id=$1 AND app_id=$2
		AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE NOWAIT`, f.tenantID, f.appID, []string{f.userID, f.anonymousID})
	if err != nil {
		t.Fatalf("identify held a profile while waiting for a cursor: %v", err)
	}
	for rows.Next() {
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		t.Fatalf("identify held a profile while waiting for a cursor: %v", err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatalf("identify failed after cursor release: %v", err)
	}
}

func waitForIdentifyLock(t *testing.T, ctx context.Context, f *mergeFixture, blocker pgx.Tx, finished <-chan error) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		err := f.c.pg.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
			WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock')`,
			int32(blocker.Conn().PgConn().PID())).Scan(&blocked)
		if err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case err := <-finished:
			t.Fatalf("identify bypassed the receipt cursor: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
}
