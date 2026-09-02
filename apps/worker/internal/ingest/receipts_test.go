package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
)

type receiptTestCH struct {
	driver.Conn
	mu         sync.Mutex
	failEvents bool
	events     [][]any
	afterSend  func()
}
type receiptTestBatch struct {
	driver.Batch
	owner *receiptTestCH
	query string
	rows  [][]any
}

func (ch *receiptTestCH) PrepareBatch(_ context.Context, query string, _ ...driver.PrepareBatchOption) (driver.Batch, error) {
	return &receiptTestBatch{owner: ch, query: query}, nil
}
func (b *receiptTestBatch) Append(values ...any) error {
	b.rows = append(b.rows, append([]any(nil), values...))
	return nil
}
func (b *receiptTestBatch) Close() error { return nil }
func (b *receiptTestBatch) Send() error {
	b.owner.mu.Lock()
	defer b.owner.mu.Unlock()
	if strings.Contains(b.query, "INSERT INTO events") {
		if b.owner.failEvents {
			return errors.New("injected CH durable insert failure")
		}
		b.owner.events = append(b.owner.events, b.rows...)
		if b.owner.afterSend != nil {
			b.owner.afterSend()
		}
	}
	return nil
}

type receiptFixture struct {
	c                       *Consumer
	tenantID, appID, userID string
	ch                      *receiptTestCH
	clk                     *clock.Fake
}

