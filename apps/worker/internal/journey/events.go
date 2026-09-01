package journey

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

type durableEvent struct {
	insertID, userID, name string
	sequence               int64
	receivedAt             time.Time
	matchedAt              *time.Time
}

// HandleEvent commits conversion, wait resolution, trigger outbox, and matched_at
// together. Queue redelivery and out-of-order normalization cannot split them.
func (s *Scheduler) HandleEvent(ctx context.Context, msg *libqueue.Message) error {
	var input struct {
		InsertID string `json:"insert_id"`
	}
	if err := json.Unmarshal(msg.Envelope.Payload, &input); err != nil {
		return err
	}
	if input.InsertID == "" {
		return fmt.Errorf("durable event has no insert_id")
	}
	tenantID, appID := msg.Envelope.TenantID, msg.Envelope.AppID
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var userID string
	err = tx.QueryRow(ctx, `SELECT user_id FROM event_receipts WHERE tenant_id=$1 AND app_id=$2 AND insert_id=$3`, tenantID, appID, input.InsertID).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	} // A deleted customer may leave a queued pointer.
	if err != nil {
		return fmt.Errorf("durable event receipt: %w", err)
	}
	if _, err := s.lockCustomer(ctx, tx, tenantID, appID, userID); err != nil {
		return err
	}
	var e durableEvent
	err = tx.QueryRow(ctx, `SELECT insert_id::text,user_id,event_name,receipt_seq,received_at,matched_at
		FROM event_receipts WHERE tenant_id=$1 AND app_id=$2 AND insert_id=$3 FOR UPDATE`, tenantID, appID, input.InsertID).
		Scan(&e.insertID, &e.userID, &e.name, &e.sequence, &e.receivedAt, &e.matchedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if e.matchedAt != nil {
		return nil
	}
	now, err := s.runtimeNow(ctx, tx)
	if err != nil {
		return err
	}
	var userActive bool
	if err := tx.QueryRow(ctx, `SELECT status='active' FROM users WHERE tenant_id=$1 AND app_id=$2 AND id=$3`, tenantID, appID, userID).Scan(&userActive); err != nil {
		return err
	}
	if userActive {
		rows, err := tx.Query(ctx, `SELECT j.id FROM journeys j
			LEFT JOIN journey_versions v ON v.journey_id=j.id AND v.version=j.active_version
			WHERE j.tenant_id=$1 AND j.app_id=$2 AND j.status IN ('active','paused') AND (
			(j.status='active' AND v.definition->'entry'->>'type'='trigger' AND v.definition->'entry'->>'trigger_event'=$4)
			OR EXISTS(SELECT 1 FROM journey_states st WHERE st.tenant_id=$1 AND st.app_id=$2 AND st.journey_id=j.id
			AND st.user_id=$3 AND st.status IN ('active','waiting','claimed'))) ORDER BY j.id`, tenantID, appID, userID, e.name)
		if err != nil {
			return err
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		for _, journeyID := range ids {
			if err := s.matchJourneyEvent(ctx, tx, tenantID, appID, journeyID, &e, now); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE event_receipts SET matched_at=$4 WHERE tenant_id=$1 AND app_id=$2 AND insert_id=$3`, tenantID, appID, e.insertID, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Scheduler) matchJourneyEvent(ctx context.Context, tx pgx.Tx, tenantID, appID, journeyID string, e *durableEvent, now time.Time) error {
	var status string
	var activeVersion *int
	if err := tx.QueryRow(ctx, `SELECT status,active_version FROM journeys
		WHERE tenant_id=$1 AND app_id=$2 AND id=$3 FOR SHARE`, tenantID, appID, journeyID).Scan(&status, &activeVersion); err != nil {
		return err
	}
	if status == "archived" {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT st.id,st.journey_version,st.current_node,st.entry_seq,st.entered_at,v.definition
		FROM journey_states st JOIN journey_versions v ON v.journey_id=st.journey_id AND v.version=st.journey_version
		WHERE st.tenant_id=$1 AND st.app_id=$2 AND st.journey_id=$3 AND st.user_id=$4
		AND st.status IN ('active','waiting','claimed') ORDER BY st.id FOR UPDATE OF st`, tenantID, appID, journeyID, e.userID)
	if err != nil {
		return err
	}
	type activeState struct {
		c       claimedState
		entered time.Time
		raw     []byte
	}
	states := []activeState{}
	for rows.Next() {
		st := activeState{c: claimedState{tenantID: tenantID, appID: appID, journeyID: journeyID, userID: e.userID}}
		if err := rows.Scan(&st.c.id, &st.c.version, &st.c.currentNode, &st.c.entrySeq, &st.entered, &st.raw); err != nil {
			rows.Close()
			return err
		}
		states = append(states, st)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	converted := false
	for _, st := range states {
		def, err := ParseDefinition(st.raw)
		if err != nil {
			return err
		}
		exited, err := s.applyPendingConversion(ctx, tx, &st.c, def, now)
		if err != nil {
			return err
		}
		if exited {
			converted = true
			continue
		}
		if def.SchemaVersion == 2 && st.c.currentNode >= 0 && st.c.currentNode < len(def.Nodes) {
			node := def.Nodes[st.c.currentNode]
			if node.Type == "event_wait" {
				if err := s.resolveWaitEvent(ctx, tx, &st.c, node, now); err != nil {
					return err
				}
			}
		}
	}
	// A conversion wins over entry even if a newer version changed its trigger.
	if converted || status != "active" || activeVersion == nil || len(states) != 0 {
		return nil
	}
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT v.definition FROM journey_versions v
		JOIN journeys j ON j.id=v.journey_id WHERE j.tenant_id=$1 AND j.app_id=$2 AND v.journey_id=$3 AND v.version=$4`, tenantID, appID, journeyID, *activeVersion).Scan(&raw); err != nil {
		return err
	}
	def, err := ParseDefinition(raw)
	if err != nil {
		return err
	}
	if def.Entry.Type != "trigger" || def.Entry.TriggerEvent != e.name || def.Exit.ConversionEvent == e.name {
		return nil
	}
	allowed, err := canAdmit(ctx, tx, tenantID, appID, journeyID, e.userID, def.Settings.Reentry, "trigger", now)
	if err != nil || !allowed {
		return err
	}
	payload, err := json.Marshal(entryPayload{JourneyID: journeyID, Version: *activeVersion, Source: "trigger", UserID: &e.userID, EntryID: e.insertID, ReceiptSeq: strconv.FormatInt(e.sequence, 10)})
	if err != nil {
		return err
	}
	key := fmt.Sprintf("v2:entry:%s:%d:%s:%s", journeyID, *activeVersion, e.userID, e.insertID)
	_, err = tx.Exec(ctx, `INSERT INTO journey_outbox(tenant_id,app_id,stream,idempotency_key,payload,created_at)
		VALUES($1,$2,'stream:journey.entry',$3,$4,$5) ON CONFLICT DO NOTHING`, tenantID, appID, key, payload, now)
	return err
}

func (s *Scheduler) resolveWaitEvent(ctx context.Context, tx pgx.Tx, c *claimedState, node Node, now time.Time) error {
	var record executionRecord
	err := tx.QueryRow(ctx, `SELECT status,arrived_at,after_seq,deadline FROM journey_node_executions
		WHERE tenant_id=$1 AND app_id=$2 AND state_id=$3 AND node_index=$4 FOR UPDATE`, c.tenantID, c.appID, c.id, c.currentNode).
		Scan(&record.status, &record.arrivedAt, &record.afterSeq, &record.deadline)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	} // The customer has not arrived at the wait yet.
	if err != nil {
		return err
	}
	if record.status != "waiting" {
		return nil
	}
	id, err := matchingReceipt(ctx, tx, c, node.EventName, &record)
	if err != nil || id == nil {
		return err
	}
	if err := s.resolveExecution(ctx, tx, c, "matched", id, now); err != nil {
		return err
	}
	// Keep the cursor at this node. Paused journeys record the result now and
	// advance only when resumed; invalidating the old claim prevents late writes.
	_, err = tx.Exec(ctx, `UPDATE journey_states SET status='waiting',next_wake_at=$4,
		claimed_by=NULL,claimed_at=NULL,claim_token=NULL,updated_at=$4
		WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND status IN ('active','waiting','claimed')`, c.tenantID, c.appID, c.id, now)
	return err
}
