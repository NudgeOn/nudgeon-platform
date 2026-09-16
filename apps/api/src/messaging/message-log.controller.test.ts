import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { SessionRequest } from "../auth/session.guard";
import { MessageLogController } from "./message-log.controller";

const appId = "b87ba2ad-a68c-4dc0-9f63-8d542f110b77";
const runId = "db33d3bf-d6dd-41df-9804-3d3e583bc62f";
const req = { member: { tenantId: "tenant-a" } } as SessionRequest;
function setup(owned = true) {
  const pg = { query: vi.fn().mockResolvedValue({ rowCount: owned ? 1 : 0 }) };
  const ch = { query: vi.fn().mockImplementation(async ({ query }: { query: string }) => ({
    json: async () => query.includes("countIf") ? [{ total: "8", failed: "2" }] : [],
  })) };
  const controller = new MessageLogController(pg as unknown as Pool, ch as unknown as ClickHouseClient);
  return { controller, pg, ch };
}

describe("message log filters", () => {
  it("scopes test-run and skipped queries to the owned tenant/app and keeps hour stats app-wide", async () => {
    const { controller, pg, ch } = setup();
    const result = await controller.list(appId, "skipped", appId, "200", req, runId);
    expect(pg.query.mock.calls[0]?.[1]).toEqual([appId, "tenant-a"]);
    const list = ch.query.mock.calls[0]?.[0];
    expect(list.query).toContain("tenant_id = {tid:UUID} AND app_id = {aid:UUID}");
    expect(list.query).toContain("startsWith(status, 'skipped_')");
    expect(list.query).toContain("campaign_ref = {campaign:String}");
    expect(list.query).toContain("LIMIT 200");
    expect(list.query_params).toEqual({ tid: "tenant-a", aid: appId, jid: appId, campaign: `test:${runId}` });
    expect(ch.query.mock.calls[1]?.[0].query_params).toEqual({ tid: "tenant-a", aid: appId });
    expect(result.recent_hour).toEqual({ total: 8, failed: 2, failure_rate: 0.25 });
  });
  it.each(["-1", "1.5", "Infinity", "501", "oops", "0"])("rejects invalid limit %s before querying ClickHouse", async (limit) => {
    const { controller, ch } = setup();
    await expect(controller.list(appId, undefined, undefined, limit, req)).rejects.toBeInstanceOf(BadRequestException);
    expect(ch.query).not.toHaveBeenCalled();
  });
  it("rejects invalid UUID filters", async () => {
    const { controller, ch } = setup();
    await expect(controller.list(appId, undefined, "bad", undefined, req)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.list(appId, undefined, undefined, undefined, req, "bad")).rejects.toBeInstanceOf(BadRequestException);
    expect(ch.query).not.toHaveBeenCalled();
  });
  it("checks ownership before filter validation and never queries another tenant's logs", async () => {
    const { controller, ch } = setup(false);
    await expect(controller.list(appId, undefined, "bad", undefined, req)).rejects.toBeInstanceOf(NotFoundException);
    expect(ch.query).not.toHaveBeenCalled();
  });
  it("keeps exact status filtering parameterized and defaults to 100 rows", async () => {
    const { controller, ch } = setup();
    await controller.list(appId, "failed", undefined, undefined, req);
    expect(ch.query.mock.calls[0]?.[0].query_params.status).toBe("failed");
    expect(ch.query.mock.calls[0]?.[0].query).toContain("LIMIT 100");
  });
});
