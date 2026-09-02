import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueueProducer } from "@nudgeon/libqueue";
import { toGraphDefinition, type JourneyDefinition, type JourneyGraphDefinition } from "@nudgeon/journey-model";
import type { AppConfig } from "../config";
import type { SessionRequest } from "../auth/session.guard";
import { AnalyticsController } from "../analytics/analytics.controller";
import { JourneysController } from "./journeys.controller";

const databaseUrl = process.env.NUDGEON_JOURNEY_TEST_DATABASE_URL;
const clickhouseUrl = process.env.NUDGEON_JOURNEY_TEST_CLICKHOUSE_URL;
let pg: Pool;
let ch: ClickHouseClient;
let api: JourneysController;
let analytics: AnalyticsController;
const tenantId = randomUUID(), appId = randomUUID(), memberId = randomUUID();
const req = { member: { tenantId, memberId, role: "owner", name: "QA", email: "journey-qa@example.test", totpEnabled: false, requires2fa: false } } as SessionRequest;
const legacy: JourneyDefinition = {
  entry: { type: "trigger", trigger_event: "qa_start" },
  nodes: [{ type: "message", push: { title: "test", body: "synthetic only", deep_link: "nudgeon://qa" } }],
  exit: {}, settings: { category: "transactional", reentry: "always" },
};
const config = { journeyGraphV2Enabled: true } as AppConfig;

function graph(): JourneyGraphDefinition {
  return { ...toGraphDefinition(legacy), start_node_id: "split", nodes: [
    { id: "split", type: "ab_split", variants: [{ id: "a", label: "A", weight: 50 }, { id: "b", label: "B", weight: 50 }] },
    { id: "message", type: "message", push: { title: "test", body: "synthetic" } },
  ], edges: [
    { id: "a", source: "split", source_port: "a", target: "message" },
    { id: "b", source: "split", source_port: "b", target: "message" },
    { id: "end", source: "message", source_port: "next", target: null },
  ] };
}

