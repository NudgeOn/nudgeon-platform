import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import type { QueueProducer } from "@onda/libqueue";
import type { ResolvedApiKey } from "../auth/api-key.service";
import { persistTrackReceipts } from "./event-receipts";
import { IngestionService } from "./ingestion.service";
import type { TrackBody } from "./schemas";

const databaseUrl = process.env.ONDA_RECEIPT_TEST_DATABASE_URL;
const runPG = databaseUrl != null;
const tenants: string[] = [];
let pg: Pool;

describe.skipIf(!runPG)("track receipt / actual PostgreSQL transactions", () => {
  beforeAll(async () => {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl!).hostname)) {
      throw new Error("Receipt integration tests require an explicitly configured loopback database");
    }
    pg = new Pool({ connectionString: databaseUrl, max: 12 });
    await pg.query("SELECT 1");
  });
  afterAll(async () => {
    if (!pg) return;
    for (const tenant of tenants) {
      // Only this suite's randomly generated synthetic tenants are removed.
      for (const table of ["journey_outbox", "event_receipts", "event_customer_cursors", "devices", "user_merges", "users", "apps", "tenants"]) {
        await pg.query(`DELETE FROM ${table} WHERE ${table === "tenants" ? "id" : "tenant_id"} = $1`, [tenant]);
      }
    }
    await pg.end();
  });

  async function fixture(): Promise<ResolvedApiKey> {
    const key: ResolvedApiKey = { tenantId: randomUUID(), appId: randomUUID(), id: randomUUID(), kind: "server", scope: "full" };
    await pg.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [key.tenantId, "receipt-test"]);
    tenants.push(key.tenantId);
    await pg.query("INSERT INTO apps (id, tenant_id, name) VALUES ($1, $2, $3)", [key.appId, key.tenantId, "synthetic"]);
    return key;
  }

  const event = (externalId = "synthetic-customer"): TrackBody["batch"][number] => ({
    insert_id: randomUUID(), external_id: externalId, event: "purchase",
    properties: { order_id: "invented-order", amount: 12000, nested: { synthetic: true } },
    client_ts: "2026-08-30T21:15:00.123+09:00",
  });
  const save = (key: ResolvedApiKey, body: TrackBody) => persistTrackReceipts(pg, key, body, randomUUID());
  const receipts = (key: ResolvedApiKey) => pg.query(
    `SELECT r.*, r.receipt_seq::text AS receipt_seq, r.received_at::text AS first_received_at
      FROM event_receipts r WHERE tenant_id = $1 AND app_id = $2 ORDER BY r.receipt_seq`, [key.tenantId, key.appId],
  );

  it("batch duplicates and subsequent retries preserve the first identity, body, time and sequence", async () => {
    const key = await fixture();
    const first = { ...event(), insert_id: "ab111111-2222-4333-8444-555555555555" };
    const second = event();
    const changed = { ...first, insert_id: first.insert_id.toUpperCase(), external_id: "different-customer", properties: { replaced: true } };
    const device = { device_id: randomUUID(), platform: "ios" as const, app_version: "qa-only" };
    await save(key, { batch: [first, changed, second], device });
    const before = (await receipts(key)).rows;
    expect(before.map((r) => r.receipt_seq)).toEqual(["1", "2"]);
    expect(before[0].properties).toEqual(first.properties);
    expect(before[0].device).toEqual(device);
    expect(before[0].projected_at).toBeNull();
    expect(before[0].matched_at).toBeNull();
    await save(key, { batch: [changed] });
    expect((await receipts(key)).rows).toEqual(before);
    expect((await pg.query("SELECT id FROM users WHERE tenant_id = $1", [key.tenantId])).rowCount).toBe(1);
    const outbox = (await pg.query("SELECT payload, published_at FROM journey_outbox WHERE tenant_id = $1 ORDER BY id", [key.tenantId])).rows;
    expect(outbox).toHaveLength(2);
    expect(outbox[0].published_at).toBeNull();
    expect(outbox[0].payload.events[0]).toMatchObject({ insert_id: first.insert_id, receipt_seq: "1", properties: first.properties, client_ts: first.client_ts });
    expect(outbox[0].payload.events[0].user_id).toBe(before[0].user_id);
  });

  it("concurrent customers submitting the same insert_id create one receipt/outbox/customer", async () => {
    const key = await fixture();
    const first = event("customer-a");
    await Promise.all([
      save(key, { batch: [first] }),
      save(key, { batch: [{ ...first, external_id: "customer-b", properties: { alternative: true } }] }),
    ]);
    expect((await receipts(key)).rows).toHaveLength(1);
    expect((await pg.query("SELECT id FROM journey_outbox WHERE tenant_id = $1", [key.tenantId])).rowCount).toBe(1);
    expect((await pg.query("SELECT id FROM users WHERE tenant_id = $1", [key.tenantId])).rowCount).toBe(1);
  });

  it("concurrent distinct events get one ordered cursor and decimal bigint values remain exact", async () => {
    const key = await fixture();
    await Promise.all(Array.from({ length: 8 }, () => save(key, { batch: [event()] })));
    const received = (await receipts(key)).rows;
    expect(received.map((r) => r.receipt_seq)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(new Set(received.map((r) => r.user_id)).size).toBe(1);
    await pg.query("UPDATE event_customer_cursors SET last_seq = $2 WHERE tenant_id = $1", [key.tenantId, "9007199254740992"]);
    const next = event();
    await save(key, { batch: [next] });
    const row = (await pg.query("SELECT payload FROM journey_outbox WHERE tenant_id = $1 AND idempotency_key = $2", [key.tenantId, `event.ingest:${next.insert_id}`])).rows[0];
    expect(row.payload.events[0].receipt_seq).toBe("9007199254740993");
  });

  it("merged anonymous identity resolves to the canonical profile without a new identify operation", async () => {
    const key = await fixture();
    const canonical = randomUUID(), alias = randomUUID(), anon = randomUUID();
    await pg.query("INSERT INTO users (id, tenant_id, app_id, external_id) VALUES ($1, $2, $3, $4)", [canonical, key.tenantId, key.appId, "canonical"]);
    await pg.query("INSERT INTO users (id, tenant_id, app_id, anon_id, status, merged_into) VALUES ($1, $2, $3, $4, 'merged', $5)", [alias, key.tenantId, key.appId, anon, canonical]);
    await save(key, { batch: [{ ...event(), external_id: undefined, anon_id: anon }] });
    expect((await receipts(key)).rows[0].user_id).toBe(canonical);
  });

  it("same insert_id in a different app is independent", async () => {
    const a = await fixture(), b = await fixture(), original = event();
    await Promise.all([save(a, { batch: [original] }), save(b, { batch: [original] })]);
    expect((await receipts(a)).rows).toHaveLength(1);
    expect((await receipts(b)).rows).toHaveLength(1);
  });

  it("database error at outbox insertion rolls back the complete batch and produces 503", async () => {
    const key = await fixture();
    const failingPool = {
      async connect() {
        const client = await pg.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query") return (sql: string, values?: unknown[]) =>
              sql.includes("INSERT INTO journey_outbox") ? target.query("SELECT 1 / 0") : target.query(sql, values);
            const value = target[property as keyof PoolClient];
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    const insert = vi.fn().mockResolvedValue({});
    const publish = vi.fn();
    const service = new IngestionService({ insert } as unknown as ClickHouseClient, { publish } as unknown as QueueProducer, failingPool);
    await expect(service.track(key, { batch: [event(), event()] }, {})).rejects.toMatchObject({ status: 503 });
    for (const table of ["event_receipts", "event_customer_cursors", "journey_outbox", "users"]) {
      expect((await pg.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [key.tenantId])).rowCount).toBe(0);
    }
    expect(insert).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("track response shape is unchanged and success requires no Redis publish", async () => {
    const key = await fixture();
    const insert = vi.fn().mockResolvedValue({}), publish = vi.fn();
    const service = new IngestionService({ insert } as unknown as ClickHouseClient, { publish } as unknown as QueueProducer, pg);
    const first = event();
    const result = await service.track(key, { batch: [first, first] }, { synthetic: true });
    expect(result).toEqual({ accepted: 2, request_id: expect.any(String) });
    expect((await receipts(key)).rows).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
  });
});
