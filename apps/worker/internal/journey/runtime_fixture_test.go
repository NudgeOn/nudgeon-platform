package journey

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/ondahq/onda/apps/worker/internal/clock"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
	"github.com/redis/go-redis/v9"
)

type runtimeFixture struct {
	t                                  *testing.T
	ctx                                context.Context
	pg                                 *pgxpool.Pool
	s                                  *Scheduler
	clk                                *clock.Fake
	tenant, app, user, journey, device string
}

// Real PostgreSQL with the repository schema, isolated from other QA consumers.
// CI without an explicitly supplied integration database skips these tests.
func newRuntimeFixture(t *testing.T, def Definition) *runtimeFixture {
	t.Helper()
	dsn := os.Getenv("ONDA_JOURNEY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set ONDA_JOURNEY_TEST_DATABASE_URL for PostgreSQL runtime tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := "journey_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = 12
	pg, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pg.Close()
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("test schema cleanup: %v", err)
		}
		admin.Close()
	})
	_, file, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "../../../..", "db/postgres/schema.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pg.Exec(ctx, string(raw)); err != nil {
		t.Fatalf("apply isolated repository schema: %v", err)
	}
	clk := &clock.Fake{Current: time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)}
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	f := &runtimeFixture{t: t, ctx: ctx, pg: pg, clk: clk, tenant: uuid.NewString(), app: uuid.NewString(), user: uuid.NewString(), journey: uuid.NewString(), device: uuid.NewString()}
	f.s = NewScheduler(nil, libqueue.NewProducer(rdb, 0), pg, nil, rdb, clk, "integration", logger)
	f.exec(`INSERT INTO tenants(id,name) VALUES($1,'runtime integration')`, f.tenant)
	f.exec(`INSERT INTO apps(id,tenant_id,name,timezone) VALUES($1,$2,'runtime integration','UTC')`, f.app, f.tenant)
	f.exec(`INSERT INTO users(id,tenant_id,app_id,custom_attrs,subscriptions,created_at)
		VALUES($1,$2,$3,'{"score":12,"tags":["vip"],"enabled":true}','{"push":"opted_in"}',$4)`, f.user, f.tenant, f.app, clk.Now())
	f.exec(`INSERT INTO devices(id,tenant_id,app_id,user_id,platform,push_token,os_permission)
		VALUES($1,$2,$3,$4,'android','integration-token','granted')`, f.device, f.tenant, f.app, f.user)
	definition := f.definitionJSON(def)
	f.exec(`INSERT INTO journeys(id,tenant_id,app_id,name,status,active_version,draft_definition)
		VALUES($1,$2,$3,'runtime integration','active',1,$4)`, f.journey, f.tenant, f.app, definition)
	f.exec(`INSERT INTO journey_versions(journey_id,version,definition) VALUES($1,1,$2)`, f.journey, definition)
	return f
}

func (f *runtimeFixture) definitionJSON(def Definition) []byte {
	f.t.Helper()
	raw, err := json.Marshal(def)
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := ParseDefinition(raw); err != nil {
		f.t.Fatalf("test graph is invalid: %v", err)
	}
	return raw
}

func (f *runtimeFixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.pg.Exec(f.ctx, sql, args...); err != nil {
		f.t.Fatal(err)
	}
}

func (f *runtimeFixture) admit(entryID string, version int) string {
	f.t.Helper()
	if err := f.s.enterUser(f.ctx, f.tenant, f.app, f.journey, version, f.user, entryID, "blast"); err != nil {
		f.t.Fatal(err)
	}
	var id string
	if err := f.pg.QueryRow(f.ctx, `SELECT id FROM journey_states WHERE tenant_id=$1 AND app_id=$2 AND journey_id=$3
		AND user_id=$4 ORDER BY entered_at DESC,id DESC LIMIT 1`, f.tenant, f.app, f.journey, f.user).Scan(&id); err != nil {
		f.t.Fatal(err)
	}
	return id
}

