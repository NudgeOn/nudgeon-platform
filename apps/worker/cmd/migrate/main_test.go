package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestIgnorablePostgresErrorsRequireDuplicateObjectSQLState(t *testing.T) {
	for _, code := range []string{"42710", "42P07", "42P06", "42701"} {
		t.Run(code, func(t *testing.T) {
			// Classification must work without depending on a localized message.
			err := &pgconn.PgError{Code: code, Message: "이미 존재하는 스키마 객체"}
			if !ignorableErr(err) || !ignorableErr(fmt.Errorf("migration: %w", err)) {
				t.Fatalf("duplicate-object SQLSTATE %s should be ignorable, including wrapped errors", code)
			}
		})
	}
	for _, test := range []struct {
		name string
		err  error
	}{
		{"nil", nil},
		{"unique violation", &pgconn.PgError{Code: "23505", Message: "duplicate key value violates unique constraint", Detail: "Key (idempotency_key)=(event.example) already exists."}},
		{"foreign key violation", &pgconn.PgError{Code: "23503", Message: "duplicate referenced key already exists"}},
		{"missing column", &pgconn.PgError{Code: "42703", Message: "column does not exist"}},
		{"duplicate text", errors.New("duplicate object")},
		{"already exists text", errors.New("relation already exists")},
		{"SQLSTATE text", errors.New("ERROR 42710: duplicate object")},
		{"ClickHouse error", &clickhouse.Exception{Code: 57, Message: "Table already exists"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if ignorableErr(test.err) {
				t.Fatalf("error must stop PostgreSQL migration: %v", test.err)
			}
			if test.err != nil && ignorableErr(fmt.Errorf("migration: %w", test.err)) {
				t.Fatalf("wrapping must not make a data error ignorable: %v", test.err)
			}
		})
	}
}

func TestClickHouseAlreadyExistsCompatibility(t *testing.T) {
	for _, err := range []error{
		&clickhouse.Exception{Code: 57, Message: "Table onda.events already exists"},
		fmt.Errorf("bootstrap: %w", errors.New("Database ONDA ALREADY EXISTS")),
	} {
		if !ignorableClickHouseErr(err) {
			t.Fatalf("ClickHouse already-exists error should remain ignorable: %v", err)
		}
	}
	for _, err := range []error{nil, errors.New("connection refused"), errors.New("duplicate rows violate an invariant")} {
		if ignorableClickHouseErr(err) {
			t.Fatalf("unrelated ClickHouse error should fail migration: %v", err)
		}
	}
}

// 0008_message_lifecycle.sql — 인라인 '--' 주석이 섞인 CREATE TABLE과 ALTER가 정확히 2개 문으로 분리되어야 한다.
func TestSplitSQLMessageLifecycleMigration(t *testing.T) {
	raw, err := os.ReadFile("../../../../db/clickhouse/0008_message_lifecycle.sql")
	if err != nil {
		t.Fatal(err)
	}
	stmts := splitSQL(string(raw))
	if len(stmts) != 2 {
		t.Fatalf("2개 문 기대, got %d: %q", len(stmts), stmts)
	}
	if !strings.HasPrefix(stmts[0], "CREATE TABLE IF NOT EXISTS onda.message_lifecycle") ||
		!strings.Contains(stmts[0], "ENGINE = ReplacingMergeTree(received_at)") {
		t.Errorf("CREATE 문 불일치: %q", stmts[0])
	}
	if strings.Contains(stmts[0], "--") {
		t.Errorf("주석이 제거되지 않음: %q", stmts[0])
	}
	if stmts[1] != "ALTER TABLE onda.message_log ADD COLUMN IF NOT EXISTS provider_message_id String DEFAULT ''" {
		t.Errorf("ALTER 문 불일치: %q", stmts[1])
	}
}
