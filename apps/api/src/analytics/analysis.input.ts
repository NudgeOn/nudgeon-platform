import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Use a valid calendar date (YYYY-MM-DD)");
const event = z.string().min(1).max(128).refine(value => !/[\u0000-\u001f]/.test(value));
const base = {
  start_date: date.optional(), end_date: date.optional(),
  time_basis: z.enum(["client_ts", "server_ts"]).default("client_ts"),
};
export const eventInput = z.object({
  ...base, event_names: z.array(event).min(1).max(20).optional(),
  interval: z.enum(["day", "week"]).default("day"),
  group_by: z.enum(["event_name", "country", "language"]).default("event_name"),
  compare: z.boolean().default(false),
}).strict();
export const messageInput = z.object({
  start_date: date.optional(), end_date: date.optional(),
  interval: z.enum(["day", "week"]).default("day"),
  group_by: z.enum(["channel", "journey", "version"]).default("channel"),
  channel: z.string().min(1).max(64).optional(), journey_id: z.string().uuid().optional(),
  journey_version: z.number().int().min(1).max(2147483647).optional(),
  compare: z.boolean().default(false),
}).strict().refine(value => value.journey_version === undefined || value.journey_id !== undefined,
  "journey_version requires journey_id");
export const funnelInput = z.object({
  ...base, steps: z.array(event).min(2).max(5).refine(steps => new Set(steps).size === steps.length, "Steps must have distinct event names"),
  window_days: z.number().int().min(1).max(30).default(7),
}).strict();
export const retentionInput = z.object({
  ...base, cohort_event: event, return_event: event,
  days: z.array(z.union([z.literal(1), z.literal(7), z.literal(30)])).min(1).max(3)
    .refine(days => new Set(days).size === days.length).default([1, 7, 30]),
}).strict();
export type EventInput = z.infer<typeof eventInput>;
export type MessageInput = z.infer<typeof messageInput>;
export type FunnelInput = z.infer<typeof funnelInput>;
export type RetentionInput = z.infer<typeof retentionInput>;
export interface Period {
  start: string; end: string; previous: string; days: number; today: string;
  timezone: string; asOf: string;
}

export function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw new BadRequestException({ code: "invalid_analysis_input", issues: result.error.issues });
  return result.data;
}

export function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function addDays(value: string, days: number): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
export function period(input: { start_date?: string; end_date?: string }, timezone: string, now: Date, maxDays = 90): Period {
  const today = localDate(now, timezone);
  if (!!input.start_date !== !!input.end_date) throw new BadRequestException("Provide both start_date and end_date, or neither");
  const start = input.start_date ?? addDays(today, -30);
  const end = input.end_date ?? today;
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
  if (days < 1 || days > maxDays || end > today) {
    throw new BadRequestException(`Choose 1–${maxDays} completed calendar days; end_date is exclusive and cannot be after today`);
  }
  // events TTL is 180 days. The server cannot reconstruct older cohorts reliably.
  if (start < addDays(today, -180)) throw new BadRequestException("The requested period is outside the 180-day event retention window");
  return { start, end, previous: addDays(start, -days), days, today, timezone, asOf: now.toISOString() };
}
export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}
export function change(current: number, previous: number) {
  return { current, previous, absolute_difference: current - previous, relative_change: ratio(current - previous, previous) };
}

/** Static definitions are safe to share before a connection chooses an app. */
export function metricCatalog() {
  return {
    version: 1,
    limits: { default_days: 30, max_days: 90, cohort_max_days: 30, max_window_days: 30, max_rows: 500, timeout_seconds: 30 },
    rate_scale: "Rates and relative changes are ratios (1 = 100%); zero denominators are null",
    standard_events: ["sign_up", "login", "purchase_completed", "product_viewed", "add_to_cart", "checkout_started"],
    custom_events: "Accepted; names are exact and case-sensitive. Standard events are not automatically collected.",
    dimensions: { events: ["event_name", "country", "language"], messages: ["channel", "journey", "version"], profile_basis: "current mirrored profile, not event-time attributes" },
    metrics: [
      { name: "event_count", definition: "One event per app/insert_id; earliest observed payload wins", denominator: null },
      { name: "unique_users", definition: "Exact distinct canonical customer IDs using latest path-compressed merge mirror", denominator: null },
      { name: "purchase_amount", definition: "Sum of valid numeric purchase_completed.total_amount, separately by uppercase ISO currency code; no refunds, settlement or attribution", denominator: null },
      { name: "observed_delivery_rate", definition: "Observed delivery evidence / provider-accepted messages", denominator: "sent" },
      { name: "open_rate", definition: "Observed opened messages / observed delivered messages", denominator: "observed_delivered" },
      { name: "click_rate", definition: "Observed clicked messages / provider-accepted messages", denominator: "sent" },
      { name: "bounce_rate", definition: "Observed bounced messages / provider-accepted messages", denominator: "sent" },
      { name: "funnel_conversion", definition: "Customers completing strictly ordered steps within the window after first start in the entry period", denominator: "first-step customers" },
      { name: "retention", definition: "Exact local-calendar Nth-day return following first cohort event in the entry period; not lifetime-first signup", denominator: "cohort customers, only after Nth day has ended" },
    ],
    time: { events_default: "client_ts", events_alternative: "server_ts", timezone: "app IANA timezone", period: "start_date inclusive, end_date exclusive; calendar dates" },
    limitations: ["No raw events, arbitrary SQL, or personal-data dimensions", "Ingestion and profile/merge mirroring are asynchronous; completeness is unknown", "Not an attribution or statistical significance engine"],
  };
}
