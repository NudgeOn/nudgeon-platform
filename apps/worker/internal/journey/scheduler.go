package journey

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/ondahq/onda/apps/worker/internal/clock"
	"github.com/ondahq/onda/apps/worker/internal/policy"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

const (
	tickInterval  = time.Second
	claimBatch    = 500
	relayBatch    = 500
	claimReap     = 5 * time.Minute // claimed 초과 회수 (DEV-sub-03)
	entryPageSize = 1000
)

// Scheduler — journey.entry 소비 + 상태머신 틱 + outbox 릴레이 + 리퍼.
type Scheduler struct {
	entryQueue *libqueue.Consumer
	producer   *libqueue.Producer
	pg         *pgxpool.Pool
	ch         driver.Conn
	rdb        redis.Cmdable
	freqCap    *policy.FreqCapChecker
	clk        clock.Clock
	logger     *slog.Logger
	consumer   string

	defMu sync.Mutex
	defs  map[string]*Definition // key: journey_id/version
}

func NewScheduler(
	entryQueue *libqueue.Consumer,
	producer *libqueue.Producer,
	pg *pgxpool.Pool,
	ch driver.Conn,
	rdb redis.Cmdable,
	clk clock.Clock,
	consumer string,
	logger *slog.Logger,
) *Scheduler {
	return &Scheduler{
		entryQueue: entryQueue, producer: producer, pg: pg, ch: ch,
		rdb: rdb, freqCap: policy.NewFreqCapChecker(rdb),
		clk: clk, consumer: consumer, logger: logger,
		defs: map[string]*Definition{},
	}
}

// appPolicy — 앱의 발송 정책 (quiet hours·freq cap·timezone). 매 message 노드에서 조회.
type appPolicy struct {
	quietHours policy.QuietHours
	freqCap    policy.FrequencyCap
	tz         *time.Location
}

func (s *Scheduler) loadAppPolicy(ctx context.Context, appID string) (*appPolicy, error) {
	var tzName string
	var qhRaw, fcRaw []byte
	if err := s.pg.QueryRow(ctx,
		`SELECT timezone, quiet_hours, frequency_cap FROM apps WHERE id = $1`, appID).
		Scan(&tzName, &qhRaw, &fcRaw); err != nil {
		return nil, err
	}
	qh, err := policy.ParseQuietHours(qhRaw)
	if err != nil {
		return nil, err
	}
	fc, err := policy.ParseFrequencyCap(fcRaw)
	if err != nil {
		return nil, err
	}
	tz, err := time.LoadLocation(tzName)
	if err != nil {
		tz = time.UTC
	}
	return &appPolicy{quietHours: qh, freqCap: fc, tz: tz}, nil
}

// RunEntryConsumer는 journey.entry를 소비해 journey_states를 벌크 생성한다 (IT-2).
func (s *Scheduler) RunEntryConsumer(ctx context.Context) error {
	if err := s.entryQueue.EnsureGroup(ctx); err != nil {
		return err
	}
	s.logger.Info("journey.entry 소비 시작")
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		msgs, err := s.entryQueue.Fetch(ctx, 50, time.Second)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			s.logger.Error("entry fetch 실패", "err", err)
			time.Sleep(time.Second)
			continue
		}
		for _, m := range msgs {
			if err := s.handleEntry(ctx, &m); err != nil {
				s.logger.Error("진입 처리 실패 — 재시도", "err", err, "msg_id", m.Envelope.ID)
				// ack 없이 재시도 (벌크 생성은 ON CONFLICT DO NOTHING으로 멱등)
				continue
			}
			if err := s.entryQueue.Ack(ctx, m.StreamID); err != nil {
				s.logger.Error("entry ack 실패", "err", err)
			}
		}
	}
}

type entryPayload struct {
	JourneyID   string  `json:"journey_id"`
	Version     int     `json:"version"`
	Source      string  `json:"source"`
	AudienceRef *string `json:"audience_ref"`
	UserID      *string `json:"user_id"`
}

func (s *Scheduler) handleEntry(ctx context.Context, m *libqueue.Message) error {
	var p entryPayload
	if err := json.Unmarshal(m.Envelope.Payload, &p); err != nil {
		s.logger.Warn("entry payload 불량 — skip", "err", err)
		return nil
	}
	env := &m.Envelope

	switch p.Source {
	case "blast":
		if p.AudienceRef == nil {
			s.logger.Warn("blast 진입에 audience_ref 없음 — skip")
			return nil
		}
		return s.bulkEnter(ctx, env.TenantID, env.AppID, p.JourneyID, p.Version, *p.AudienceRef)
	case "trigger":
		if p.UserID == nil {
			return nil
		}
		return s.enterUsers(ctx, env.TenantID, env.AppID, p.JourneyID, p.Version, []string{*p.UserID})
	default:
		return nil
	}
}

// bulkEnter는 audience_ref 커서를 페이지 단위로 스트리밍하며 journey_states를 벌크 생성한다.
func (s *Scheduler) bulkEnter(ctx context.Context, tenantID, appID, journeyID string, version int, audienceRef string) error {
	total := 0
	for offset := 0; ; offset += entryPageSize {
		rows, err := s.ch.Query(ctx, `
			SELECT toString(user_id) FROM campaign_audiences
			 WHERE audience_ref = ? ORDER BY user_id LIMIT ? OFFSET ?`,
			audienceRef, entryPageSize, offset)
		if err != nil {
			return fmt.Errorf("audience 조회: %w", err)
		}
		var page []string
		for rows.Next() {
			var uid string
			if err := rows.Scan(&uid); err != nil {
				rows.Close()
				return err
			}
			page = append(page, uid)
		}
		rows.Close()
		if len(page) == 0 {
			break
		}
		if err := s.enterUsers(ctx, tenantID, appID, journeyID, version, page); err != nil {
			return err
		}
		total += len(page)
		if len(page) < entryPageSize {
			break
		}
	}
	s.logger.Info("일괄 진입 완료", "journey", journeyID, "version", version, "count", total)
	return nil
}

// enterUsers는 유저 목록을 journey_states에 벌크 삽입한다.
// UNIQUE(진행중) 충돌은 무시(멱등·재진입 방지 — 동시 1인스턴스, PRD-03 3.1).
func (s *Scheduler) enterUsers(ctx context.Context, tenantID, appID, journeyID string, version int, userIDs []string) error {
	if len(userIDs) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	now := s.clk.Now()
	for _, uid := range userIDs {
		batch.Queue(`
			INSERT INTO journey_states
			  (tenant_id, app_id, journey_id, journey_version, user_id, current_node, status, next_wake_at, entered_at)
			VALUES ($1, $2, $3, $4, $5, 0, 'active', $6, $6)
			ON CONFLICT DO NOTHING`,
			tenantID, appID, journeyID, version, uid, now)
	}
	br := s.pg.SendBatch(ctx, batch)
	defer br.Close()
	for range userIDs {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("journey_states 벌크 삽입: %w", err)
		}
	}
	return nil
}
