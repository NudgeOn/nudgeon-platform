import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AnalysisService } from "./analysis.service";

const url = process.env.NUDGEON_ANALYTICS_TEST_CLICKHOUSE_URL;
const tenant = randomUUID(), app = randomUUID(), zero = "00000000-0000-0000-0000-000000000000";
const fixtureDatabase = `analysis_test_${randomUUID().replaceAll("-", "")}`;
let ch: ClickHouseClient;
let admin: ClickHouseClient;
let timezone = "Asia/Seoul";
let service: AnalysisService;
const pg = { query: vi.fn(async (_sql: string, args: string[]) => ({ rows: args[0] === tenant && args[1] === app ? [{ timezone }] : [] })) };
const ts = (date: string) => date.replace("T", " ").replace("Z", "");

describe.skipIf(!url)("analysis / actual ClickHouse 24.8", () => {
  beforeAll(async () => {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url!).hostname)) throw new Error("Use an explicitly configured loopback test ClickHouse");
    const sourceDatabase = new URL(url!).pathname.slice(1) || "default";
    if (!/^[a-zA-Z0-9_]+$/.test(sourceDatabase)) throw new Error("Invalid fixture source database name");
    admin = createClient({ url });
    await admin.command({ query: `CREATE DATABASE ${fixtureDatabase}` });
    for (const table of ["events", "user_merges", "profiles_mirror", "message_log", "message_lifecycle"]) {
      await admin.command({ query: `CREATE TABLE ${fixtureDatabase}.${table} AS ${sourceDatabase}.${table}` });
    }
    // Only the randomly owned test database loses TTL. Fixed historical/DST fixtures
    // must remain reproducible after the production 180-day retention has elapsed.
    await admin.command({ query: `ALTER TABLE ${fixtureDatabase}.events REMOVE TTL` });
    const fixtureUrl = new URL(url!);
    fixtureUrl.pathname = `/${fixtureDatabase}`;
    ch = createClient({ url: fixtureUrl.toString(), keep_alive: { enabled: false }, clickhouse_settings: { async_insert: 0 } });
    await (await ch.query({ query: "SELECT version()" })).text();
    const client = { query: async (options: Parameters<ClickHouseClient["query"]>[0]) => {
      try { return await ch.query(options); }
      catch (error) { console.error("Fixture query failed:", (error as Error).message); throw error; }
    } } as ClickHouseClient;
    service = new AnalysisService(pg as unknown as Pool, client);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
  });
  afterAll(async () => {
    vi.useRealTimers();
    if (ch) await ch.close();
    if (admin) {
      await admin.command({ query: `DROP DATABASE IF EXISTS ${fixtureDatabase}` });
      await admin.close();
    }
  });
  async function event(user: string, name: string, at: string, properties = {}, insert = randomUUID(), received = at, otherApp = app) {
    await ch.insert({ table: "events", format: "JSONEachRow", values: [{ tenant_id: tenant, app_id: otherApp,
      insert_id: insert, user_id: user, device_id: zero, event_name: name, properties: JSON.stringify(properties), client_ts: ts(at), server_ts: ts(received) }] });
  }
  const dates = { start_date: "2026-09-01", end_date: "2026-09-20" };

  it("deduplicates inserts and resolves multi-step merges without counting foreign apps; groups valid purchases separately", async () => {
    const a = randomUUID(), b = randomUUID(), c = randomUUID(), duplicate = randomUUID();
    await event(a, "analysis_buy", "2026-09-02T01:00:00Z", {}, duplicate);
    await event(a, "analysis_buy", "2026-09-02T01:00:00Z", {}, duplicate, "2026-09-02T02:00:00Z");
    await event(b, "analysis_buy", "2026-09-03T01:00:00Z");
    await event(c, "analysis_buy", "2026-09-04T01:00:00Z");
    await event(randomUUID(), "analysis_buy", "2026-09-04T01:00:00Z", {}, randomUUID(), "2026-09-04T01:00:00Z", randomUUID());
    await ch.insert({ table: "user_merges", format: "JSONEachRow", values: [
      { tenant_id: tenant, app_id: app, from_user_id: a, to_user_id: b, merged_at: "2026-09-05 00:00:00" },
      { tenant_id: tenant, app_id: app, from_user_id: a, to_user_id: c, merged_at: "2026-09-06 00:00:00" },
      { tenant_id: tenant, app_id: app, from_user_id: b, to_user_id: c, merged_at: "2026-09-06 00:00:00" },
    ] });
    await ch.insert({ table: "profiles_mirror", format: "JSONEachRow", values: [{ tenant_id: tenant, app_id: app, user_id: c,
      external_id: "synthetic", std_attrs: '{"country":"KR","language":"ko"}', custom_attrs: '{}',
      push_opt_in: 0, os_permission_granted: 0, token_active: 0, platforms: [], status: "active", updated_at: "2026-09-06 00:00:00" }] });
    const result = await service.events(tenant, app, { ...dates, event_names: ["analysis_buy"], group_by: "country" });
    expect(result.totals.current.event_count).toBe(3);
    expect(result.totals.current.unique_users).toBe(1);
    expect(result.rows.every(row => row.dimension === "KR")).toBe(true);
    for (const [amount, currency] of [[100, "KRW"], [5.5, "USD"], ["12", "USD"], [7, "FAK"], [-1, "KRW"]]) {
      await event(c, "purchase_completed", "2026-09-05T12:00:00Z", { total_amount: amount, currency });
    }
    const money = await service.events(tenant, app, { ...dates, event_names: ["purchase_completed"], compare: true });
    expect(money.purchases).toEqual([
      { period: "current", currency: "KRW", purchase_events: 1, purchase_amount: 100 },
      { period: "current", currency: "USD", purchase_events: 1, purchase_amount: 5.5 },
    ]);
    expect(money.totals.current.invalid_purchase_events).toBe(3);
    expect(money.comparison?.event_count.relative_change).toBeNull();
  });

  it("uses explicit client/server time and reports delayed and future timestamps", async () => {
    const user = randomUUID();
    await event(user, "analysis_time", "2026-08-30T00:00:00Z", {}, randomUUID(), "2026-09-05T00:00:00Z");
    await event(user, "analysis_time", "2026-10-01T00:00:00Z", {}, randomUUID(), "2026-09-05T00:00:00Z");
    expect((await service.events(tenant, app, { ...dates, event_names: ["analysis_time"] })).totals.current.event_count).toBe(0);
    const result = await service.events(tenant, app, { ...dates, event_names: ["analysis_time"], time_basis: "server_ts" });
    expect(result.totals.current.event_count).toBe(2);
    expect(result.totals.current.late_received_events).toBe(1);
    expect(result.data_quality.future_timestamp_events).toBe(1);
  });

  it("counts strict ordered funnel steps, tied timestamps, first-start windows and zero denominators", async () => {
    const pass = randomUUID(), tied = randomUUID(), late = randomUUID();
    const steps = ["flow_start", "flow_middle", "flow_finish"];
    await event(pass, steps[0]!, "2026-09-02T00:00:00.001Z");
    await event(pass, steps[1]!, "2026-09-02T00:00:00.002Z");
    await event(pass, steps[2]!, "2026-09-02T00:00:00.003Z");
    await event(tied, steps[0]!, "2026-09-02T00:00:00.001Z");
    await event(tied, steps[1]!, "2026-09-02T00:00:00.001Z");
    await event(tied, steps[2]!, "2026-09-02T00:00:00.003Z");
    await event(late, steps[0]!, "2026-09-02T00:00:00Z");
    await event(late, steps[0]!, "2026-09-09T00:00:00Z");
    await event(late, steps[1]!, "2026-09-10T00:00:00Z");
    const result = await service.funnel(tenant, app, { ...dates, steps });
    expect(result.rows.map(row => row.users)).toEqual([3, 1, 1]);
    expect(result.rows[1]!.conversion_rate).toBeCloseTo(1 / 3);
    expect(result.data_quality.ambiguous_same_timestamp_users).toBe(1);
    const empty = await service.funnel(tenant, app, { ...dates, steps: ["none-start", "none-finish"] });
    expect(empty.rows.map(row => row.conversion_rate)).toEqual([null, null]);
  });

  it("returns exact-calendar retention and null for unfinished Nth days", async () => {
    const a = randomUUID(), b = randomUUID();
    await event(a, "retention_join", "2026-09-01T14:30:00Z"); // Sep1 23:30 KST
    await event(a, "retention_return", "2026-09-01T15:30:00Z"); // Sep2 00:30 KST, only one elapsed hour
    await event(a, "retention_return", "2026-09-08T00:30:00Z");
    await event(b, "retention_join", "2026-09-01T12:00:00Z");
    const result = await service.retention(tenant, app, { ...dates, cohort_event: "retention_join", return_event: "retention_return" });
    expect(result.rows).toEqual([
      { cohort_date: "2026-09-01", day: 1, cohort_users: 2, returned_users: 1, retention_rate: 0.5, status: "measured" },
      { cohort_date: "2026-09-01", day: 7, cohort_users: 2, returned_users: 1, retention_rate: 0.5, status: "measured" },
      { cohort_date: "2026-09-01", day: 30, cohort_users: 2, returned_users: null, retention_rate: null, status: "not_matured" },
    ]);
  });

  it("cohorts messages by first sent date and deduplicates late SDK and provider evidence", async () => {
    const mid = randomUUID(), user = randomUUID(), journey = randomUUID();
    const log = { tenant_id: tenant, app_id: app, message_id: mid, idempotency_key: "synthetic", journey_id: journey,
      journey_version: 1, node_index: 0, campaign_ref: "test", user_id: user, device_id: zero,
      channel: "push_fcm", failure_class: "", failure_detail: "" };
    await ch.insert({ table: "message_log", format: "JSONEachRow", values: [
      { ...log, status: "failed", sent_at: "2026-08-30 00:00:00" },
      { ...log, status: "sent", sent_at: "2026-09-02 00:00:00" },
      { ...log, status: "sent", sent_at: "2026-09-22 00:00:00" },
    ] });
    await event(user, "$push_opened", "2026-09-22T00:00:00Z", { message_id: mid });
    await ch.insert({ table: "message_lifecycle", format: "JSONEachRow", values: ["delivered", "opened", "opened"].map(status => ({
      tenant_id: tenant, app_id: app, message_id: mid, status, occurred_at: "2026-09-22 00:00:00", received_at: "2026-09-22 00:00:00",
      source: "sdk", channel: "push_fcm", connector_id: "", provider_message_id: "", user_id: user, endpoint_id: zero,
      failure_class: "", failure_detail: "", fallback_index: 0, attempt: 0, cost_currency: "", cost_amount: 0, click_ref: "",
    })) });
    const result = await service.messages(tenant, app, { ...dates, journey_id: journey });
    expect(result.totals.current.sent).toBe(1);
    expect(result.totals.current.failed).toBe(0);
    expect(result.totals.current.observed_delivered).toBe(1);
    expect(result.totals.current.observed_opened).toBe(1);
    expect(result.totals.current.open_rate).toBe(1);
    expect(result.totals.current.observed_clicked).toBeNull();
    const later = await service.messages(tenant, app, { start_date: "2026-09-20", end_date: "2026-09-23", journey_id: journey });
    expect(later.totals.current.sent).toBe(0);
  });

  it("observes DST calendar boundaries rather than fixed 24-hour retention days", async () => {
    timezone = "America/New_York";
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    try {
      const user = randomUUID();
      await event(user, "dst_join", "2026-11-01T04:30:00Z"); // Nov1 00:30 EDT
      await event(user, "dst_return", "2026-11-02T05:10:00Z"); // Nov2 00:10 EST, 24h40m
      const result = await service.retention(tenant, app, { start_date: "2026-11-01", end_date: "2026-11-02", cohort_event: "dst_join", return_event: "dst_return", days: [1] });
      expect(result.rows[0]).toMatchObject({ cohort_date: "2026-11-01", day: 1, returned_users: 1, retention_rate: 1 });
    } finally { timezone = "Asia/Seoul"; vi.setSystemTime(new Date("2026-09-23T00:00:00Z")); }
  });

  it("does not count lifecycle or SDK evidence dated before the first accepted send", async () => {
    const mid = randomUUID(), user = randomUUID(), journey = randomUUID();
    await ch.insert({ table: "message_log", format: "JSONEachRow", values: [{
      tenant_id: tenant, app_id: app, message_id: mid, idempotency_key: "pre-send-evidence", journey_id: journey,
      journey_version: 1, node_index: 0, campaign_ref: "test", user_id: user, device_id: zero,
      channel: "push_fcm", failure_class: "", failure_detail: "", status: "sent", sent_at: "2026-09-02 00:00:00",
    }] });
    await event(user, "$push_opened", "2026-09-01T00:00:00Z", { message_id: mid }, randomUUID(), "2026-09-03T00:00:00Z");
    await ch.insert({ table: "message_lifecycle", format: "JSONEachRow", values: [{
      tenant_id: tenant, app_id: app, message_id: mid, status: "opened", occurred_at: "2026-09-01 00:00:00", received_at: "2026-09-03 00:00:00",
      source: "sdk", channel: "push_fcm", connector_id: "", provider_message_id: "", user_id: user, endpoint_id: zero,
      failure_class: "", failure_detail: "", fallback_index: 0, attempt: 0, cost_currency: "", cost_amount: 0, click_ref: "",
    }] });
    const result = await service.messages(tenant, app, { ...dates, journey_id: journey });
    expect(result.totals.current).toMatchObject({ sent: 1, observed_delivered: null, observed_opened: null, observed_delivery_rate: null, open_rate: null });
  });
});
