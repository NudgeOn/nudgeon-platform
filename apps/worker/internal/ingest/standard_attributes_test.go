package ingest

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type attributeTestRow func(...any) error

func (r attributeTestRow) Scan(dest ...any) error { return r(dest...) }

type attributeTestDB struct {
	Querier
	std, custom map[string]any
	registered  string
	writes      int
}

func (q *attributeTestDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	return attributeTestRow(func(dest ...any) error {
		if strings.Contains(sql, "SELECT std_attrs") {
			*dest[0].(*[]byte), _ = json.Marshal(q.std)
			*dest[1].(*[]byte), _ = json.Marshal(q.custom)
		} else {
			*dest[0].(*string) = q.registered
		}
		return nil
	})
}
func (q *attributeTestDB) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	q.writes++
	q.std, q.custom = nil, nil
	_ = json.Unmarshal(args[2].([]byte), &q.std)
	_ = json.Unmarshal(args[3].([]byte), &q.custom)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}
func TestPromotedAttributesPreserveUpdateAndUnsetSemantics(t *testing.T) {
	for _, key := range []string{"dob", "gender", "home_city"} {
		for _, tc := range []struct {
			name       string
			value      any
			registered string
			reject     bool
		}{
			{"same value migrates", "legacy", "string", false},
			{"new value migrates", "new", "string", false},
			{"unset clears legacy", nil, "string", false},
			{"type mismatch preserves legacy", float64(2), "string", true},
		} {
			t.Run(key+"/"+tc.name, func(t *testing.T) {
				q := &attributeTestDB{std: map[string]any{}, custom: map[string]any{key: "legacy", "tier": "gold"}, registered: tc.registered}
				result, err := ApplyAttributes(context.Background(), q, "tenant", "app", "user", map[string]any{key: tc.value}, "sdk", "request", time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC))
				if err != nil {
					t.Fatal(err)
				}
				if tc.reject {
					if q.writes != 0 || len(result.Errors) != 1 || q.custom[key] != "legacy" {
						t.Fatalf("rejected mutation changed profile: %#v", q)
					}
					return
				}
				if q.writes != 1 || q.custom["tier"] != "gold" {
					t.Fatalf("incorrect update: %#v", q)
				}
				if _, ok := q.custom[key]; ok {
					t.Fatal("legacy value would resurrect after unset")
				}
				if tc.value == nil {
					if _, ok := q.std[key]; ok {
						t.Fatal("unset kept standard value")
					}
					if len(result.Changes) != 1 || result.Changes[0][6] != "unset" {
						t.Fatalf("unset history: %#v", result.Changes)
					}
				} else if !reflect.DeepEqual(q.std[key], tc.value) {
					t.Fatalf("standard value: %#v", q.std)
				}
			})
		}
	}
}
