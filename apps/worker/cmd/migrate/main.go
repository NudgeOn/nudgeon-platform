// nudgeon-migrate — 스키마 부트스트랩 (PRD-08 4장, DEV-sub-08).
// db/postgres/schema.sql + db/clickhouse/*.sql를 순서대로 적용한다.
// "already exists" 류 오류는 무시해 멱등하게 만든다(관리형 DB·재실행 경로).
// 프로덕션 정식 마이그레이션은 Atlas(선언적, ADR-4)이며, 본 도구는 셀프호스팅
// 부트스트랩과 관리형 DB 초기 스키마 적용용이다.
//
//	nudgeon-migrate  (DATABASE_URL·CLICKHOUSE_URL 환경변수 사용)
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/config"
)

func main() {
	dir := "db"
	if len(os.Args) > 1 {
		dir = os.Args[1] // db 디렉터리 경로 (이미지에선 /app/db)
	}
	cfg, err := config.Load("DATABASE_URL", "CLICKHOUSE_URL")
	if err != nil {
		log.Fatalf("설정 로드: %v", err)
	}
	ctx := context.Background()

	if err := migratePostgres(ctx, cfg.DatabaseURL, filepath.Join(dir, "postgres", "schema.sql")); err != nil {
		log.Fatalf("PG 마이그레이션 실패: %v", err)
	}
	if err := migrateClickHouse(ctx, cfg.ClickHouseURL, filepath.Join(dir, "clickhouse")); err != nil {
		log.Fatalf("CH 마이그레이션 실패: %v", err)
	}
	fmt.Println("마이그레이션 완료 ✓")
}

// ignorableErr permits only PostgreSQL duplicate schema-object SQLSTATEs.
// A unique_violation can also say "duplicate" or "already exists", but means
// existing data violates a new constraint and must stop the migration.
func ignorableErr(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr == nil {
		return false
	}
	switch pgErr.Code {
	case "42710", "42P07", "42P06", "42701": // object, table/index, schema, column
		return true
	default:
		return false
	}
}

// ClickHouse bootstrap errors have their own format; preserve its existing
// already-exists compatibility without applying message matching to PostgreSQL.
func ignorableClickHouseErr(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "already exists")
}

type postgresMigrationPhase uint8

const (
	postgresSchemaPhase postgresMigrationPhase = iota
	postgresUpgradePhase
)

// postgresMigrationPhases keeps existing installations on the historical
// upgrade-before-schema path because schema indexes can reference additive
// columns. A fresh database needs the opposite order: schema.sql creates the
// enum types that the idempotent channel upgrades extend.
func postgresMigrationPhases(hasBaseSchema bool) []postgresMigrationPhase {
	if hasBaseSchema {
		return []postgresMigrationPhase{postgresUpgradePhase, postgresSchemaPhase}
	}
	return []postgresMigrationPhase{postgresSchemaPhase, postgresUpgradePhase}
}

// migrationLockKey — 세션 advisory lock 키. 같은 DB에 migrator가 둘 이상 붙으면
// (레플리카 동시 기동, 두 compose 스택이 한 DB를 공유) 뒤의 것이 앞의 것을 기다린다.
// 0007처럼 CREATE INDEX CONCURRENTLY를 쓰는 upgrade는 트랜잭션 안에서 못 돌므로
// 트랜잭션 락이 아니라 세션 락이어야 한다. 값은 "nudgeon:migrate"의 FNV-1a 64비트.
const migrationLockKey int64 = -7910111656743643054

// reapplyDriftedEnv — 적용 후 수정된 upgrade를 다시 적용하게 허용하는 개발용 스위치.
// 운영에서는 쓰지 않는다: 적용된 파일은 고치지 말고 새 번호로 추가한다.
const reapplyDriftedEnv = "MIGRATE_REAPPLY_DRIFTED"

// migrationReport — 한 번의 PG 마이그레이션이 무엇을 했는지. 테스트가 판정 근거로 쓴다.
type migrationReport struct {
	SchemaApplied, SchemaSkipped     int
	UpgradesApplied, UpgradesSkipped int
	WaitedForLock                    bool
}

