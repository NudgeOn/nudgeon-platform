package message

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/channel"
	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

func TestMessageDLQMissingDatabaseReturnsError(t *testing.T) {
	if err := (&Worker{}).DLQ(context.Background(), &libqueue.Envelope{}, &Job{}, channel.SendOutcome{}); err == nil {
		t.Fatal("unconfigured DLQ reported success")
	}
}

func TestMessageDLQDatabaseErrors(t *testing.T) {
	url := os.Getenv("DLQ_STORAGE_WRITER_URL")
	if url == "" {
		t.Skip("isolated PostgreSQL writer required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, os.Getenv("DLQ_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	writer, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	tenant, app := "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
	var name string
	if err := admin.QueryRow(ctx, "SELECT name FROM tenants WHERE id=$1", tenant).Scan(&name); err != nil || name != "DLQ STORAGE LOCAL QA" {
		t.Fatal("not the isolated fixture database")
	}
	if _, err := admin.Exec(ctx, "REVOKE INSERT ON send_dlq FROM dlq_writer"); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(context.Background(), "GRANT INSERT ON send_dlq TO dlq_writer")
	w := &Worker{pg: writer}
	job := &Job{P: &Payload{IdempotencyKey: uuid.NewString(), MessageID: uuid.NewString()}}
	env := &libqueue.Envelope{TenantID: tenant, AppID: app, Type: "send.message.v1", Payload: []byte(`{}`)}
	out := channel.SendOutcome{MessageID: job.P.MessageID, FailureID: uuid.NewString(), FailureClass: "retryable_exhausted", Attempts: 5}
	err = w.DLQ(ctx, env, job, out)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("database permission error not propagated: %v", err)
	}
	if _, err := admin.Exec(ctx, "GRANT INSERT ON send_dlq TO dlq_writer"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := w.DLQ(ctx, env, job, out); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := admin.QueryRow(ctx, "SELECT count(*) FROM send_dlq WHERE tenant_id=$1 AND idempotency_key=$2 AND failure_id=$3", tenant, job.P.IdempotencyKey, out.FailureID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}
