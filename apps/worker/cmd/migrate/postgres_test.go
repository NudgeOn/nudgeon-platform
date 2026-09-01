package main

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// These tests are opt-in and never use DATABASE_URL or any default service port.
// ONDA_MIGRATE_TEST_DATABASE_URL must name a dedicated PostgreSQL test database.
// Every test creates a random search_path and removes only that schema afterward.
func migrationDatabase(t *testing.T) (context.Context, *pgx.Conn, string) {
	t.Helper()
	dsn := os.Getenv("ONDA_MIGRATE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set ONDA_MIGRATE_TEST_DATABASE_URL to an isolated PostgreSQL test database")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
		t.Fatal("ONDA_MIGRATE_TEST_DATABASE_URL must be a postgres:// or postgresql:// URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect to explicitly configured test database: %v", err)
	}
	schema := "onda_migration_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		admin.Close(ctx)
		t.Fatalf("create isolated test schema: %v", err)
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		defer admin.Close(cleanup)
		if _, err := admin.Exec(cleanup, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("remove test schema %s: %v", schema, err)
		}
	})
	query := parsed.Query()
	query.Set("search_path", schema) // no fallback to public or other test schemas
	parsed.RawQuery = query.Encode()
	scopedDSN := parsed.String()
	conn, err := pgx.Connect(ctx, scopedDSN)
	if err != nil {
		t.Fatalf("connect to isolated schema: %v", err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	return ctx, conn, scopedDSN
}

func migrationSchemaPaths(t *testing.T) (legacy, current string) {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate migration test fixtures")
	}
	dir := filepath.Dir(source)
	return filepath.Join(dir, "testdata", "postgres-v1.sql"), filepath.Join(dir, "..", "..", "..", "..", "db", "postgres", "schema.sql")
}

const legacyJourneyDefinition = `{
  "entry": {"type": "trigger", "trigger_event": "signed_up"},
  "nodes": [
    {"type": "message", "push": {"title": "Legacy welcome", "body": "Immutable version seven"}},
    {"type": "delay", "duration_seconds": 600},
    {"type": "message", "push": {"title": "Legacy follow-up", "body": "Keep original node indexes"}},
    {"type": "delay", "duration_seconds": 60}
  ],
  "exit": {"conversion_event": "purchased"},
  "settings": {"category": "marketing", "reentry": {"after_days": 3}}
}`

