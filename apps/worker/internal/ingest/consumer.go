// Package ingest — ingest-consumer 역할 (DEV-sub-01 §2).
// 배치 클레임 → users/devices upsert·병합·속성·토큰 → CH 마이크로배치 insert → XACK.
// 크래시 시 pending 재클레임(XAUTOCLAIM, idle 30s). 멱등은 Redis dedup + CH 엔진 2중.
package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ondahq/onda/apps/worker/internal/clock"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

const (
	fetchCount   = 200
	fetchBlock   = time.Second
	reclaimIdle  = 30 * time.Second
	reclaimEvery = 10 * time.Second
)

type Consumer struct {
	queue    *libqueue.Consumer
	producer *libqueue.Producer // 정규화 이벤트 발행 (stream:events)
	dedup    *Deduper
	pg       *pgxpool.Pool
	ch       driver.Conn
	clk      clock.Clock
	logger   *slog.Logger

	lastReclaim time.Time
}

func NewConsumer(
	queue *libqueue.Consumer,
	producer *libqueue.Producer,
	dedup *Deduper,
	pg *pgxpool.Pool,
	ch driver.Conn,
	clk clock.Clock,
	logger *slog.Logger,
) *Consumer {
	return &Consumer{queue: queue, producer: producer, dedup: dedup, pg: pg, ch: ch, clk: clk, logger: logger}
}

// Run은 소비 루프를 돈다. ctx 취소로 종료.
func (c *Consumer) Run(ctx context.Context) error {
	if err := c.queue.EnsureGroup(ctx); err != nil {
		return err
	}
	c.logger.Info("ingest-consumer 시작")
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		msgs, err := c.queue.Fetch(ctx, fetchCount, fetchBlock)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			c.logger.Error("fetch 실패", "err", err)
			time.Sleep(time.Second)
			continue
		}

		// 주기적으로 죽은 소비자의 pending 회수
		if c.clk.Now().Sub(c.lastReclaim) > reclaimEvery {
			c.lastReclaim = c.clk.Now()
			reclaimed, err := c.queue.Reclaim(ctx, reclaimIdle, fetchCount)
			if err != nil {
				c.logger.Error("reclaim 실패", "err", err)
			} else if len(reclaimed) > 0 {
				c.logger.Info("pending 회수", "count", len(reclaimed))
				msgs = append(msgs, reclaimed...)
			}
		}
		if len(msgs) == 0 {
			continue
		}
		if err := c.processBatch(ctx, msgs); err != nil {
			// 배치 실패 — ack 없이 재시도 (at-least-once, dedup·upsert가 멱등 보장)
			c.logger.Error("배치 처리 실패 — 재시도 예정", "err", err, "count", len(msgs))
			time.Sleep(time.Second)
		}
	}
}

// chRows — CH 마이크로배치 적재 대기 행 (테이블별)
type chRows struct {
	events  [][]any
	changes [][]any
	errors  [][]any
	// affected — 이 배치에서 상태가 바뀐 유저(미러 재생성 대상). map으로 중복 제거.
	affected map[string]struct{}
	// normEvents — 정규화 이벤트(트리거 매처용). flush 성공 후 발행.
	normEvents []normEvent
}

type normEvent struct {
	tenantID  string
	appID     string
	userID    string
	eventName string
	serverTS  time.Time
}

func newCHRows() *chRows {
	return &chRows{affected: map[string]struct{}{}}
}

func (r *chRows) touch(userID string) {
	if userID != "" && userID != "00000000-0000-0000-0000-000000000000" {
		r.affected[userID] = struct{}{}
	}
}

func (c *Consumer) processBatch(ctx context.Context, msgs []libqueue.Message) error {
	rows := newCHRows()
	ackIDs := make([]string, 0, len(msgs))

	for _, m := range msgs {
		payload, err := ParsePayload(m.Envelope.Payload)
		if err != nil {
			// 스키마 검증을 통과해 발행된 메시지가 깨진 경우 — 재시도 무의미, 버린다
			// (원본은 raw_ingestions에 보존 → replay 가능)
			c.logger.Warn("payload 파싱 실패 — skip", "err", err, "msg_id", m.Envelope.ID)
			ackIDs = append(ackIDs, m.StreamID)
			continue
		}
		if err := c.handle(ctx, m.Envelope.TenantID, m.Envelope.AppID, payload, rows); err != nil {
			return fmt.Errorf("%s 처리: %w", payload.Endpoint, err)
		}
		ackIDs = append(ackIDs, m.StreamID)
	}

	if err := c.flushCH(ctx, rows); err != nil {
		return err
	}
	// 정규화 이벤트 발행 (트리거 매처용) — flush 성공 후. 발행 실패는 로그만(수집은 이미 확정).
	c.publishNormEvents(ctx, rows.normEvents)
	return c.queue.Ack(ctx, ackIDs...)
}

