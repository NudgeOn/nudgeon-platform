package journey

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ondahq/onda/apps/worker/internal/policy"
)

// RunTick은 상태머신 틱 루프다. next_wake_at 도래한 상태를 클레임해 노드를 실행한다.
func (s *Scheduler) RunTick(ctx context.Context) error {
	s.logger.Info("scheduler 틱 시작")
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := s.tickOnce(ctx); err != nil && ctx.Err() == nil {
				s.logger.Error("틱 처리 실패", "err", err)
			}
		}
	}
}

// claimedState — 클레임한 상태 스냅샷
type claimedState struct {
	id         string
	tenantID   string
	appID      string
	journeyID  string
	version    int
	userID     string
	currentNode int
}

func (s *Scheduler) tickOnce(ctx context.Context) error {
	// 배치 클레임: waiting/active 중 기상 도래분을 claimed로 선점 (FOR UPDATE SKIP LOCKED)
	now := s.clk.Now()
	rows, err := s.pg.Query(ctx, `
		UPDATE journey_states SET status = 'claimed', claimed_by = $1, claimed_at = $2, updated_at = $2
		 WHERE id IN (
		   SELECT id FROM journey_states
		    WHERE status IN ('active', 'waiting')
		      AND (next_wake_at IS NULL OR next_wake_at <= $2)
		    ORDER BY next_wake_at NULLS FIRST
		    LIMIT $3
		    FOR UPDATE SKIP LOCKED
		 )
		 RETURNING id, tenant_id, app_id, journey_id, journey_version, user_id, current_node`,
		s.consumer, now, claimBatch)
	if err != nil {
		return fmt.Errorf("클레임: %w", err)
	}
	var claimed []claimedState
	for rows.Next() {
		var c claimedState
		if err := rows.Scan(&c.id, &c.tenantID, &c.appID, &c.journeyID, &c.version, &c.userID, &c.currentNode); err != nil {
			rows.Close()
			return err
		}
		claimed = append(claimed, c)
	}
	rows.Close()

	for _, c := range claimed {
		if err := s.executeNode(ctx, &c); err != nil {
			s.logger.Error("노드 실행 실패", "state", c.id, "err", err)
			s.failState(ctx, c.id, err.Error())
		}
	}
	return nil
}

