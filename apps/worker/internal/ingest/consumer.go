// Package ingest — ingest-consumer 역할 (DEV-sub-01 §2).
// 배치 클레임 → 트랜잭션: users/devices upsert → CH 마이크로배치 insert → XACK.
// 크래시 시 pending 재클레임(XAUTOCLAIM, idle 30s). 멱등은 Redis dedup + CH 엔진 2중.
package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
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
	queue  *libqueue.Consumer
	dedup  *Deduper
	pg     *pgxpool.Pool
	ch     driver.Conn
	clk    clock.Clock
	logger *slog.Logger

	lastReclaim time.Time
}

func NewConsumer(
	queue *libqueue.Consumer,
	dedup *Deduper,
	pg *pgxpool.Pool,
	ch driver.Conn,
	clk clock.Clock,
	logger *slog.Logger,
) *Consumer {
	return &Consumer{queue: queue, dedup: dedup, pg: pg, ch: ch, clk: clk, logger: logger}
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
			// 배치 실패 — ack 없이 재시도 (at-least-once, dedup이 멱등 보장)
			c.logger.Error("배치 처리 실패 — 재시도 예정", "err", err, "count", len(msgs))
			time.Sleep(time.Second)
		}
	}
}

func (c *Consumer) processBatch(ctx context.Context, msgs []libqueue.Message) error {
	rows := make([][]any, 0, len(msgs)) // CH events 마이크로배치
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
		fresh, err := c.dedup.FilterNew(ctx, m.Envelope.TenantID, payload.Events)
		if err != nil {
			return err
		}
		for _, e := range fresh {
			userID, err := c.upsertUser(ctx, m.Envelope.TenantID, m.Envelope.AppID, e)
			if err != nil {
				return fmt.Errorf("user upsert: %w", err)
			}
			deviceID, err := c.upsertDevice(ctx, m.Envelope.TenantID, m.Envelope.AppID, userID, payload.Device)
			if err != nil {
				return fmt.Errorf("device upsert: %w", err)
			}
			props := "{}"
			if len(e.Properties) > 0 {
				props = string(e.Properties)
			}
			rows = append(rows, []any{
				m.Envelope.TenantID, m.Envelope.AppID, e.Event,
				userID, deviceID, props, e.ClientTS, e.ServerTS, e.InsertID,
			})
		}
		ackIDs = append(ackIDs, m.StreamID)
	}

	if len(rows) > 0 {
		if err := c.insertEvents(ctx, rows); err != nil {
			return fmt.Errorf("CH events insert: %w", err)
		}
	}
	return c.queue.Ack(ctx, ackIDs...)
}

// upsertUser는 external_id 우선, 없으면 anon_id로 유저를 찾거나 만든다.
// identify 병합(S2)은 별도 경로 — 여기서는 존재 보장만.
func (c *Consumer) upsertUser(ctx context.Context, tenantID, appID string, e TrackEvent) (string, error) {
	var id string
	now := c.clk.Now()
	if e.ExternalID != nil && *e.ExternalID != "" {
		err := c.pg.QueryRow(ctx, `
			INSERT INTO users (tenant_id, app_id, external_id, last_seen_at)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (app_id, external_id)
			DO UPDATE SET last_seen_at = GREATEST(users.last_seen_at, EXCLUDED.last_seen_at), updated_at = now()
			RETURNING id`,
			tenantID, appID, *e.ExternalID, now).Scan(&id)
		return id, err
	}
	err := c.pg.QueryRow(ctx, `
		INSERT INTO users (tenant_id, app_id, anon_id, last_seen_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (app_id, anon_id)
		DO UPDATE SET last_seen_at = GREATEST(users.last_seen_at, EXCLUDED.last_seen_at), updated_at = now()
		RETURNING id`,
		tenantID, appID, *e.AnonID, now).Scan(&id)
	return id, err
}

// upsertDevice는 SDK가 발급한 device_id를 PK로 upsert한다. 토큰 등록은 별도 엔드포인트(S2).
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

func (c *Consumer) insertEvents(ctx context.Context, rows [][]any) error {
	batch, err := c.ch.PrepareBatch(ctx, `
		INSERT INTO events (tenant_id, app_id, event_name, user_id, device_id,
		                    properties, client_ts, server_ts, insert_id)`)
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
