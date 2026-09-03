import "reflect-metadata";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { CapacityMetrics } from "./capacity-metrics";
import { persistTrackReceipts } from "../ingestion/event-receipts";

const key = { tenantId: "t", appId: "a", id: "k" };
const first = { insert_id: "AB", external_id: "synthetic", event: "qa", client_ts: "2026-09-03T00:00:00Z" };
async function value(metrics: CapacityMetrics, name: string, labels: Record<string, string> = {}) {
  const data = await metrics.registry.getSingleMetric(name)?.get();
  return data?.values.find(v => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value ?? 0;
}
function fixture(options: { existing?: boolean; fail?: string; deadlockOnce?: boolean } = {}) {
  let deadlocked = false;
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (options.fail && sql.includes(options.fail)) throw new Error("synthetic failure");
    if (options.deadlockOnce && !deadlocked && sql.includes("pg_advisory")) {
      deadlocked = true; throw Object.assign(new Error("synthetic deadlock"), { code: "40P01" });
    }
    if (sql.includes("SELECT insert_id")) return { rows: options.existing ? [{ insert_id: "ab" }] : [] };
    if (sql.includes("SELECT id, status")) return { rows: [{ id: "u", status: "active", merged_into: null }] };
    if (sql.includes("RETURNING last_seq")) return { rows: [{ receipt_seq: "1", received_at: "2026-09-03T00:00:00Z" }] };
    return { rows: [] };
  });
  const client = { query, release } as unknown as PoolClient;
  return { pg: { connect: vi.fn(async () => client) } as unknown as Pool, query, release };
}

describe("capacity accounting", () => {
  it("counts server finish and client abort once; ignores readiness, GET and unmatched paths", async () => {
    const metrics = new CapacityMetrics(), next = vi.fn();
    const request = (path: string, method = "POST") => {
      const res = Object.assign(new EventEmitter(), { statusCode: 202 });
      metrics.middleware({ method, path } as Request, res as unknown as Response, next);
      return res;
    };
    const a = request("/v1/track"), b = request("/V1/TRACK/");
    a.emit("finish"); a.emit("close"); b.emit("close"); b.emit("finish");
    for (const p of ["/readyz", "/metrics", "/v1/track/secret-id"]) request(p).emit("finish");
    request("/v1/track", "GET").emit("finish");
    expect(await value(metrics, "nudgeon_api_track_started_total")).toBe(2);
    expect(await value(metrics, "nudgeon_api_track_completed_total", { status_class: "2xx" })).toBe(1);
    expect(await value(metrics, "nudgeon_api_track_aborted_total")).toBe(1);
    expect(await value(metrics, "nudgeon_api_track_inflight")).toBe(0);
    expect(await metrics.registry.metrics()).not.toContain("secret-id");
  });

  it("counts only committed new receipts, excluding in-batch and existing duplicates", async () => {
    const metrics = new CapacityMetrics(), f = fixture();
    await persistTrackReceipts(f.pg, key, { batch: [first, first] }, "r", metrics);
    await persistTrackReceipts(fixture({ existing: true }).pg, key, { batch: [first] }, "r", metrics);
    expect(await value(metrics, "nudgeon_api_receipts_committed_total")).toBe(1);
    expect(await value(metrics, "nudgeon_api_receipt_duplicates_total")).toBe(2);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["BEGIN", "INSERT INTO journey_outbox", "COMMIT"])("does not count a failed %s", async fail => {
    const metrics = new CapacityMetrics(), f = fixture({ fail });
    await expect(persistTrackReceipts(f.pg, key, { batch: [first] }, "r", metrics)).rejects.toThrow("synthetic failure");
    expect(await value(metrics, "nudgeon_api_receipts_committed_total")).toBe(0);
    expect(await value(metrics, "nudgeon_api_receipt_duplicates_total")).toBe(0);
    expect(f.query).toHaveBeenCalledWith("ROLLBACK", undefined);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("counts a retried deadlock as one committed event and keeps bounded stage labels", async () => {
    const metrics = new CapacityMetrics(), f = fixture({ deadlockOnce: true });
    await persistTrackReceipts(f.pg, key, { batch: [first] }, "r", metrics);
    expect(await value(metrics, "nudgeon_api_receipts_committed_total")).toBe(1);
    expect(await value(metrics, "nudgeon_api_receipt_retries_total")).toBe(1);
    const text = await metrics.registry.metrics();
    expect(text).toContain('stage="advisory_lock",outcome="error"');
    expect(text).toContain('stage="commit",outcome="success"');
    expect(text).not.toContain("synthetic deadlock");
    expect(f.release).toHaveBeenCalledTimes(2);
  });

  it("scrapes disconnected pool state without querying or connecting", async () => {
    const metrics = new CapacityMetrics(), query = vi.fn(), connect = vi.fn();
    metrics.registerPool({ totalCount: 2, idleCount: 1, waitingCount: 3, query, connect } as unknown as Pool);
    expect(await value(metrics, "nudgeon_api_pg_pool_connections", { state: "waiting" })).toBe(3);
    expect(query).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  });
});
