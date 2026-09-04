package ingest

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/metrics"
)

func outcome(err error) string {
	if err != nil {
		return "error"
	}
	return "success"
}

func (c *Consumer) observeStage(stage string, start time.Time, err error) {
	metrics.ProjectionStage.WithLabelValues(stage, outcome(err)).Observe(c.clk.Now().Sub(start).Seconds())
}

// Wrap only the receipt projection transaction. Preserve every original SQL,
// lock order and Scan error; do not replace pool or transaction behavior.
type observedProjectionTx struct {
	pgx.Tx
	c *Consumer
}

func (tx observedProjectionTx) Exec(ctx context.Context, sql string, args ...any) (tag pgconn.CommandTag, err error) {
	start := tx.c.clk.Now()
	defer func() { tx.c.observeStage("sql", start, err) }()
	return tx.Tx.Exec(ctx, sql, args...)
}

func (tx observedProjectionTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	stage := "sql"
	if strings.Contains(sql, "FOR UPDATE") {
		stage = "cursor_lock"
	}
	if strings.Contains(sql, "FOR SHARE") {
		stage = "profile_lock"
	}
	start := tx.c.clk.Now()
	return observedProjectionRow{Row: tx.Tx.QueryRow(ctx, sql, args...), c: tx.c, start: start, stage: stage}
}

type observedProjectionRow struct {
	pgx.Row
	c     *Consumer
	start time.Time
	stage string
}

func (row observedProjectionRow) Scan(dest ...any) error {
	err := row.Row.Scan(dest...)
	row.c.observeStage(row.stage, row.start, err)
	return err
}

func clickhouseTable(sql string) string {
	for _, table := range []string{"events", "profiles_mirror", "user_merges", "attr_changes", "ingestion_errors"} {
		if strings.HasPrefix(sql, "INSERT INTO "+table+" (") {
			return table
		}
	}
	return "other"
}
