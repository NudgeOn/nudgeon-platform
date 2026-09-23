import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import type { JourneyDefinition } from "@nudgeon/journey-model";
import { CLICKHOUSE, PG } from "../infra/infra.module";
import { change, eventInput, funnelInput, messageInput, metricCatalog, parseInput, period, ratio, retentionInput, type Period } from "./analysis.input";
import { cohortQualityQuery, eventQueries, funnelQuery, parameters, retentionQuery, type AnalysisQuery } from "./analysis.queries";
import { messageCounts, messageQueries } from "./analysis.messages";

type Row = Record<string, unknown>;
const n = (row: Row, key: string) => Number(row[key] ?? 0);

/** Shared by authenticated REST and MCP. Authorization of the caller belongs to the adapter;
 * ownership is always rechecked here so no adapter can choose a foreign app.
 */
@Injectable()
export class AnalysisService {
  constructor(@Inject(PG) private readonly pg: Pool, @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient) {}

  catalog() { return metricCatalog(); }

  async appCatalog(tenantId: string, appId: string) {
    const timezone = await this.app(tenantId, appId);
    const [result] = await this.run([{
      query: `SELECT event_name FROM events WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
        GROUP BY event_name ORDER BY event_name LIMIT 501`, query_params: { tid: tenantId, aid: appId },
    }]);
    this.checkRows(result!);
    const attributes = await this.pg.query(
      `SELECT key, type FROM attribute_registry WHERE tenant_id = $1 AND app_id = $2 ORDER BY key LIMIT 501`, [tenantId, appId],
    );
    this.checkRows(attributes.rows);
    return { ...this.catalog(), scope: { app_id: appId, timezone }, collected_events: result!.map(row => row.event_name),
      collected_attributes: attributes.rows, as_of: new Date().toISOString() };
  }

  async events(tenantId: string, appId: string, raw: unknown) {
    const timezone = await this.app(tenantId, appId);
    const input = parseInput(eventInput, raw);
    const p = period(input, timezone, new Date());
    this.checkComparison(p, input.compare);
    const [series, totals, purchases, quality] = await this.run(eventQueries(input, parameters(tenantId, appId, p)));
    this.checkRows([...series!, ...purchases!]);
    const summary = (kind: string) => {
      const row = totals!.find(value => value.period === kind) ?? {};
      return { event_count: n(row, "event_count"), unique_users: n(row, "unique_users"),
        duplicates_removed: n(row, "duplicates_removed"), late_received_events: n(row, "late_received_events"),
        valid_purchase_events: n(row, "valid_purchase_events"), invalid_purchase_events: n(row, "invalid_purchase_events"),
        latest_received_at: row.latest_received_at ?? null };
    };
    const current = summary("current"), previous = summary("previous");
    return {
      ...this.envelope(appId, p, input, input.time_basis),
      definitions: this.catalog().metrics.filter(metric => ["event_count", "unique_users", "purchase_amount"].includes(metric.name)),
      rows: series!.map(row => ({ period: row.period, bucket: row.bucket, dimension: row.dimension,
        event_count: n(row, "event_count"), unique_users: n(row, "unique_users") })),
      totals: { current, ...(input.compare ? { previous } : {}) },
      comparison: input.compare ? { event_count: change(current.event_count, previous.event_count), unique_users: change(current.unique_users, previous.unique_users) } : null,
      purchases: purchases!.map(row => ({ period: row.period, currency: row.currency, purchase_events: n(row, "purchase_events"), purchase_amount: n(row, "purchase_amount") })),
      data_quality: {
        completeness: "coverage_unknown", future_timestamp_events: n(quality![0] ?? {}, "future_timestamp_events"),
        duplicate_policy: "earliest received payload per insert_id", identity_basis: "latest path-compressed merge mirror",
        profile_basis: input.group_by === "event_name" ? null : "current mirrored profile, not event-time attributes; invalid country/language values are suppressed",
        missing_buckets: "No observed events; rows are sparse. This does not establish collection coverage.",
      },
    };
  }

  async messages(tenantId: string, appId: string, raw: unknown) {
    const timezone = await this.app(tenantId, appId);
    const input = parseInput(messageInput, raw);
    const p = period(input, timezone, new Date());
    this.checkComparison(p, input.compare);
    const [series, totals] = await this.run(messageQueries(input, parameters(tenantId, appId, p)));
    this.checkRows(series!);
    const current = messageCounts(totals!.find(row => row.period === "current") ?? {});
    const previous = messageCounts(totals!.find(row => row.period === "previous") ?? {});
    return {
      ...this.envelope(appId, p, input, "first_sent_at; unsent outcomes use first_attempt_at"),
      definitions: this.catalog().metrics.filter(metric => ["observed_delivery_rate", "open_rate", "click_rate", "bounce_rate"].includes(metric.name)),
      rows: series!.map(row => ({ period: row.period, bucket: row.bucket, dimension: row.dimension, ...messageCounts(row) })),
      totals: { current, ...(input.compare ? { previous } : {}) },
      comparison: input.compare ? { sent: change(current.sent, previous.sent), failed: change(current.failed, previous.failed), skipped: change(current.skipped, previous.skipped) } : null,
      data_quality: { completeness: "coverage_unknown", outcome_cutoff: p.asOf,
        notes: ["Provider acceptance is not device delivery", "SDK and provider evidence are deduplicated by message_id, from first sent through as_of including outcomes after the send period",
          "null outcome counts/rates mean no observed evidence; collection support and coverage are unknown, not a measured zero",
          "Failed/skipped count the latest outcome of messages never accepted; a successful retry counts as sent only"] },
    };
  }

