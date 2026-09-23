import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import type { ClickHouseClient } from "@clickhouse/client";
import type { QueueProducer } from "@nudgeon/libqueue";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import type { SessionRequest } from "../auth/session.guard";
import { SegmentDrafts } from "../segments/segment-drafts.service";
import { JourneyDrafts, parseJourneyIfMatch } from "../journeys/journey-drafts.service";
import { JourneysController } from "../journeys/journeys.controller";
import type { DraftActor } from "./draft-support";

const databaseUrl = process.env.NUDGEON_MCP_TEST_DATABASE_URL;
if (databaseUrl && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname)) throw new Error("Draft tests require a loopback database");
const definition = { version: 1, operator: "AND", groups: [{ operator: "AND", conditions: [{ type: "attribute", key: "country", op: "eq", value: "KR" }] }] };
const journeyDefinition = { entry: { type: "trigger", trigger_event: "sign_up" }, nodes: [
  { type: "message", push: { title: "Welcome", body: "Synthetic draft" } },
], exit: {}, settings: { category: "transactional", reentry: "never" } };

describe("journey conditional requests", () => {
  it("accepts only one strong content revision and preserves absent headers", () => {
    const hash = "a".repeat(64);
    expect(parseJourneyIfMatch(undefined)).toBeUndefined();
    expect(parseJourneyIfMatch(hash)).toBe(hash);
    expect(parseJourneyIfMatch(`"${hash}"`)).toBe(hash);
    for (const invalid of ["*", `W/"${hash}"`, `"${hash}","${hash}"`, "", "invalid"]) expect(() => parseJourneyIfMatch(invalid)).toThrow();
  });
});

