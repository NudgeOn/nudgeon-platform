package ingest

import (
	"context"
	"encoding/json"
	"fmt"

	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

// Old ingest stream entries may predate the durable API. Adopt each exactly once
// while preserving its original server_ts, so backlog is not a new wait event.
func (c *Consumer) legacyReceipt(ctx context.Context, tenantID, appID string, event TrackEvent, device *DeviceInfo, rows *chRows) (*receipt, error) {
	existing, err := loadReceipt(ctx, c.pg, tenantID, appID, event.InsertID)
	if err != nil || existing != nil {
		return existing, err
	}
	// Preserve the old 7-day dedup behavior for legacy events already processed
	// before deployment. Durable API events never use this expiring filter.
	fresh, keys, err := c.dedup.FilterUnseen(ctx, tenantID, []TrackEvent{event}, rows.seen)
	if err != nil || len(fresh) == 0 {
		return nil, err
	}
	rows.markKeys = append(rows.markKeys, keys...)
	tx, err := c.pg.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
		"event.receipt:"+tenantID+":"+appID+":"+event.InsertID); err != nil {
		return nil, err
	}
	existing, err = loadReceipt(ctx, tx, tenantID, appID, event.InsertID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, tx.Commit(ctx)
	}
	userID, err := c.resolveOrCreateUser(ctx, tenantID, appID, event.ExternalID, event.AnonID, c.clk.Now())
	if err != nil {
		return nil, err
	}
	if err := lockCustomerCursor(ctx, tx, tenantID, appID, userID); err != nil {
		return nil, err
	}
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM users
		WHERE tenant_id = $1 AND app_id = $2 AND id = $3 FOR SHARE`, tenantID, appID, userID).Scan(&status); err != nil {
		return nil, err
	}
	if status == "deleted" {
		return nil, tx.Commit(ctx)
	}
	if event.ClientTS.IsZero() {
		return nil, fmt.Errorf("legacy track client timestamp missing")
	}
	received := event.ServerTS
	if received.IsZero() {
		received = c.clk.Now()
	}
	properties := event.Properties
	if len(properties) == 0 {
		properties = json.RawMessage(`{}`)
	}
	r := &receipt{tenantID: tenantID, appID: appID, userID: userID, insertID: event.InsertID,
		eventName: event.Event, properties: properties, clientTS: &event.ClientTS, receivedAt: received, device: device}
	if err := tx.QueryRow(ctx, `UPDATE event_customer_cursors SET last_seq = last_seq + 1, updated_at = $4
		WHERE tenant_id = $1 AND app_id = $2 AND user_id = $3 RETURNING last_seq`,
		tenantID, appID, userID, c.clk.Now()).Scan(&r.seq); err != nil {
		return nil, err
	}
	var deviceJSON []byte
	if device != nil {
		deviceJSON, err = json.Marshal(device)
		if err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO event_receipts
		(tenant_id, app_id, insert_id, user_id, event_name, properties, client_ts, received_at, receipt_seq, device)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		tenantID, appID, event.InsertID, userID, event.Event, properties, event.ClientTS, received, r.seq, deviceJSON); err != nil {
		return nil, err
	}
	payload, err := r.ingestPayload()
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO journey_outbox
		(tenant_id, app_id, stream, idempotency_key, payload, published_at)
		VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
		tenantID, appID, libqueue.StreamIngest, "event.ingest:"+r.insertID, payload, c.clk.Now()); err != nil {
		return nil, err
	}
	return r, tx.Commit(ctx)
}
