import "reflect-metadata";
import { Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyUsage, API_KEY_USAGE_MAX_PENDING } from "./api-key-usage";
import { ApiKeyService, type ResolvedApiKey } from "./api-key.service";
import { ShutdownState } from "../infra/shutdown-state";
import { CapacityMetrics } from "../infra/capacity-metrics";
import type { AppConfig } from "../config";

const key: ResolvedApiKey = { id: "k", tenantId: "t", appId: "a", kind: "server", scope: "full" };
const raw = "sk_synthetic_000000000000000000000";
async function value(metrics: CapacityMetrics, outcome?: string) {
  const name = outcome ? "nudgeon_api_key_usage_total" : "nudgeon_api_key_usage_pending";
  const data = await metrics.registry.getSingleMetric(name)?.get();
  return data?.values.find(v => !outcome || v.labels.outcome === outcome)?.value ?? 0;
}
function fixture(enabled = true) {
  const jobs: Array<{ resolve: (value: { rowCount: number }) => void; reject: (error: Error) => void }> = [];
  const query = vi.fn(() => new Promise<{ rowCount: number }>((resolve, reject) => jobs.push({ resolve, reject })));
  const pg = { query } as unknown as Pool, shutdown = new ShutdownState(), metrics = new CapacityMetrics();
  const usage = new ApiKeyUsage(pg, shutdown, enabled, metrics);
  return { jobs, query, pg, shutdown, metrics, usage };
}

describe("bounded best-effort API key usage", () => {
  it("coalesces a hot key before acquiring a connection and scopes the write", async () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.usage.record(key, true);
    await Promise.resolve();
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.query.mock.calls[0]).toEqual([expect.stringContaining("tenant_id = $2 AND app_id = $3"), ["k", "t", "a"]]);
    expect(await value(f.metrics)).toBe(1);
    expect(await value(f.metrics, "coalesced")).toBe(99);
    f.jobs[0]!.resolve({ rowCount: 1 });
    expect(await f.shutdown.waitForBackground(1000)).toBe(true);
    expect(await value(f.metrics)).toBe(0);
    expect(await value(f.metrics, "updated")).toBe(1);
  });

  it("bounds different keys too, then releases the budget after completion", async () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.usage.record({ ...key, id: String(i) }, true);
    await Promise.resolve();
    expect(f.query).toHaveBeenCalledTimes(API_KEY_USAGE_MAX_PENDING);
    expect(await value(f.metrics, "budget")).toBe(100 - API_KEY_USAGE_MAX_PENDING);
    f.jobs.forEach(job => job.resolve({ rowCount: 1 }));
    await f.shutdown.waitForBackground(1000);
    f.usage.record(key, true); await Promise.resolve();
    expect(f.query).toHaveBeenCalledTimes(API_KEY_USAGE_MAX_PENDING + 1);
    f.jobs.at(-1)!.resolve({ rowCount: 0 }); await f.shutdown.waitForBackground(1000);
    expect(await value(f.metrics, "noop")).toBe(1);
  });

  it("does not write when the database says the touch is recent", async () => {
    const f = fixture(); f.usage.record(key, false); await Promise.resolve();
    expect(f.query).not.toHaveBeenCalled();
    expect(await value(f.metrics, "recent")).toBe(1);
  });

  it("preserves per-request writes when explicitly disabled", async () => {
    const f = fixture(false);
    for (let i = 0; i < 4; i++) f.usage.record(key, false);
    await Promise.resolve(); expect(f.query).toHaveBeenCalledTimes(4);
    f.jobs.forEach(job => job.resolve({ rowCount: 1 }));
    expect(await f.shutdown.waitForBackground(1000)).toBe(true);
    expect(await value(f.metrics)).toBe(0);
  });

  it("releases a failed write without leaking errors, keys, or poisoning retries", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    try {
      const f = fixture(); f.usage.record(key, true); await Promise.resolve();
      f.jobs[0]!.reject(new Error("private driver detail"));
      await f.shutdown.waitForBackground(1000);
      expect(await value(f.metrics, "error")).toBe(1);
      expect(await value(f.metrics)).toBe(0);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private driver detail");
      f.usage.record(key, true); await Promise.resolve();
      expect(f.query).toHaveBeenCalledTimes(2);
      f.jobs[1]!.resolve({ rowCount: 1 }); await f.shutdown.waitForBackground(1000);
    } finally { warn.mockRestore(); }
  });
});

describe("usage coalescing is never an authorization cache", () => {
  function resolver() {
    const row = { id: "k", tenant_id: "t", app_id: "a", kind: "server", scope: "full", status: "active", grace_expires_at: null as string | null, usage_due: false };
    const query = vi.fn(async (_sql: string) => ({ rows: [{ ...row }] }));
    const service = new ApiKeyService({ query } as unknown as Pool, new ShutdownState(), undefined, { apiKeyUsageCoalesceEnabled: true } as AppConfig);
    return { row, query, service };
  }
  it("reads validity and scope on every request, rejecting a newly revoked key", async () => {
    const f = resolver(); expect((await f.service.resolve(raw))?.scope).toBe("full");
    f.row.scope = "ingest_only"; expect((await f.service.resolve(raw))?.scope).toBe("ingest_only");
    f.row.status = "revoked"; expect(await f.service.resolve(raw)).toBeNull();
    expect(f.query).toHaveBeenCalledTimes(3);
    expect(f.query.mock.calls.every(call => String(call[0]).includes("WHERE key_hash = $1"))).toBe(true);
  });
  it("preserves rotation grace and rejects expired keys without a write", async () => {
    const f = resolver(); f.row.status = "rotating";
    f.row.grace_expires_at = "2999-01-01"; expect(await f.service.resolve(raw)).not.toBeNull();
    f.row.grace_expires_at = "2000-01-01"; expect(await f.service.resolve(raw)).toBeNull();
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed and unknown keys, and never allows on database failure", async () => {
    const f = resolver(); expect(await f.service.resolve("bad")).toBeNull(); expect(f.query).not.toHaveBeenCalled();
    f.query.mockResolvedValueOnce({ rows: [] }); expect(await f.service.resolve(raw)).toBeNull();
    f.query.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(f.service.resolve(raw)).rejects.toThrow("database unavailable");
  });
});
