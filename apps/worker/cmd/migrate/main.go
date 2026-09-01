// onda-migrate — 스키마 부트스트랩 (PRD-08 4장, DEV-sub-08).
// db/postgres/schema.sql + db/clickhouse/*.sql를 순서대로 적용한다.
// "already exists" 류 오류는 무시해 멱등하게 만든다(관리형 DB·재실행 경로).
// 프로덕션 정식 마이그레이션은 Atlas(선언적, ADR-4)이며, 본 도구는 셀프호스팅
// 부트스트랩과 관리형 DB 초기 스키마 적용용이다.
//
//	onda-migrate  (DATABASE_URL·CLICKHOUSE_URL 환경변수 사용)
package main

import (
	"context"
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

	"github.com/ondahq/onda/apps/worker/internal/config"
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

func migratePostgres(ctx context.Context, url, schemaPath string) error {
	raw, err := os.ReadFile(schemaPath)
	if err != nil {
		return fmt.Errorf("스키마 파일 %s: %w", schemaPath, err)
	}
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return fmt.Errorf("PG 연결: %w", err)
	}
	defer conn.Close(ctx)

	applied, skipped := 0, 0
	// Additive upgrades must precede schema indexes referencing newly added columns.
	// Atlas users receive the same changes from the declarative schema diff.
	upgrades, err := filepath.Glob(filepath.Join(filepath.Dir(schemaPath), "upgrades", "*.sql"))
	if err != nil {
		return err
	}
	sort.Strings(upgrades)
	for _, path := range upgrades {
		upgrade, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, stmt := range splitSQL(string(upgrade)) {
			if _, err := conn.Exec(ctx, stmt); err != nil {
				return fmt.Errorf("PG upgrade %s: %w", filepath.Base(path), err)
			}
		}
	}
	for _, stmt := range splitSQL(string(raw)) {
		if _, err := conn.Exec(ctx, stmt); err != nil {
			if ignorableErr(err) {
				skipped++
				continue
			}
			return fmt.Errorf("문 실행 실패:\n%s\n오류: %w", truncate(stmt), err)
		}
		applied++
	}
	fmt.Printf("PostgreSQL: %d개 문 적용, %d개 스킵(기존)\n", applied, skipped)
	return nil
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
