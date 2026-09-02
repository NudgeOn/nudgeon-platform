import {
  Controller,
  BadRequestException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import type { JourneyDefinition } from "@nudgeon/journey-model";
import { CLICKHOUSE, PG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";

/** 분석 리포팅 (PRD-07). 저니 리포트·대시보드·사용량. */
@Controller("v1/apps/:appId")
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermission("analytics:read") // 중앙 인가(R-07)
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
    @Query("version") requestedVersion?: string,
  ) {
    await this.assertApp(appId, req);
    const journey = await this.pg.query(
      `SELECT name, status, active_version FROM journeys WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
      [id, req.member.tenantId, appId],
    );
    if (!journey.rows[0]) throw new NotFoundException();
    if (requestedVersion !== undefined && !/^[1-9]\d*$/.test(requestedVersion)) throw new BadRequestException("올바른 저니 버전을 선택하세요");
    const versionRows = await this.pg.query(
      `SELECT v.version, v.created_at, v.definition FROM journey_versions v JOIN journeys j ON j.id = v.journey_id
        WHERE j.id = $1 AND j.tenant_id = $2 AND j.app_id = $3 ORDER BY v.version DESC`,
      [id, req.member.tenantId, appId],
    );
    const version = requestedVersion ? Number(requestedVersion) : journey.rows[0].active_version;
    const selected = versionRows.rows.find(row => row.version === version);
    if (requestedVersion && !selected) throw new NotFoundException("저니 버전을 찾을 수 없습니다");
    const definition: JourneyDefinition | null = selected?.definition ?? null;
    // Preserve legacy all-version totals only for callers omitting the version filter.
    const versionFilter = requestedVersion ? version : null;

    // 상태 분포 (PG journey_states)
    const states = await this.pg.query(
      `SELECT status, count(*) AS n FROM journey_states
        WHERE journey_id = $1 AND tenant_id = $2 AND app_id = $3
          AND ($4::int IS NULL OR journey_version = $4) GROUP BY status`,
      [id, req.member.tenantId, appId, versionFilter],
    );

    // 발송 결과 분류 (CH message_log)
    const sendRes = await this.ch.query({
      query: `SELECT status, node_index, count() AS n FROM message_log
               WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID} AND journey_id = {jid:UUID}
                 ${versionFilter ? "AND journey_version = {ver:UInt32}" : ""}
               GROUP BY status, node_index ORDER BY node_index`,
      query_params: { tid: req.member.tenantId, aid: appId, jid: id, ...(versionFilter ? { ver: versionFilter } : {}) },
      format: "JSONEachRow",
    });
    const sends = (await sendRes.json()) as Array<{
      status: string;
      node_index: number;
      n: string;
    }>;

    const stateDist: Record<string, number> = {};
    for (const r of states.rows) stateDist[r.status] = Number(r.n);

    const instrumentation = !definition ? "unpublished" : definition.schema_version === 2 ? "available" : "unsupported";
    const nodes = instrumentation === "available" && definition
      ? await this.nodeReport(req.member.tenantId, appId, id, version, definition) : [];

    return {
      name: journey.rows[0].name,
      status: journey.rows[0].status,
      state_distribution: stateDist,
      sends: sends.map((s) => ({ status: s.status, node_index: s.node_index, count: Number(s.n) })),
      version: version ?? null,
      versions: versionRows.rows.map(row => ({ version: row.version, created_at: row.created_at })),
      definition, instrumentation, nodes,
    };
  }

  /**
   * 도달·오픈 리포트 (R-15): message_id로 발송(message_log)과 SDK 이벤트($push_delivered/$push_opened)를 조인.
   * - sent = 공급자 접수 고유 message_id (실도달 아님, 분모)
   * - delivered/opened = SDK 이벤트를 message_id로 조인·중복 제거(uniqExact) — sent된 것만 집계
   */
  @Get("journeys/:id/delivery")
  async deliveryReport(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const p = { tid: req.member.tenantId, aid: appId, jid: id };

    const sentRes = await this.ch.query({
      query: `SELECT uniqExact(message_id) AS sent FROM message_log
               WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
                 AND journey_id = {jid:UUID} AND status = 'sent'`,
      query_params: p,
      format: "JSONEachRow",
    });
    const sent = Number(((await sentRes.json()) as Array<{ sent: string }>)[0]?.sent ?? 0);

    // 도달/오픈 = SDK 이벤트($push_delivered/$push_opened) ∪ message_lifecycle(공급자 콜백 — Resend 웹훅 등).
    // 두 소스를 (message_id, kind)로 UNION ALL한 뒤 uniqExactIf로 한 번에 중복 제거해야 정확한 합집합이 된다
    // (쿼리를 나누면 uniqExact를 병합할 수 없음). 모두 sent된 message_id로만 조인.
    const doRes = await this.ch.query({
      query: `SELECT
                uniqExactIf(mid, kind = 'delivered') AS delivered,
                uniqExactIf(mid, kind = 'opened') AS opened,
                uniqExactIf(mid, kind = 'clicked') AS clicked,
                uniqExactIf(mid, kind = 'bounced') AS bounced
              FROM (
                SELECT JSONExtractString(properties, 'message_id') AS mid,
                       if(event_name = '$push_delivered', 'delivered', 'opened') AS kind
                  FROM events
                 WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
                   AND event_name IN ('$push_delivered', '$push_opened')
                   AND JSONExtractString(properties, 'message_id') IN (
                     SELECT toString(message_id) FROM message_log
                      WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
                        AND journey_id = {jid:UUID} AND status = 'sent')
                UNION ALL
                SELECT toString(message_id) AS mid, status AS kind
                  FROM message_lifecycle
                 WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
                   AND status IN ('delivered', 'opened', 'clicked', 'bounced')
                   AND message_id IN (
                     SELECT message_id FROM message_log
                      WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
                        AND journey_id = {jid:UUID} AND status = 'sent')
              )`,
      query_params: p,
      format: "JSONEachRow",
    });
    const row = ((await doRes.json()) as Array<{ delivered: string; opened: string; clicked: string; bounced: string }>)[0];
    const delivered = Number(row?.delivered ?? 0);
    const opened = Number(row?.opened ?? 0);
    const clicked = Number(row?.clicked ?? 0);
    const bounced = Number(row?.bounced ?? 0);
    const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0);

    return {
      sent, // 공급자 접수(실도달 아님) — 분모
      delivered, // SDK $push_delivered ∪ lifecycle delivered (실도달), message_id 중복 제거
      opened, // SDK $push_opened ∪ lifecycle opened, 중복 제거
      clicked, // lifecycle clicked (이메일 링크 클릭 등), 중복 제거
      bounced, // lifecycle bounced (반송), 중복 제거
      delivery_rate: rate(delivered, sent), // 도달/발송
      open_rate: rate(opened, delivered), // 오픈/도달 (분모=도달)
    };
  }

  private async nodeReport(tenantId: string, appId: string, journeyId: string, version: number, definition: JourneyDefinition) {
    const scope = [tenantId, appId, journeyId, version];
    const [visits, choices] = await Promise.all([
      this.pg.query(
        `SELECT node_id, status, count(*) AS n FROM journey_node_executions
          WHERE tenant_id = $1 AND app_id = $2 AND journey_id = $3 AND journey_version = $4
          GROUP BY node_id, status`, scope,
      ),
      this.pg.query(
        `SELECT node_id, output_port, count(*) AS n, count(DISTINCT user_id) AS users
          FROM journey_node_executions
          WHERE tenant_id = $1 AND app_id = $2 AND journey_id = $3 AND journey_version = $4
            AND output_port IS NOT NULL AND status = 'resolved' GROUP BY node_id, output_port`, scope,
      ),
    ]);
    const countsByNode = new Map<string, Map<string, number>>();
    for (const row of visits.rows) {
      const counts = countsByNode.get(row.node_id) ?? new Map<string, number>();
      counts.set(row.status, Number(row.n)); countsByNode.set(row.node_id, counts);
    }
    const pathsByNode = new Map<string, Array<{ output_port: string; executions: number; unique_users: number }>>();
    for (const row of choices.rows) {
      const paths = pathsByNode.get(row.node_id) ?? [];
      paths.push({ output_port: row.output_port, executions: Number(row.n), unique_users: Number(row.users) });
      pathsByNode.set(row.node_id, paths);
    }
    return definition.nodes.map((node, index) => {
      const counts = countsByNode.get(node.id!);
      const count = (status: string) => counts?.get(status) ?? 0;
      return {
        node_id: node.id!, node_index: index, type: node.type,
        arrived: [...(counts?.values() ?? [])].reduce((total, value) => total + value, 0),
        waiting: count("waiting"), completed: count("resolved"), failed: count("failed"),
        paths: pathsByNode.get(node.id!) ?? [],
      };
    });
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

    // DAU — 오늘 일간 고유 활성 유저(클라이언트 SDK 이벤트 기반, session_start 등)
    const dauRes = await this.ch.query({
      query: `SELECT uniqCombinedMerge(users) AS dau FROM usage_active_users_daily
               WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID} AND day = today()`,
      query_params: params,
      format: "JSONEachRow",
    });
    const dau = Number(((await dauRes.json()) as Array<{ dau: string }>)[0]?.dau ?? 0);

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
      dau_today: dau,
      sends_30d: sends.map((s) => ({ channel: s.channel, sent: Number(s.total) })),
    };
  }

  /** 앱 삭제율 (최근 N일): silent/일반 푸시의 UNREGISTERED/410 기반 삭제 감지 (기본 30일) */
  @Get("uninstalls")
  async uninstalls(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Req() req: SessionRequest,
    @Query("days") days?: string,
  ) {
    await this.assertApp(appId, req);
    const n = Math.min(Math.max(Number(days) || 30, 1), 365);
    const res = await this.ch.query({
      query: `SELECT count() AS uninstalls FROM app_uninstalls
               WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
                 AND detected_at > now() - INTERVAL {n:UInt16} DAY`,
      query_params: { tid: req.member.tenantId, aid: appId, n },
      format: "JSONEachRow",
    });
    const uninstalls = Number(((await res.json()) as Array<{ uninstalls: string }>)[0]?.uninstalls ?? 0);
    // 현재 활성 디바이스(분모) — 삭제 감지 시점엔 이미 invalid이므로 분모에 삭제 수를 더해 근사한다.
    const active = await this.pg.query(
      `SELECT count(*)::int AS n FROM devices d JOIN users u ON u.id = d.user_id
        WHERE u.app_id = $1 AND d.push_token IS NOT NULL AND d.token_status = 'active'`,
      [appId],
    );
    const activeCount = active.rows[0]?.n ?? 0;
    const denom = activeCount + uninstalls;
    return {
      days: n,
      uninstalls,
      active_devices: activeCount,
      uninstall_rate: denom > 0 ? Math.round((uninstalls / denom) * 10000) / 10000 : 0,
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
