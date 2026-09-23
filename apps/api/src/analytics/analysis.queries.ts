import type { EventInput, FunnelInput, Period, RetentionInput } from "./analysis.input";

export type Parameters = Record<string, string | number | string[] | number[]>;
export interface AnalysisQuery { query: string; query_params: Parameters }
export const at = (name: string) => `toDateTime64(concat({${name}:String}, ' 00:00:00'), 3, {tz:String})`;
export const asOf = "parseDateTime64BestEffort({as_of:String}, 3, 'UTC')";
export function parameters(tenantId: string, appId: string, p: Period): Parameters {
  return { tid: tenantId, aid: appId, start: p.start, end: p.end, previous: p.previous, tz: p.timezone, as_of: p.asOf, today: p.today };
}

/** Deduplicate BEFORE restricting event time: a retry may cross a period boundary.
 * The ingestion consumer path-compresses merge edges; argMax handles CH background merge lag.
 * Never use usage materialized views for exact counts or identity resolution.
 */
export function canonicalEvents(basis: "client_ts" | "server_ts", profiles = false): string {
  return `event_payloads AS (
    SELECT insert_id, count() AS source_rows,
      argMin(tuple(event_name, user_id, properties, client_ts, server_ts),
        tuple(server_ts, event_name, toString(user_id), properties, client_ts)) AS payload
    FROM events WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID} AND server_ts <= ${asOf}
    GROUP BY insert_id
  ), merge_edges AS (
    SELECT from_user_id, argMax(to_user_id, tuple(merged_at, toString(to_user_id))) AS to_user_id
    FROM user_merges WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID} AND merged_at <= ${asOf}
    GROUP BY from_user_id
  )${profiles ? `, current_profiles AS (
    SELECT user_id, argMax(tuple(std_attrs, custom_attrs, status), updated_at) AS attrs
    FROM profiles_mirror WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID} AND updated_at <= ${asOf}
    GROUP BY user_id
  )` : ""}, canonical_events AS (
    SELECT d.insert_id, d.source_rows, tupleElement(d.payload, 1) AS event_name,
      coalesce(m.to_user_id, tupleElement(d.payload, 2)) AS canonical_id,
      tupleElement(d.payload, 3) AS properties, tupleElement(d.payload, 4) AS client_ts,
      tupleElement(d.payload, 5) AS server_ts, tupleElement(d.payload, ${basis === "client_ts" ? 4 : 5}) AS event_ts
    FROM event_payloads d LEFT JOIN merge_edges m ON tupleElement(d.payload, 2) = m.from_user_id
  )`;
}

const isoCurrencies = "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWG".split(" ");

export function eventQueries(input: EventInput, params: Parameters): AnalysisQuery[] {
  const profile = input.group_by !== "event_name";
  const profileValue = `if(JSONHas(tupleElement(p.attrs, 1), {dimension:String}),
    JSONExtractString(tupleElement(p.attrs, 1), {dimension:String}), JSONExtractString(tupleElement(p.attrs, 2), {dimension:String}))`;
  // Profile keys are bounded, and invalid values are suppressed (a country field can contain personal data).
  const dimension = profile ? `if(match(${profileValue}, {dimension_pattern:String}), ${profileValue}, '(unknown)')` : "e.event_name";
  const bucket = input.interval === "week" ? "toString(toStartOfWeek(event_ts, 1, {tz:String}))" : "toString(toDate(event_ts, {tz:String}))";
  const query_params = {
    ...params, names: input.event_names ?? [], dimension: input.group_by,
    dimension_pattern: input.group_by === "country" ? "^[A-Z]{2}$" : "^[a-z]{2,3}$",
    currencies: isoCurrencies,
  };
  const withClause = `WITH ${canonicalEvents(input.time_basis, profile)}, selected AS (
    SELECT e.*, if(e.event_ts >= ${at("start")}, 'current', 'previous') AS period,
      ${dimension} AS dimension, ${bucket} AS bucket,
      JSONExtractString(e.properties, 'currency') AS currency,
      JSONExtractFloat(e.properties, 'total_amount') AS amount,
      (JSONType(e.properties, 'total_amount') IN ('Int64', 'UInt64', 'Double')
        AND isFinite(amount) AND amount >= 0 AND has({currencies:Array(String)}, currency)) AS valid_purchase
    FROM canonical_events e ${profile ? "LEFT JOIN current_profiles p ON e.canonical_id = p.user_id" : ""}
    WHERE e.event_ts >= ${at(input.compare ? "previous" : "start")} AND e.event_ts < ${at("end")}
      AND (empty({names:Array(String)}) OR has({names:Array(String)}, e.event_name))
  )`;
  return [
    { query: `${withClause} SELECT period, bucket, dimension, count() AS event_count, uniqExact(canonical_id) AS unique_users
      FROM selected GROUP BY period, bucket, dimension ORDER BY period, bucket, dimension LIMIT 501`, query_params },
    { query: `${withClause} SELECT period, count() AS event_count, uniqExact(canonical_id) AS unique_users,
        sum(source_rows - 1) AS duplicates_removed, countIf(server_ts > client_ts + INTERVAL 1 DAY) AS late_received_events,
        countIf(event_name = 'purchase_completed' AND NOT valid_purchase) AS invalid_purchase_events,
        countIf(event_name = 'purchase_completed' AND valid_purchase) AS valid_purchase_events,
        formatDateTime(max(server_ts), '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS latest_received_at
      FROM selected GROUP BY period`, query_params },
    { query: `${withClause} SELECT period, currency, count() AS purchase_events, sum(amount) AS purchase_amount
      FROM selected WHERE event_name = 'purchase_completed' AND valid_purchase
      GROUP BY period, currency ORDER BY period, currency LIMIT 501`, query_params },
    { query: `WITH ${canonicalEvents(input.time_basis)}
      SELECT countIf(client_ts > ${asOf}) AS future_timestamp_events
      FROM canonical_events WHERE server_ts >= ${at(input.compare ? "previous" : "start")} AND server_ts < ${at("end")}
        AND (empty({names:Array(String)}) OR has({names:Array(String)}, event_name))`, query_params },
  ];
}