func migratePostgres(ctx context.Context, url, schemaPath string) error {
	rep, err := migratePostgresReport(ctx, url, schemaPath, os.Getenv(reapplyDriftedEnv) == "1")
	if err != nil {
		return err
	}
	fmt.Printf("PostgreSQL: schema %d개 문 적용·%d개 스킵(기존), upgrade %d개 적용·%d개 스킵(기록됨)\n",
		rep.SchemaApplied, rep.SchemaSkipped, rep.UpgradesApplied, rep.UpgradesSkipped)
	return nil
}

func migratePostgresReport(ctx context.Context, url, schemaPath string, reapplyDrifted bool) (migrationReport, error) {
	var rep migrationReport
	raw, err := os.ReadFile(schemaPath)
	if err != nil {
		return rep, fmt.Errorf("스키마 파일 %s: %w", schemaPath, err)
	}
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return rep, fmt.Errorf("PG 연결: %w", err)
	}
	defer conn.Close(ctx)

	// 1) 직렬화. 즉시 못 잡으면 다른 migrator가 돌고 있는 것이다 — 기다린다.
	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, migrationLockKey).Scan(&got); err != nil {
		return rep, fmt.Errorf("PG advisory lock: %w", err)
	}
	if !got {
		rep.WaitedForLock = true
		fmt.Println("PostgreSQL: 다른 migrator가 실행 중 — 완료를 기다린다")
		if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationLockKey); err != nil {
			return rep, fmt.Errorf("PG advisory lock 대기: %w", err)
		}
	}
	defer conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, migrationLockKey) //nolint:errcheck // 세션 종료가 어차피 푼다

	// 2) 버전 테이블. schema.sql과 무관하게 먼저 있어야 한다 — 기존 설치는 upgrade가 schema보다 먼저 돈다.
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		filename   text PRIMARY KEY,
		checksum   text NOT NULL,
		applied_at timestamptz NOT NULL DEFAULT now()
	)`); err != nil {
		return rep, fmt.Errorf("PG schema_migrations: %w", err)
	}

	var hasBaseSchema bool
	if err := conn.QueryRow(ctx, `SELECT to_regclass('tenants') IS NOT NULL`).Scan(&hasBaseSchema); err != nil {
		return rep, fmt.Errorf("PG base schema check: %w", err)
	}

	upgrades, err := filepath.Glob(filepath.Join(filepath.Dir(schemaPath), "upgrades", "*.sql"))
	if err != nil {
		return rep, err
	}
	sort.Strings(upgrades)

	for _, phase := range postgresMigrationPhases(hasBaseSchema) {
		switch phase {
		case postgresUpgradePhase:
			for _, path := range upgrades {
				applied, err := applyUpgrade(ctx, conn, path, reapplyDrifted)
				if err != nil {
					return rep, err
				}
				if applied {
					rep.UpgradesApplied++
				} else {
					rep.UpgradesSkipped++
				}
			}
		case postgresSchemaPhase:
			for _, stmt := range splitSQL(string(raw)) {
				if _, err := conn.Exec(ctx, stmt); err != nil {
					if ignorableErr(err) {
						rep.SchemaSkipped++
						continue
					}
					return rep, fmt.Errorf("문 실행 실패:\n%s\n오류: %w", truncate(stmt), err)
				}
				rep.SchemaApplied++
			}
		}
	}
	// Historical schema fixtures can intentionally omit the claim upgrade.
	// Validate the index only when this migration bundle declares it.
	if strings.Contains(string(raw), "journey_outbox_relay_scope_idx") {
		var relayIndexValid bool
		if err := conn.QueryRow(ctx, `SELECT COALESCE((SELECT indisvalid FROM pg_index
		WHERE indexrelid=to_regclass('journey_outbox_relay_scope_idx')),false)`).Scan(&relayIndexValid); err != nil {
			return rep, err
		}
		if !relayIndexValid {
			return rep, fmt.Errorf("relay claim index missing or invalid; inspect an interrupted concurrent index build before retrying")
		}
	}
	return rep, nil
}

// applyUpgrade — upgrade 파일 하나를 적용하고 schema_migrations에 기록한다.
// 같은 체크섬으로 이미 기록돼 있으면 건너뛴다(false). 기록은 있는데 체크섬이 다르면
// "적용된 파일을 고쳤다"는 뜻이라 실패한다 — 다른 설치본은 옛 내용을 적용했고 이 내용은
// 아무도 검증하지 않았다. 문 단위 autocommit이라(CONCURRENTLY 때문) 중간에 실패하면
// 기록이 남지 않고, 다음 실행이 처음부터 다시 적용한다 — 이관 전과 같은 실패 의미론이다.
func applyUpgrade(ctx context.Context, conn *pgx.Conn, path string, reapplyDrifted bool) (bool, error) {
	name := filepath.Base(path)
	upgrade, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	sum := sha256.Sum256(upgrade)
	checksum := hex.EncodeToString(sum[:])

	var recorded string
	err = conn.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE filename = $1`, name).Scan(&recorded)
	switch {
	case err == nil && recorded == checksum:
		return false, nil
	case err == nil && !reapplyDrifted:
		return false, fmt.Errorf("PG upgrade %s 는 적용된 뒤 수정됐다 (기록 %s… ≠ 현재 %s…). "+
			"적용된 파일은 고치지 말고 새 번호로 추가한다. 개발 DB에서 재적용하려면 %s=1",
			name, shortSum(recorded), shortSum(checksum), reapplyDriftedEnv)
	case err == nil:
		fmt.Printf("PostgreSQL: upgrade %s 체크섬 불일치 — %s=1 이라 재적용한다\n", name, reapplyDriftedEnv)
	case !errors.Is(err, pgx.ErrNoRows):
		return false, fmt.Errorf("PG schema_migrations 조회 %s: %w", name, err)
	}

	for _, stmt := range splitSQL(string(upgrade)) {
		if _, err := conn.Exec(ctx, stmt); err != nil {
			return false, fmt.Errorf("PG upgrade %s: %w", name, err)
		}
	}
	if _, err := conn.Exec(ctx, `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
		ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`, name, checksum); err != nil {
		return false, fmt.Errorf("PG schema_migrations 기록 %s: %w", name, err)
	}
	return true, nil
}