func (c *Consumer) publishNormEvents(ctx context.Context, events []normEvent) {
	for _, e := range events {
		payload, _ := json.Marshal(map[string]any{
			"user_id":     e.userID,
			"event_name":  e.eventName,
			"occurred_at": e.serverTS,
		})
		env := &libqueue.Envelope{
			ID:         uuid.NewString(),
			Type:       "event.normalized",
			SchemaVer:  1,
			TenantID:   e.tenantID,
			AppID:      e.appID,
			OccurredAt: c.clk.Now(),
			TraceID:    uuid.NewString(),
			Payload:    json.RawMessage(payload),
		}
		if _, err := c.producer.Publish(ctx, libqueue.StreamEvents, env); err != nil {
			c.logger.Error("정규화 이벤트 발행 실패", "err", err, "event", e.eventName)
		}
	}
}

func (c *Consumer) handle(ctx context.Context, tenantID, appID string, p *IngestBatchPayload, rows *chRows) error {
	now := c.clk.Now()
	switch p.Endpoint {
	case "track":
		return c.handleTrack(ctx, tenantID, appID, p, rows)

	case "identify":
		userID, res, err := ProcessIdentify(ctx, c.pg, tenantID, appID, p.Identify, p.RequestID, now)
		if err != nil {
			return err
		}
		rows.changes = append(rows.changes, res.Changes...)
		rows.errors = append(rows.errors, res.Errors...)
		if p.Device != nil {
			if _, err := c.upsertDevice(ctx, tenantID, appID, userID, p.Device); err != nil {
				return err
			}
		}
		rows.touch(userID)
		// 병합으로 tombstone된 anon도 미러 상태(merged)를 갱신해야 평가에서 빠진다
		if p.Identify.AnonID != nil {
			if anonID := c.lookupAnonUserID(ctx, appID, *p.Identify.AnonID); anonID != "" {
				rows.touch(anonID)
			}
		}
		return nil

	case "attributes":
		for _, update := range p.Attributes {
			extID := update.ExternalID
			userID, err := c.resolveOrCreateUser(ctx, tenantID, appID, &extID, nil, now)
			if err != nil {
				return err
			}
			// 유저 단위 트랜잭션 — FOR UPDATE 잠금과 갱신의 원자성
			tx, err := c.pg.Begin(ctx)
			if err != nil {
				return err
			}
			res, err := ApplyAttributes(ctx, tx, tenantID, appID, userID, update.Attributes, "server", p.RequestID, now)
			if err != nil {
				_ = tx.Rollback(ctx)
				return err
			}
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			rows.changes = append(rows.changes, res.Changes...)
			rows.errors = append(rows.errors, res.Errors...)
			rows.touch(userID)
		}
		return nil

	case "devices_token":
		userID, err := c.resolveOrCreateUser(ctx, tenantID, appID, p.Token.ExternalID, p.Token.AnonID, now)
		if err != nil {
			return err
		}
		if err := ProcessToken(ctx, c.pg, tenantID, appID, userID, p.Device, p.Token, now); err != nil {
			return err
		}
		rows.touch(userID)
		return nil

	case "user_delete":
		// S2: 삭제 마킹만. 완전 익명화 + CH mutation은 S3 (D-8)
		var deletedID string
		err := c.pg.QueryRow(ctx, `
			UPDATE users SET status = 'deleted', updated_at = now()
			 WHERE tenant_id = $1 AND app_id = $2 AND external_id = $3 AND status = 'active'
			 RETURNING id`,
			tenantID, appID, p.UserDelete.ExternalID).Scan(&deletedID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil // 대상 없음 — 멱등
			}
			return err
		}
		rows.touch(deletedID) // 미러 status=deleted 반영 → 평가 제외
		return nil

	default:
		c.logger.Warn("알 수 없는 endpoint — skip", "endpoint", p.Endpoint)
		return nil
	}
}

func (c *Consumer) handleTrack(ctx context.Context, tenantID, appID string, p *IngestBatchPayload, rows *chRows) error {
	fresh, err := c.dedup.FilterNew(ctx, tenantID, p.Events)
	if err != nil {
		return err
	}
	for _, e := range fresh {
		userID, err := c.resolveOrCreateUser(ctx, tenantID, appID, e.ExternalID, e.AnonID, c.clk.Now())
		if err != nil {
			return fmt.Errorf("user upsert: %w", err)
		}
		deviceID, err := c.upsertDevice(ctx, tenantID, appID, userID, p.Device)
		if err != nil {
			return fmt.Errorf("device upsert: %w", err)
		}
		props := "{}"
		if len(e.Properties) > 0 {
			props = string(e.Properties)
		}
		rows.events = append(rows.events, []any{
			tenantID, appID, e.Event, userID, deviceID, props, e.ClientTS, e.ServerTS, e.InsertID,
		})
		rows.touch(userID)
		rows.normEvents = append(rows.normEvents, normEvent{
			tenantID: tenantID, appID: appID, userID: userID, eventName: e.Event, serverTS: e.ServerTS,
		})
	}
	return nil
}