func (f *runtimeFixture) tick() {
	f.t.Helper()
	if err := f.s.tickOnce(f.ctx); err != nil {
		f.t.Fatal(err)
	}
}

func (f *runtimeFixture) state(id string) (string, int) {
	f.t.Helper()
	var status string
	var node int
	if err := f.pg.QueryRow(f.ctx, `SELECT status,current_node FROM journey_states WHERE tenant_id=$1 AND id=$2`, f.tenant, id).Scan(&status, &node); err != nil {
		f.t.Fatal(err)
	}
	return status, node
}

func (f *runtimeFixture) execution(id string, index int) (string, string, int) {
	f.t.Helper()
	var status, port string
	var retry int
	if err := f.pg.QueryRow(f.ctx, `SELECT status,COALESCE(output_port,''),retry_count FROM journey_node_executions
		WHERE tenant_id=$1 AND state_id=$2 AND node_index=$3`, f.tenant, id, index).Scan(&status, &port, &retry); err != nil {
		f.t.Fatal(err)
	}
	return status, port, retry
}

func (f *runtimeFixture) count(table string) int {
	f.t.Helper()
	var n int
	if err := f.pg.QueryRow(f.ctx, `SELECT count(*) FROM `+pgx.Identifier{table}.Sanitize()+` WHERE tenant_id=$1`, f.tenant).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func (f *runtimeFixture) receipt(event string, at time.Time, projected bool) *libqueue.Message {
	f.t.Helper()
	tx, err := f.pg.Begin(f.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	seq, err := f.s.lockCustomer(f.ctx, tx, f.tenant, f.app, f.user)
	if err != nil {
		f.t.Fatal(err)
	}
	seq++
	if _, err := tx.Exec(f.ctx, `UPDATE event_customer_cursors SET last_seq=$4,updated_at=$5
		WHERE tenant_id=$1 AND app_id=$2 AND user_id=$3`, f.tenant, f.app, f.user, seq, at); err != nil {
		f.t.Fatal(err)
	}
	id := uuid.NewString()
	var projectedAt *time.Time
	if projected {
		projectedAt = &at
	}
	if _, err := tx.Exec(f.ctx, `INSERT INTO event_receipts(tenant_id,app_id,insert_id,user_id,event_name,receipt_seq,received_at,projected_at,properties,client_ts)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}',$7)`, f.tenant, f.app, id, f.user, event, seq, at, projectedAt); err != nil {
		f.t.Fatal(err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		f.t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"insert_id": id, "user_id": f.user, "event_name": event})
	return &libqueue.Message{Envelope: libqueue.Envelope{ID: uuid.NewString(), TenantID: f.tenant, AppID: f.app, Payload: raw}}
}

func testGraph(nodes []Node, edges []Edge, start string) Definition {
	return Definition{SchemaVersion: 2, StartNodeID: &start, Nodes: nodes, Edges: edges,
		Entry: Entry{Type: "blast", SegmentID: uuid.NewString()}, Settings: Settings{Category: "transactional", Reentry: json.RawMessage(`"always"`)}}
}

func testEdge(source, port, target string) Edge {
	var to *string
	if target != "" {
		to = &target
	}
	return Edge{ID: source + "_" + port, Source: source, SourcePort: port, Target: to}
}

func testMessage(id, title string) Node {
	return Node{ID: id, Type: "message", Push: &PushContent{Title: title, Body: "test body"}}
}

func messageGraph() Definition {
	return testGraph([]Node{testMessage("message", "message")}, []Edge{testEdge("message", "next", "")}, "message")
}

func waitGraph() Definition {
	return testGraph([]Node{{ID: "wait", Type: "event_wait", EventName: "purchase", TimeoutSeconds: 10}, testMessage("matched", "matched"), testMessage("timeout", "timeout")},
		[]Edge{testEdge("wait", "matched", "matched"), testEdge("wait", "timeout", "timeout"), testEdge("matched", "next", ""), testEdge("timeout", "next", "")}, "wait")
}
