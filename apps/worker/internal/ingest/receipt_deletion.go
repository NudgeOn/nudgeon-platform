package ingest

import (
	"context"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Receipt identity is immutable, including events accepted before an anon merge.
// Delete every known alias as well as the current external profile, and return
// their internal IDs for the existing asynchronous CH deletion path.
func (c *Consumer) anonymizeUser(ctx context.Context, tenantID, appID, externalID string) ([]string, error) {
	for attempt := 0; ; attempt++ {
		ids, err := c.anonymizeUserOnce(ctx, tenantID, appID, externalID)
		if err == nil || attempt >= 2 || !isRetryable(err) {
			return ids, err
		}
	}
}

func relatedUsers(ctx context.Context, q Querier, tenantID, appID, rootID string) ([]string, error) {
	rows, err := q.Query(ctx, `WITH RECURSIVE related(id) AS (
		SELECT id FROM users WHERE tenant_id = $1 AND app_id = $2 AND id = $3
		UNION SELECT u.id FROM users u JOIN related r ON u.merged_into = r.id
		WHERE u.tenant_id = $1 AND u.app_id = $2)
		SELECT id FROM related ORDER BY id`, tenantID, appID, rootID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (c *Consumer) anonymizeUserOnce(ctx context.Context, tenantID, appID, externalID string) ([]string, error) {
	tx, err := c.pg.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var rootID string
	err = tx.QueryRow(ctx, `SELECT id FROM users
		WHERE tenant_id = $1 AND app_id = $2 AND external_id = $3 AND status = 'active'`, tenantID, appID, externalID).Scan(&rootID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ids, err := relatedUsers(ctx, tx, tenantID, appID, rootID)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		if err := lockCustomerCursor(ctx, tx, tenantID, appID, id); err != nil {
			return nil, err
		}
	}
	// All cursors first, then users in the same order as receipt acceptance.
	for _, id := range ids {
		var status string
		if err := tx.QueryRow(ctx, `SELECT status FROM users
			WHERE tenant_id = $1 AND app_id = $2 AND id = $3 FOR UPDATE`, tenantID, appID, id).Scan(&status); err != nil {
			return nil, err
		}
		if id == rootID && status != "active" {
			return nil, nil
		}
	}
	// A merge that committed while acquiring the locks requires a fresh lock set.
	current, err := relatedUsers(ctx, tx, tenantID, appID, rootID)
	if err != nil {
		return nil, err
	}
	if !slices.Equal(ids, current) {
		return nil, &pgconn.PgError{Code: "40001", Message: "customer aliases changed during deletion"}
	}
	for _, id := range ids {
		if _, err := tx.Exec(ctx, `UPDATE users SET status = 'deleted', external_id = NULL, anon_id = NULL,
			merged_into = NULL, std_attrs = '{}', custom_attrs = '{}', subscriptions = '{}', updated_at = $4
			WHERE tenant_id = $1 AND app_id = $2 AND id = $3`, tenantID, appID, id, c.clk.Now()); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE devices SET push_token = NULL, token_status = 'invalid', updated_at = $4
			WHERE tenant_id = $1 AND app_id = $2 AND user_id = $3`, tenantID, appID, id, c.clk.Now()); err != nil {
			return nil, err
		}
		if err := c.deleteReceiptState(ctx, tx, tenantID, appID, id); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_merges WHERE tenant_id = $1 AND app_id = $2
		AND (from_user_id = ANY($3::uuid[]) OR to_user_id = ANY($3::uuid[]))`, tenantID, appID, ids); err != nil {
		return nil, err
	}
	return ids, tx.Commit(ctx)
}

// Called only while holding the customer's cursor and profile row locks.
func (c *Consumer) deleteReceiptState(ctx context.Context, q Querier, tenantID, appID, userID string) error {
	if _, err := q.Exec(ctx, `UPDATE journey_states
		SET status = 'exited', next_wake_at = NULL, claimed_at = NULL, claimed_by = NULL, claim_token = NULL,
		 fail_reason = 'user_deleted', updated_at = $4
		WHERE tenant_id = $1 AND app_id = $2 AND user_id = $3 AND status IN ('active', 'waiting', 'claimed')`,
		tenantID, appID, userID, c.clk.Now()); err != nil {
		return err
	}
	if _, err := q.Exec(ctx, `UPDATE journey_node_executions
		SET status = CASE WHEN status IN ('arrived', 'waiting', 'retrying') THEN 'exited' ELSE status END,
		 resolved_at = COALESCE(resolved_at, $4), context = '{}', matched_insert_id = NULL,
		 failure_reason = NULL, updated_at = $4
		WHERE tenant_id = $1 AND app_id = $2 AND user_id = $3`, tenantID, appID, userID, c.clk.Now()); err != nil {
		return err
	}
	// Include already published outbox copies: they otherwise retain properties,
	// client identity or a device token after the authoritative data is deleted.
	if _, err := q.Exec(ctx, `DELETE FROM journey_outbox
		WHERE tenant_id = $1 AND app_id = $2 AND (
		 payload->>'user_id' = $3 OR
		 payload->'events' @> jsonb_build_array(jsonb_build_object('user_id', $3::text)))`,
		tenantID, appID, userID); err != nil {
		return err
	}
	if _, err := q.Exec(ctx, `DELETE FROM event_receipts
		WHERE tenant_id = $1 AND app_id = $2 AND user_id = $3`, tenantID, appID, userID); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `DELETE FROM event_customer_cursors
		WHERE tenant_id = $1 AND app_id = $2 AND user_id = $3`, tenantID, appID, userID)
	return err
}