func migrateClickHouse(ctx context.Context, url, dir string) error {
	opts, err := clickhouse.ParseDSN(url)
	if err != nil {
		return fmt.Errorf("CLICKHOUSE_URL: %w", err)
	}
	conn, err := clickhouse.Open(opts)
	if err != nil {
		return fmt.Errorf("CH 연결: %w", err)
	}
	defer conn.Close()

	files, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil {
		return err
	}
	sort.Strings(files) // 순번(0001, 0002 …) 순서 적용
	total := 0
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		for _, stmt := range splitSQL(string(raw)) {
			if err := conn.Exec(ctx, stmt); err != nil {
				if ignorableClickHouseErr(err) {
					continue
				}
				return fmt.Errorf("%s 실행 실패:\n%s\n오류: %w", filepath.Base(f), truncate(stmt), err)
			}
			total++
		}
	}
	fmt.Printf("ClickHouse: %d개 파일, %d개 문 적용\n", len(files), total)
	return nil
}

// splitSQL — 세미콜론 기준 문 분리. 줄 주석(-- …)은 인라인 포함 제거한다
// (세미콜론 뒤 트레일링 주석이 문 종료 탐지를 막지 않도록). 문자열 리터럴 내
// '--'·';'는 스키마에 없다는 전제(간이 스플리터 — 스키마·마이그레이션 SQL 용도로 충분).
func splitSQL(sql string) []string {
	var out []string
	var buf strings.Builder
	for _, rawLine := range strings.Split(sql, "\n") {
		line := stripLineComment(rawLine)
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		buf.WriteString(line)
		buf.WriteString("\n")
		if strings.HasSuffix(trimmed, ";") {
			stmt := strings.TrimSpace(buf.String())
			stmt = strings.TrimSuffix(stmt, ";")
			if stmt != "" {
				out = append(out, stmt)
			}
			buf.Reset()
		}
	}
	if rest := strings.TrimSpace(buf.String()); rest != "" {
		out = append(out, rest)
	}
	return out
}

// stripLineComment — 줄에서 '--' 이후를 제거 (문자열 리터럴 미고려 — 스키마 SQL 전제)
func stripLineComment(line string) string {
	if i := strings.Index(line, "--"); i >= 0 {
		return line[:i]
	}
	return line
}

func truncate(s string) string {
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}

// shortSum — 오류 메시지용 체크섬 접두. 손으로 고친 짧은 값이 와도 패닉하지 않는다.
func shortSum(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}
