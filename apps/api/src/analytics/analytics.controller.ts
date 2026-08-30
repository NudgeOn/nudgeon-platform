import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { CLICKHOUSE, PG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";

/** 분석 리포팅 (PRD-07). 저니 리포트·대시보드·사용량. */
@Controller("v1/apps/:appId")
@UseGuards(SessionGuard)
export class AnalyticsController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
  ) {}

  /** 대시보드: 오늘 발송/실패, 활성 저니 수, 최근 사용량 */
  @Get("dashboard")
  async dashboard(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    await this.assertApp(appId, req);
    const params = { tid: req.member.tenantId, aid: appId };

    const todayRes = await this.ch.query({
      query: `SELECT status, count() AS n FROM message_log
               WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
                 AND toDate(sent_at) = today()
               GROUP BY status`,
      query_params: params,
      format: "JSONEachRow",
    });
    const today = (await todayRes.json()) as Array<{ status: string; n: string }>;

    const activeJourneys = await this.pg.query(
      `SELECT count(*) AS n FROM journeys WHERE tenant_id = $1 AND app_id = $2 AND status = 'active'`,
      [req.member.tenantId, appId],
    );

    const byStatus: Record<string, number> = {};
    for (const r of today) byStatus[r.status] = Number(r.n);

    return {
      today: {
        sent: byStatus.sent ?? 0,
        failed: byStatus.failed ?? 0,
        skipped:
          (byStatus.skipped_quiet_hours ?? 0) +
          (byStatus.skipped_cap ?? 0) +
          (byStatus.skipped_unreachable ?? 0),
        by_status: byStatus,
      },
      active_journeys: Number(activeJourneys.rows[0]?.n ?? 0),
    };
  }

  /** 저니 리포트: 상태 분포 + 노드 퍼널 + 발송 결과 분류 */
  @Get("journeys/:id/report")
  async journeyReport(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const journey = await this.pg.query(
      `SELECT name, status FROM journeys WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
      [id, req.member.tenantId, appId],
    );
    if (!journey.rows[0]) throw new NotFoundException();

    // 상태 분포 (PG journey_states)
    const states = await this.pg.query(
      `SELECT status, count(*) AS n FROM journey_states WHERE journey_id = $1 GROUP BY status`,
      [id],
    );

    // 발송 결과 분류 (CH message_log)
    const sendRes = await this.ch.query({
      query: `SELECT status, node_index, count() AS n FROM message_log
               WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID} AND journey_id = {jid:UUID}
               GROUP BY status, node_index ORDER BY node_index`,
      query_params: { tid: req.member.tenantId, aid: appId, jid: id },
      format: "JSONEachRow",
    });
    const sends = (await sendRes.json()) as Array<{
      status: string;
      node_index: number;
      n: string;
    }>;

    const stateDist: Record<string, number> = {};
    for (const r of states.rows) stateDist[r.status] = Number(r.n);

    return {
      name: journey.rows[0].name,
      status: journey.rows[0].status,
      state_distribution: stateDist,
      sends: sends.map((s) => ({ status: s.status, node_index: s.node_index, count: Number(s.n) })),
    };
  }

  /** 사용량 (T-7 계측): MAU 근사 + 채널별 발송량 (최근 30일) */
  @Get("usage")
  async usage(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    await this.assertApp(appId, req);
    const params = { tid: req.member.tenantId, aid: appId };

    const mauRes = await this.ch.query({
      query: `SELECT uniqCombinedMerge(users) AS mau FROM usage_active_users_daily
               WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
                 AND day > today() - 30`,
      query_params: params,
      format: "JSONEachRow",
    });
    const mau = Number(((await mauRes.json()) as Array<{ mau: string }>)[0]?.mau ?? 0);

    const sendsRes = await this.ch.query({
      query: `SELECT channel, sum(sends) AS total FROM usage_sends_daily
               WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
                 AND day > today() - 30 AND status = 'sent'
               GROUP BY channel`,
      query_params: params,
      format: "JSONEachRow",
    });
    const sends = (await sendsRes.json()) as Array<{ channel: string; total: string }>;

    return {
      mau_30d: mau,
      sends_30d: sends.map((s) => ({ channel: s.channel, sent: Number(s.total) })),
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
