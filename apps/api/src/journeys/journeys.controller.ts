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
  type JourneyDefinition,
} from "@onda/journey-model";
import { CLICKHOUSE, PG, QUEUE } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";

const pushSchema = z.object({
  title: z.string().max(256),
  body: z.string().max(2048),
  image_url: z.string().optional(),
  deep_link: z.string().optional(),
});
const nodeSchema = z.union([
  z.object({ type: z.literal("message"), push: pushSchema }),
  z.object({ type: z.literal("delay"), duration_seconds: z.number().int().positive() }),
]);
const definitionSchema = z.object({
  entry: z.object({
    type: z.enum(["blast", "trigger"]),
    segment_id: z.string().uuid().optional(),
    trigger_event: z.string().optional(),
  }),
  nodes: z.array(nodeSchema),
  exit: z.object({ conversion_event: z.string().optional() }).default({}),
  settings: z.object({
    category: z.enum(["marketing", "transactional"]),
    reentry: z.any().default("never"),
  }),
});
const upsertSchema = z.object({
  name: z.string().min(1).max(200),
  definition: definitionSchema,
});

const EDITOR_ROLES = ["owner", "admin", "editor"];

/** 저니·캠페인 관리 (세션 인증). 단발 캠페인 = 1노드 blast 저니. */
@Controller("v1/apps/:appId/journeys")
@UseGuards(SessionGuard)
export class JourneysController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
    @Inject(QUEUE) private readonly queue: QueueProducer,
  ) {}

  @Get()
  async list(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    await this.assertApp(appId, req);
    const { rows } = await this.pg.query(
      `SELECT id, name, status, category, active_version, updated_at
         FROM journeys WHERE tenant_id = $1 AND app_id = $2 ORDER BY updated_at DESC`,
      [req.member.tenantId, appId],
    );
    return { journeys: rows };
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
    return rows[0];
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
    return { id: rows[0].id };
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
    return { ok: true };
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
    const issues = validateJourney(def);
    let estimatedCount: number | null = null;
    if (def.entry.type === "blast" && def.entry.segment_id) {
      estimatedCount = await this.audienceCount(req.member.tenantId, appId, def.entry.segment_id, def.settings.category);
    }
    return { issues, estimated_count: estimatedCount };
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
  ) {
    this.assertEditor(req);
    const journey = await this.load(appId, id, req);
    const def = journey.draft_definition as JourneyDefinition;
    const issues = validateJourney(def);
    if (hasErrors(issues)) {
      throw new BadRequestException({ message: "검증 실패로 활성화할 수 없습니다", issues });
    }

    // 새 버전 번호
    const verRes = await this.pg.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM journey_versions WHERE journey_id = $1`,
      [id],
    );
    const version: number = verRes.rows[0].next;

    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO journey_versions (journey_id, version, definition) VALUES ($1, $2, $3)`,
        [id, version, def],
      );
      await client.query(
        `UPDATE journeys SET status = 'active', active_version = $2, updated_at = now() WHERE id = $1`,
        [id, version],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // blast 진입: 세그먼트 스냅샷 → campaign_audiences → journey.entry
    if (def.entry.type === "blast" && def.entry.segment_id) {
      const audienceRef = await this.snapshotAudience(
        req.member.tenantId,
        appId,
        def.entry.segment_id,
        def.settings.category,
      );
      const payload: JourneyEntryPayload = {
        journey_id: id,
        version,
        source: "blast",
        audience_ref: audienceRef,
      };
      await this.queue.publish(STREAMS.journeyEntry, {
        type: "journey.enter",
        tenantId: req.member.tenantId,
        appId,
        payload: payload as unknown as Record<string, unknown>,
      });
      return { version, entry: "blast", audience_ref: audienceRef };
    }
    // trigger 진입은 S5 (trigger-matcher)
    return { version, entry: def.entry.type };
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
    const journey = await this.load(appId, id, req);
    await this.pg.query(
      `UPDATE journey_states SET status = 'exited', updated_at = now()
        WHERE journey_id = $1 AND status IN ('active', 'waiting', 'claimed')`,
      [journey.id],
    );
    await this.pg.query(`UPDATE journeys SET status = 'archived', updated_at = now() WHERE id = $1`, [
      journey.id,
    ]);
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