describe.skipIf(!databaseUrl)("MCP drafts on actual PostgreSQL", () => {
  const schema = `mcp_drafts_${randomUUID().replaceAll("-", "")}`;
  const tenantId = randomUUID(), appId = randomUUID(), otherApp = randomUUID(), memberId = randomUUID();
  const foreignTenant = randomUUID(), foreignApp = randomUUID();
  const actor: DraftActor = { tenantId, memberId, role: "editor", email: `${memberId}@example.test` };
  const viewer = { ...actor, role: "viewer" };
  const config = { journeyGraphV2Enabled: true } as AppConfig;
  const query = vi.fn(async (_request: unknown) => ({ json: async () => [{ approx: "12", c: "12" }] }));
  const ch = { query } as unknown as ClickHouseClient;
  let admin: Pool, pg: Pool, segments: SegmentDrafts, journeys: JourneyDrafts, controller: JourneysController;
  const req = { member: actor } as SessionRequest;
  const newSegment = (extra: Record<string, unknown> = {}) => segments.create(actor, appId, { name: `segment-${randomUUID()}`, definition, ...extra });
  const newJourney = () => journeys.create(actor, appId, { name: `journey-${randomUUID()}`, definition: journeyDefinition });

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pg = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await pg.query(readFileSync(resolve(__dirname, "../../../../db/postgres/schema.sql"), "utf8"));
    const migration = readFileSync(resolve(__dirname, "../../../../db/postgres/upgrades/0014_mcp_segment_drafts.sql"), "utf8");
    await pg.query(migration);
    await pg.query(migration); // Both fresh bootstrap and repeat application are safe.
    await pg.query("INSERT INTO tenants(id,name) VALUES($1,'draft QA'),($2,'foreign draft QA')", [tenantId, foreignTenant]);
    await pg.query("INSERT INTO apps(id,tenant_id,name) VALUES($1,$2,'draft QA'),($3,$2,'other app'),($4,$5,'foreign app')", [appId, tenantId, otherApp, foreignApp, foreignTenant]);
    await pg.query("INSERT INTO members(id,tenant_id,email,role) VALUES($1,$2,$3,'editor')", [memberId, tenantId, actor.email]);
    segments = new SegmentDrafts(pg, ch);
    journeys = new JourneyDrafts(pg, ch, config);
    controller = new JourneysController(pg, ch, {} as QueueProducer, config, journeys);
  });
  afterAll(async () => {
    if (pg) await pg.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });

  it("replays concurrent creates once without creating any evaluated segment", async () => {
    const input = { name: `unique-${randomUUID()}`, definition, request_id: randomUUID() };
    const drafts = await Promise.all(Array.from({ length: 5 }, () => segments.create(actor, appId, input)));
    expect(new Set(drafts.map(draft => draft.id)).size).toBe(1);
    expect((await pg.query("SELECT count(*)::int AS n FROM segments WHERE tenant_id=$1 AND app_id=$2 AND name=$3", [tenantId, appId, input.name])).rows[0].n).toBe(0);
    expect((await pg.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND target_id=$2", [tenantId, drafts[0]!.id])).rows[0].n).toBe(1);
    expect((await new SegmentDrafts(pg, ch).create(actor, appId, input)).id).toBe(drafts[0]!.id);
    await expect(segments.create(actor, appId, { ...input, name: "changed body" })).rejects.toMatchObject({ status: 409 });
  });

  it("promotes exactly once and freezes the reviewed draft", async () => {
    const draft = await newSegment();
    const promoted = await Promise.all(Array.from({ length: 5 }, () => segments.promote(actor, appId, draft.id, { expected_revision: draft.revision })));
    expect(new Set(promoted.map(result => result.segment_id)).size).toBe(1);
    const stored = await pg.query("SELECT name,definition,status FROM segments WHERE tenant_id=$1 AND app_id=$2 AND id=$3", [tenantId, appId, promoted[0]!.segment_id]);
    expect(stored.rows).toEqual([{ name: draft.name, definition, status: "active" }]);
    await expect(segments.update(actor, appId, draft.id, { name: "changed", definition, expected_revision: draft.revision })).rejects.toMatchObject({ status: 409 });
    expect((await segments.get(actor, appId, draft.id)).promoted_segment_id).toBe(promoted[0]!.segment_id);
  });

  it("rejects stale edits and stale promotion without overwriting a winning edit", async () => {
    const draft = await newSegment();
    const changes = await Promise.allSettled(["one", "two"].map(name => segments.update(actor, appId, draft.id, { name, definition, expected_revision: 1 })));
    expect(changes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(changes.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 412 } });
    await expect(segments.promote(actor, appId, draft.id, { expected_revision: 1 })).rejects.toMatchObject({ status: 412 });
    expect((await segments.get(actor, appId, draft.id)).revision).toBe(2);
  });

  it("keeps a draft available when promotion conflicts with an existing segment name", async () => {
    const draft = await newSegment();
    await pg.query("INSERT INTO segments(tenant_id,app_id,name,definition) VALUES($1,$2,$3,$4)", [tenantId, appId, draft.name, definition]);
    await expect(segments.promote(actor, appId, draft.id, { expected_revision: 1 })).rejects.toMatchObject({ status: 409 });
    expect((await segments.get(actor, appId, draft.id)).promoted_segment_id).toBeNull();
  });

  it("allows Viewer reads while enforcing role, app, and tenant boundaries on every mutation", async () => {
    const draft = await newSegment();
    expect((await segments.get(viewer, appId, draft.id)).id).toBe(draft.id);
    await expect(segments.create(viewer, appId, { name: "denied", definition })).rejects.toMatchObject({ status: 403 });
    await expect(segments.promote(viewer, appId, draft.id, { expected_revision: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(segments.get(actor, otherApp, draft.id)).rejects.toMatchObject({ status: 404 });
    await expect(segments.get({ ...actor, tenantId: foreignTenant }, appId, draft.id)).rejects.toMatchObject({ status: 404 });
    await expect(segments.create(actor, foreignApp, {})).rejects.toMatchObject({ status: 404 });
    await expect(journeys.create(viewer, appId, {})).rejects.toMatchObject({ status: 403 });
  });

  it("previews only a count with tenant and app constrained SQL", async () => {
    const draft = await newSegment(); query.mockClear();
    expect(await segments.preview(viewer, appId, draft.id)).toEqual({ approx_count: 12, revision: 1 });
    expect(query).toHaveBeenCalledTimes(1);
    const request = query.mock.calls[0]![0] as unknown as { query: string; query_params: Record<string, unknown> };
    expect(request.query).toContain("tenant_id");
    expect(Object.values(request.query_params)).toEqual(expect.arrayContaining([tenantId, appId]));
    expect(request.query).not.toContain("external_id");
  });

  it("creates an unpublished journey once and reports its saved content revision", async () => {
    const requestId = randomUUID();
    const input = { name: `idempotent-${randomUUID()}`, definition: journeyDefinition };
    const results = await Promise.all(Array.from({ length: 4 }, () => journeys.create(actor, appId, input, { requestId })));
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(await journeys.get(actor, appId, results[0]!.id)).toMatchObject({ status: "draft", active_version: null, revision: results[0]!.revision });
    expect((await journeys.validate(actor, appId, results[0]!.id)).issues).toEqual([]);
    await expect(journeys.create(actor, appId, { ...input, name: "changed" }, { requestId })).rejects.toMatchObject({ status: 409 });
  });

  it("serializes competing MCP and console edits against the same revision", async () => {
    const draft = await newJourney();
    const changes = await Promise.allSettled([
      journeys.update(actor, appId, draft.id, { name: `MCP-${draft.id}`, definition: journeyDefinition }, { expectedRevision: draft.revision, draftOnly: true }),
      controller.update(appId, draft.id, { name: `console-${draft.id}`, definition: journeyDefinition }, req, `"${draft.revision}"`),
    ]);
    expect(changes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(changes.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 412 } });
    await expect(journeys.update(actor, appId, draft.id, { name: "no revision", definition: journeyDefinition }, { draftOnly: true })).rejects.toMatchObject({ status: 400 });
    await expect(controller.update(appId, draft.id, { name: `legacy-${draft.id}`, definition: journeyDefinition }, req)).resolves.toMatchObject({ ok: true });
  });

  it("fences a race with publication using the activation row lock", async () => {
    const draft = await newJourney();
    const results = await Promise.allSettled([
      journeys.update(actor, appId, draft.id, { name: `raced-${draft.id}`, definition: journeyDefinition }, { expectedRevision: draft.revision, draftOnly: true }),
      controller.activate(appId, draft.id, req, { revision: draft.revision }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });

  it("keeps published or paused journeys out of MCP edits, preserving console paused editing", async () => {
    const draft = await newJourney();
    await controller.activate(appId, draft.id, req, { revision: draft.revision });
    await expect(journeys.update(actor, appId, draft.id, { name: "denied", definition: journeyDefinition }, { draftOnly: true, expectedRevision: draft.revision })).rejects.toMatchObject({ status: 409 });
    await controller.pause(appId, draft.id, req);
    await expect(journeys.update(actor, appId, draft.id, { name: "denied", definition: journeyDefinition }, { draftOnly: true, expectedRevision: draft.revision })).rejects.toMatchObject({ status: 409 });
    await expect(controller.update(appId, draft.id, { name: `paused-${draft.id}`, definition: journeyDefinition }, req, draft.revision)).resolves.toMatchObject({ ok: true });
  });
});
