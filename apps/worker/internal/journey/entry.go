package journey

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Scheduler) enterUser(ctx context.Context, tenantID, appID, journeyID string, version int, userID, entryID, source string) error {
	def, err := s.loadDefinition(ctx, journeyID, version)
	if err != nil {
		return err
	}
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var sequence *int64
	var entry *string
	if def.SchemaVersion == 2 {
		if entryID == "" {
			return fmt.Errorf("v2 admission requires a stable entry_id")
		}
		seq, err := s.lockCustomer(ctx, tx, tenantID, appID, userID)
		if err != nil {
			return err
		}
		sequence, entry = &seq, &entryID
		if source == "trigger" {
			var event string
			err := tx.QueryRow(ctx, `SELECT receipt_seq,event_name FROM event_receipts
				WHERE tenant_id=$1 AND app_id=$2 AND user_id=$3 AND insert_id=$4`, tenantID, appID, userID, entryID).Scan(&seq, &event)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			if event != def.Entry.TriggerEvent || event == def.Exit.ConversionEvent {
				return nil
			}
		}
	}
	var journeyStatus string
	err = tx.QueryRow(ctx, `SELECT status FROM journeys WHERE tenant_id=$1 AND app_id=$2 AND id=$3 FOR SHARE`, tenantID, appID, journeyID).Scan(&journeyStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if journeyStatus == "archived" {
		return nil
	}
	if journeyStatus != "active" {
		return fmt.Errorf("journey admission is paused")
	}
	now, err := s.runtimeNow(ctx, tx)
	if err != nil {
		return err
	}
	if def.SchemaVersion == 2 {
		allowed, err := canAdmit(ctx, tx, tenantID, appID, journeyID, userID, def.Settings.Reentry, source, now)
		if err != nil {
			return err
		}
		if !allowed {
			return nil
		}
		if source == "trigger" && def.Exit.ConversionEvent != "" {
			var converted bool
			err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM event_receipts WHERE tenant_id=$1 AND app_id=$2
				AND user_id=$3 AND receipt_seq>$4 AND event_name=$5)`, tenantID, appID, userID, *sequence, def.Exit.ConversionEvent).Scan(&converted)
			if err != nil {
				return err
			}
			if converted {
				return nil
			}
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO journey_states
		(tenant_id,app_id,journey_id,journey_version,user_id,current_node,status,next_wake_at,entered_at,updated_at,entry_id,entry_seq)
		SELECT $1,$2,$3,$4,id,$6,'active',$7,$7,$7,$8,$9 FROM users
		WHERE tenant_id=$1 AND app_id=$2 AND id=$5 AND status='active' ON CONFLICT DO NOTHING`,
		tenantID, appID, journeyID, version, userID, def.startIndex(), now, entry, sequence)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func canAdmit(ctx context.Context, tx pgx.Tx, tenantID, appID, journeyID, userID string, reentry json.RawMessage, source string, now time.Time) (bool, error) {
	var active bool
	var entered *time.Time
	err := tx.QueryRow(ctx, `SELECT COALESCE(bool_or(status IN ('active','waiting','claimed')),false),max(entered_at)
		FROM journey_states WHERE tenant_id=$1 AND app_id=$2 AND journey_id=$3 AND user_id=$4`, tenantID, appID, journeyID, userID).Scan(&active, &entered)
	if err != nil || active {
		return false, err
	}
	// Reentry policy belongs to trigger journeys. A later blast is a new
	// campaign, while entry_id still deduplicates replay of the same audience.
	if source == "blast" {
		return true, nil
	}
	if entered == nil {
		return true, nil
	}
	if source == "trigger" && entered.Add(60*time.Second).After(now) {
		return false, nil
	}
	var mode string
	if json.Unmarshal(reentry, &mode) == nil {
		return mode == "always", nil
	}
	var days struct {
		AfterDays int `json:"after_days"`
	}
	if json.Unmarshal(reentry, &days) == nil && days.AfterDays > 0 {
		// Guard the arithmetic even if a caller did not compile a v2 definition.
		if days.AfterDays > maxReentryDays {
			return false, fmt.Errorf("reentry after_days exceeds %d", maxReentryDays)
		}
		return !entered.AddDate(0, 0, days.AfterDays).After(now), nil
	}
	return false, nil
}

// Keep blast admission batched. Lock receipt cursors in user order before the
// shared journey lock, then atomically capture each customer's admission fence.
func (s *Scheduler) enterAudiencePage(ctx context.Context, tenantID, appID, journeyID string, version int, userIDs []string, audienceRef string) error {
	if len(userIDs) == 0 {
		return nil
	}
	def, err := s.loadDefinition(ctx, journeyID, version)
	if err != nil {
		return err
	}
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `INSERT INTO event_customer_cursors(tenant_id,app_id,user_id,last_seq,updated_at)
		SELECT tenant_id,app_id,id,0,$4 FROM users WHERE tenant_id=$1 AND app_id=$2 AND id=ANY($3::uuid[]) AND status='active'
		ORDER BY id ON CONFLICT DO NOTHING`, tenantID, appID, userIDs, s.clk.Now()); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT user_id FROM event_customer_cursors WHERE tenant_id=$1 AND app_id=$2 AND user_id=ANY($3::uuid[])
		ORDER BY user_id FOR UPDATE`, tenantID, appID, userIDs)
	if err != nil {
		return err
	}
	for rows.Next() {
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM journeys WHERE tenant_id=$1 AND app_id=$2 AND id=$3 FOR SHARE`, tenantID, appID, journeyID).Scan(&status); err != nil {
		return err
	}
	if status == "archived" {
		return nil
	}
	if status != "active" {
		return fmt.Errorf("journey admission is paused")
	}
	now, err := s.runtimeNow(ctx, tx)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO journey_states
		(tenant_id,app_id,journey_id,journey_version,user_id,current_node,status,next_wake_at,entered_at,updated_at,entry_id,entry_seq)
		SELECT u.tenant_id,u.app_id,$3,$4,u.id,$6,'active',$7,$7,$7,
		CASE WHEN $8 THEN 'blast:'||$9::text||':'||u.id::text ELSE NULL END,
		CASE WHEN $8 THEN c.last_seq ELSE NULL END
		FROM users u JOIN event_customer_cursors c ON c.tenant_id=u.tenant_id AND c.app_id=u.app_id AND c.user_id=u.id
		WHERE u.tenant_id=$1 AND u.app_id=$2 AND u.id=ANY($5::uuid[]) AND u.status='active' ON CONFLICT DO NOTHING`,
		tenantID, appID, journeyID, version, userIDs, def.startIndex(), now, def.SchemaVersion == 2, audienceRef)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
