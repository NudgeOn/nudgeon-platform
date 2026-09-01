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

/** 메시지 로그 조회 (PRD-05 3.5). 필터: 상태·실패분류·저니. */
@Controller("v1/apps/:appId/message-log")
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermission("analytics:read") // 중앙 인가(R-07)
export class MessageLogController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
  ) {}

  @Get()
  async list(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Query("status") status: string | undefined,
    @Query("journey_id") journeyId: string | undefined,
    @Query("limit") limit: string | undefined,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const conds = ["tenant_id = {tid:UUID}", "app_id = {aid:UUID}"];
    const params: Record<string, unknown> = { tid: req.member.tenantId, aid: appId };
    if (status) {
      conds.push("status = {status:String}");
      params.status = status;
    }
    if (journeyId) {
      conds.push("journey_id = {jid:UUID}");
      params.jid = journeyId;
    }
    const max = Math.min(Number(limit) || 100, 500);

    const res = await this.ch.query({
      query: `SELECT message_id, idempotency_key, journey_id, journey_version, node_index,
                     campaign_ref, user_id, device_id, channel, status, failure_class,
                     failure_detail, formatDateTime(sent_at, '%Y-%m-%dT%H:%M:%S') AS sent_at
                FROM message_log WHERE ${conds.join(" AND ")}
               ORDER BY sent_at DESC LIMIT ${max}`,
      query_params: params,
      format: "JSONEachRow",
    });
    const rows = await res.json();

    // 실패율 배너용 최근 1시간 집계 (PRD-05 3.5 대량 실패 감지)
    const statRes = await this.ch.query({
      query: `SELECT countIf(status = 'failed') AS failed, count() AS total
                FROM message_log
               WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
                 AND sent_at > now() - INTERVAL 1 HOUR`,
      query_params: { tid: req.member.tenantId, aid: appId },
      format: "JSONEachRow",
    });
    const stat = ((await statRes.json()) as Array<{ failed: string; total: string }>)[0];
    const total = Number(stat?.total ?? 0);
    const failed = Number(stat?.failed ?? 0);

    return {
      messages: rows,
      recent_hour: {
        total,
        failed,
        failure_rate: total > 0 ? failed / total : 0,
      },
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