describe.skipIf(!databaseUrl || !clickhouseUrl)("journey management / actual PostgreSQL + ClickHouse", () => {
  beforeAll(async () => {
    for (const url of [databaseUrl!, clickhouseUrl!]) if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Journey tests require an explicit loopback database");
    pg = new Pool({ connectionString: databaseUrl, max: 12 });
    const url = new URL(clickhouseUrl!);
    ch = createClient({ url: url.origin, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) || "nudgeon", clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 } });
    api = new JourneysController(pg, ch, {} as QueueProducer, config);
    analytics = new AnalyticsController(pg, ch);
    await pg.query("INSERT INTO tenants (id,name) VALUES ($1,'journey-api-test')", [tenantId]);
    await pg.query("INSERT INTO apps (id,tenant_id,name) VALUES ($1,$2,'synthetic')", [appId, tenantId]);
    await pg.query("INSERT INTO members (id,tenant_id,email,role) VALUES ($1,$2,$3,'owner')", [memberId, tenantId, `${memberId}@example.test`]);
  });
  afterAll(async () => {
    if (!pg) return;
    for (const table of ["journey_node_executions", "journey_states", "journey_outbox"]) await pg.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    await pg.query("DELETE FROM journey_versions WHERE journey_id IN (SELECT id FROM journeys WHERE tenant_id=$1)", [tenantId]);
    for (const table of ["journeys", "segments", "users", "members", "apps", "tenants"]) await pg.query(`DELETE FROM ${table} WHERE ${table === "tenants" ? "id" : "tenant_id"} = $1`, [tenantId]);
    await pg.end(); await ch.close();
  });
  const create = async (definition: JourneyDefinition = graph()) => {
    const name = `qa-${randomUUID()}`;
    const { id } = await api.create(appId, { name, definition }, req);
    return { id, name, definition };
  };
  const activate = async (id: string) => {
    const validation = await api.validate(appId, id, req);
    expect(validation.issues.filter(issue => issue.level === "error")).toEqual([]);
    return api.activate(appId, id, req, { revision: validation.revision });
  };

  it("round-trips v2 edges and rejects missing/stale validation revisions", async () => {
    const fixture = await create();
    expect((await api.get(appId, fixture.id, req)).draft_definition).toEqual(fixture.definition);
    await expect(api.activate(appId, fixture.id, req)).rejects.toMatchObject({ status: 409 });
    const check = await api.validate(appId, fixture.id, req);
    await api.update(appId, fixture.id, { ...fixture, name: `${fixture.name}-edited` }, req);
    await expect(api.activate(appId, fixture.id, req, { revision: check.revision })).rejects.toMatchObject({ status: 409 });
    expect((await pg.query("SELECT count(*)::int AS n FROM journey_versions WHERE journey_id=$1", [fixture.id])).rows[0].n).toBe(0);
    expect((await activate(fixture.id)).version).toBe(1);
  });

  it("serializes concurrent activation into one immutable version", async () => {
    const fixture = await create(); const check = await api.validate(appId, fixture.id, req);
    const results = await Promise.allSettled([api.activate(appId, fixture.id, req, { revision: check.revision }), api.activate(appId, fixture.id, req, { revision: check.revision })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await pg.query("SELECT count(*)::int AS n FROM journey_versions WHERE journey_id=$1", [fixture.id])).rows[0].n).toBe(1);
  });

  it("locks published AB allocation server-side and preserves old versions for new experiments", async () => {
    const fixture = await create(); await activate(fixture.id); await api.pause(appId, fixture.id, req);
    const changed = graph(); const split = changed.nodes[0]!;
    if (split.type !== "ab_split") throw new Error("fixture");
    split.variants[0]!.weight = 60; split.variants[1]!.weight = 40;
    await api.update(appId, fixture.id, { name: fixture.name, definition: changed }, req);
    const invalid = await api.validate(appId, fixture.id, req);
    expect(invalid.issues).toContainEqual(expect.objectContaining({ level: "error", node_id: "split" }));
    await expect(api.activate(appId, fixture.id, req, { revision: invalid.revision })).rejects.toMatchObject({ status: 400 });
    split.id = "new-experiment"; changed.start_node_id = split.id;
    changed.edges.forEach(edge => { if (edge.source === "split") edge.source = split.id!; });
    await api.update(appId, fixture.id, { name: fixture.name, definition: changed }, req);
    expect((await activate(fixture.id)).version).toBe(2);
    const stored = await pg.query("SELECT version,definition FROM journey_versions WHERE journey_id=$1 ORDER BY version", [fixture.id]);
    expect(stored.rows[0].definition).toEqual(fixture.definition);
    expect(stored.rows[1].definition).toEqual(changed);
    expect(Object.keys((await api.get(appId, fixture.id, req)).published_ab_nodes)).toEqual(["split", "new-experiment"]);
  });

  it("gates graph activation while legacy definitions stay activatable and unchanged", async () => {
    const disabled = new JourneysController(pg, ch, {} as QueueProducer, { ...config, journeyGraphV2Enabled: false });
    const v2 = await create(); const check = await disabled.validate(appId, v2.id, req);
    expect(check.issues).toContainEqual(expect.objectContaining({ field: "schema_version", level: "error" }));
    await expect(disabled.activate(appId, v2.id, req, { revision: check.revision })).rejects.toMatchObject({ status: 400 });
    const v1 = await create(legacy); await disabled.activate(appId, v1.id, req);
    expect((await pg.query("SELECT definition FROM journey_versions WHERE journey_id=$1", [v1.id])).rows[0].definition).toEqual(legacy);
  });

  it("returns version-isolated graph counts and distinguishes unique assignment from reentry", async () => {
    const fixture = await create(); await activate(fixture.id);
    await api.pause(appId, fixture.id, req); await activate(fixture.id);
    const customer = randomUUID();
    for (const [version, port] of [[1, "a"], [1, "a"], [2, "b"]] as const) {
      const state = randomUUID();
      await pg.query("INSERT INTO journey_states (id,tenant_id,app_id,journey_id,journey_version,user_id,status) VALUES ($1,$2,$3,$4,$5,$6,'completed')", [state, tenantId, appId, fixture.id, version, customer]);
      await pg.query("INSERT INTO journey_node_executions (state_id,node_id,node_index,tenant_id,app_id,journey_id,journey_version,user_id,status,arrived_at,resolved_at,output_port) VALUES ($1,'split',0,$2,$3,$4,$5,$6,'resolved',now(),now(),$7)", [state, tenantId, appId, fixture.id, version, customer, port]);
      await ch.insert({ table: "message_log", format: "JSONEachRow", values: [{ tenant_id: tenantId, app_id: appId, journey_id: fixture.id, journey_version: version, node_index: 1, message_id: randomUUID(), user_id: customer, device_id: randomUUID(), idempotency_key: `qa:${state}`, status: "sent", channel: "push_fcm", sent_at: "2026-08-31 00:00:00.000" }] });
    }
    const first = await analytics.journeyReport(appId, fixture.id, req, "1");
    expect(first.definition).toEqual(fixture.definition);
    expect(first.state_distribution.completed).toBe(2);
    expect(first.sends).toEqual([{ status: "sent", node_index: 1, count: 2 }]);
    expect(first.nodes[0]?.paths).toEqual([{ output_port: "a", executions: 2, unique_users: 1 }]);
    expect((await analytics.journeyReport(appId, fixture.id, req, "2")).nodes[0]?.paths).toEqual([{ output_port: "b", executions: 1, unique_users: 1 }]);
    expect((await analytics.journeyReport(appId, fixture.id, req)).state_distribution.completed).toBe(3);
    await expect(analytics.journeyReport(appId, fixture.id, req, "9999")).rejects.toMatchObject({ status: 404 });
  });

  it("never fabricates per-node zero counts for legacy versions", async () => {
    const fixture = await create(legacy); await activate(fixture.id);
    const report = await analytics.journeyReport(appId, fixture.id, req, "1");
    expect(report.instrumentation).toBe("unsupported"); expect(report.nodes).toEqual([]);
  });

  it("enforces tenant access and atomically fences archived waiting executions", async () => {
    const fixture = await create(); await activate(fixture.id);
    const stranger = { member: { ...req.member, tenantId: randomUUID() } } as SessionRequest;
    await expect(api.get(appId, fixture.id, stranger)).rejects.toMatchObject({ status: 404 });
    await expect(api.validate(appId, fixture.id, stranger)).rejects.toMatchObject({ status: 404 });
    await expect(analytics.journeyReport(appId, fixture.id, stranger, "1")).rejects.toMatchObject({ status: 404 });
    const state = randomUUID(), customer = randomUUID();
    await pg.query("INSERT INTO journey_states (id,tenant_id,app_id,journey_id,journey_version,user_id,status,claim_token,next_wake_at) VALUES ($1,$2,$3,$4,1,$5,'waiting',$6,now())", [state, tenantId, appId, fixture.id, customer, randomUUID()]);
    await pg.query("INSERT INTO journey_node_executions (state_id,node_id,node_index,tenant_id,app_id,journey_id,journey_version,user_id,status,arrived_at) VALUES ($1,'split',0,$2,$3,$4,1,$5,'waiting',now())", [state, tenantId, appId, fixture.id, customer]);
    await api.archive(appId, fixture.id, req);
    expect((await pg.query("SELECT status,claim_token,next_wake_at FROM journey_states WHERE id=$1", [state])).rows[0]).toEqual({ status: "exited", claim_token: null, next_wake_at: null });
    expect((await pg.query("SELECT status FROM journey_node_executions WHERE state_id=$1", [state])).rows[0].status).toBe("exited");
  });
});