  async funnel(tenantId: string, appId: string, raw: unknown) {
    const timezone = await this.app(tenantId, appId);
    const input = parseInput(funnelInput, raw);
    const p = period(input, timezone, new Date(), 30);
    const params = parameters(tenantId, appId, p);
    const [result, quality] = await this.run([funnelQuery(input, params), cohortQualityQuery(input.time_basis, input.steps, input.window_days, params)]);
    const row = result![0] ?? {};
    const first = n(row, "step1");
    const rows = input.steps.map((name, index) => {
      const users = n(row, `step${index + 1}`), prior = index ? n(row, `step${index}`) : first;
      return { step: index + 1, event_name: name, users, initial_users: first, previous_step_users: prior,
        conversion_rate: ratio(users, first), step_conversion_rate: ratio(users, prior),
        dropped_users: index ? prior - users : 0, dropoff_rate: index ? ratio(prior - users, prior) : null };
    });
    return {
      ...this.envelope(appId, p, input, input.time_basis),
      definition: this.catalog().metrics.find(metric => metric.name === "funnel_conversion"), rows,
      data_quality: { completeness: "coverage_unknown", ambiguous_same_timestamp_users: n(row, "ambiguous_users"),
        not_matured_users: n(row, "immature_users"),
        ...this.cohortQuality(quality![0] ?? {}),
        notes: ["First start in entry period; strictly later timestamps for each next step; intervening events are allowed",
          "Tied timestamps are not ordered artificially", "Window is elapsed 24-hour days from first start; incomplete windows are provisional",
          "Future event timestamps are excluded. Late arrivals and asynchronous merge mirroring can revise results."] },
    };
  }

  async retention(tenantId: string, appId: string, raw: unknown) {
    const timezone = await this.app(tenantId, appId);
    const input = parseInput(retentionInput, raw);
    const p = period(input, timezone, new Date(), 30);
    const params = parameters(tenantId, appId, p);
    const [result, quality] = await this.run([retentionQuery(input, params), cohortQualityQuery(input.time_basis, [input.cohort_event, input.return_event], 31, params)]);
    this.checkRows(result!);
    return {
      ...this.envelope(appId, p, input, input.time_basis),
      definition: this.catalog().metrics.find(metric => metric.name === "retention"),
      rows: result!.map(row => {
        const matured = n(row, "matured") === 1, customers = n(row, "cohort_users"), returns = n(row, "returned_users");
        return { cohort_date: row.cohort_date, day: n(row, "day"), cohort_users: customers,
          returned_users: matured ? returns : null, retention_rate: matured ? ratio(returns, customers) : null,
          status: matured ? "measured" : "not_matured" };
      }),
      data_quality: { completeness: "coverage_unknown", ...this.cohortQuality(quality![0] ?? {}), notes: ["Exact local calendar Nth day, not rolling 24 hours or on-or-after retention",
        "First cohort event within requested entry period, not lifetime-first signup", "Current local day is incomplete; future timestamps excluded",
        "Late arrivals and asynchronous merge mirroring can revise results"] },
    };
  }

