package journey

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/policy"
)

const nodeMaxAttempts = 5

type executionRecord struct {
	status, output string
	context        []byte
	arrivedAt      time.Time
	afterSeq       *int64
	deadline       *time.Time
	matchedID      *string
	retries        int
}

// Cursor -> journey -> state -> execution is the shared lock order. Ingress
// takes the same customer cursor, so event registration has an exact boundary.
func (s *Scheduler) lockClaim(ctx context.Context, c *claimedState, def *Definition) (pgx.Tx, int64, time.Time, error) {
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return nil, 0, time.Time{}, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = tx.Rollback(ctx)
		}
	}()
	var seq int64
	if def != nil {
		seq, err = s.lockCustomer(ctx, tx, c.tenantID, c.appID, c.userID)
		if err != nil {
			return nil, 0, time.Time{}, err
		}
	}
	var journeyStatus string
	err = tx.QueryRow(ctx, `SELECT status FROM journeys WHERE tenant_id=$1 AND app_id=$2 AND id=$3 FOR SHARE`,
		c.tenantID, c.appID, c.journeyID).Scan(&journeyStatus)
	if err != nil {
		return nil, 0, time.Time{}, err
	}
	var status string
	var index int
	var token *string
	err = tx.QueryRow(ctx, `SELECT status, current_node, claim_token::text FROM journey_states
		WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND journey_id=$4 AND journey_version=$5 AND user_id=$6 FOR UPDATE`,
		c.tenantID, c.appID, c.id, c.journeyID, c.version, c.userID).Scan(&status, &index, &token)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, time.Time{}, nil
	}
	if err != nil {
		return nil, 0, time.Time{}, err
	}
	if status != "claimed" || index != c.currentNode || token == nil || *token != c.claimToken {
		return nil, 0, time.Time{}, nil
	}
	now, err := s.runtimeNow(ctx, tx)
	if err != nil {
		return nil, 0, time.Time{}, err
	}
	if journeyStatus != "active" {
		if journeyStatus == "archived" {
			err = s.exitState(ctx, tx, c, now)
		} else {
			_, err = tx.Exec(ctx, `UPDATE journey_states SET status='waiting', claimed_by=NULL,
			claimed_at=NULL, claim_token=NULL, updated_at=$4 WHERE tenant_id=$1 AND app_id=$2 AND id=$3`, c.tenantID, c.appID, c.id, now)
		}
		if err != nil {
			return nil, 0, time.Time{}, err
		}
		return nil, 0, time.Time{}, tx.Commit(ctx)
	}
	keep = true
	return tx, seq, now, nil
}

func (s *Scheduler) lockCustomer(ctx context.Context, tx pgx.Tx, tenantID, appID, userID string) (int64, error) {
	_, err := tx.Exec(ctx, `INSERT INTO event_customer_cursors (tenant_id,app_id,user_id,last_seq,updated_at)
		SELECT tenant_id,app_id,id,0,$4 FROM users WHERE tenant_id=$1 AND app_id=$2 AND id=$3
		ON CONFLICT DO NOTHING`, tenantID, appID, userID, s.clk.Now())
	if err != nil {
		return 0, err
	}
	var seq int64
	err = tx.QueryRow(ctx, `SELECT last_seq FROM event_customer_cursors
		WHERE tenant_id=$1 AND app_id=$2 AND user_id=$3 FOR UPDATE`, tenantID, appID, userID).Scan(&seq)
	return seq, err
}

// Production receipt and wait times come from PostgreSQL after the cursor lock.
// A supplied fake clock keeps deadline/race tests deterministic without sleeps.
func (s *Scheduler) runtimeNow(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	switch s.clk.(type) {
	case clock.Real, *clock.Real:
		var now time.Time
		if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
			return time.Time{}, err
		}
		return now, nil
	default:
		return s.clk.Now(), nil
	}
}

func (s *Scheduler) moveState(ctx context.Context, tx pgx.Tx, c *claimedState, next int, status string, wake *time.Time, now time.Time) error {
	tag, err := tx.Exec(ctx, `UPDATE journey_states SET current_node=$4, status=$5, next_wake_at=$6,
		claimed_by=NULL, claimed_at=NULL, claim_token=NULL, fail_reason=NULL, updated_at=$7
		WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND status='claimed' AND claim_token=$8
		AND current_node=$9 AND journey_version=$10`,
		c.tenantID, c.appID, c.id, next, status, wake, now, c.claimToken, c.currentNode, c.version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("journey claim was lost")
	}
	return nil
}