func newReceiptFixture(t *testing.T) *receiptFixture {
	t.Helper()
	dsn := os.Getenv("NUDGEON_RECEIPT_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set NUDGEON_RECEIPT_TEST_DATABASE_URL to an isolated local PostgreSQL database")
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		t.Fatal("receipt integration tests require loopback PostgreSQL")
	}
	ctx := context.Background()
	pg, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	f := &receiptFixture{tenantID: uuid.NewString(), appID: uuid.NewString(), userID: uuid.NewString(),
		ch: &receiptTestCH{}, clk: &clock.Fake{Current: time.Date(2026, 8, 31, 5, 0, 0, 0, time.UTC)}}
	f.c = &Consumer{pg: pg, ch: f.ch, clk: f.clk, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	t.Cleanup(func() {
		for _, table := range []string{"journey_outbox", "event_receipts", "event_customer_cursors", "journey_node_executions", "journey_states", "journeys", "devices", "user_merges", "users", "apps", "tenants"} {
			column := "tenant_id"
			if table == "tenants" {
				column = "id"
			}
			if _, err := pg.Exec(ctx, "DELETE FROM "+table+" WHERE "+column+" = $1", f.tenantID); err != nil {
				t.Errorf("cleanup %s: %v", table, err)
			}
		}
		pg.Close()
	})
	for _, command := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO tenants (id, name) VALUES ($1, 'receipt-test')`, []any{f.tenantID}},
		{`INSERT INTO apps (id, tenant_id, name) VALUES ($1, $2, 'synthetic')`, []any{f.appID, f.tenantID}},
		{`INSERT INTO users (id, tenant_id, app_id, external_id) VALUES ($1, $2, $3, 'synthetic-customer')`, []any{f.userID, f.tenantID, f.appID}},
		{`INSERT INTO event_customer_cursors (tenant_id, app_id, user_id, last_seq) VALUES ($1, $2, $3, 0)`, []any{f.tenantID, f.appID, f.userID}},
	} {
		if _, err := pg.Exec(ctx, command.sql, command.args...); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f *receiptFixture) receipt(t *testing.T, event string, received time.Time) *receipt {
	t.Helper()
	r := &receipt{tenantID: f.tenantID, appID: f.appID, insertID: uuid.NewString(), userID: f.userID,
		eventName: event, properties: json.RawMessage(`{"order_id":"synthetic-order","nested":{"valid":true}}`),
		clientTS: &received, receivedAt: received}
	ctx := context.Background()
	if err := f.c.pg.QueryRow(ctx, `UPDATE event_customer_cursors SET last_seq = last_seq + 1
		WHERE tenant_id = $1 AND app_id = $2 AND user_id = $3 RETURNING last_seq`, f.tenantID, f.appID, f.userID).Scan(&r.seq); err != nil {
		t.Fatal(err)
	}
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO event_receipts
		(tenant_id, app_id, insert_id, user_id, event_name, properties, client_ts, received_at, receipt_seq)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, f.tenantID, f.appID, r.insertID, f.userID, event, r.properties, received, received, r.seq); err != nil {
		t.Fatal(err)
	}
	return r
}

func (f *receiptFixture) rows(t *testing.T, r *receipt) *chRows {
	t.Helper()
	rows := newCHRows()
	err := f.c.handleTrack(context.Background(), f.tenantID, f.appID, &IngestBatchPayload{Endpoint: "track", RequestID: uuid.NewString(),
		Events: []TrackEvent{{InsertID: r.insertID, UserID: r.userID, ReceiptSeq: fmt.Sprint(r.seq), ReceivedAt: r.receivedAt,
			Event: "spoofed-stream-name", Properties: json.RawMessage(`{"changed":true}`)}}}, rows)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func TestReceiptProjectionCommitAndReplay(t *testing.T) {
	f := newReceiptFixture(t)
	ctx := context.Background()
	r := f.receipt(t, "purchase", f.clk.Now())
	f.ch.failEvents = true
	if err := f.c.flushAndProject(ctx, f.rows(t, r)); err == nil {
		t.Fatal("injected CH failure must fail projection")
	}
	pending, err := loadReceipt(ctx, f.c.pg, f.tenantID, f.appID, r.insertID)
	if err != nil || pending.projectedAt != nil {
		t.Fatalf("failure marked readiness: %+v, %v", pending, err)
	}
	var count int
	if err := f.c.pg.QueryRow(ctx, `SELECT count(*) FROM journey_outbox WHERE tenant_id = $1 AND app_id = $2`, f.tenantID, f.appID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed projection published: %d %v", count, err)
	}
	f.ch.failEvents = false
	if err := f.c.flushAndProject(ctx, f.rows(t, r)); err != nil {
		t.Fatal(err)
	}
	done, err := loadReceipt(ctx, f.c.pg, f.tenantID, f.appID, r.insertID)
	if err != nil || done.projectedAt == nil || done.matchedAt != nil {
		t.Fatalf("projection readiness incorrect: %+v %v", done, err)
	}
	var payload []byte
	if err := f.c.pg.QueryRow(ctx, `SELECT payload FROM journey_outbox WHERE tenant_id = $1 AND app_id = $2`, f.tenantID, f.appID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var normalized map[string]any
	if err := json.Unmarshal(payload, &normalized); err != nil {
		t.Fatal(err)
	}
	if normalized["insert_id"] != r.insertID || normalized["receipt_seq"] != "1" || normalized["event_name"] != "purchase" {
		t.Fatalf("identity not stable: %s", payload)
	}
	if normalized["properties"].(map[string]any)["order_id"] != "synthetic-order" {
		t.Fatalf("properties lost: %s", payload)
	}
	if err := f.c.flushAndProject(ctx, f.rows(t, r)); err != nil {
		t.Fatal(err)
	}
	if len(f.ch.events) != 1 {
		t.Fatalf("replay projected again: %d", len(f.ch.events))
	}
	if err := f.c.pg.QueryRow(ctx, `SELECT count(*) FROM journey_outbox WHERE tenant_id = $1 AND app_id = $2`, f.tenantID, f.appID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate normalized job: %d %v", count, err)
	}
}

func TestReceiptRepairRetainsFirstReceipt(t *testing.T) {
	f := newReceiptFixture(t)
	ctx := context.Background()
	r := f.receipt(t, "purchase", f.clk.Now().Add(-time.Hour))
	if err := f.c.requeueReceipt(ctx, f.tenantID, f.appID, f.userID, r.insertID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.c.pg.Exec(ctx, `UPDATE journey_outbox SET published_at = $2 WHERE tenant_id = $1`, f.tenantID, f.clk.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := f.c.repairReceiptScope(ctx, f.tenantID, f.appID); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.c.pg.QueryRow(ctx, `SELECT count(*) FROM journey_outbox WHERE tenant_id = $1 AND app_id = $2 AND published_at IS NULL`, f.tenantID, f.appID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("lost stream entry not rearmed: %d %v", count, err)
	}
	again, err := loadReceipt(ctx, f.c.pg, f.tenantID, f.appID, r.insertID)
	if err != nil || again.seq != r.seq || !again.receivedAt.Equal(r.receivedAt) {
		t.Fatalf("repair assigned new receipt: %+v %v", again, err)
	}
}

func TestReceiptCrashAfterCHBeforePGCommitIsRetryable(t *testing.T) {
	f := newReceiptFixture(t)
	r := f.receipt(t, "purchase", f.clk.Now())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.ch.afterSend = cancel
	if err := f.c.flushAndProject(ctx, f.rows(t, r)); err == nil {
		t.Fatal("canceled projection must not commit PG readiness")
	}
	ready, err := loadReceipt(context.Background(), f.c.pg, f.tenantID, f.appID, r.insertID)
	if err != nil || ready.projectedAt != nil {
		t.Fatalf("crash advertised an uncommitted projection: %+v %v", ready, err)
	}
	f.ch.afterSend = nil
	if err := f.c.flushAndProject(context.Background(), f.rows(t, r)); err != nil {
		t.Fatal(err)
	}
	var jobs int
	if err := f.c.pg.QueryRow(context.Background(), `SELECT count(*) FROM journey_outbox
		WHERE tenant_id = $1 AND app_id = $2`, f.tenantID, f.appID).Scan(&jobs); err != nil || jobs != 1 {
		t.Fatalf("recovery must publish one stable normalized event: %d %v", jobs, err)
	}
}

func TestReceiptCleanupPreservesPendingWaitAndProjection(t *testing.T) {
	f := newReceiptFixture(t)
	ctx := context.Background()
	old := f.clk.Now().Add(-31 * 24 * time.Hour)
	pending := f.receipt(t, "unprojected", old)
	waiting := f.receipt(t, "purchase", old)
	done := f.receipt(t, "unreferenced", old)
	if _, err := f.c.pg.Exec(ctx, `UPDATE event_receipts SET projected_at = $3, matched_at = $3
		WHERE tenant_id = $1 AND app_id = $2 AND insert_id != $4`, f.tenantID, f.appID, f.clk.Now(), pending.insertID); err != nil {
		t.Fatal(err)
	}
	journey, state := uuid.NewString(), uuid.NewString()
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO journeys (id, tenant_id, app_id, name) VALUES ($1,$2,$3,'receipt-wait')`, journey, f.tenantID, f.appID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO journey_states (id, tenant_id, app_id, journey_id, journey_version, user_id, status)
		VALUES ($1,$2,$3,$4,1,$5,'waiting')`, state, f.tenantID, f.appID, journey, f.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO journey_node_executions
		(state_id,node_id,node_index,tenant_id,app_id,journey_id,journey_version,user_id,status,arrived_at,wait_event,after_seq,deadline)
		VALUES ($1,'wait',0,$2,$3,$4,1,$5,'waiting',$6,'purchase',0,$7)`, state, f.tenantID, f.appID, journey, f.userID, old.Add(-time.Hour), old.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := f.c.cleanReceiptBodies(ctx, f.tenantID, f.appID); err != nil {
		t.Fatal(err)
	}
	for _, r := range []*receipt{pending, waiting, done} {
		actual, err := loadReceipt(ctx, f.c.pg, f.tenantID, f.appID, r.insertID)
		if err != nil || actual == nil || actual.seq != r.seq {
			t.Fatalf("tombstone missing: %+v %v", actual, err)
		}
		if r == done && (len(actual.properties) != 0 || actual.clientTS != nil) {
			t.Fatal("resolved old receipt body not purged")
		}
		if r != done && (len(actual.properties) == 0 || actual.clientTS == nil) {
			t.Fatal("pending projection or wait lost its body")
		}
	}
}

