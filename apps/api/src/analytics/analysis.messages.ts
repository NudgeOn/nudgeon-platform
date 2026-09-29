import { ratio, type MessageInput } from "./analysis.input";
import { asOf, at, type AnalysisQuery, type Parameters } from "./analysis.queries";

export function messageQueries(input: MessageInput, params: Parameters): AnalysisQuery[] {
  const dimension = input.group_by === "journey" ? "toString(journey_id)" : input.group_by === "version" ? "concat(toString(journey_id), ':', toString(journey_version))" : "channel";
  const bucket = input.interval === "week" ? "toString(toStartOfWeek(cohort_at, 1, {tz:String}))" : "toString(toDate(cohort_at, {tz:String}))";
  const query_params = { ...params, channel: input.channel ?? "", journey: input.journey_id ?? "00000000-0000-0000-0000-000000000000", version: input.journey_version ?? 0 };
  const withClause = `WITH log_by_message AS (
    SELECT message_id, min(sent_at) AS first_attempt,
      minOrNullIf(sent_at, status = 'sent') AS first_sent,
      argMax(status, tuple(sent_at, status)) AS last_status,
      argMin(tuple(channel, journey_id, journey_version), tuple(sent_at, channel)) AS first_metadata,
      argMinIf(tuple(channel, journey_id, journey_version), tuple(sent_at, channel), status = 'sent') AS sent_metadata
    FROM message_log WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID} AND sent_at <= ${asOf}
    GROUP BY message_id
  ), message_cohorts AS (
    SELECT message_id, coalesce(first_sent, first_attempt) AS cohort_at, first_sent IS NOT NULL AS was_sent, last_status,
      tupleElement(if(was_sent, sent_metadata, first_metadata), 1) AS channel,
      tupleElement(if(was_sent, sent_metadata, first_metadata), 2) AS journey_id,
      tupleElement(if(was_sent, sent_metadata, first_metadata), 3) AS journey_version
    FROM log_by_message
  ), selected_messages AS (
    SELECT *, if(cohort_at >= ${at("start")}, 'current', 'previous') AS period,
      ${bucket} AS bucket, ${dimension} AS dimension
    FROM message_cohorts WHERE cohort_at >= ${at(input.compare ? "previous" : "start")} AND cohort_at < ${at("end")}
      ${input.channel ? "AND channel = {channel:String}" : ""}
      ${input.journey_id ? "AND journey_id = {journey:UUID}" : ""}
      ${input.journey_version ? "AND journey_version = {version:UInt32}" : ""}
  ), receipt_evidence AS (
    SELECT toString(l.message_id) AS mid,
      max(l.status IN ('delivered', 'opened', 'clicked')) AS delivered,
      max(l.status = 'opened') AS opened, max(l.status = 'clicked') AS clicked, max(l.status = 'bounced') AS bounced
    FROM message_lifecycle l INNER JOIN selected_messages m ON l.message_id = m.message_id
    WHERE l.tenant_id = {tid:UUID} AND l.app_id = {aid:UUID} AND m.was_sent
      AND l.received_at <= ${asOf} AND l.occurred_at <= ${asOf} AND l.occurred_at >= m.cohort_at
    GROUP BY l.message_id
    UNION ALL
    SELECT JSONExtractString(e.properties, 'message_id') AS mid, toUInt8(1) AS delivered,
      max(e.event_name = '$push_opened') AS opened, toUInt8(0) AS clicked, toUInt8(0) AS bounced
    FROM events e INNER JOIN selected_messages m ON JSONExtractString(e.properties, 'message_id') = toString(m.message_id)
    WHERE e.tenant_id = {tid:UUID} AND e.app_id = {aid:UUID} AND m.was_sent
      AND e.server_ts <= ${asOf} AND e.client_ts <= ${asOf} AND e.client_ts >= m.cohort_at
      AND e.event_name IN ('$push_delivered', '$push_received', '$push_opened')
    GROUP BY mid
  ), evidence AS (
    SELECT mid, max(delivered) AS delivered, max(opened) AS opened, max(clicked) AS clicked, max(bounced) AS bounced
    FROM receipt_evidence GROUP BY mid
  ), measured AS (
    SELECT m.*, coalesce(e.delivered, 0) AS delivered, coalesce(e.opened, 0) AS opened,
      coalesce(e.clicked, 0) AS clicked, coalesce(e.bounced, 0) AS bounced
    FROM selected_messages m LEFT JOIN evidence e ON toString(m.message_id) = e.mid
  )`;
  const measures = `countIf(was_sent) AS sent,
    countIf(NOT was_sent AND last_status = 'failed') AS failed,
    countIf(NOT was_sent AND startsWith(last_status, 'skipped_')) AS skipped,
    countIf(NOT was_sent AND last_status != 'failed' AND NOT startsWith(last_status, 'skipped_')) AS other,
    countIf(was_sent AND delivered) AS observed_delivered,
    countIf(was_sent AND opened) AS observed_opened,
    countIf(was_sent AND clicked) AS observed_clicked,
    countIf(was_sent AND bounced) AS observed_bounced`;
  return [
    { query: `${withClause} SELECT period, bucket, dimension, ${measures} FROM measured
      GROUP BY period, bucket, dimension ORDER BY period, bucket, dimension LIMIT 501`, query_params },
    { query: `${withClause} SELECT period, ${measures} FROM measured GROUP BY period`, query_params },
  ];
}

export function messageCounts(raw: Record<string, unknown>) {
  const n = (key: string) => Number(raw[key] ?? 0);
  const sent = n("sent"), delivered = n("observed_delivered"), opened = n("observed_opened");
  const clicked = n("observed_clicked"), bounced = n("observed_bounced");
  return {
    sent, failed: n("failed"), skipped: n("skipped"), other: n("other"),
    observed_delivered: delivered || null, observed_opened: opened || null,
    observed_clicked: clicked || null, observed_bounced: bounced || null,
    observed_delivery_rate: delivered ? ratio(delivered, sent) : null,
    open_rate: opened ? ratio(opened, delivered) : null,
    click_rate: clicked ? ratio(clicked, sent) : null,
    bounce_rate: bounced ? ratio(bounced, sent) : null,
    coverage: "coverage_unknown" as const,
  };
}
