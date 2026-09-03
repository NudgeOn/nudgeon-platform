// Package ops contains read-only, bounded operational observations. These
// aggregates must never expose tenant identifiers or event bodies in metrics.
package ops

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

var PostgresDefinitions = map[string]string{
	"projection_pending_count":                     "Receipts whose projection marker is not committed; not API RPS",
	"projection_oldest_received_timestamp_seconds": "Oldest unprojected receipt received_at; NOT a commit timestamp",
	"matching_pending_count":                       "Receipts whose trigger matching marker is not committed",
	"matching_oldest_received_timestamp_seconds":   "Oldest unmatched receipt received_at; NOT a commit timestamp",
	"outbox_pending_count":                         "Outbox rows not yet marked published, across all streams",
	"outbox_oldest_created_timestamp_seconds":      "Oldest unpublished outbox created_at; zero only after complete empty snapshot",
}

// Three aggregates share a single statement snapshot. Partial indexes already
// cover these predicates. A large backlog can still be expensive: use the
// monitor's dedicated max-one, read-only pool and 2s statement/context timeout.
const BacklogSQL = `
SELECT 'projection', count(*), coalesce(extract(epoch FROM min(received_at)), 0)::double precision
  FROM event_receipts WHERE projected_at IS NULL
UNION ALL
SELECT 'matching', count(*), coalesce(extract(epoch FROM min(received_at)), 0)::double precision
  FROM event_receipts WHERE matched_at IS NULL
UNION ALL
SELECT 'outbox', count(*), coalesce(extract(epoch FROM min(created_at)), 0)::double precision
  FROM journey_outbox WHERE published_at IS NULL`

type Querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func PostgresSnapshot(ctx context.Context, pg Querier) (map[string]float64, error) {
	rows, err := pg.Query(ctx, BacklogSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make(map[string]float64, len(PostgresDefinitions))
	for rows.Next() {
		var stage string
		var count int64
		var oldest float64
		if err := rows.Scan(&stage, &count, &oldest); err != nil {
			return nil, err
		}
		timestamp := stage + "_oldest_received_timestamp_seconds"
		if stage == "outbox" {
			timestamp = "outbox_oldest_created_timestamp_seconds"
		}
		if _, ok := PostgresDefinitions[timestamp]; !ok || count < 0 || (count > 0 && oldest <= 0) || (count == 0 && oldest != 0) {
			return nil, fmt.Errorf("invalid backlog aggregate")
		}
		values[stage+"_pending_count"], values[timestamp] = float64(count), oldest
	}
	return values, rows.Err()
}
