import type { MessageLogEntry } from "@nudgeon/api-client";

export const LOG_LIMIT = 200;
export const LOG_STATUSES = ["all", "sent", "failed", "skipped"] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRecordId = (id: string) => uuid.test(id) && id !== "00000000-0000-0000-0000-000000000000";
export const logStatus = (value: string | null): LogStatus => LOG_STATUSES.find((status) => status === value) ?? "all";
export const statusGroup = (status: string) => status.startsWith("skipped_") ? "skipped" : status === "sent" || status === "failed" ? status : "unknown";
export function matchesLogSearch(row: MessageLogEntry, value: string): boolean {
  const query = value.trim().toLowerCase();
  return !query || [row.message_id, row.user_id, row.device_id, row.campaign_ref, row.failure_class, row.failure_detail, row.channel]
    .some((field) => field.toLowerCase().includes(query));
}
export function guidanceKey(row: MessageLogEntry) {
  if (["skipped_quiet_hours", "skipped_cap", "skipped_unreachable", "skipped_stale"].includes(row.status)) return row.status;
  if (row.status === "sent") return "sent";
  return "inspect";
}