func TestReceiptUserDeletionDoesNotReproject(t *testing.T) {
	f := newReceiptFixture(t)
	ctx := context.Background()
	r := f.receipt(t, "purchase", f.clk.Now())
	rows := f.rows(t, r) // worker claimed the receipt before user deletion
	if err := f.c.requeueReceipt(ctx, f.tenantID, f.appID, f.userID, r.insertID); err != nil {
		t.Fatal(err)
	}
	deleted, err := f.c.anonymizeUser(ctx, f.tenantID, f.appID, "synthetic-customer")
	if err != nil || len(deleted) != 1 || deleted[0] != f.userID {
		t.Fatalf("delete: %v %v", deleted, err)
	}
	if err := f.c.flushAndProject(ctx, rows); err != nil {
		t.Fatal(err)
	}
	if len(f.ch.events) != 0 {
		t.Fatal("in-flight projection resurrected deleted customer event")
	}
	if err := f.c.requeueReceipt(ctx, f.tenantID, f.appID, f.userID, r.insertID); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"event_receipts", "journey_outbox", "event_customer_cursors"} {
		var count int
		if err := f.c.pg.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE tenant_id = $1", f.tenantID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("deleted receipt retained in %s: %d %v", table, count, err)
		}
	}
}

func TestReceiptDeletionIncludesMergedAliasAndExitsPendingExecution(t *testing.T) {
	f := newReceiptFixture(t)
	ctx := context.Background()
	alias := uuid.NewString()
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO users (id,tenant_id,app_id,anon_id,status,merged_into,std_attrs)
		VALUES ($1,$2,$3,$4,'merged',$5,'{"first_name":"Synthetic"}')`, alias, f.tenantID, f.appID, uuid.NewString(), f.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO event_customer_cursors (tenant_id,app_id,user_id)
		VALUES ($1,$2,$3)`, f.tenantID, f.appID, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO user_merges (tenant_id,app_id,from_user_id,to_user_id)
		VALUES ($1,$2,$3,$4)`, f.tenantID, f.appID, alias, f.userID); err != nil {
		t.Fatal(err)
	}
	aliasFixture := *f
	aliasFixture.userID = alias
	r := aliasFixture.receipt(t, "purchase", f.clk.Now())
	stale := aliasFixture.rows(t, r)
	if err := f.c.requeueReceipt(ctx, f.tenantID, f.appID, alias, r.insertID); err != nil {
		t.Fatal(err)
	}
	journey, state := uuid.NewString(), uuid.NewString()
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO journeys (id,tenant_id,app_id,name)
		VALUES ($1,$2,$3,'delete-alias')`, journey, f.tenantID, f.appID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO journey_states (id,tenant_id,app_id,journey_id,journey_version,user_id,status,claim_token)
		VALUES ($1,$2,$3,$4,1,$5,'claimed',gen_random_uuid())`, state, f.tenantID, f.appID, journey, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := f.c.pg.Exec(ctx, `INSERT INTO journey_node_executions
		(state_id,node_id,node_index,tenant_id,app_id,journey_id,journey_version,user_id,status,arrived_at,wait_event,after_seq,deadline,context)
		VALUES ($1,'wait',0,$2,$3,$4,1,$5,'waiting',$6,'purchase',0,$7,'{"first_name":"Synthetic"}')`,
		state, f.tenantID, f.appID, journey, alias, f.clk.Now().Add(-time.Hour), f.clk.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	ids, err := f.c.anonymizeUser(ctx, f.tenantID, f.appID, "synthetic-customer")
	if err != nil || len(ids) != 2 {
		t.Fatalf("alias deletion: %v %v", ids, err)
	}
	if err := f.c.flushAndProject(ctx, stale); err != nil {
		t.Fatal(err)
	}
	if len(f.ch.events) != 0 {
		t.Fatal("old alias receipt reprojected after deletion")
	}
	var status, executionStatus string
	var contextJSON []byte
	var hasClaim bool
	if err := f.c.pg.QueryRow(ctx, `SELECT s.status,n.status,n.context,s.claim_token IS NOT NULL FROM journey_states s
		JOIN journey_node_executions n ON n.state_id=s.id
		WHERE s.tenant_id=$1 AND s.app_id=$2 AND s.id=$3`, f.tenantID, f.appID, state).Scan(&status, &executionStatus, &contextJSON, &hasClaim); err != nil {
		t.Fatal(err)
	}
	if status != "exited" || executionStatus != "exited" || string(contextJSON) != "{}" || hasClaim {
		t.Fatalf("pending execution survived deletion: %s %s %s claim=%v", status, executionStatus, contextJSON, hasClaim)
	}
	for _, table := range []string{"event_receipts", "event_customer_cursors", "journey_outbox", "user_merges"} {
		var count int
		if err := f.c.pg.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE tenant_id=$1 AND app_id=$2", f.tenantID, f.appID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("alias data retained in %s: %d %v", table, count, err)
		}
	}
}

func TestReceiptProjectionActualClickHouse(t *testing.T) {
	dsn := os.Getenv("NUDGEON_RECEIPT_TEST_CLICKHOUSE_DSN")
	if dsn == "" {
		t.Skip("set NUDGEON_RECEIPT_TEST_CLICKHOUSE_DSN for actual ClickHouse verification")
	}
	f := newReceiptFixture(t)
	u, err := url.Parse(dsn)
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		t.Fatal("ClickHouse test requires loopback")
	}
	opts, err := clickhouse.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := clickhouse.Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	f.c.ch = conn
	t.Cleanup(func() {
		for _, table := range []string{"events", "profiles_mirror"} {
			_ = conn.Exec(context.Background(), "ALTER TABLE "+table+" DELETE WHERE tenant_id = ? AND app_id = ?", f.tenantID, f.appID)
		}
		_ = conn.Close()
	})
	r := f.receipt(t, "receipt_verified", f.clk.Now())
	if err := f.c.flushAndProject(context.Background(), f.rows(t, r)); err != nil {
		t.Fatal(err)
	}
	var count uint64
	if err := conn.QueryRow(context.Background(), `SELECT count() FROM events
		WHERE tenant_id = ? AND app_id = ? AND insert_id = ?`, f.tenantID, f.appID, r.insertID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("CH visibility before ready: %d %v", count, err)
	}
	ready, err := loadReceipt(context.Background(), f.c.pg, f.tenantID, f.appID, r.insertID)
	if err != nil || ready.projectedAt == nil {
		t.Fatalf("ready not committed: %+v %v", ready, err)
	}
}

func TestNormalizedReceiptPayloadKeepsDecimalSequenceAndClientTime(t *testing.T) {
	at := time.Date(2026, 8, 31, 1, 2, 3, 123456000, time.UTC)
	r := &receipt{insertID: "synthetic-id", userID: "synthetic-user", eventName: "purchase", seq: 9007199254740993,
		clientTS: &at, receivedAt: at, properties: json.RawMessage(`{"message_id":"synthetic-message"}`)}
	body, err := r.normalizedPayload()
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["receipt_seq"] != "9007199254740993" || decoded["received_at"] != "2026-08-31T01:02:03.123456Z" {
		t.Fatalf("lossy receipt: %s", body)
	}
}