func (s *Scheduler) ensureExecution(ctx context.Context, tx pgx.Tx, c *claimedState, node Node, now time.Time) (*executionRecord, error) {
	_, err := tx.Exec(ctx, `INSERT INTO journey_node_executions
		(state_id,node_id,node_index,tenant_id,app_id,journey_id,journey_version,user_id,status,arrived_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,'arrived',$9,$9) ON CONFLICT DO NOTHING`,
		c.id, node.ID, c.currentNode, c.tenantID, c.appID, c.journeyID, c.version, c.userID, now)
	if err != nil {
		return nil, err
	}
	var record executionRecord
	err = tx.QueryRow(ctx, `SELECT status,COALESCE(output_port,''),context,arrived_at,after_seq,deadline,matched_insert_id::text,retry_count
		FROM journey_node_executions WHERE tenant_id=$1 AND app_id=$2 AND state_id=$3 AND node_index=$4 FOR UPDATE`,
		c.tenantID, c.appID, c.id, c.currentNode).Scan(&record.status, &record.output, &record.context, &record.arrivedAt, &record.afterSeq, &record.deadline, &record.matchedID, &record.retries)
	return &record, err
}

func (s *Scheduler) executeDAG(ctx context.Context, tx pgx.Tx, c *claimedState, def *Definition, seq int64, now time.Time) error {
	if c.currentNode >= len(def.Nodes) {
		if err := s.moveState(ctx, tx, c, c.currentNode, "completed", nil, now); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	node := def.Nodes[c.currentNode]
	record, err := s.ensureExecution(ctx, tx, c, node, now)
	if err != nil {
		return err
	}
	if record.status == "resolved" {
		if err := s.advanceDAG(ctx, tx, c, def, record.output, now); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if record.status == "failed" || record.status == "exited" {
		return fmt.Errorf("terminal node execution cannot run")
	}
	port := "next"
	switch node.Type {
	case "branch":
		var snapshot conditionSnapshot
		if err := json.Unmarshal(record.context, &snapshot); err != nil {
			return err
		}
		if snapshot.EvaluatedAt.IsZero() {
			captured, err := s.captureCondition(ctx, tx, c, now, seq)
			if err != nil {
				return err
			}
			snapshot = *captured
			if err := s.setExecutionContext(ctx, tx, c, snapshot); err != nil {
				return err
			}
		}
		evaluationCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		matched, evalErr := s.evaluateCondition(evaluationCtx, tx, c, node.Condition, &snapshot)
		cancel()
		if evalErr != nil {
			if err := s.retryExecution(ctx, tx, c, record, evalErr, now); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
		port = "false"
		if matched {
			port = "true"
		}
	case "ab_split":
		port = chooseVariant(c.journeyID, node, c.userID)
		if err := s.setExecutionContext(ctx, tx, c, map[string]any{"variant_id": port, "assignment": "journey_node_user_sha256_v1"}); err != nil {
			return err
		}
	case "delay", "event_wait":
		if record.deadline == nil {
			seconds := node.DurationSeconds
			if node.Type == "event_wait" {
				seconds = node.TimeoutSeconds
			}
			deadline := now.Add(time.Duration(seconds) * time.Second)
			var event *string
			var after *int64
			if node.Type == "event_wait" {
				event, after = &node.EventName, &seq
			}
			_, err := tx.Exec(ctx, `UPDATE journey_node_executions SET status='waiting',wait_event=$5,
				after_seq=$6,deadline=$7,updated_at=$8 WHERE tenant_id=$1 AND app_id=$2 AND state_id=$3 AND node_index=$4`,
				c.tenantID, c.appID, c.id, c.currentNode, event, after, deadline, now)
			if err != nil {
				return err
			}
			record.deadline, record.afterSeq = &deadline, after
		}
		if node.Type == "event_wait" {
			matchedID, err := matchingReceipt(ctx, tx, c, node.EventName, record)
			if err != nil {
				return err
			}
			if matchedID != nil {
				port, record.matchedID = "matched", matchedID
			} else if !now.Before(*record.deadline) {
				port = "timeout"
			} else {
				port = ""
			}
		} else if now.Before(*record.deadline) {
			port = ""
		}
		if port == "" {
			if err := s.moveState(ctx, tx, c, c.currentNode, "waiting", record.deadline, now); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
	case "message":
		pol, err := s.loadAppPolicy(ctx, tx, c.tenantID, c.appID)
		if err != nil {
			return err
		}
		decision, err := policy.EvaluateQuietHours(policy.Category(def.Settings.Category), pol.quietHours, pol.tz, now)
		if err != nil {
			return err
		}
		if decision.Action == policy.ActionDelay {
			if _, err := tx.Exec(ctx, `UPDATE journey_node_executions SET status='waiting',updated_at=$5
				WHERE tenant_id=$1 AND app_id=$2 AND state_id=$3 AND node_index=$4`, c.tenantID, c.appID, c.id, c.currentNode, now); err != nil {
				return err
			}
			if err := s.moveState(ctx, tx, c, c.currentNode, "waiting", &decision.DelayUntil, now); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
		outcome := "skipped_quiet_hours"
		if decision.Action == policy.ActionSend {
			outcome, err = s.enqueueSends(ctx, tx, c, def, node, pol)
			if err != nil {
				return err
			}
		} else {
			s.logSkip(ctx, c, def, outcome)
		}
		if err := s.setExecutionContext(ctx, tx, c, map[string]any{"delivery_status": outcome}); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported DAG node type %q", node.Type)
	}
	if err := s.resolveExecution(ctx, tx, c, port, record.matchedID, now); err != nil {
		return err
	}
	if err := s.advanceDAG(ctx, tx, c, def, port, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func chooseVariant(journeyID string, node Node, userID string) string {
	hash := sha256.Sum256([]byte(journeyID + "\x00" + node.ID + "\x00" + userID))
	bucket := int(binary.BigEndian.Uint64(hash[:8]) % 100)
	for _, variant := range sortedVariants(node.Variants) {
		if bucket < variant.Weight {
			return variant.ID
		}
		bucket -= variant.Weight
	}
	return "" // Validated weights total 100.
}

func (s *Scheduler) setExecutionContext(ctx context.Context, tx pgx.Tx, c *claimedState, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE journey_node_executions SET context=context || $5::jsonb
		WHERE tenant_id=$1 AND app_id=$2 AND state_id=$3 AND node_index=$4`, c.tenantID, c.appID, c.id, c.currentNode, raw)
	return err
}

func (s *Scheduler) resolveExecution(ctx context.Context, tx pgx.Tx, c *claimedState, port string, matchedID *string, now time.Time) error {
	_, err := tx.Exec(ctx, `UPDATE journey_node_executions SET status='resolved',output_port=$5,
		matched_insert_id=$6,resolved_at=$7,updated_at=$7,failure_reason=NULL
		WHERE tenant_id=$1 AND app_id=$2 AND state_id=$3 AND node_index=$4
		AND status IN ('arrived','waiting','retrying')`, c.tenantID, c.appID, c.id, c.currentNode, port, matchedID, now)
	return err
}

func (s *Scheduler) advanceDAG(ctx context.Context, tx pgx.Tx, c *claimedState, def *Definition, port string, now time.Time) error {
	next, err := def.nextIndex(c.currentNode, port)
	if err != nil {
		return err
	}
	status := "active"
	if next >= len(def.Nodes) {
		status = "completed"
	}
	return s.moveState(ctx, tx, c, next, status, nil, now)
}

func (s *Scheduler) retryExecution(ctx context.Context, tx pgx.Tx, c *claimedState, record *executionRecord, failure error, now time.Time) error {
	attempts := record.retries + 1
	executionStatus, stateStatus := "retrying", "waiting"
	wake := now.Add(time.Duration(1<<min(attempts-1, 6)) * time.Second)
	var resolved *time.Time
	if attempts >= nodeMaxAttempts {
		executionStatus, stateStatus, resolved = "failed", "failed", &now
	}
	_, err := tx.Exec(ctx, `UPDATE journey_node_executions SET status=$5,retry_count=$6,
		failure_reason=$7,resolved_at=$8,updated_at=$9 WHERE tenant_id=$1 AND app_id=$2 AND state_id=$3 AND node_index=$4`,
		c.tenantID, c.appID, c.id, c.currentNode, executionStatus, attempts, failure.Error(), resolved, now)
	if err != nil {
		return err
	}
	if err := s.moveState(ctx, tx, c, c.currentNode, stateStatus, &wake, now); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE journey_states SET fail_reason=$4 WHERE tenant_id=$1 AND app_id=$2 AND id=$3`, c.tenantID, c.appID, c.id, failure.Error())
	return err
}

func (s *Scheduler) failClaim(ctx context.Context, c *claimedState, failure error) {
	def, _ := s.loadDefinition(ctx, c.journeyID, c.version)
	tx, _, now, err := s.lockClaim(ctx, c, def)
	if err != nil {
		s.logger.Error("claim failure recovery", "err", err, "state", c.id)
		return
	}
	if tx == nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if def != nil && def.SchemaVersion == 2 && c.currentNode >= 0 && c.currentNode < len(def.Nodes) {
		record, recordErr := s.ensureExecution(ctx, tx, c, def.Nodes[c.currentNode], now)
		if recordErr != nil {
			err = recordErr
		} else {
			err = s.retryExecution(ctx, tx, c, record, failure, now)
		}
	} else {
		err = s.moveState(ctx, tx, c, c.currentNode, "failed", nil, now)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE journey_states SET fail_reason=$4 WHERE tenant_id=$1 AND app_id=$2 AND id=$3`, c.tenantID, c.appID, c.id, failure.Error())
		}
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		s.logger.Error("claim failure recovery", "err", err, "state", c.id)
	}
}

func matchingReceipt(ctx context.Context, tx pgx.Tx, c *claimedState, event string, record *executionRecord) (*string, error) {
	if record.afterSeq == nil || record.deadline == nil {
		return nil, fmt.Errorf("event wait is missing its receipt boundary")
	}
	var id string
	err := tx.QueryRow(ctx, `SELECT insert_id::text FROM event_receipts
		WHERE tenant_id=$1 AND app_id=$2 AND user_id=$3 AND event_name=$4 AND receipt_seq>$5
		AND received_at >= $6 AND received_at < $7 ORDER BY receipt_seq LIMIT 1`,
		c.tenantID, c.appID, c.userID, event, *record.afterSeq, record.arrivedAt, *record.deadline).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func (s *Scheduler) applyPendingConversion(ctx context.Context, tx pgx.Tx, c *claimedState, def *Definition, now time.Time) (bool, error) {
	if def.Exit.ConversionEvent == "" {
		return false, nil
	}
	var exists bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM event_receipts r
		JOIN journey_states st ON st.tenant_id=r.tenant_id AND st.app_id=r.app_id AND st.user_id=r.user_id
		WHERE r.tenant_id=$1 AND r.app_id=$2 AND st.id=$3 AND r.event_name=$4
		AND ((st.entry_seq IS NOT NULL AND r.receipt_seq>st.entry_seq) OR (st.entry_seq IS NULL AND r.received_at>=st.entered_at)))`,
		c.tenantID, c.appID, c.id, def.Exit.ConversionEvent).Scan(&exists)
	if err != nil || !exists {
		return false, err
	}
	return true, s.exitState(ctx, tx, c, now)
}

func (s *Scheduler) exitState(ctx context.Context, tx pgx.Tx, c *claimedState, now time.Time) error {
	_, err := tx.Exec(ctx, `UPDATE journey_states SET status='exited',next_wake_at=NULL,claimed_by=NULL,
		claimed_at=NULL,claim_token=NULL,updated_at=$4 WHERE tenant_id=$1 AND app_id=$2 AND id=$3
		AND status IN ('active','waiting','claimed')`, c.tenantID, c.appID, c.id, now)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE journey_node_executions SET status='exited',resolved_at=$4,updated_at=$4
		WHERE tenant_id=$1 AND app_id=$2 AND state_id=$3 AND status IN ('arrived','waiting','retrying')`, c.tenantID, c.appID, c.id, now)
	return err
}
