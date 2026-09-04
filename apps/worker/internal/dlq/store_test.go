package dlq

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The dedicated integration runner supplies an isolated DB. All fixtures are
// temporary tables inside a rolled-back transaction; no provider is contacted.
func TestPostgresDLQStateLifecycle(t *testing.T) {
	url := os.Getenv("DLQ_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set DLQ_TEST_DATABASE_URL to the isolated test database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(ctx, `CREATE TEMP TABLE send_dlq (LIKE public.send_dlq INCLUDING DEFAULTS INCLUDING INDEXES) ON COMMIT DROP;
 ALTER TABLE send_dlq DROP COLUMN resolved_at; ALTER TABLE send_dlq DROP COLUMN resolution_note;`)
	if err != nil {
		t.Fatal(err)
	}
	upgrade, err := os.ReadFile("../../../../db/postgres/upgrades/0005_dlq_resolution.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := tx.Exec(ctx, string(upgrade)); err != nil {
			t.Fatal(err)
		}
	}
	e := Entry{TenantID: uuid.NewString(), AppID: uuid.NewString(), IdempotencyKey: "state-test", FailureClass: "retryable", Attempts: 5, Envelope: []byte(`{"type":"send.push"}`)}
	if err := Insert(ctx, tx, e); err != nil {
		t.Fatal(err)
	}
	rows, err := Snapshot(ctx, tx)
	if err != nil || len(rows) != 1 || rows[0].Unresolved != 1 || rows[0].Replaying != 0 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	var id string
	var observed time.Time
	if err := tx.QueryRow(ctx, `SELECT id,created_at FROM send_dlq`).Scan(&id, &observed); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `UPDATE send_dlq SET replayed_at=clock_timestamp()`)
	if err != nil {
		t.Fatal(err)
	}
	rows, _ = Snapshot(ctx, tx)
	if rows[0].Replaying != 1 || rows[0].Unresolved != 1 {
		t.Fatal("replay hid backlog")
	}
	if err := Resolve(ctx, tx, uuid.NewString(), id, observed, "test"); !errors.Is(err, ErrChanged) {
		t.Fatalf("cross-tenant resolution: %v", err)
	}
	if err := Resolve(ctx, tx, e.TenantID, id, observed.Add(-time.Second), "test"); !errors.Is(err, ErrChanged) {
		t.Fatalf("stale resolution: %v", err)
	}
	if err := Resolve(ctx, tx, e.TenantID, id, observed, "synthetic disposition verified"); err != nil {
		t.Fatal(err)
	}
	rows, _ = Snapshot(ctx, tx)
	if len(rows) != 0 {
		t.Fatal("resolved row counted")
	}
	if err := Insert(ctx, tx, e); err != nil {
		t.Fatal(err)
	}
	rows, _ = Snapshot(ctx, tx)
	if len(rows) != 1 || rows[0].Unresolved != 1 || rows[0].Replaying != 0 {
		t.Fatal("new failure did not reopen")
	}
	if err := Resolve(ctx, tx, e.TenantID, id, observed, "old approval"); !errors.Is(err, ErrChanged) {
		t.Fatalf("old approval closed new failure: %v", err)
	}
	e.IdempotencyKey = "unknown"
	e.FailureClass = "arbitrary-secret-text"
	e.Envelope = []byte(`{"type":"custom-vendor-secret"}`)
	if err := Insert(ctx, tx, e); err != nil {
		t.Fatal(err)
	}
	rows, err = Snapshot(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range rows {
		if row.Stream == "unknown" && row.FailureClass == "unknown" && row.Unresolved == 1 {
			found = true
		}
	}
	if !found {
		t.Fatal("unknown group missing")
	}
}
