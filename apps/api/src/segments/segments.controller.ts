import {
  BadRequestException,
  Body,
  Controller,
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
import { createHash } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type Redis from "ioredis";
import type { Pool } from "pg";
import { z } from "zod";
import {
  compile,
  CompileError,
  toClickHouse,
  type Category,
  type Compiled,
  type SegmentDSL,
} from "@onda/segment-dsl";
import { CLICKHOUSE, PG, REDIS } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";

const conditionSchema = z.record(z.unknown()); // 상세 구조는 컴파일러가 검증
const dslSchema = z.object({
  version: z.literal(1),
  operator: z.enum(["AND", "OR"]),
  groups: z.array(
    z.object({
      operator: z.enum(["AND", "OR"]),
      conditions: z.array(conditionSchema).min(1),
    }),
  ),
});

const upsertSchema = z.object({
  name: z.string().min(1).max(200),
  definition: dslSchema,
});

const previewSchema = z.object({
  definition: dslSchema,
  category: z.enum(["marketing", "transactional"]).default("marketing"),
});

const PREVIEW_CACHE_TTL = 60; // 조건 해시 60s 캐시 (PRD-02 4.3)
const EDITOR_ROLES = ["owner", "admin", "editor"];

/** 세그먼트 관리 (세션 인증) — 콘솔 세그먼트 빌더의 백엔드 */
@Controller("v1/apps/:appId/segments")
@UseGuards(SessionGuard)
export class SegmentsController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  async list(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    await this.assertApp(appId, req);
    const { rows } = await this.pg.query(
      `SELECT id, name, status, status_detail, last_count, last_evaluated_at, updated_at
         FROM segments WHERE tenant_id = $1 AND app_id = $2 ORDER BY updated_at DESC`,
      [req.member.tenantId, appId],
    );
    return { segments: rows };
  }

  @Get(":id")
  async get(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const { rows } = await this.pg.query(
      `SELECT id, name, definition, status, status_detail, last_count, updated_at
         FROM segments WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
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
    const data = this.parse(upsertSchema, body);
    this.assertCompiles(data.definition, req.member.tenantId, appId);
    const { rows } = await this.pg.query(
      `INSERT INTO segments (tenant_id, app_id, name, definition, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.member.tenantId, appId, data.name, data.definition, req.member.memberId],
    ).catch(this.mapUniqueViolation);
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
    const data = this.parse(upsertSchema, body);
    this.assertCompiles(data.definition, req.member.tenantId, appId);
    const { rowCount } = await this.pg.query(
      `UPDATE segments SET name = $4, definition = $5, status = 'active', status_detail = NULL,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
      [id, req.member.tenantId, appId, data.name, data.definition],
    ).catch(this.mapUniqueViolation);
    if (!rowCount) throw new NotFoundException();
    return { ok: true };
  }

  @Delete(":id")
  async remove(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    this.assertEditor(req);
    const { rowCount } = await this.pg.query(
      `DELETE FROM segments WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
      [id, req.member.tenantId, appId],
    );
    if (!rowCount) throw new NotFoundException();
    return { ok: true };
  }

  /**
   * 미리보기 (PRD-02 4.3): uniqCombined 근사 카운트 + 샘플 10명 + 플랫폼 분포.
   * 조건 해시 기준 60s Redis 캐시.
   */
  @Post("preview")
  async preview(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const data = this.parse(previewSchema, body);

    let compiled;
    try {
      compiled = compile(
        data.definition as unknown as SegmentDSL,
        req.member.tenantId,
        appId,
        data.category as Category,
      );
    } catch (e) {
      if (e instanceof CompileError) throw new BadRequestException(e.message);
      throw e;
    }

    const cacheKey = `seg:preview:${req.member.tenantId}:${createHash("sha256")
      .update(compiled.sql + JSON.stringify(compiled.args))
      .digest("hex")}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // 근사 카운트 — uniqCombined (±2% 허용, PRD-02 7장). 컴파일된 SQL을 서브쿼리로 감싼다.
    const countQuery = toClickHouse({
      sql: `SELECT uniqCombined(user_id) AS approx FROM (${compiled.sql})`,
      args: compiled.args,
    } satisfies Compiled);
    const countRes = await this.ch.query({ ...countQuery, format: "JSONEachRow" });
    const countRows = (await countRes.json()) as Array<{ approx: string }>;
    const count = Number(countRows[0]?.approx ?? 0);

    // 샘플 10명 + 플랫폼 분포 (mirror 조인)
    const sampleQuery = toClickHouse({
      sql: `SELECT user_id, external_id, platforms
              FROM profiles_mirror FINAL
             WHERE user_id IN (${compiled.sql})
             LIMIT 10`,
      args: compiled.args,
    } satisfies Compiled);
    const sampleRes = await this.ch.query({ ...sampleQuery, format: "JSONEachRow" });
    const sample = (await sampleRes.json()) as Array<{
      user_id: string;
      external_id: string;
      platforms: string[];
    }>;

    const result = {
      approx_count: count,
      sample: sample.map((s) => ({
        user_id: s.user_id,
        external_id: s.external_id || null,
        platforms: s.platforms,
      })),
    };
    await this.redis.set(cacheKey, JSON.stringify(result), "EX", PREVIEW_CACHE_TTL);
    return result;
  }

  private assertCompiles(definition: unknown, tenantId: string, appId: string) {
    try {
      compile(definition as unknown as SegmentDSL, tenantId, appId, "marketing");
    } catch (e) {
      if (e instanceof CompileError) {
        throw new BadRequestException(`DSL 컴파일 실패: ${e.message}`);
      }
      throw e;
    }
  }

  private parse<T>(schema: z.ZodSchema<T>, body: unknown): T {
    const r = schema.safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.flatten());
    return r.data;
  }

  private mapUniqueViolation = (e: unknown): never => {
    if ((e as { code?: string }).code === "23505") {
      throw new BadRequestException("같은 이름의 세그먼트가 이미 있습니다");
    }
    throw e;
  };

  private async assertApp(appId: string, req: SessionRequest) {
    const { rowCount } = await this.pg.query(
      `SELECT 1 FROM apps WHERE id = $1 AND tenant_id = $2`,
      [appId, req.member.tenantId],
    );
    if (!rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");
  }

  private assertEditor(req: SessionRequest) {
    if (!EDITOR_ROLES.includes(req.member.role)) {
      throw new ForbiddenException("세그먼트 편집은 Editor 이상만 가능합니다");
    }
  }
}
