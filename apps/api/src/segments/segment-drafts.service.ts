import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, PreconditionFailedException } from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { z } from "zod";
import { compile, CompileError, toClickHouse, type SegmentDSL } from "@nudgeon/segment-dsl";
import { CLICKHOUSE, PG } from "../infra/infra.module";
import { assertDraftAccess, createDraftOnce, parseDraft, recordDraftAudit, type DraftActor } from "../drafts/draft-support";

const definition = z.object({ version: z.literal(1), operator: z.enum(["AND", "OR"]), groups: z.array(
  z.object({ operator: z.enum(["AND", "OR"]), conditions: z.array(z.record(z.unknown())).min(1).max(100) }),
).max(100) });
const input = z.object({ name: z.string().trim().min(1).max(200), definition });
const createInput = input.extend({ request_id: z.string().uuid().optional() }).strict();
const updateInput = input.extend({ expected_revision: z.number().int().positive() }).strict();
const promotionInput = z.object({ expected_revision: z.number().int().positive() }).strict();

export interface SegmentDraft {
  id: string; name: string; definition: SegmentDSL; revision: number;
  promoted_segment_id: string | null; promoted_at: Date | null; created_at: Date; updated_at: Date;
}

@Injectable()
export class SegmentDrafts {
  constructor(@Inject(PG) private readonly pg: Pool, @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient) {}

  async list(actor: DraftActor, appId: string) {
    await assertDraftAccess(this.pg, actor, appId, "segments:read");
    const result = await this.pg.query<SegmentDraft>(
      `SELECT id,name,definition,revision,promoted_segment_id,promoted_at,created_at,updated_at FROM segment_drafts
        WHERE tenant_id=$1 AND app_id=$2 ORDER BY updated_at DESC LIMIT 100`, [actor.tenantId, appId],
    );
    return { drafts: result.rows };
  }

  async get(actor: DraftActor, appId: string, id: string): Promise<SegmentDraft> {
    await assertDraftAccess(this.pg, actor, appId, "segments:read");
    const result = await this.pg.query<SegmentDraft>(
      `SELECT id,name,definition,revision,promoted_segment_id,promoted_at,created_at,updated_at FROM segment_drafts
        WHERE tenant_id=$1 AND app_id=$2 AND id=$3`, [actor.tenantId, appId, id],
    );
    if (!result.rows[0]) throw new NotFoundException("세그먼트 초안을 찾을 수 없습니다");
    return result.rows[0];
  }

  async create(actor: DraftActor, appId: string, body: unknown) {
    await assertDraftAccess(this.pg, actor, appId, "segments:write");
    const { request_id, ...data } = parseDraft(createInput, body);
    this.compile(data.definition, actor.tenantId, appId);
    return createDraftOnce(this.pg, actor, appId, "segment", data, request_id, async db => {
      const result = await db.query<SegmentDraft>(
        `INSERT INTO segment_drafts(tenant_id,app_id,name,definition,created_by) VALUES($1,$2,$3,$4,$5)
          RETURNING id,name,definition,revision,promoted_segment_id,promoted_at,created_at,updated_at`,
        [actor.tenantId, appId, data.name, data.definition, actor.memberId],
      );
      await recordDraftAudit(db, actor, appId, "segment_draft.create", result.rows[0]!.id);
      return result.rows[0]!;
    });
  }

  async update(actor: DraftActor, appId: string, id: string, body: unknown) {
    await assertDraftAccess(this.pg, actor, appId, "segments:write");
    const data = parseDraft(updateInput, body);
    this.compile(data.definition, actor.tenantId, appId);
    const db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      const found = await db.query(
        "SELECT revision,promoted_segment_id FROM segment_drafts WHERE tenant_id=$1 AND app_id=$2 AND id=$3 FOR UPDATE",
        [actor.tenantId, appId, id],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException();
      if (current.promoted_segment_id) throw new ConflictException("DRAFT_ALREADY_PROMOTED");
      if (current.revision !== data.expected_revision) throw new PreconditionFailedException("REVISION_CONFLICT");
      const result = await db.query<SegmentDraft>(
        `UPDATE segment_drafts SET name=$4,definition=$5,revision=revision+1,updated_at=now()
          WHERE tenant_id=$1 AND app_id=$2 AND id=$3
          RETURNING id,name,definition,revision,promoted_segment_id,promoted_at,created_at,updated_at`,
        [actor.tenantId, appId, id, data.name, data.definition],
      );
      await recordDraftAudit(db, actor, appId, "segment_draft.update", id);
      await db.query("COMMIT");
      return result.rows[0]!;
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  }

  async preview(actor: DraftActor, appId: string, id: string) {
    const draft = await this.get(actor, appId, id);
    const compiled = this.compile(draft.definition, actor.tenantId, appId);
    const query = toClickHouse({ sql: `SELECT uniqCombined(user_id) AS approx FROM (${compiled.sql})`, args: compiled.args });
    const result = await this.ch.query({ ...query, format: "JSONEachRow", clickhouse_settings: { max_execution_time: 10 } });
    const rows = await result.json<{ approx: string }>();
    return { approx_count: Number(rows[0]?.approx ?? 0), revision: draft.revision };
  }

  /** Console-only promotion. MCP deliberately has no tool that calls this method. */
  async promote(actor: DraftActor, appId: string, id: string, body: unknown) {
    await assertDraftAccess(this.pg, actor, appId, "segments:write");
    const data = parseDraft(promotionInput, body);
    const db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      const found = await db.query<SegmentDraft>(
        "SELECT * FROM segment_drafts WHERE tenant_id=$1 AND app_id=$2 AND id=$3 FOR UPDATE", [actor.tenantId, appId, id],
      );
      const draft = found.rows[0];
      if (!draft) throw new NotFoundException();
      if (draft.promoted_segment_id) {
        await db.query("COMMIT");
        return { draft_id: id, segment_id: draft.promoted_segment_id };
      }
      if (draft.revision !== data.expected_revision) throw new PreconditionFailedException("REVISION_CONFLICT");
      this.compile(draft.definition, actor.tenantId, appId);
      const result = await db.query<{ id: string }>(
        "INSERT INTO segments(tenant_id,app_id,name,definition,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [actor.tenantId, appId, draft.name, draft.definition, actor.memberId],
      );
      const segmentId = result.rows[0]!.id;
      await db.query(
        `UPDATE segment_drafts SET promoted_segment_id=$4,promoted_at=now(),updated_at=now()
          WHERE tenant_id=$1 AND app_id=$2 AND id=$3`, [actor.tenantId, appId, id, segmentId],
      );
      await recordDraftAudit(db, actor, appId, "segment_draft.promote", id);
      await db.query("COMMIT");
      return { draft_id: id, segment_id: segmentId };
    } catch (error) {
      await db.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw new ConflictException("NAME_ALREADY_EXISTS");
      throw error;
    } finally { db.release(); }
  }

  private compile(value: unknown, tenantId: string, appId: string) {
    try { return compile(value as SegmentDSL, tenantId, appId, "marketing"); }
    catch (error) { if (error instanceof CompileError) throw new BadRequestException(error.message); throw error; }
  }
}
