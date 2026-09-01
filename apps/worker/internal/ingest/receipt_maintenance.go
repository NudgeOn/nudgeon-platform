package ingest

import (
	"context"
	"time"

	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

const receiptBodyRetention = 30 * 24 * time.Hour

// repairReceipts discovers tenant scopes only. All event reads and writes below
// are tenant/app-scoped. PG remains the source if a published stream entry was
// trimmed before any consumer could process it.
func (c *Consumer) repairReceipts(ctx context.Context) error {
	rows, err := c.pg.Query(ctx, `SELECT DISTINCT tenant_id, app_id FROM event_receipts
		WHERE matched_at IS NULL OR (purged_at IS NULL AND received_at < $1)`, c.clk.Now().Add(-receiptBodyRetention))
	if err != nil {
		return err
	}
	type scope struct{ tenantID, appID string }
	var scopes []scope
	for rows.Next() {
		var s scope
		if err := rows.Scan(&s.tenantID, &s.appID); err != nil {
			rows.Close()
			return err
		}
		scopes = append(scopes, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, s := range scopes {
		if err := c.repairReceiptScope(ctx, s.tenantID, s.appID); err != nil {
			return err
		}
		if err := c.cleanReceiptBodies(ctx, s.tenantID, s.appID); err != nil {
			return err
		}
	}
	return nil
}

func (c *Consumer) repairReceiptScope(ctx context.Context, tenantID, appID string) error {
	rows, err := c.pg.Query(ctx, `SELECT r.insert_id, r.user_id FROM event_receipts r
		LEFT JOIN journey_outbox o ON o.tenant_id = r.tenant_id AND o.app_id = r.app_id
		 AND o.idempotency_key = CASE WHEN r.projected_at IS NULL THEN 'event.ingest:' ELSE 'event.normalized:' END || r.insert_id::text
		WHERE r.tenant_id = $1 AND r.app_id = $2 AND r.matched_at IS NULL
		 AND (o.id IS NULL OR o.published_at < $3)
		ORDER BY r.received_at, r.receipt_seq LIMIT $4`, tenantID, appID, c.clk.Now().Add(-reclaimIdle), fetchCount)
	if err != nil {
		return err
	}
	type pending struct{ insertID, userID string }
	var entries []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.insertID, &p.userID); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, p := range entries {
		if err := c.requeueReceipt(ctx, tenantID, appID, p.userID, p.insertID); err != nil {
			return err
		}
	}
	return nil
}

func (c *Consumer) requeueReceipt(ctx context.Context, tenantID, appID, userID, insertID string) error {
	tx, err := c.pg.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	locked, err := lockReceiptCursor(ctx, tx, tenantID, appID, userID)
	if err != nil {
		return err
	}
	if !locked {
		return tx.Commit(ctx)
	}
	r, err := loadReceipt(ctx, tx, tenantID, appID, insertID)
	if err != nil {
		return err
	}
	if r == nil || r.matchedAt != nil {
		return tx.Commit(ctx)
	}
	stream, key := libqueue.StreamIngest, "event.ingest:"+insertID
	payload, err := r.ingestPayload()
	if r.projectedAt != nil {
		stream, key = libqueue.StreamEvents, "event.normalized:"+insertID
		payload, err = r.normalizedPayload()
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO journey_outbox (tenant_id, app_id, stream, idempotency_key, payload)
		VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, tenantID, appID, stream, key, payload); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE journey_outbox SET published_at = NULL
		WHERE tenant_id = $1 AND app_id = $2 AND idempotency_key = $3 AND published_at < $4`,
		tenantID, appID, key, c.clk.Now().Add(-reclaimIdle)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Keep the identity/order tombstone indefinitely (until user deletion). SDK
// offline queues have no time limit, so the old seven-day Redis key is not enough.
func (c *Consumer) cleanReceiptBodies(ctx context.Context, tenantID, appID string) error {
	tx, err := c.pg.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE event_receipts r
		SET properties = NULL, client_ts = NULL, device = NULL, purged_at = $4
		WHERE r.tenant_id = $1 AND r.app_id = $2 AND r.received_at < $3
		 AND r.projected_at IS NOT NULL AND r.matched_at IS NOT NULL AND r.purged_at IS NULL
		 AND NOT EXISTS (
		   SELECT 1 FROM journey_node_executions n JOIN journey_states s ON s.id = n.state_id
		   WHERE n.tenant_id = $1 AND n.app_id = $2 AND s.tenant_id = $1 AND s.app_id = $2
		     AND n.user_id = r.user_id AND s.status IN ('active', 'waiting', 'claimed')
		     AND n.status IN ('arrived', 'waiting', 'retrying')
		     AND (n.matched_insert_id = r.insert_id OR
		       (n.wait_event = r.event_name AND n.after_seq < r.receipt_seq
		        AND n.arrived_at <= r.received_at AND r.received_at < n.deadline)))`,
		tenantID, appID, c.clk.Now().Add(-receiptBodyRetention), c.clk.Now()); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM journey_outbox o USING event_receipts r
		WHERE o.tenant_id = $1 AND o.app_id = $2 AND r.tenant_id = $1 AND r.app_id = $2
		 AND r.purged_at IS NOT NULL AND (o.idempotency_key = 'event.ingest:' || r.insert_id::text
		 OR o.idempotency_key = 'event.normalized:' || r.insert_id::text)`, tenantID, appID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
