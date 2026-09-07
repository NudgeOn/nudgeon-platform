package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// 첫 실행은 upgrade를 전부 적용하고 기록한다. 두 번째 실행은 기록을 보고 전부 건너뛴다.
// 이관 전에는 매 기동마다 모든 upgrade를 재실행했다 — 멱등이 아닌 문 하나가 들어오면 깨졌다.
func TestPostgresVersionTableRecordsAndSkipsUpgrades(t *testing.T) {
	ctx, conn, dsn := migrationDatabase(t)
	_, current := migrationSchemaPaths(t)

	first, err := migratePostgresReport(ctx, dsn, current, false)
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	if first.UpgradesApplied == 0 || first.UpgradesSkipped != 0 {
		t.Fatalf("first run should apply every upgrade: %+v", first)
	}
	var recorded int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&recorded); err != nil {
		t.Fatalf("read schema_migrations: %v", err)
	}
	if recorded != first.UpgradesApplied {
		t.Fatalf("schema_migrations rows=%d, applied=%d", recorded, first.UpgradesApplied)
	}

	second, err := migratePostgresReport(ctx, dsn, current, false)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if second.UpgradesApplied != 0 || second.UpgradesSkipped != first.UpgradesApplied {
		t.Fatalf("second run should skip every recorded upgrade: %+v", second)
	}
}

// 적용된 upgrade 파일이 나중에 수정되면 기본은 실패다. 다른 설치본은 옛 내용을 적용했고
// 새 내용은 아무도 검증하지 않았다. 개발 DB에서만 스위치로 재적용을 허용한다.
func TestPostgresChecksumDriftFailsUnlessReapplyRequested(t *testing.T) {
	ctx, conn, dsn := migrationDatabase(t)
	_, current := migrationSchemaPaths(t)

	if _, err := migratePostgresReport(ctx, dsn, current, false); err != nil {
		t.Fatalf("initial run: %v", err)
	}
	var name string
	if err := conn.QueryRow(ctx, `SELECT filename FROM schema_migrations ORDER BY filename LIMIT 1`).Scan(&name); err != nil {
		t.Fatalf("pick a recorded upgrade: %v", err)
	}
	if _, err := conn.Exec(ctx, `UPDATE schema_migrations SET checksum = 'stale' WHERE filename = $1`, name); err != nil {
		t.Fatalf("simulate drift: %v", err)
	}

	_, err := migratePostgresReport(ctx, dsn, current, false)
	if err == nil || !strings.Contains(err.Error(), name) || !strings.Contains(err.Error(), reapplyDriftedEnv) {
		t.Fatalf("drift must fail naming the file and the override, got: %v", err)
	}

	rep, err := migratePostgresReport(ctx, dsn, current, true)
	if err != nil {
		t.Fatalf("reapply with override: %v", err)
	}
	if rep.UpgradesApplied != 1 {
		t.Fatalf("only the drifted upgrade should be re-applied: %+v", rep)
	}
	var checksum string
	if err := conn.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE filename = $1`, name).Scan(&checksum); err != nil {
		t.Fatal(err)
	}
	if checksum == "stale" {
		t.Fatal("reapply must record the current checksum")
	}
}

// 다른 세션이 락을 쥐고 있으면 migrator는 완료를 기다린다. 두 레플리카가 동시에 기동해도
// 한 번에 하나만 스키마를 만진다.
func TestPostgresAdvisoryLockSerializesMigrators(t *testing.T) {
	ctx, _, dsn := migrationDatabase(t)
	_, current := migrationSchemaPaths(t)

	holder, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close(context.Background())
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationLockKey); err != nil {
		t.Fatalf("hold lock: %v", err)
	}

	type result struct {
		rep migrationReport
		err error
	}
	done := make(chan result, 1)
	go func() {
		rep, err := migratePostgresReport(ctx, dsn, current, false)
		done <- result{rep, err}
	}()

	select {
	case r := <-done:
		t.Fatalf("migrator finished while another session held the lock: %+v %v", r.rep, r.err)
	case <-time.After(1500 * time.Millisecond):
	}

	if _, err := holder.Exec(ctx, `SELECT pg_advisory_unlock($1)`, migrationLockKey); err != nil {
		t.Fatalf("release lock: %v", err)
	}
	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("migrator after lock release: %v", r.err)
		}
		if !r.rep.WaitedForLock {
			t.Fatalf("report must say it waited: %+v", r.rep)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("migrator did not proceed after the lock was released")
	}
}
