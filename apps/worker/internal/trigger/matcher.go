package trigger

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/ondahq/onda/apps/worker/internal/clock"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

const (
	entryCooldown = 60 * time.Second // 유저·저니당 진입 쿨다운 (PRD-03 9장 Open Q2 초안)
	fetchCount    = 200
)

// Matcher — stream:events 소비 → 트리거 진입 + conversion 이탈.
type Matcher struct {
	queue    *libqueue.Consumer
	producer *libqueue.Producer
	rdb      redis.Cmdable
	pg       *pgxpool.Pool
	clk      clock.Clock
	logger   *slog.Logger
	idx      *activeIndex

	lastReload time.Time
}

func NewMatcher(
	queue *libqueue.Consumer,
	producer *libqueue.Producer,
	rdb redis.Cmdable,
	pg *pgxpool.Pool,
	clk clock.Clock,
	logger *slog.Logger,
) *Matcher {
	return &Matcher{
		queue: queue, producer: producer, rdb: rdb, pg: pg, clk: clk, logger: logger,
		idx: newActiveIndex(),
	}
}

type normalizedEvent struct {
	UserID    string `json:"user_id"`
	EventName string `json:"event_name"`
}

func (m *Matcher) Run(ctx context.Context) error {
	if err := m.queue.EnsureGroup(ctx); err != nil {
		return err
	}
	if err := m.idx.reload(ctx, m.pg); err != nil {
		m.logger.Error("초기 인덱스 로드 실패", "err", err)
	}
	m.lastReload = m.clk.Now()
	m.logger.Info("trigger-matcher 시작")

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// 활성 저니 인덱스 주기 갱신 (버전 변경·활성화 반영)
		if m.clk.Now().Sub(m.lastReload) > reloadInterval {
			if err := m.idx.reload(ctx, m.pg); err != nil {
				m.logger.Error("인덱스 갱신 실패", "err", err)
			}
			m.lastReload = m.clk.Now()
		}

		msgs, err := m.queue.Fetch(ctx, fetchCount, time.Second)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			m.logger.Error("events fetch 실패", "err", err)
			time.Sleep(time.Second)
			continue
		}
		for _, msg := range msgs {
			if err := m.handle(ctx, &msg); err != nil {
				m.logger.Error("이벤트 매칭 실패 — 재시도", "err", err, "msg_id", msg.Envelope.ID)
				continue // ack 안 함 (재시도; 진입 쿨다운·이탈 멱등)
			}
			if err := m.queue.Ack(ctx, msg.StreamID); err != nil {
				m.logger.Error("events ack 실패", "err", err)
			}
		}
	}
}

func (m *Matcher) handle(ctx context.Context, msg *libqueue.Message) error {
	var e normalizedEvent
	if err := json.Unmarshal(msg.Envelope.Payload, &e); err != nil {
		return nil // 형식 불량 — skip (ack)
	}
	appID := msg.Envelope.AppID
	tenantID := msg.Envelope.TenantID

	// 1) conversion 이탈 (진입보다 먼저 — 같은 이벤트가 이탈이면 진입시키지 않는 게 자연스러움)
	for _, ex := range m.idx.exitRules(appID, e.EventName) {
		if err := m.exitUser(ctx, ex.JourneyID, e.UserID); err != nil {
			return err
		}
	}

	// 2) 이벤트 트리거 진입
	for _, en := range m.idx.entryRules(appID, e.EventName) {
		ok, err := m.canEnter(ctx, &en, e.UserID)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		if err := m.publishEntry(ctx, tenantID, appID, &en, e.UserID); err != nil {
			return err
		}
	}
	return nil
}

// exitUser는 진행 중인 journey_states를 exited로 전이하고 전환을 기록한다 (O-5).
// 후속 노드는 스케줄러가 exited 상태를 클레임하지 않으므로 실행되지 않는다.
func (m *Matcher) exitUser(ctx context.Context, journeyID, userID string) error {
	tag, err := m.pg.Exec(ctx, `
		UPDATE journey_states SET status = 'exited', updated_at = $3
		 WHERE journey_id = $1 AND user_id = $2 AND status IN ('active', 'waiting', 'claimed')`,
		journeyID, userID, m.clk.Now())
	if err != nil {
		return fmt.Errorf("conversion 이탈: %w", err)
	}
	if tag.RowsAffected() > 0 {
		m.logger.Info("conversion 이탈", "journey", journeyID, "user", userID)
	}
	return nil
}

// canEnter는 재진입 정책 + 쿨다운을 검사한다 (O-6).
func (m *Matcher) canEnter(ctx context.Context, en *entryRule, userID string) (bool, error) {
	// 진입 쿨다운 (동일 유저·저니 60s) — 트리거 폭주 방어
	cdKey := fmt.Sprintf("trig:cd:%s:%s", en.JourneyID, userID)
	set, err := m.rdb.SetNX(ctx, cdKey, 1, entryCooldown).Result()
	if err != nil {
		return false, err
	}
	if !set {
		return false, nil // 쿨다운 중
	}

	// 진행 중 인스턴스가 있으면 진입 불가 (동시 1개 — UNIQUE가 최종 방어이나 사전 차단)
	var activeCount int
	if err := m.pg.QueryRow(ctx, `
		SELECT count(*) FROM journey_states
		 WHERE journey_id = $1 AND user_id = $2 AND status IN ('active','waiting','claimed')`,
		en.JourneyID, userID).Scan(&activeCount); err != nil {
		return false, err
	}
	if activeCount > 0 {
		return false, nil
	}

	switch en.Reentry {
	case "always":
		return true, nil
	case "after_days":
		// 마지막 진입이 N일 이내면 차단
		var recent int
		if err := m.pg.QueryRow(ctx, `
			SELECT count(*) FROM journey_states
			 WHERE journey_id = $1 AND user_id = $2 AND entered_at > $3`,
			en.JourneyID, userID, m.clk.Now().AddDate(0, 0, -en.ReentryDays)).Scan(&recent); err != nil {
			return false, err
		}
		return recent == 0, nil
	default: // never — 과거 진입 이력이 있으면 차단
		var everCount int
		if err := m.pg.QueryRow(ctx, `
			SELECT count(*) FROM journey_states WHERE journey_id = $1 AND user_id = $2`,
			en.JourneyID, userID).Scan(&everCount); err != nil {
			return false, err
		}
		return everCount == 0, nil
	}
}

func (m *Matcher) publishEntry(ctx context.Context, tenantID, appID string, en *entryRule, userID string) error {
	payload, _ := json.Marshal(map[string]any{
		"journey_id": en.JourneyID,
		"version":    en.Version,
		"source":     "trigger",
		"user_id":    userID,
	})
	env := &libqueue.Envelope{
		ID:         newID(),
		Type:       "journey.enter",
		SchemaVer:  1,
		TenantID:   tenantID,
		AppID:      appID,
		OccurredAt: m.clk.Now(),
		TraceID:    newID(),
		Payload:    payload,
	}
	_, err := m.producer.Publish(ctx, libqueue.StreamJourneyEntry, env)
	if err != nil {
		return fmt.Errorf("트리거 진입 발행: %w", err)
	}
	m.logger.Info("이벤트 트리거 진입", "journey", en.JourneyID, "user", userID, "event", en.TriggerEvent)
	return nil
}
