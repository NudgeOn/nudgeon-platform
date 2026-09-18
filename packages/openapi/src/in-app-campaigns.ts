export type InAppTrigger =
  | { type: "foreground" | "launch" }
  | { type: "screen" | "event"; name: string };
export interface InAppCampaignConfig {
  platforms: ("ios" | "android")[];
  trigger: InAppTrigger;
  /** IANA zone for daily limits and hide-today. Omitted legacy configurations use UTC. */
  time_zone?: string;
  starts_at: string;
  ends_at: string;
  cooldown_seconds: number;
  max_per_day: number;
  max_total: number;
  priority: number;
}
export interface InAppCampaignInput {
  name: string;
  revision_id: string;
  config: InAppCampaignConfig;
}
export interface InAppCampaign extends InAppCampaignInput {
  id: string;
  version: number;
  state: "draft" | "published" | "paused";
  updated_at: string;
}
export interface InAppReview {
  revision_id: string;
  platform: "ios" | "android";
  run_id: string;
  passed: boolean;
  reviewed_at: string;
}
export interface InAppCampaignReport {
  deliveries: { state: string; count: number }[];
  events: { kind: string; count: number }[];
  interruptions?: { id: string; created_at: string; reason: string }[];
  failures: { id: string; created_at: string; detail: string }[];
}
type Request = <T>(method: string, path: string, body?: unknown) => Promise<T>;
export function inAppCampaignClient(request: Request) {
  const base = (a: string) => `/v1/apps/${encodeURIComponent(a)}/in-app`;
  return {
    list: (a: string) =>
      request<{ campaigns: InAppCampaign[] }>("GET", `${base(a)}/campaigns`),
    create: (a: string, b: InAppCampaignInput) =>
      request<InAppCampaign>("POST", `${base(a)}/campaigns`, b),
    update: (
      a: string,
      id: string,
      b: InAppCampaignInput & { expected_version: number },
    ) => request<InAppCampaign>("POST", `${base(a)}/campaigns/${id}`, b),
    publish: (a: string, id: string, version: number) =>
      request<InAppCampaign>("POST", `${base(a)}/campaigns/${id}/publish`, {
        expected_version: version,
      }),
    pause: (a: string, id: string, version: number) =>
      request<InAppCampaign>("POST", `${base(a)}/campaigns/${id}/pause`, {
        expected_version: version,
      }),
    report: (a: string, id: string) =>
      request<InAppCampaignReport>("GET", `${base(a)}/campaigns/${id}/report`),
    reviews: (a: string) =>
      request<{ reviews: InAppReview[] }>("GET", `${base(a)}/reviews`),
    review: (
      a: string,
      b: {
        run_id: string;
        passed: boolean;
        layout_checked: boolean;
        close_checked: boolean;
        actions_checked: boolean;
      },
    ) => request<{ ok: true }>("POST", `${base(a)}/reviews`, b),
  };
}