// lookupAnonUserID는 anon_id에 해당하는 (tombstone 포함) 유저 id를 찾는다. 없으면 빈 문자열.
func (c *Consumer) lookupAnonUserID(ctx context.Context, appID, anonID string) string {
	var id string
	err := c.pg.QueryRow(ctx,
		`SELECT id FROM users WHERE app_id = $1 AND anon_id = $2`, appID, anonID).Scan(&id)
	if err != nil {
		return ""
	}
	return id
}

// resolveOrCreateUser는 external_id 우선, 없으면 anon_id로 유저를 찾거나 만든다.
// tombstone(merged) 프로필이면 승계 프로필로 리다이렉트한다 (병합 후 이벤트 귀속).
func (c *Consumer) resolveOrCreateUser(ctx context.Context, tenantID, appID string, externalID, anonID *string, now time.Time) (string, error) {
	var id, status string
	var mergedInto *string

	if externalID != nil && *externalID != "" {
		err := c.pg.QueryRow(ctx, `
			INSERT INTO users (tenant_id, app_id, external_id, last_seen_at)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (app_id, external_id)
			DO UPDATE SET last_seen_at = GREATEST(users.last_seen_at, EXCLUDED.last_seen_at), updated_at = now()
			RETURNING id, status, merged_into`,
			tenantID, appID, *externalID, now).Scan(&id, &status, &mergedInto)
		if err != nil {
			return "", err
		}
	} else if anonID != nil && *anonID != "" {
		err := c.pg.QueryRow(ctx, `
			INSERT INTO users (tenant_id, app_id, anon_id, last_seen_at)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (app_id, anon_id)
			DO UPDATE SET last_seen_at = GREATEST(users.last_seen_at, EXCLUDED.last_seen_at), updated_at = now()
			RETURNING id, status, merged_into`,
			tenantID, appID, *anonID, now).Scan(&id, &status, &mergedInto)
		if err != nil {
			return "", err
		}
	} else {
		return "", fmt.Errorf("식별자 없음")
	}

	if status == "merged" && mergedInto != nil {
		return *mergedInto, nil
	}
	return id, nil
}

// upsertDevice는 SDK가 발급한 device_id를 PK로 upsert한다 (토큰은 devices/token 경로 전용).
func (c *Consumer) upsertDevice(ctx context.Context, tenantID, appID, userID string, d *DeviceInfo) (string, error) {
	if d == nil {
		return "00000000-0000-0000-0000-000000000000", nil
	}
	meta, _ := json.Marshal(map[string]string{
		"app_version": d.AppVersion, "os_version": d.OSVersion,
		"model": d.Model, "locale": d.Locale,
	})
	var id string
	err := c.pg.QueryRow(ctx, `
		INSERT INTO devices (id, tenant_id, app_id, user_id, platform, device_meta, last_active_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id)
		DO UPDATE SET user_id = EXCLUDED.user_id, device_meta = EXCLUDED.device_meta,
		              last_active_at = EXCLUDED.last_active_at, updated_at = now()
		RETURNING id`,
		d.DeviceID, tenantID, appID, userID, d.Platform, meta, c.clk.Now()).Scan(&id)
	return id, err
}

func (c *Consumer) flushCH(ctx context.Context, rows *chRows) error {
	// 미러: 배치에서 건드린 유저의 최종 PG 상태를 읽어 profiles_mirror에 동봉 (PRD-02 3.1)
	if len(rows.affected) > 0 {
		userIDs := make([]string, 0, len(rows.affected))
		for id := range rows.affected {
			userIDs = append(userIDs, id)
		}
		mirrorRows, err := BuildMirrorRows(ctx, c.pg, userIDs, c.clk.Now())
		if err != nil {
			return err
		}
		if err := c.insertCH(ctx, `INSERT INTO profiles_mirror (tenant_id, app_id, user_id,
			external_id, std_attrs, custom_attrs, push_opt_in, os_permission_granted,
			token_active, platforms, status, updated_at)`, mirrorRows); err != nil {
			return fmt.Errorf("CH profiles_mirror insert: %w", err)
		}
	}
	if err := c.insertCH(ctx, `INSERT INTO events (tenant_id, app_id, event_name, user_id, device_id,
		properties, client_ts, server_ts, insert_id)`, rows.events); err != nil {
		return fmt.Errorf("CH events insert: %w", err)
	}
	if err := c.insertCH(ctx, `INSERT INTO attr_changes (tenant_id, app_id, user_id, attr_key,
		old_value, new_value, change_kind, source, changed_at, request_id)`, rows.changes); err != nil {
		return fmt.Errorf("CH attr_changes insert: %w", err)
	}
	if err := c.insertCH(ctx, `INSERT INTO ingestion_errors (tenant_id, app_id, endpoint, reason,
		detail, payload, request_id, received_at)`, rows.errors); err != nil {
		return fmt.Errorf("CH ingestion_errors insert: %w", err)
	}
	return nil
}

func (c *Consumer) insertCH(ctx context.Context, insertSQL string, rows [][]any) error {
	if len(rows) == 0 {
		return nil
	}
	batch, err := c.ch.PrepareBatch(ctx, insertSQL)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if err := batch.Append(r...); err != nil {
			return err
		}
	}
	return batch.Send()
}
