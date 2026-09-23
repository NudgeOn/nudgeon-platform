import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, PreconditionFailedException } from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { compile, toClickHouse, type Category, type SegmentDSL } from "@nudgeon/segment-dsl";
import { collectPublishedABNodes, hasErrors, validateJourney, validatePublishedABNodes, type JourneyDefinition, type PublishedABNodes } from "@nudgeon/journey-model";
import { CLICKHOUSE, CONFIG, PG } from "../infra/infra.module";
import type { AppConfig } from "../config";
import { assertDraftAccess, createDraftOnce, parseDraft, recordDraftAudit, type DraftActor, type DraftDatabase } from "../drafts/draft-support";
import { draftRevision, journeyCapabilities, upsertSchema } from "./journey-contract";

export interface JourneyDraftUpdateOptions { expectedRevision?: string; draftOnly?: boolean }

/** Strong single revision tags only; legacy REST callers may omit If-Match. */
export function parseJourneyIfMatch(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const parsed = /^(?:"([a-f0-9]{64})"|([a-f0-9]{64}))$/.exec(header.trim());
  if (!parsed) throw new BadRequestException("If-Match must contain one draft revision");
  return parsed[1] ?? parsed[2];
}

@Injectable()
export class JourneyDrafts {
  constructor(@Inject(PG) private readonly pg: Pool, @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
    @Inject(CONFIG) private readonly config: AppConfig) {}

  async list(actor: DraftActor, appId: string) {
    await assertDraftAccess(this.pg, actor, appId, "journeys:read");
    const { rows } = await this.pg.query(
      `SELECT id,name,status,category,active_version,updated_at FROM journeys
        WHERE tenant_id=$1 AND app_id=$2 ORDER BY updated_at DESC`, [actor.tenantId, appId]);
    return { journeys: rows, capabilities: journeyCapabilities(this.config.journeyGraphV2Enabled) };
  }

  async get(actor: DraftActor, appId: string, id: string) {
    await assertDraftAccess(this.pg, actor, appId, "journeys:read");
    const { rows } = await this.pg.query(
      `SELECT id,name,status,category,draft_definition,active_version,updated_at FROM journeys
        WHERE tenant_id=$1 AND app_id=$2 AND id=$3`, [actor.tenantId, appId, id]);
    const journey = rows[0];
    if (!journey) throw new NotFoundException("저니를 찾을 수 없습니다");
    return { ...journey, revision: draftRevision(journey.name, journey.draft_definition),
      published_ab_nodes: await this.publishedABNodes(this.pg, actor.tenantId, appId, id),
      capabilities: journeyCapabilities(this.config.journeyGraphV2Enabled) };
  }

