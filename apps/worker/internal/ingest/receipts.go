package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

// receipt is the authoritative first accepted event, not the stream payload.
// A trimmed/replayed stream entry never assigns a new receipt time or sequence.
type receipt struct {
	tenantID, appID, insertID, userID, eventName string
	properties                                   json.RawMessage
	clientTS                                     *time.Time
	receivedAt                                   time.Time
	seq                                          int64
	device                                       *DeviceInfo
	projectedAt, matchedAt                       *time.Time
}

func loadReceipt(ctx context.Context, q Querier, tenantID, appID, insertID string) (*receipt, error) {
	r := &receipt{tenantID: tenantID, appID: appID, insertID: insertID}
	var deviceJSON []byte
	err := q.QueryRow(ctx, `
		SELECT user_id, event_name, properties, client_ts, received_at, receipt_seq, device, projected_at, matched_at
		  FROM event_receipts WHERE tenant_id = $1 AND app_id = $2 AND insert_id = $3`,
		tenantID, appID, insertID).Scan(&r.userID, &r.eventName, &r.properties, &r.clientTS,
		&r.receivedAt, &r.seq, &deviceJSON, &r.projectedAt, &r.matchedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil // deleted customer / already removed receipt: never resurrect it
	}
	if err != nil {
		return nil, err
	}
	if len(deviceJSON) != 0 && string(deviceJSON) != "null" {
		if err := json.Unmarshal(deviceJSON, &r.device); err != nil {
			return nil, fmt.Errorf("receipt device: %w", err)
		}
	}
	return r, nil
}

func (r *receipt) normalizedPayload() ([]byte, error) {
	if r.clientTS == nil || len(r.properties) == 0 {
		return nil, fmt.Errorf("unprocessed receipt body missing")
	}
	return json.Marshal(map[string]any{
		"insert_id": r.insertID, "user_id": r.userID, "event_name": r.eventName,
		"receipt_seq": strconv.FormatInt(r.seq, 10), "occurred_at": r.receivedAt,
		"received_at": r.receivedAt, "client_ts": *r.clientTS, "properties": r.properties,
	})
}

func (r *receipt) ingestPayload() ([]byte, error) {
	if r.clientTS == nil || len(r.properties) == 0 {
		return nil, fmt.Errorf("unprojected receipt body missing")
	}
	return json.Marshal(IngestBatchPayload{
		Endpoint: "track", RequestID: r.insertID, Device: r.device,
		Events: []TrackEvent{{InsertID: r.insertID, UserID: r.userID, Event: r.eventName,
			Properties: r.properties, ClientTS: *r.clientTS, ServerTS: r.receivedAt,
			ReceivedAt: r.receivedAt, ReceiptSeq: strconv.FormatInt(r.seq, 10)}},
	})
}

func lockCustomerCursor(ctx context.Context, q Querier, tenantID, appID, userID string) error {
	_, err := q.Exec(ctx, `INSERT INTO event_customer_cursors (tenant_id, app_id, user_id, last_seq)
		VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`, tenantID, appID, userID)
	if err != nil {
		return err
	}
	var seq int64
	return q.QueryRow(ctx, `SELECT last_seq FROM event_customer_cursors
		WHERE tenant_id = $1 AND app_id = $2 AND user_id = $3 FOR UPDATE`, tenantID, appID, userID).Scan(&seq)
}

// A stale projection/repair job must not recreate a cursor removed by deletion.
func lockReceiptCursor(ctx context.Context, q Querier, tenantID, appID, userID string) (bool, error) {
	var seq int64
	err := q.QueryRow(ctx, `SELECT last_seq FROM event_customer_cursors
		WHERE tenant_id = $1 AND app_id = $2 AND user_id = $3 FOR UPDATE`, tenantID, appID, userID).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// flushAndProject holds customer cursors until CH is durable and PG projection
// markers + normalized outbox jobs commit. Deletion uses the same cursor, so a
// deleted customer's event cannot be inserted after its CH deletion mutation.
func (c *Consumer) flushAndProject(ctx context.Context, rows *chRows) error {
	if len(rows.receipts) == 0 {
		return c.flushCH(ctx, rows)
	}
	tx, err := c.pg.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ordered := append([]*receipt(nil), rows.receipts...)
	sort.Slice(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		return a.tenantID+a.appID+a.userID < b.tenantID+b.appID+b.userID
	})
	active := map[string]bool{}
	for _, r := range ordered {
		key := r.tenantID + ":" + r.appID + ":" + r.userID
		if _, found := active[key]; found {
			continue
		}
		locked, err := lockReceiptCursor(ctx, tx, r.tenantID, r.appID, r.userID)
		if err != nil {
			return err
		}
		if !locked {
			active[key] = false
			continue
		}
		var status string
		err = tx.QueryRow(ctx, `SELECT status FROM users
			WHERE tenant_id = $1 AND app_id = $2 AND id = $3 FOR SHARE`, r.tenantID, r.appID, r.userID).Scan(&status)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		active[key] = err == nil && status != "deleted"
	}
	keep := map[string]bool{}
	var pending []*receipt
	for _, r := range rows.receipts {
		if !active[r.tenantID+":"+r.appID+":"+r.userID] {
			continue
		}
		current, err := loadReceipt(ctx, tx, r.tenantID, r.appID, r.insertID)
		if err != nil {
			return err
		}
		if current == nil || current.projectedAt != nil {
			continue
		}
		key := r.tenantID + ":" + r.appID + ":" + r.insertID
		if !keep[key] {
			keep[key] = true
			pending = append(pending, current)
		}
	}
	filtered := rows.events[:0]
	for _, event := range rows.events {
		key := fmt.Sprint(event[0]) + ":" + fmt.Sprint(event[1]) + ":" + fmt.Sprint(event[8])
		if keep[key] {
			filtered = append(filtered, event)
		}
	}
	rows.events = filtered
	if err := c.flushCH(ctx, rows); err != nil {
		return err
	}
	for _, r := range pending {
		payload, err := r.normalizedPayload()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO journey_outbox
			(tenant_id, app_id, stream, idempotency_key, payload) VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT DO NOTHING`, r.tenantID, r.appID, libqueue.StreamEvents, "event.normalized:"+r.insertID, payload); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE event_receipts SET projected_at = $4
			WHERE tenant_id = $1 AND app_id = $2 AND insert_id = $3 AND projected_at IS NULL`,
			r.tenantID, r.appID, r.insertID, c.clk.Now()); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
