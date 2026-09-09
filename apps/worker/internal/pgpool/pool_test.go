package pgpool

import (
	"context"
	"os"
	"testing"
)

// 실 PG: 풀의 세션이 idle_in_transaction_session_timeout을 갖고, 트랜잭션을 연 채 쉬면 PG가 끊는다.
func TestPoolSessionsCarryIdleInTransactionTimeout(t *testing.T) {
	url := os.Getenv("NUDGEON_JOURNEY_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set NUDGEON_JOURNEY_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	pool, err := New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var got string
	if err := pool.QueryRow(ctx, "SHOW idle_in_transaction_session_timeout").Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != IdleInTransactionTimeout {
		t.Fatalf("idle_in_transaction_session_timeout = %q, want %q", got, IdleInTransactionTimeout)
	}
}
