package main

import (
	"errors"
	"fmt"
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
