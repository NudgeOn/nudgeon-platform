package main

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

type resolveStub struct{ calls int }

func (s *resolveStub) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	s.calls++
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func TestResolveRequiresVerifiedScopedFreshTarget(t *testing.T) {
	args := []string{"--tenant", "00000000-0000-4000-8000-000000000001", "--id", "00000000-0000-4000-8000-000000000002",
		"--created-at", "2026-09-03T00:00:00Z", "--note", "INC-test"}
	pg := &resolveStub{}
	if err := resolveDLQ(context.Background(), pg, args); err == nil || pg.calls != 0 {
		t.Fatal("resolution without verification")
	}
	if err := resolveDLQ(context.Background(), pg, append(args, "--verified")); err != nil || pg.calls != 1 {
		t.Fatalf("err=%v calls=%d", err, pg.calls)
	}
	pg.calls = 0
	if err := resolveDLQ(context.Background(), pg, []string{"--verified", "--created-at", "2026-09-03T00:00:00Z", "--note", "INC-test"}); err == nil || pg.calls != 0 {
		t.Fatal("unscoped resolution")
	}
}