/** Each stage joins only its customer's bounded timeline; minOrNullIf does not invent an epoch for missing steps. */
export function funnelQuery(input: FunnelInput, params: Parameters): AnalysisQuery {
  const query_params = { ...params, names: input.steps, window: input.window_days };
  const stages: string[] = [
    `timeline AS (SELECT * FROM canonical_events
      WHERE has({names:Array(String)}, event_name) AND event_ts >= ${at("start")}
        AND event_ts < ${at("end")} + toIntervalDay({window:UInt32}) AND event_ts <= ${asOf})`,
    `stage1 AS (SELECT canonical_id, min(event_ts) AS t1 FROM timeline
      WHERE event_name = {names:Array(String)}[1] AND event_ts < ${at("end")} GROUP BY canonical_id)`,
  ];
  for (let n = 2; n <= input.steps.length; n++) {
    const prior = ["s.canonical_id", ...Array.from({ length: n - 1 }, (_, i) => `s.t${i + 1}`), ...Array.from({ length: n - 2 }, (_, i) => `s.tie${i + 2}`)];
    stages.push(`stage${n} AS (SELECT ${prior.join(", ")},
      minOrNullIf(e.event_ts, e.event_name = {names:Array(String)}[${n}]
        AND e.event_ts > s.t${n - 1} AND e.event_ts <= s.t1 + toIntervalDay({window:UInt32})) AS t${n},
      countIf(e.event_name = {names:Array(String)}[${n}] AND e.event_ts = s.t${n - 1}) AS tie${n}
      FROM stage${n - 1} s LEFT JOIN timeline e ON s.canonical_id = e.canonical_id
      GROUP BY ${prior.join(", ")})`);
  }
  const columns = ["count() AS step1", ...Array.from({ length: input.steps.length - 1 }, (_, i) => `countIf(t${i + 2} IS NOT NULL) AS step${i + 2}`),
    `countIf(${Array.from({ length: input.steps.length - 1 }, (_, i) => `tie${i + 2} > 0`).join(" OR ")}) AS ambiguous_users`,
    `countIf(t1 + toIntervalDay({window:UInt32}) > ${asOf}) AS immature_users`];
  return { query: `WITH ${canonicalEvents(input.time_basis)}, ${stages.join(", ")}
    SELECT ${columns.join(", ")} FROM stage${input.steps.length}`, query_params };
}

export function retentionQuery(input: RetentionInput, params: Parameters): AnalysisQuery {
  return {
    query: `WITH ${canonicalEvents(input.time_basis)}, timeline AS (
      SELECT * FROM canonical_events WHERE event_name IN ({cohort:String}, {return:String})
        AND event_ts >= ${at("start")} AND event_ts < ${at("end")} + INTERVAL 31 DAY AND event_ts <= ${asOf}
    ), cohorts AS (
      SELECT canonical_id, toDate(min(event_ts), {tz:String}) AS cohort_date
      FROM timeline WHERE event_name = {cohort:String} AND event_ts < ${at("end")} GROUP BY canonical_id
    ), customer_days AS (
      SELECT c.canonical_id, c.cohort_date,
        groupUniqArrayIf(dateDiff('day', c.cohort_date, toDate(e.event_ts, {tz:String})), e.event_name = {return:String}) AS return_days
      FROM cohorts c LEFT JOIN timeline e ON c.canonical_id = e.canonical_id
      GROUP BY c.canonical_id, c.cohort_date
    ) SELECT toString(cohort_date) AS cohort_date, day, count() AS cohort_users,
      countIf(has(return_days, toInt64(day))) AS returned_users,
      toUInt8(addDays(cohort_date, day) < toDate({today:String})) AS matured
    FROM customer_days ARRAY JOIN {days:Array(UInt16)} AS day
    GROUP BY cohort_date, day ORDER BY cohort_date, day LIMIT 501`,
    query_params: { ...params, cohort: input.cohort_event, return: input.return_event, days: input.days },
  };
}

/** Quality counters describe observed rows, not a guarantee of complete collection.
 * Invalid future client clocks are counted by reception period even when client-time analysis excludes them.
 */
export function cohortQualityQuery(basis: "client_ts" | "server_ts", names: string[], window: number, params: Parameters): AnalysisQuery {
  return {
    query: `WITH ${canonicalEvents(basis)} SELECT
      countIf(server_ts >= ${at("start")} AND server_ts < ${at("end")} AND client_ts > ${asOf}) AS future_timestamp_events,
      countIf(event_ts >= ${at("start")} AND event_ts < ${at("end")} + toIntervalDay({window:UInt32})
        AND event_ts <= ${asOf} AND server_ts > client_ts + INTERVAL 1 DAY) AS late_received_events,
      sumIf(source_rows - 1, event_ts >= ${at("start")} AND event_ts < ${at("end")} + toIntervalDay({window:UInt32})
        AND event_ts <= ${asOf}) AS observed_duplicates_removed
      FROM canonical_events WHERE has({quality_names:Array(String)}, event_name)`,
    query_params: { ...params, quality_names: names, window },
  };
}