  async journeyReport(tenantId: string, appId: string, journeyId: string, requestedVersion?: number) {
    const timezone = await this.app(tenantId, appId);
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(journeyId) ||
        requestedVersion !== undefined && (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1 || requestedVersion > 2147483647)) {
      throw new BadRequestException("Invalid journey_id or version");
    }
    const { rows: journeys } = await this.pg.query(
      `SELECT id, name, status, active_version FROM journeys WHERE tenant_id = $1 AND app_id = $2 AND id = $3`, [tenantId, appId, journeyId],
    );
    const journey = journeys[0];
    if (!journey) throw new NotFoundException("Journey not found");
    const version = requestedVersion ?? journey.active_version;
    const selected = version == null ? null : (await this.pg.query(
      `SELECT v.definition FROM journey_versions v JOIN journeys j ON j.id = v.journey_id
        WHERE j.tenant_id = $1 AND j.app_id = $2 AND j.id = $3 AND v.version = $4`, [tenantId, appId, journeyId, version],
    )).rows[0];
    if (requestedVersion !== undefined && !selected) throw new NotFoundException("Journey version not found");
    const definition = selected?.definition as JourneyDefinition | undefined;
    const as_of = new Date().toISOString();
    const supported = definition?.schema_version === 2;
    const scope = [tenantId, appId, journeyId, version ?? null, as_of];
    const states = version == null ? { rows: [] } : await this.pg.query(
      `SELECT status, count(*) AS n FROM journey_states
        WHERE tenant_id = $1 AND app_id = $2 AND journey_id = $3 AND journey_version = $4 AND entered_at <= $5
        GROUP BY status`, scope,
    );
    const visits = supported ? await this.pg.query(
      `SELECT node_id, status, output_port, count(*) AS executions, count(DISTINCT user_id) AS unique_users
        FROM journey_node_executions WHERE tenant_id = $1 AND app_id = $2 AND journey_id = $3
          AND journey_version = $4 AND arrived_at <= $5 GROUP BY node_id, status, output_port LIMIT 501`, scope,
    ) : { rows: [] };
    this.checkRows(visits.rows);
    return {
      scope: { app_id: appId, journey_id: journeyId, version: version ?? null, timezone }, as_of,
      name: journey.name, status: journey.status, time_basis: "current execution state across selected version lifetime",
      state_distribution: Object.fromEntries(states.rows.map(row => [row.status, Number(row.n)])),
      instrumentation: supported ? "available" : definition ? "unsupported" : "unpublished",
      nodes: supported ? definition!.nodes.map(node => {
        const matching = visits.rows.filter(row => row.node_id === node.id);
        const executions = (status?: string) => matching.filter(row => status === undefined || row.status === status)
          .reduce((sum, row) => sum + Number(row.executions), 0);
        return { node_id: node.id, type: node.type, arrived_executions: executions(), completed_executions: executions("resolved"),
          waiting_executions: executions("waiting"), failed_executions: executions("failed"),
          paths: matching.filter(row => row.status === "resolved" && row.output_port != null)
            .map(row => ({ output_port: row.output_port, executions: Number(row.executions), unique_users: Number(row.unique_users) })) };
      }) : [],
      data_quality: { completeness: supported ? "available" : "unsupported", notes: ["Journey completion is not purchase conversion",
        "Counts are current execution states; branch users are stored execution identities, not historical canonical-customer analysis",
        "A/B allocation counts do not establish an experiment winner"] },
    };
  }

  private async app(tenantId: string, appId: string): Promise<string> {
    const result = await this.pg.query(`SELECT timezone FROM apps WHERE tenant_id = $1 AND id = $2`, [tenantId, appId]);
    if (!result.rows[0]) throw new NotFoundException("App not found");
    return result.rows[0].timezone;
  }

  private envelope(appId: string, p: Period, input: unknown, timeBasis: string) {
    return { scope: { app_id: appId, timezone: p.timezone, start_date: p.start, end_date: p.end },
      as_of: p.asOf, computed_at: new Date().toISOString(), time_basis: timeBasis, query: input,
      limits: { max_rows: 500, timeout_seconds: 30 }, sampling: "none" };
  }
  private checkComparison(p: Period, enabled: boolean) {
    if (enabled && p.previous < new Date(Date.parse(`${p.today}T00:00:00Z`) - 180 * 86400000).toISOString().slice(0, 10)) {
      throw new BadRequestException("Comparison period exceeds the 180-day event retention window");
    }
  }
  private cohortQuality(row: Row) {
    return { future_timestamp_events: n(row, "future_timestamp_events"), late_received_events: n(row, "late_received_events"),
      observed_duplicates_removed: n(row, "observed_duplicates_removed"),
      quality_scope: "Selected event names in entry+observation window; future clocks counted by entry-period reception. Background storage deduplication may already have removed retries." };
  }
  private checkRows(rows: unknown[]) {
    if (rows.length > 500) throw new BadRequestException({ code: "analysis_result_too_large", message: "More than 500 aggregate rows; shorten the period, use weekly buckets or narrow filters" });
  }
  private async run(queries: AnalysisQuery[]): Promise<Row[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      return await Promise.all(queries.map(async query => {
        const result = await this.ch.query({ ...query, format: "JSONEachRow", abort_signal: controller.signal,
          clickhouse_settings: { max_execution_time: 30, timeout_overflow_mode: "throw", max_memory_usage: "268435456",
            max_result_rows: "501", result_overflow_mode: "throw", max_threads: 2, join_use_nulls: 1 } });
        return await result.json<Row>();
      }));
    } catch (error) {
      // Do not expose SQL, parameters, infrastructure addresses or raw provider errors to AI clients.
      const code = String((error as { code?: unknown })?.code ?? "");
      if (["159", "241", "396", "119"].includes(code) || controller.signal.aborted) {
        throw new BadRequestException({ code: "analysis_budget_exceeded", message: "Analysis exceeded its time, memory or result budget; narrow the query" });
      }
      throw new ServiceUnavailableException({ code: "analysis_unavailable", message: "Analytics storage is unavailable; retry later" });
    } finally {
      controller.abort();
      clearTimeout(timeout);
    }
  }
}