func seedLegacyJourney(t *testing.T, ctx context.Context, conn *pgx.Conn, idempotencyKey string) {
	t.Helper()
	tenant, app, journey := uuid.NewString(), uuid.NewString(), uuid.NewString()
	user1, user2 := uuid.NewString(), uuid.NewString()
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO tenants(id, name) VALUES ($1, 'Migration fixture tenant')`, []any{tenant}},
		{`INSERT INTO apps(id, tenant_id, name) VALUES ($1, $2, 'Migration fixture app')`, []any{app, tenant}},
		{`INSERT INTO users(id, tenant_id, app_id, external_id) VALUES ($1,$2,$3,'legacy-waiting'),($4,$2,$3,'legacy-claimed')`, []any{user1, tenant, app, user2}},
		{`INSERT INTO journeys(id, tenant_id, app_id, name, status, category, draft_definition, active_version, created_at, updated_at)
          VALUES ($1,$2,$3,'Legacy journey','active','marketing',$4::jsonb,7,'2026-01-01T01:00:00Z','2026-01-02T02:00:00Z')`, []any{journey, tenant, app, legacyJourneyDefinition}},
		{`INSERT INTO journey_versions(journey_id, version, definition, created_at)
          VALUES ($1,7,$2::jsonb,'2026-01-02T02:00:00Z')`, []any{journey, legacyJourneyDefinition}},
		{`INSERT INTO journey_states(tenant_id, app_id, journey_id, journey_version, user_id, current_node, status, next_wake_at, entered_at, updated_at)
          VALUES ($1,$2,$3,7,$4,2,'waiting','2030-01-01T05:00:00Z','2026-01-02T03:00:00Z','2026-01-02T04:00:00Z')`, []any{tenant, app, journey, user1}},
		{`INSERT INTO journey_states(tenant_id, app_id, journey_id, journey_version, user_id, current_node, status, next_wake_at, claimed_by, claimed_at, fail_reason, entered_at, updated_at)
          VALUES ($1,$2,$3,7,$4,3,'claimed','2026-01-02T05:00:00Z','legacy-worker','2026-01-02T05:01:00Z','previous retry detail','2026-01-02T03:00:00Z','2026-01-02T05:01:00Z')`, []any{tenant, app, journey, user2}},
		{`INSERT INTO journey_outbox(tenant_id, app_id, stream, idempotency_key, payload, created_at, published_at)
          VALUES ($1,$2,'send.push',$3,'{"fixture":"legacy-first","node_index":0}'::jsonb,'2026-01-02T04:00:00Z','2026-01-02T04:00:01Z'),
                 ($1,$2,'send.push',$3,'{"fixture":"legacy-retry","node_index":0}'::jsonb,'2026-01-02T04:00:02Z',NULL)`, []any{tenant, app, idempotencyKey}},
	}
	for _, stmt := range statements {
		if _, err := conn.Exec(ctx, stmt.sql, stmt.args...); err != nil {
			t.Fatalf("seed v1 fixture: %v", err)
		}
	}
}

// Compare the full legacy rows, not only their counts or selected columns.
// Added state columns are excluded only from the post-upgrade snapshot.
func legacySnapshot(t *testing.T, ctx context.Context, conn *pgx.Conn, upgraded bool) string {
	t.Helper()
	state := "to_jsonb(s)"
	if upgraded {
		state += " - 'claim_token' - 'entry_id' - 'entry_seq'"
	}
	query := `SELECT jsonb_build_object(
      'journeys', (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM journeys j),
      'versions', (SELECT jsonb_agg(to_jsonb(v) ORDER BY version) FROM journey_versions v),
      'states', (SELECT jsonb_agg(` + state + ` ORDER BY id) FROM journey_states s),
      'outbox', (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM journey_outbox o)
    )::text`
	var snapshot string
	if err := conn.QueryRow(ctx, query).Scan(&snapshot); err != nil {
		t.Fatalf("read legacy snapshot: %v", err)
	}
	return snapshot
}

func TestPostgresV1ToV2MigrationPreservesExistingJourneysTwice(t *testing.T) {
	ctx, conn, dsn := migrationDatabase(t)
	legacy, current := migrationSchemaPaths(t)
	if err := migratePostgres(ctx, dsn, legacy); err != nil {
		t.Fatalf("bootstrap frozen v1 schema: %v", err)
	}
	// This format intentionally does not enter the new v2/event partial index.
	const legacyKey = "legacy-journey:7:legacy-user:0:legacy-device"
	seedLegacyJourney(t, ctx, conn, legacyKey)
	before := legacySnapshot(t, ctx, conn, false)
	for pass := 1; pass <= 2; pass++ {
		if err := migratePostgres(ctx, dsn, current); err != nil {
			t.Fatalf("v2 migration pass %d: %v", pass, err)
		}
		if after := legacySnapshot(t, ctx, conn, true); after != before {
			t.Fatalf("migration pass %d changed immutable definitions, progress, timestamps, or legacy outbox rows\nbefore: %s\nafter: %s", pass, before, after)
		}
	}
	var legacyNulls, duplicateKeys int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM journey_states WHERE claim_token IS NULL AND entry_id IS NULL AND entry_seq IS NULL`).Scan(&legacyNulls); err != nil || legacyNulls != 2 {
		t.Fatalf("legacy states must not be backfilled or re-admitted: count=%d err=%v", legacyNulls, err)
	}
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM journey_outbox WHERE idempotency_key=$1`, legacyKey).Scan(&duplicateKeys); err != nil || duplicateKeys != 2 {
		t.Fatalf("both original duplicate legacy idempotency keys must survive: count=%d err=%v", duplicateKeys, err)
	}
	for _, table := range []string{"journey_node_executions", "event_customer_cursors", "event_receipts"} {
		var count int
		if err := conn.QueryRow(ctx, "SELECT count(*) FROM "+pgx.Identifier{table}.Sanitize()).Scan(&count); err != nil || count != 0 {
			t.Fatalf("new table %s must exist without inventing legacy v2 executions: count=%d err=%v", table, count, err)
		}
	}
	for _, index := range []string{"journey_states_entry_uniq", "journey_outbox_v2_dedup_idx", "journey_node_executions_wait_idx", "event_receipts_projection_idx"} {
		var exists bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname=$1)`, index).Scan(&exists); err != nil || !exists {
			t.Fatalf("v2 index %s must exist after additive columns: exists=%v err=%v", index, exists, err)
		}
	}
}

func TestPostgresMigrationFailsOnV2OutboxUniqueViolation(t *testing.T) {
	for _, key := range []string{"v2:duplicate-node-send", "event.duplicate-receipt"} {
		t.Run(key, func(t *testing.T) {
			ctx, conn, dsn := migrationDatabase(t)
			legacy, current := migrationSchemaPaths(t)
			if err := migratePostgres(ctx, dsn, legacy); err != nil {
				t.Fatalf("bootstrap frozen v1 schema: %v", err)
			}
			seedLegacyJourney(t, ctx, conn, key)
			err := migratePostgres(ctx, dsn, current)
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
				t.Fatalf("a real duplicate during unique-index creation must fail with SQLSTATE 23505, got %v", err)
			}
			var count int
			if err := conn.QueryRow(ctx, `SELECT count(*) FROM journey_outbox WHERE idempotency_key=$1`, key).Scan(&count); err != nil || count != 2 {
				t.Fatalf("failed migration must not deduplicate or rewrite payload rows: count=%d err=%v", count, err)
			}
		})
	}
}
