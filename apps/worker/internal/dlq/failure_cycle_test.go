package dlq

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestPostgresDLQFailureCycle(t *testing.T) {
	url := os.Getenv("DLQ_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("isolated PostgreSQL required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, "CREATE TEMP TABLE send_dlq (LIKE public.send_dlq INCLUDING DEFAULTS INCLUDING INDEXES) ON COMMIT DROP; ALTER TABLE send_dlq DROP COLUMN failure_id"); err != nil {
		t.Fatal(err)
	}
	upgrade, err := os.ReadFile("../../../../db/postgres/upgrades/0006_dlq_failure_id.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := tx.Exec(ctx, string(upgrade)); err != nil {
			t.Fatal(err)
		}
	}
	e := Entry{TenantID: uuid.NewString(), AppID: uuid.NewString(), IdempotencyKey: "cycle", FailureID: uuid.NewString(), FailureClass: "retryable", Attempts: 5, Envelope: []byte(`{"type":"send.push"}`)}
	if written, err := Persist(ctx, tx, e); err != nil || !written {
		t.Fatalf("first insert=%v err=%v", written, err)
	}
	var id string
	var created time.Time
	if err := tx.QueryRow(ctx, "SELECT id,created_at FROM send_dlq").Scan(&id, &created); err != nil {
		t.Fatal(err)
	}
	if err := Resolve(ctx, tx, e.TenantID, id, created, "verified synthetic disposition"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if written, err := Persist(ctx, tx, e); err != nil || written {
			t.Fatalf("retry changed same cycle=%v err=%v", written, err)
		}
	}
	var preserved bool
	if err := tx.QueryRow(ctx, "SELECT created_at=$1 AND resolved_at IS NOT NULL FROM send_dlq", created).Scan(&preserved); err != nil || !preserved {
		t.Fatal("same cycle reset operator resolution")
	}
	e.FailureID = uuid.NewString()
	if written, err := Persist(ctx, tx, e); err != nil || !written {
		t.Fatalf("new cycle not reopened=%v err=%v", written, err)
	}
	var count int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM send_dlq WHERE resolved_at IS NULL AND failure_id=$1", e.FailureID).Scan(&count); err != nil || count != 1 {
		t.Fatal("new cycle missing or duplicated")
	}
}
