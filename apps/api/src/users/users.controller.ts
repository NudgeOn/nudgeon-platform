import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { CLICKHOUSE, PG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";

/** 유저 검색 · 프로필 상세 (PRD-05 3.2). "왜 안 갔나" 2클릭의 데이터 소스 (U-7). */
@Controller("v1/apps/:appId/users")
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermission("users:read") // 중앙 인가(R-07) — 전 역할이 보유(READ_ALL)하나 명시 강제
export class UsersController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
  ) {}

  /** 검색: external_id 또는 email 완전 일치 (PRD-05 3.2, 전문 검색 비범위) */
  @Get()
  async search(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Query("q") q: string | undefined,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    if (!q) return { users: [] };
    const { rows } = await this.pg.query(
      `SELECT id, external_id, std_attrs->>'email' AS email, status, last_seen_at
         FROM users
        WHERE tenant_id = $1 AND app_id = $2 AND status = 'active'
          AND (external_id = $3 OR std_attrs->>'email' = $3)
        LIMIT 20`,
      [req.member.tenantId, appId, q],
    );
    return { users: rows };
  }

  /** 프로필 상세: 개요·디바이스·활동·메시지 이력·저니 */
  @Get(":id")
  async detail(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const { rows } = await this.pg.query(
      `SELECT id, external_id, anon_id, std_attrs, custom_attrs, subscriptions,
              status, last_seen_at, created_at
         FROM users WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
      [id, req.member.tenantId, appId],
    );
    const user = rows[0];
    if (!user) throw new NotFoundException("유저를 찾을 수 없습니다");

    // 디바이스 — 토큰 상태·OS 권한이 "왜 안 받았나"의 1차 답 (PRD-05 3.2)
    const devices = await this.pg.query(
      `SELECT id, platform, token_status, os_permission,
              (push_token IS NOT NULL) AS has_token,
              device_meta, last_active_at, updated_at
         FROM devices WHERE user_id = $1 ORDER BY last_active_at DESC NULLS LAST`,
      [id],
    );

    // 진행 중/완료 저니
    const journeys = await this.pg.query(
      `SELECT js.journey_id, j.name, js.journey_version, js.current_node, js.status,
              js.next_wake_at, js.entered_at
         FROM journey_states js JOIN journeys j ON j.id = js.journey_id
        WHERE js.user_id = $1 ORDER BY js.entered_at DESC LIMIT 20`,
      [id],
    );

    // 활동 이벤트 (최근 50) + 메시지 이력 (skip 사유 포함) — ClickHouse
    const eventsRes = await this.ch.query({
      query: `SELECT event_name, formatDateTime(server_ts, '%Y-%m-%dT%H:%M:%S') AS ts
                FROM events WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID} AND user_id = {uid:UUID}
               ORDER BY server_ts DESC LIMIT 50`,
      query_params: { tid: req.member.tenantId, aid: appId, uid: id },
      format: "JSONEachRow",
    });
    const messagesRes = await this.ch.query({
      query: `SELECT channel, status, failure_class, failure_detail, journey_id,
                     formatDateTime(sent_at, '%Y-%m-%dT%H:%M:%S') AS sent_at
                FROM message_log WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID} AND user_id = {uid:UUID}
               ORDER BY sent_at DESC LIMIT 50`,
      query_params: { tid: req.member.tenantId, aid: appId, uid: id },
      format: "JSONEachRow",
    });

    return {
      user: {
        id: user.id,
        external_id: user.external_id,
        std_attrs: user.std_attrs,
        custom_attrs: user.custom_attrs,
        subscriptions: user.subscriptions,
        status: user.status,
        last_seen_at: user.last_seen_at,
        created_at: user.created_at,
      },
      devices: devices.rows,
      journeys: journeys.rows,
      events: await eventsRes.json(),
      messages: await messagesRes.json(),
    };
  }

  private async assertApp(appId: string, req: SessionRequest) {
    const { rowCount } = await this.pg.query(`SELECT 1 FROM apps WHERE id = $1 AND tenant_id = $2`, [
      appId,
      req.member.tenantId,
    ]);
    if (!rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");
  }
}
