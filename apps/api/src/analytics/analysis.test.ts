import "reflect-metadata";
import { BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { SessionGuard } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { PERMISSION_KEY } from "../authz/require-permission.decorator";
import { AnalysisController } from "./analysis.controller";
import { AnalysisService } from "./analysis.service";
import { eventInput, funnelInput, localDate, messageInput, parseInput, period, retentionInput } from "./analysis.input";

const tenant = "31724d85-46ca-4bf4-bf8d-d5455bb2c0a1", app = "b87ba2ad-a68c-4dc0-9f63-8d542f110b77";
function setup(owned = true, values: Record<string, unknown>[][] = []) {
  const pg = { query: vi.fn().mockResolvedValue({ rows: owned ? [{ timezone: "Asia/Seoul" }] : [] }) };
  let index = 0;
  const ch = { query: vi.fn().mockImplementation(async () => ({ json: async () => values[index++] ?? [] })) };
  return { service: new AnalysisService(pg as unknown as Pool, ch as unknown as ClickHouseClient), pg, ch };
}

describe("analysis contracts and resource limits", () => {
  it("requires session and analytics:read at the adapter", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AnalysisController)).toEqual([SessionGuard, PermissionGuard]);
    expect(Reflect.getMetadata(PERMISSION_KEY, AnalysisController)).toBe("analytics:read");
  });

  it.each(["events", "messages", "funnel", "retention"] as const)("rejects foreign apps before parsing or querying %s", async method => {
    const { service, ch, pg } = setup(false);
    await expect(service[method](tenant, app, { sql: "secret" })).rejects.toBeInstanceOf(NotFoundException);
    expect(ch.query).not.toHaveBeenCalled();
    expect(pg.query.mock.calls[0]?.[1]).toEqual([tenant, app]);
  });

  it.each([
    { sql: "SELECT * FROM users" }, { time_basis: "now()" }, { interval: "hour" }, { group_by: "email" },
    { compare: "true" }, { start_date: "2026-02-30" }, { event_names: [] }, { event_names: ["bad\nname"] },
    { event_names: Array(21).fill("event") }, { start_date: "2026-09-01", end_date: "2026-09-02", timezone: "UTC" },
  ])("rejects invalid or unsupported event input %j", input => {
    expect(() => parseInput(eventInput, input)).toThrow(BadRequestException);
  });

  it("limits cohorts, distinct steps, fixed return days, and version selection", () => {
    for (const input of [{ steps: ["one"] }, { steps: ["one", "one"] }, { steps: ["one", "two"], window_days: 31 }]) {
      expect(() => parseInput(funnelInput, input)).toThrow(BadRequestException);
    }
    expect(() => parseInput(retentionInput, { cohort_event: "a", return_event: "b", days: [2] })).toThrow(BadRequestException);
    expect(() => parseInput(messageInput, { journey_version: 2 })).toThrow(BadRequestException);
    expect(parseInput(eventInput, {})).toMatchObject({ time_basis: "client_ts", interval: "day", group_by: "event_name", compare: false });
  });

  it("defaults to thirty closed local dates and validates boundaries across DST", () => {
    const now = new Date("2026-03-09T01:00:00Z");
    expect(localDate(now, "America/New_York")).toBe("2026-03-08");
    expect(period({}, "America/New_York", now)).toMatchObject({ start: "2026-02-06", end: "2026-03-08", days: 30 });
    expect(() => period({ start_date: "2026-03-01" }, "UTC", now)).toThrow(BadRequestException);
    expect(() => period({ start_date: "2026-03-08", end_date: "2026-03-08" }, "UTC", now)).toThrow(BadRequestException);
    expect(() => period({ start_date: "2026-01-01", end_date: "2026-03-08" }, "UTC", now, 30)).toThrow(BadRequestException);
    expect(() => period({ start_date: "2026-03-01", end_date: "2026-03-10" }, "UTC", now)).toThrow(BadRequestException);
  });

  it("binds event names rather than interpolating them, and bounds every query", async () => {
    const { service, ch } = setup();
    const malicious = "purchase'); SELECT secret FROM users; --";
    await service.events(tenant, app, { event_names: [malicious] });
    for (const [call] of ch.query.mock.calls) {
      expect(call.query).not.toContain(malicious);
      expect(call.query_params).toMatchObject({ tid: tenant, aid: app, names: [malicious] });
      expect(call.clickhouse_settings).toMatchObject({ max_execution_time: 30, timeout_overflow_mode: "throw", max_memory_usage: "268435456", result_overflow_mode: "throw", join_use_nulls: 1 });
      expect(call.abort_signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("returns null unknown outcome rates, empty-result denominators and no raw customer values", async () => {
    const { service } = setup();
    const messages = await service.messages(tenant, app, {});
    expect(messages.totals.current).toMatchObject({ sent: 0, observed_delivered: null, observed_opened: null, open_rate: null, coverage: "coverage_unknown" });
    const result = await service.funnel(tenant, app, { steps: ["start", "finish"] });
    expect(result.rows[1]).toMatchObject({ users: 0, previous_step_users: 0, conversion_rate: null, dropoff_rate: null });
    expect(JSON.stringify(result)).not.toContain("user_id");
  });

  it("rejects overflow instead of returning a biased truncated aggregate", async () => {
    const { service } = setup(true, [Array.from({ length: 501 }, () => ({ event_count: 1 }))]);
    await expect(service.events(tenant, app, {})).rejects.toMatchObject({ response: { code: "analysis_result_too_large" } });
  });

  it.each(["159", "241", "396"])("classifies storage budget code %s without returning SQL/provider details", async code => {
    const { service, ch } = setup();
    ch.query.mockRejectedValue(Object.assign(new Error("SELECT secret FROM customer_emails on internal-host"), { code }));
    await expect(service.messages(tenant, app, {})).rejects.toMatchObject({ response: { code: "analysis_budget_exceeded" } });
  });

  it("sanitizes other storage failures", async () => {
    const { service, ch } = setup();
    ch.query.mockRejectedValue(new Error("sensitive infrastructure details"));
    await expect(service.messages(tenant, app, {})).rejects.toBeInstanceOf(ServiceUnavailableException);
    try { await service.events(tenant, app, {}); } catch (error) { expect(JSON.stringify(error)).not.toContain("sensitive"); }
  });

  it("does not imply node instrumentation for legacy/unpublished journey versions", async () => {
    const { service, pg, ch } = setup();
    pg.query.mockResolvedValueOnce({ rows: [{ timezone: "Asia/Seoul" }] });
    pg.query.mockResolvedValueOnce({ rows: [{ id: app, name: "Draft", status: "draft", active_version: null }] });
    const result = await service.journeyReport(tenant, app, app);
    expect(result).toMatchObject({ instrumentation: "unpublished", nodes: [], state_distribution: {} });
    expect(ch.query).not.toHaveBeenCalled();
  });
});
