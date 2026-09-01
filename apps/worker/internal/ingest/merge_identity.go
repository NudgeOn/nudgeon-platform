package ingest

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type identifyProfiles struct{ external, anonymous string }

func findIdentifyProfiles(ctx context.Context, q Querier, tenantID, appID string, p *IdentifyPayload) (identifyProfiles, error) {
	var profiles identifyProfiles
	err := q.QueryRow(ctx, `SELECT id FROM users
		WHERE tenant_id = $1 AND app_id = $2 AND external_id = $3 AND status = 'active'`,
		tenantID, appID, p.ExternalID).Scan(&profiles.external)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return profiles, err
	}
	if p.AnonID != nil && *p.AnonID != "" {
		err = q.QueryRow(ctx, `SELECT id FROM users
			WHERE tenant_id = $1 AND app_id = $2 AND anon_id = $3 AND status = 'active'`,
			tenantID, appID, *p.AnonID).Scan(&profiles.anonymous)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return profiles, err
		}
	}
	return profiles, nil
}

func lockIdentifyProfiles(ctx context.Context, tx pgx.Tx, tenantID, appID string, p *IdentifyPayload) (identifyProfiles, error) {
	before, err := findIdentifyProfiles(ctx, tx, tenantID, appID, p)
	if err != nil {
		return before, err
	}
	var ids []string
	if before.external != "" {
		ids = append(ids, before.external)
	}
	if before.anonymous != "" && before.anonymous != before.external {
		ids = append(ids, before.anonymous)
	}
	sort.Strings(ids)
	// Lock ALL customer cursors before ANY profile. A receipt batch may cover
	// both identities, so interleaving cursor/user locks could deadlock it.
	for _, id := range ids {
		if err := lockCustomerCursor(ctx, tx, tenantID, appID, id); err != nil {
			return before, err
		}
	}
	for _, id := range ids {
		var status string
		err := tx.QueryRow(ctx, `SELECT status FROM users
			WHERE tenant_id = $1 AND app_id = $2 AND id = $3 FOR UPDATE`, tenantID, appID, id).Scan(&status)
		if err != nil {
			return before, err
		}
		if status != "active" {
			return before, identifyChanged()
		}
	}
	after, err := findIdentifyProfiles(ctx, tx, tenantID, appID, p)
	if err != nil {
		return before, err
	}
	if before != after {
		return before, identifyChanged()
	}
	return before, nil
}

func identifyChanged() error {
	return &pgconn.PgError{Code: "40001", Message: "identify customer changed while acquiring locks"}
}

// The caller holds both identity cursors and user rows. Do not take journey
// locks here: runtime uses cursor -> journey -> state -> node execution.
// Use each execution's immutable version, never the current draft/version.
// Receipts, cursor sequences, v1 states and canonical-user states stay intact.
func exitMergedV2Journeys(ctx context.Context, tx pgx.Tx, tenantID, appID, anonymousID string, now time.Time) error {
	_, err := tx.Exec(ctx, `WITH exited_states AS (
		UPDATE journey_states s SET status = 'exited', fail_reason = 'identity_merged',
		  next_wake_at = NULL, claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = $4
		FROM journey_versions v
		WHERE s.tenant_id = $1 AND s.app_id = $2 AND s.user_id = $3
		  AND s.status IN ('active', 'waiting', 'claimed')
		  AND v.journey_id = s.journey_id AND v.version = s.journey_version
		  AND v.definition->>'schema_version' = '2'
		RETURNING s.id
	)
	UPDATE journey_node_executions n SET status = 'exited', failure_reason = 'identity_merged',
	  resolved_at = $4, updated_at = $4
	WHERE n.tenant_id = $1 AND n.app_id = $2 AND n.user_id = $3
	  AND n.state_id IN (SELECT id FROM exited_states)
	  AND n.status IN ('arrived', 'waiting', 'retrying')`, tenantID, appID, anonymousID, now)
	if err != nil {
		return fmt.Errorf("exit merged anonymous v2 journeys: %w", err)
	}
	return nil
}
