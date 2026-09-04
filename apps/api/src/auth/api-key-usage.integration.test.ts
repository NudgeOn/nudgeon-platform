import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiKeyService, generateApiKey, type ResolvedApiKey } from "./api-key.service";
import { ApiKeyUsage } from "./api-key-usage";
import { CapacityMetrics } from "../infra/capacity-metrics";
import { ShutdownState } from "../infra/shutdown-state";
import type { AppConfig } from "../config";

const url = process.env.NUDGEON_RECEIPT_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("API key QA requires an explicitly supplied loopback fixture");
describe.skipIf(!url)("API key usage on actual PostgreSQL", () => {
  let pg: Pool;
  const tenantId = randomUUID(), appId = randomUUID();
  beforeAll(async () => {
    pg = new Pool({ connectionString: url, max: 4 });
    await pg.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic usage QA')", [tenantId]);
    await pg.query("INSERT INTO apps(id,tenant_id,name) VALUES($1,$2,'Synthetic usage QA')", [appId, tenantId]);
  });
  afterAll(async () => {
    if (!pg) return;
    try {
      // Schema intentionally uses RESTRICT, not a tenant-wide cascade.
      await pg.query("DELETE FROM api_keys WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId]);
      await pg.query("DELETE FROM apps WHERE tenant_id=$1 AND id=$2", [tenantId, appId]);
      await pg.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    }
    finally { await pg.end(); }
  });
  async function fixture() {
    const generated = generateApiKey("server"), id = randomUUID();
    await pg.query("INSERT INTO api_keys(id,tenant_id,app_id,kind,scope,prefix,key_hash) VALUES($1,$2,$3,'server','full',$4,$5)", [id, tenantId, appId, generated.prefix, generated.hash]);
    const key: ResolvedApiKey = { id, tenantId, appId, kind: "server", scope: "full" };
    const shutdown = new ShutdownState(), metrics = new CapacityMetrics();
    const service = new ApiKeyService(pg, shutdown, metrics, { apiKeyUsageCoalesceEnabled: true } as AppConfig);
    const sql = (set: string) => pg.query(`UPDATE api_keys SET ${set} WHERE id=$1 AND tenant_id=$2 AND app_id=$3`, [id, tenantId, appId]);
    return { key, raw: generated.key, shutdown, metrics, service, sql };
  }
  async function count(metrics: CapacityMetrics, outcome: string) {
    return (await metrics.registry.getSingleMetric("nudgeon_api_key_usage_total")!.get()).values.find(v => v.labels.outcome === outcome)?.value ?? 0;
  }
  it("rechecks the database predicate across two independent API instances", async () => {
    const f = await fixture();
    new ApiKeyUsage(pg, f.shutdown, true, f.metrics).record(f.key, true);
    new ApiKeyUsage(pg, f.shutdown, true, f.metrics).record(f.key, true);
    expect(await f.shutdown.waitForBackground(5000)).toBe(true);
    expect(await count(f.metrics, "updated")).toBe(1);
    expect(await count(f.metrics, "noop")).toBe(1);
  });
  it("uses database age for the 60-second refresh and still resolves every request", async () => {
    const f = await fixture();
    expect(await f.service.resolve(f.raw)).not.toBeNull(); await f.shutdown.waitForBackground(5000);
    expect(await f.service.resolve(f.raw)).not.toBeNull(); await f.shutdown.waitForBackground(5000);
    expect(await count(f.metrics, "updated")).toBe(1); expect(await count(f.metrics, "recent")).toBe(1);
    await f.sql("last_used_at=now()-interval '61 seconds'");
    expect(await f.service.resolve(f.raw)).not.toBeNull(); await f.shutdown.waitForBackground(5000);
    expect(await count(f.metrics, "updated")).toBe(2);
  });
  it("immediately observes changed scope and revocation after a recent usage update", async () => {
    const f = await fixture(); await f.service.resolve(f.raw); await f.shutdown.waitForBackground(5000);
    await f.sql("scope='ingest_only'"); expect((await f.service.resolve(f.raw))?.scope).toBe("ingest_only");
    await f.sql("status='revoked'"); expect(await f.service.resolve(f.raw)).toBeNull();
    // An already scheduled stale instance cannot touch a revoked key either.
    await f.sql("last_used_at=NULL"); new ApiKeyUsage(pg, f.shutdown, true, f.metrics).record(f.key, true);
    await f.shutdown.waitForBackground(5000); expect(await count(f.metrics, "noop")).toBe(1);
  });
  it("keeps rotation expiry effective even when last_used_at is recent", async () => {
    const f = await fixture(); await f.service.resolve(f.raw); await f.shutdown.waitForBackground(5000);
    await f.sql("status='rotating',grace_expires_at=now()+interval '1 hour'"); expect(await f.service.resolve(f.raw)).not.toBeNull();
    await f.sql("grace_expires_at=now()-interval '1 hour'"); expect(await f.service.resolve(f.raw)).toBeNull();
  });
});
