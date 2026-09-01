import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { z } from "zod";
import { QueueProducer } from "@onda/libqueue";
import { STREAMS, type JourneyEntryPayload } from "@onda/queue-schemas";
import {
  compile,
  toClickHouse,
  type Category,
  type Compiled,
  type SegmentDSL,
} from "@onda/segment-dsl";
import {
  hasErrors,
  validateJourney,
  collectPublishedABNodes,
  validatePublishedABNodes,
  type PublishedABNodes,
  type JourneyDefinition,
} from "@onda/journey-model";
import { CLICKHOUSE, PG, QUEUE, CONFIG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import type { AppConfig } from "../config";
import { activationSchema, draftRevision, journeyCapabilities, upsertSchema } from "./journey-contract";

const EDITOR_ROLES = ["owner", "admin", "editor"];

/** 저니·캠페인 관리 (세션 인증). 단발 캠페인 = 1노드 blast 저니. */
@Controller("v1/apps/:appId/journeys")
@UseGuards(SessionGuard)
export class JourneysController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
    @Inject(QUEUE) private readonly queue: QueueProducer,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async list(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    await this.assertApp(appId, req);
    const { rows } = await this.pg.query(
      `SELECT id, name, status, category, active_version, updated_at
         FROM journeys WHERE tenant_id = $1 AND app_id = $2 ORDER BY updated_at DESC`,
      [req.member.tenantId, appId],
    );
    return { journeys: rows, capabilities: journeyCapabilities(this.config.journeyGraphV2Enabled) };
  }

  @Get(":id")
  async get(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const { rows } = await this.pg.query(
      `SELECT id, name, status, category, draft_definition, active_version, updated_at
         FROM journeys WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
      [id, req.member.tenantId, appId],
    );
    if (!rows[0]) throw new NotFoundException();
    const journey = rows[0];
    return { ...journey,
      revision: draftRevision(journey.name, journey.draft_definition),
      published_ab_nodes: await this.publishedABNodes(this.pg, req.member.tenantId, appId, id),
      capabilities: journeyCapabilities(this.config.journeyGraphV2Enabled),
    };
  }

  @Post()
  async create(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    this.assertEditor(req);
    const data = this.parse(body);
    const { rows } = await this.pg
      .query(
        `INSERT INTO journeys (tenant_id, app_id, name, category, draft_definition, status, created_by)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6) RETURNING id`,
        [
          req.member.tenantId,
          appId,
          data.name,
          data.definition.settings.category,
          data.definition,
          req.member.memberId,
        ],
      )
      .catch(this.mapUnique);
    return { id: rows[0].id, revision: draftRevision(data.name, data.definition) };
  }

  @Patch(":id")
  async update(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    this.assertEditor(req);
    const data = this.parse(body);
    const { rowCount } = await this.pg
      .query(
        `UPDATE journeys SET name = $4, category = $5, draft_definition = $6, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND app_id = $3 AND status IN ('draft', 'paused')`,
        [id, req.member.tenantId, appId, data.name, data.definition.settings.category, data.definition],
      )
      .catch(this.mapUnique);
    if (!rowCount) throw new NotFoundException("수정 가능한 저니를 찾을 수 없습니다 (활성 저니는 새 버전으로만 변경)");
    return { ok: true, revision: draftRevision(data.name, data.definition) };
  }

  /** 검증만 수행 (활성화 전 경고·예상 카운트 모달용) */
  @Post(":id/validate")
  async validate(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    const journey = await this.load(appId, id, req);
    const def = journey.draft_definition as JourneyDefinition;
    const issues = await this.definitionIssues(this.pg, req.member.tenantId, appId, id, def);
    let estimatedCount: number | null = null;
    if (!hasErrors(issues) && def.entry.type === "blast" && def.entry.segment_id) {
      estimatedCount = await this.audienceCount(req.member.tenantId, appId, def.entry.segment_id, def.settings.category);
    }
    return { issues, estimated_count: estimatedCount, revision: draftRevision(journey.name, def) };
  }

  /**
   * 활성화 (PRD-03): 검증 → 새 버전 스냅샷 → (blast면) 세그먼트 스냅샷 생성 →
   * journey.entry(blast) 발행. 진행 중 유저는 구버전으로 완주(버전 불변).
   */
  @Post(":id/activate")
  async activate(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
    @Body() body: unknown = {},
  ) {
    this.assertEditor(req);
    await this.assertApp(appId, req);
    const parsed = activationSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const tenantId = req.member.tenantId;
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT id, name, status, draft_definition FROM journeys
          WHERE id = $1 AND tenant_id = $2 AND app_id = $3 FOR UPDATE`,
        [id, tenantId, appId],
      );
      const journey = result.rows[0];
      if (!journey) throw new NotFoundException("저니를 찾을 수 없습니다");
      if (!["draft", "paused"].includes(journey.status)) throw new ConflictException("초안 또는 일시정지 상태에서만 활성화할 수 있습니다");
      const def = journey.draft_definition as JourneyDefinition;
      const revision = draftRevision(journey.name, def);
      if ((def.schema_version === 2 && !parsed.data.revision) ||
          (parsed.data.revision && parsed.data.revision !== revision)) {
        throw new ConflictException("검증 이후 초안이 변경되었습니다. 다시 검증해 주세요");
      }
      const issues = await this.definitionIssues(client, tenantId, appId, id, def);
      if (hasErrors(issues)) throw new BadRequestException({ message: "검증 실패로 활성화할 수 없습니다", issues });
      const verRes = await client.query(
        `SELECT COALESCE(MAX(v.version), 0) + 1 AS next FROM journey_versions v
          JOIN journeys j ON j.id = v.journey_id
          WHERE j.id = $1 AND j.tenant_id = $2 AND j.app_id = $3`,
        [id, tenantId, appId],
      );
      const version: number = verRes.rows[0].next;
      // Complete the audience snapshot before committing its durable entry job.
      const audienceRef = def.entry.type === "blast" && def.entry.segment_id
        ? await this.snapshotAudience(tenantId, appId, def.entry.segment_id, def.settings.category)
        : undefined;
      await client.query(
        `INSERT INTO journey_versions (journey_id, version, definition) VALUES ($1, $2, $3)`,
        [id, version, def],
      );
      await client.query(
        `UPDATE journeys SET status = 'active', active_version = $4, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
        [id, tenantId, appId, version],
      );
      if (audienceRef) {
        const payload: JourneyEntryPayload = { journey_id: id, version, source: "blast", audience_ref: audienceRef };
        await client.query(
          `INSERT INTO journey_outbox (tenant_id, app_id, stream, idempotency_key, payload)
            VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [tenantId, appId, STREAMS.journeyEntry, `v2:entry:${id}:${version}`, payload],
        );
      }
      await client.query("COMMIT");
      return { version, entry: def.entry.type, ...(audienceRef ? { audience_ref: audienceRef } : {}) };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

  }

  @Post(":id/pause")
  async pause(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    this.assertEditor(req);
    await this.setStatus(appId, id, req, "paused", ["active"]);
    return { ok: true };
  }

  @Delete(":id")
  async archive(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    this.assertEditor(req);
    // archived: 진행 중 유저 전원 강제 이탈 (PRD-03 2.2)
    await this.assertApp(appId, req);
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const scope = [id, req.member.tenantId, appId];
      const journey = await client.query(
        `SELECT id FROM journeys WHERE id = $1 AND tenant_id = $2 AND app_id = $3 FOR UPDATE`, scope,
      );
      if (!journey.rowCount) throw new NotFoundException("저니를 찾을 수 없습니다");
      await client.query(
        `UPDATE journeys SET status = 'archived', updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND app_id = $3`, scope,
      );
      await client.query(
        `UPDATE journey_states SET status = 'exited', claim_token = NULL, claimed_by = NULL,
          claimed_at = NULL, next_wake_at = NULL, updated_at = now()
          WHERE journey_id = $1 AND tenant_id = $2 AND app_id = $3 AND status IN ('active','waiting','claimed')`, scope,
      );
      await client.query(
        `UPDATE journey_node_executions SET status = 'exited', resolved_at = now(), updated_at = now()
          WHERE journey_id = $1 AND tenant_id = $2 AND app_id = $3 AND status IN ('arrived','waiting','retrying')`, scope,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally { client.release(); }
    return { ok: true };
  }

  // --- 세그먼트 스냅샷 ---

  private async snapshotAudience(
    tenantId: string,
    appId: string,
    segmentId: string,
    category: string,
  ): Promise<string> {
    const compiled = await this.compileSegment(tenantId, appId, segmentId, category);
    const audienceRef = randomUUID();
    // INSERT SELECT: 스냅샷 = 세그먼트 조건 user_id 집합 (push_reachable 미적용 — PRD-02 4.2 v0.2)
    const insert = toClickHouse({
      sql: `INSERT INTO campaign_audiences (audience_ref, tenant_id, app_id, user_id, created_at)
              SELECT {aref:UUID}, {tid:UUID}, {aid:UUID}, user_id, now64(3)
                FROM (${compiled.sql})`,
      args: compiled.args,
    } satisfies Compiled);
    await this.ch.command({
      query: insert.query,
      clickhouse_settings: { wait_for_async_insert: 1 },
      query_params: {
        ...insert.query_params,
        aref: audienceRef,
        tid: tenantId,
        aid: appId,
      },
    });
    return audienceRef;
  }

  private async audienceCount(
    tenantId: string,
    appId: string,
    segmentId: string,
    category: string,
  ): Promise<number> {
    const compiled = await this.compileSegment(tenantId, appId, segmentId, category);
    const q = toClickHouse({
      sql: `SELECT uniqCombined(user_id) AS c FROM (${compiled.sql})`,
      args: compiled.args,
    } satisfies Compiled);
    const res = await this.ch.query({ ...q, format: "JSONEachRow" });
    const rows = (await res.json()) as Array<{ c: string }>;
    return Number(rows[0]?.c ?? 0);
  }

  private async compileSegment(
    tenantId: string,
    appId: string,
    segmentId: string,
    category: string,
  ): Promise<Compiled> {
    const { rows } = await this.pg.query(
      `SELECT definition, status FROM segments WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
      [segmentId, tenantId, appId],
    );
    if (!rows[0]) throw new BadRequestException("세그먼트를 찾을 수 없습니다");
    if (rows[0].status === "broken") throw new BadRequestException("broken 세그먼트로는 활성화할 수 없습니다");
    return compile(
      rows[0].definition as unknown as SegmentDSL,
      tenantId,
      appId,
      category as Category,
    );
  }

  // --- 공통 ---

  private async publishedABNodes(db: Pick<Pool, "query">, tenantId: string, appId: string, id: string): Promise<PublishedABNodes> {
    const { rows } = await db.query(
      `SELECT v.definition FROM journey_versions v JOIN journeys j ON j.id = v.journey_id
        WHERE j.id = $1 AND j.tenant_id = $2 AND j.app_id = $3 ORDER BY v.version`,
      [id, tenantId, appId],
    );
    return collectPublishedABNodes(rows.map(row => row.definition as JourneyDefinition));
  }

  private async definitionIssues(db: Pick<Pool, "query">, tenantId: string, appId: string, id: string, def: JourneyDefinition) {
    const issues = validateJourney(def);
    if (def.schema_version === 2 && !this.config.journeyGraphV2Enabled) {
      issues.push({ level: "error", field: "schema_version", message: "모든 워커를 업데이트한 뒤 JOURNEY_GRAPH_V2_ENABLED=true로 활성화하세요" });
    }
    issues.push(...validatePublishedABNodes(def, await this.publishedABNodes(db, tenantId, appId, id)));
    return issues;
  }

  private async load(appId: string, id: string, req: SessionRequest) {
    const { rows } = await this.pg.query(
      `SELECT id, name, status, category, draft_definition FROM journeys
        WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
      [id, req.member.tenantId, appId],
    );
    if (!rows[0]) throw new NotFoundException("저니를 찾을 수 없습니다");
    return rows[0];
  }

  private async setStatus(
    appId: string,
    id: string,
    req: SessionRequest,
    status: string,
    from: string[],
  ) {
    await this.assertApp(appId, req);
    const { rowCount } = await this.pg.query(
      `UPDATE journeys SET status = $4, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND app_id = $3 AND status = ANY($5)`,
      [id, req.member.tenantId, appId, status, from],
    );
    if (!rowCount) throw new ConflictException(`현재 상태에서 ${status}로 전환할 수 없습니다`);
  }

  private parse(body: unknown): z.infer<typeof upsertSchema> {
    const r = upsertSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.flatten());
    return r.data;
  }

  private mapUnique = (e: unknown): never => {
    if ((e as { code?: string }).code === "23505") {
      throw new BadRequestException("같은 이름의 저니가 이미 있습니다");
    }
    throw e;
  };

  private async assertApp(appId: string, req: SessionRequest) {
    const { rowCount } = await this.pg.query(`SELECT 1 FROM apps WHERE id = $1 AND tenant_id = $2`, [
      appId,
      req.member.tenantId,
    ]);
    if (!rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");
  }

  private assertEditor(req: SessionRequest) {
    if (!EDITOR_ROLES.includes(req.member.role)) {
      throw new ForbiddenException("저니 편집·활성화는 Editor 이상만 가능합니다");
    }
  }
}