  async create(actor: DraftActor, appId: string, body: unknown, options: { requestId?: string } = {}) {
    await assertDraftAccess(this.pg, actor, appId, "journeys:write");
    const data = parseDraft(upsertSchema, body);
    try {
      return await createDraftOnce(this.pg, actor, appId, "journey", data, options.requestId, async db => {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO journeys(tenant_id,app_id,name,category,draft_definition,status,created_by)
            VALUES($1,$2,$3,$4,$5,'draft',$6) RETURNING id`,
          [actor.tenantId, appId, data.name, data.definition.settings.category, data.definition, actor.memberId]);
        const id = rows[0]!.id;
        await recordDraftAudit(db, actor, appId, "journey_draft.create", id);
        return { id, revision: draftRevision(data.name, data.definition) };
      });
    } catch (error) {
      if (error instanceof ConflictException && error.message === "NAME_ALREADY_EXISTS") throw new BadRequestException("같은 이름의 저니가 이미 있습니다");
      throw error;
    }
  }

  async update(actor: DraftActor, appId: string, id: string, body: unknown, options: JourneyDraftUpdateOptions = {}) {
    await assertDraftAccess(this.pg, actor, appId, "journeys:write");
    const data = parseDraft(upsertSchema, body);
    if (options.draftOnly && !options.expectedRevision) throw new BadRequestException("expected_revision is required");
    const expected = parseJourneyIfMatch(options.expectedRevision);
    const db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      // Activation locks this same row before publishing a version.
      const { rows } = await db.query(
        `SELECT name,draft_definition,status,active_version FROM journeys
          WHERE tenant_id=$1 AND app_id=$2 AND id=$3 FOR UPDATE`, [actor.tenantId, appId, id]);
      const current = rows[0];
      if (!current) throw new NotFoundException("저니를 찾을 수 없습니다");
      if (options.draftOnly && (current.status !== "draft" || current.active_version !== null)) throw new ConflictException("ONLY_UNPUBLISHED_DRAFTS_CAN_BE_EDITED");
      if (!["draft", "paused"].includes(current.status)) throw new NotFoundException("수정 가능한 저니를 찾을 수 없습니다 (활성 저니는 새 버전으로만 변경)");
      if (expected && expected !== draftRevision(current.name, current.draft_definition)) throw new PreconditionFailedException("REVISION_CONFLICT");
      await db.query(
        `UPDATE journeys SET name=$4,category=$5,draft_definition=$6,updated_at=now()
          WHERE tenant_id=$1 AND app_id=$2 AND id=$3`,
        [actor.tenantId, appId, id, data.name, data.definition.settings.category, data.definition]);
      await recordDraftAudit(db, actor, appId, "journey_draft.update", id);
      await db.query("COMMIT");
      return { ok: true as const, revision: draftRevision(data.name, data.definition) };
    } catch (error) {
      await db.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw new BadRequestException("같은 이름의 저니가 이미 있습니다");
      throw error;
    } finally { db.release(); }
  }

  async validate(actor: DraftActor, appId: string, id: string, options: { estimateAudience?: boolean } = {}) {
    const journey = await this.get(actor, appId, id);
    const definition = journey.draft_definition as JourneyDefinition;
    const issues = await this.definitionIssues(this.pg, actor.tenantId, appId, id, definition);
    let estimatedCount: number | null = null;
    if (options.estimateAudience !== false && !hasErrors(issues) && definition.entry.type === "blast" && definition.entry.segment_id) {
      const compiled = await this.compileSegment(actor.tenantId, appId, definition.entry.segment_id, definition.settings.category);
      const query = toClickHouse({ sql: `SELECT uniqCombined(user_id) AS c FROM (${compiled.sql})`, args: compiled.args });
      const result = await this.ch.query({ ...query, format: "JSONEachRow", clickhouse_settings: { max_execution_time: 10 } });
      const rows = await result.json<{ c: string }>();
      estimatedCount = Number(rows[0]?.c ?? 0);
    }
    return { issues, estimated_count: estimatedCount, revision: journey.revision };
  }

  async publishedABNodes(db: DraftDatabase, tenantId: string, appId: string, id: string): Promise<PublishedABNodes> {
    const { rows } = await db.query(
      `SELECT v.definition FROM journey_versions v JOIN journeys j ON j.id=v.journey_id
        WHERE j.tenant_id=$1 AND j.app_id=$2 AND j.id=$3 ORDER BY v.version`, [tenantId, appId, id]);
    return collectPublishedABNodes(rows.map(row => row.definition as JourneyDefinition));
  }

  async definitionIssues(db: DraftDatabase, tenantId: string, appId: string, id: string, definition: JourneyDefinition) {
    const issues = validateJourney(definition);
    if (definition.schema_version === 2 && !this.config.journeyGraphV2Enabled) issues.push({ level: "error", field: "schema_version", message: "모든 워커를 업데이트한 뒤 JOURNEY_GRAPH_V2_ENABLED=true로 활성화하세요" });
    issues.push(...validatePublishedABNodes(definition, await this.publishedABNodes(db, tenantId, appId, id)));
    return issues;
  }

  async compileSegment(tenantId: string, appId: string, segmentId: string, category: string) {
    const { rows } = await this.pg.query(
      "SELECT definition,status FROM segments WHERE tenant_id=$1 AND app_id=$2 AND id=$3", [tenantId, appId, segmentId]);
    if (!rows[0]) throw new BadRequestException("세그먼트를 찾을 수 없습니다. 세그먼트 초안은 콘솔에서 승인한 뒤 사용하세요");
    if (rows[0].status === "broken") throw new BadRequestException("broken 세그먼트로는 활성화할 수 없습니다");
    return compile(rows[0].definition as SegmentDSL, tenantId, appId, category as Category);
  }
}