// executeNode는 한 상태의 현재 노드를 실행하고 전이를 커밋한다 (전이+outbox 원자성).
func (s *Scheduler) executeNode(ctx context.Context, c *claimedState) error {
	def, err := s.loadDefinition(ctx, c.journeyID, c.version)
	if err != nil {
		return err
	}
	// 종료 조건: 노드 소진
	if c.currentNode >= len(def.Nodes) {
		return s.complete(ctx, c.id)
	}
	node := def.Nodes[c.currentNode]

	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	switch node.Type {
	case "delay":
		// 대기: 다음 노드로 전이 + 기상 시각 설정
		wake := s.clk.Now().Add(time.Duration(node.DurationSeconds) * time.Second)
		if _, err := tx.Exec(ctx, `
			UPDATE journey_states SET current_node = current_node + 1, status = 'waiting',
			       next_wake_at = $2, claimed_by = NULL, claimed_at = NULL, updated_at = $3
			 WHERE id = $1`, c.id, wake, s.clk.Now()); err != nil {
			return err
		}

	case "message":
		// 정책 검사: quiet hours가 delay면 전이하지 않고 다음 open까지 대기 (노드 유지)
		pol, err := s.loadAppPolicy(ctx, c.appID)
		if err != nil {
			return err
		}
		cat := policy.Category(def.Settings.Category)
		qd, err := policy.EvaluateQuietHours(cat, pol.quietHours, pol.tz, s.clk.Now())
		if err != nil {
			return err
		}
		if qd.Action == policy.ActionDelay {
			// 발송 보류 — 노드 유지, 다음 허용 시각에 재실행 (PRD-03 6.1 delay_until_open)
			if _, err := tx.Exec(ctx, `
				UPDATE journey_states SET status = 'waiting', next_wake_at = $2,
				       claimed_by = NULL, claimed_at = NULL, updated_at = $3
				 WHERE id = $1`, c.id, qd.DelayUntil, s.clk.Now()); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
		// send 또는 skip(quiet_hours skip 정책) — 어느 쪽이든 노드는 전진
		if qd.Action == policy.ActionSend {
			if err := s.enqueueSends(ctx, tx, c, def, node, pol); err != nil {
				return err
			}
		} else {
			s.logSkip(ctx, c, "skipped_quiet_hours")
		}
		nextStatus := "active"
		if c.currentNode+1 >= len(def.Nodes) {
			nextStatus = "completed"
		}
		if _, err := tx.Exec(ctx, `
			UPDATE journey_states SET current_node = current_node + 1, status = $2,
			       next_wake_at = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = $3
			 WHERE id = $1`, c.id, nextStatus, s.clk.Now()); err != nil {
			return err
		}

	default:
		return fmt.Errorf("알 수 없는 노드 타입: %s", node.Type)
	}

	return tx.Commit(ctx)
}

// enqueueSends는 유저의 도달 가능 디바이스마다 send.push outbox 행을 기록한다.
// 도달성·정책 검사(카테고리 반영)는 메시지 노드 실행 시점 (PRD-03 3.1, 6장).
func (s *Scheduler) enqueueSends(ctx context.Context, tx pgx.Tx, c *claimedState, def *Definition, node Node, pol *appPolicy) error {
	cat := policy.Category(def.Settings.Category)
	marketing := cat != policy.Transactional

	// 도달 가능 디바이스 + 렌더용 속성 조회
	var stdAttrs, customAttrs []byte
	var subscriptions []byte
	err := tx.QueryRow(ctx,
		`SELECT std_attrs, custom_attrs, subscriptions FROM users WHERE id = $1`, c.userID).
		Scan(&stdAttrs, &customAttrs, &subscriptions)
	if err != nil {
		return fmt.Errorf("유저 조회: %w", err)
	}
	// marketing이면 opt-in 필수 (transactional은 우회)
	if marketing {
		var sub map[string]string
		_ = json.Unmarshal(subscriptions, &sub)
		if sub["push"] != "opted_in" {
			s.logSkip(ctx, c, "skipped_unreachable") // opt-out
			return nil
		}
	}
	// frequency cap (유저당 24h N건, transactional 우회) — 원자 검사+증가
	allowed, err := s.freqCap.Allow(ctx, cat, pol.freqCap, c.appID, c.userID)
	if err != nil {
		return err
	}
	if !allowed {
		s.logSkip(ctx, c, "skipped_cap")
		return nil
	}
	attrs := mergeAttrs(stdAttrs, customAttrs)
	title := Render(node.Push.Title, attrs)
	body := Render(node.Push.Body, attrs)

	rows, err := tx.Query(ctx, `
		SELECT id, push_token, platform FROM devices
		 WHERE user_id = $1 AND push_token IS NOT NULL
		   AND token_status = 'active' AND os_permission = 'granted'`, c.userID)
	if err != nil {
		return err
	}
	type dev struct{ id, token, platform string }
	var devices []dev
	for rows.Next() {
		var d dev
		if err := rows.Scan(&d.id, &d.token, &d.platform); err != nil {
			rows.Close()
			return err
		}
		devices = append(devices, d)
	}
	rows.Close()

	category := "marketing"
	if !marketing {
		category = "transactional"
	}
	for _, d := range devices {
		idemKey := fmt.Sprintf("%s:%d:%s:%d:%s", c.journeyID, c.version, c.userID, c.currentNode, d.id)
		payload := map[string]any{
			"idempotency_key": idemKey,
			"user_id":         c.userID,
			"device_id":       d.id,
			"push_token":      d.token,
			"platform":        d.platform,
			"content":         map[string]any{"push": map[string]any{"title": title, "body": body}},
			"category":        category,
			"journey_id":      c.journeyID,
			"journey_version": c.version,
			"node_index":      c.currentNode,
		}
		payloadJSON, _ := json.Marshal(payload)
		if _, err := tx.Exec(ctx, `
			INSERT INTO journey_outbox (tenant_id, app_id, stream, idempotency_key, payload)
			VALUES ($1, $2, 'stream:send.push', $3, $4)`,
			c.tenantID, c.appID, idemKey, payloadJSON); err != nil {
			return err
		}
	}
	return nil
}

// logSkip은 발송 생략 사유를 message_log에 기록한다 (PRD-04 5장 — "왜 안 갔는지").
// 디바이스 단위가 아닌 유저 단위 skip이므로 device_id는 0.
func (s *Scheduler) logSkip(ctx context.Context, c *claimedState, status string) {
	idemKey := fmt.Sprintf("%s:%d:%s:%d:skip", c.journeyID, c.version, c.userID, c.currentNode)
	err := s.ch.Exec(ctx, `
		INSERT INTO message_log (tenant_id, app_id, message_id, idempotency_key,
			journey_id, journey_version, node_index, campaign_ref,
			user_id, device_id, channel, status, failure_class, failure_detail, sent_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '00000000-0000-0000-0000-000000000000',
		        'push', ?, '', '', ?)`,
		c.tenantID, c.appID, uuidString(), idemKey,
		c.journeyID, uint32(c.version), uint16(c.currentNode),
		c.userID, status, s.clk.Now())
	if err != nil {
		s.logger.Error("skip 로그 기록 실패", "err", err, "state", c.id, "status", status)
	}
}

func (s *Scheduler) complete(ctx context.Context, stateID string) error {
	_, err := s.pg.Exec(ctx, `
		UPDATE journey_states SET status = 'completed', claimed_by = NULL, claimed_at = NULL, updated_at = $2
		 WHERE id = $1`, stateID, s.clk.Now())
	return err
}

func (s *Scheduler) failState(ctx context.Context, stateID, reason string) {
	if _, err := s.pg.Exec(ctx, `
		UPDATE journey_states SET status = 'failed', fail_reason = $2,
		       claimed_by = NULL, claimed_at = NULL, updated_at = $3
		 WHERE id = $1`, stateID, reason, s.clk.Now()); err != nil {
		s.logger.Error("failState 실패", "state", stateID, "err", err)
	}
}

func (s *Scheduler) loadDefinition(ctx context.Context, journeyID string, version int) (*Definition, error) {
	key := fmt.Sprintf("%s/%d", journeyID, version)
	s.defMu.Lock()
	if d, ok := s.defs[key]; ok {
		s.defMu.Unlock()
		return d, nil
	}
	s.defMu.Unlock()

	var raw []byte
	err := s.pg.QueryRow(ctx,
		`SELECT definition FROM journey_versions WHERE journey_id = $1 AND version = $2`,
		journeyID, version).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("저니 버전 없음: %s/%d", journeyID, version)
		}
		return nil, err
	}
	def, err := ParseDefinition(raw)
	if err != nil {
		return nil, err
	}
	s.defMu.Lock()
	s.defs[key] = def // 불변 버전이므로 영구 캐시 안전
	s.defMu.Unlock()
	return def, nil
}

func mergeAttrs(stdRaw, customRaw []byte) map[string]string {
	out := map[string]string{}
	for _, raw := range [][]byte{stdRaw, customRaw} {
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil {
			for k, v := range m {
				switch t := v.(type) {
				case string:
					out[k] = t
				default:
					b, _ := json.Marshal(t)
					out[k] = string(b)
				}
			}
		}
	}
	return out
}
