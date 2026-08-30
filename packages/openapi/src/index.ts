/**
 * Onda API 클라이언트.
 * TODO(S3): openapi.yaml 코드젠 산출물로 대체한다 (ADR-5). 그 전까지 스펙과
 * 이 파일의 드리프트는 리뷰로 관리하며, 콘솔은 반드시 이 패키지만 사용한다
 * (CLAUDE.md 규칙 4 — 수기 fetch 금지의 단일 예외 지점).
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API ${status}`);
    this.name = "ApiError";
  }
}

export interface MeResponse {
  member_id: string;
  tenant_id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "editor" | "viewer";
}

export interface SignupResponse {
  tenant_id: string;
  app_id: string;
  sdk_key: string;
  server_key: string;
}

export class OndaClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      credentials: "include", // httpOnly 세션 쿠키 (ADR-8)
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }

  readonly auth = {
    signup: (input: {
      email: string;
      password: string;
      name: string;
      tenant_name: string;
    }) => this.request<SignupResponse>("POST", "/v1/auth/signup", input),
    login: (input: { email: string; password: string }) =>
      this.request<{ ok: true }>("POST", "/v1/auth/login", input),
    logout: () => this.request<{ ok: true }>("POST", "/v1/auth/logout"),
    me: () => this.request<MeResponse>("GET", "/v1/auth/me"),
  };

  readonly apps = {
    list: () => this.request<{ apps: AppSummary[] }>("GET", "/v1/apps"),
    keys: (appId: string) =>
      this.request<{ keys: ApiKeySummary[] }>("GET", `/v1/apps/${appId}/keys`),
    rotateSdkKey: (appId: string, keyId: string) =>
      this.request<{ sdk_key: string; grace_days: number }>(
        "POST",
        `/v1/apps/${appId}/keys/${keyId}/rotate`,
      ),
    createServerKey: (appId: string) =>
      this.request<{ id: string; server_key: string }>("POST", `/v1/apps/${appId}/keys`),
    revokeKey: (appId: string, keyId: string) =>
      this.request<{ ok: true }>("DELETE", `/v1/apps/${appId}/keys/${keyId}`),
    ingestStatus: (appId: string) =>
      this.request<IngestStatus>("GET", `/v1/apps/${appId}/ingest-status`),
    testPush: (appId: string, input: { external_id: string; title: string; body: string }) =>
      this.request<{ queued: number; test_run_id: string }>(
        "POST",
        `/v1/apps/${appId}/test-push`,
        input,
      ),
  };

  readonly segments = {
    list: (appId: string) =>
      this.request<{ segments: SegmentSummary[] }>("GET", `/v1/apps/${appId}/segments`),
    get: (appId: string, id: string) =>
      this.request<SegmentDetail>("GET", `/v1/apps/${appId}/segments/${id}`),
    create: (appId: string, input: { name: string; definition: unknown }) =>
      this.request<{ id: string }>("POST", `/v1/apps/${appId}/segments`, input),
    update: (appId: string, id: string, input: { name: string; definition: unknown }) =>
      this.request<{ ok: true }>("PATCH", `/v1/apps/${appId}/segments/${id}`, input),
    remove: (appId: string, id: string) =>
      this.request<{ ok: true }>("DELETE", `/v1/apps/${appId}/segments/${id}`),
    preview: (appId: string, input: { definition: unknown; category?: string }) =>
      this.request<SegmentPreview>("POST", `/v1/apps/${appId}/segments/preview`, input),
  };

  readonly journeys = {
    list: (appId: string) =>
      this.request<{ journeys: JourneySummary[] }>("GET", `/v1/apps/${appId}/journeys`),
    get: (appId: string, id: string) =>
      this.request<JourneyDetail>("GET", `/v1/apps/${appId}/journeys/${id}`),
    create: (appId: string, input: { name: string; definition: unknown }) =>
      this.request<{ id: string }>("POST", `/v1/apps/${appId}/journeys`, input),
    update: (appId: string, id: string, input: { name: string; definition: unknown }) =>
      this.request<{ ok: true }>("PATCH", `/v1/apps/${appId}/journeys/${id}`, input),
    validate: (appId: string, id: string) =>
      this.request<JourneyValidation>("POST", `/v1/apps/${appId}/journeys/${id}/validate`),
    activate: (appId: string, id: string) =>
      this.request<{ version: number; entry: string; audience_ref?: string }>(
        "POST",
        `/v1/apps/${appId}/journeys/${id}/activate`,
      ),
    pause: (appId: string, id: string) =>
      this.request<{ ok: true }>("POST", `/v1/apps/${appId}/journeys/${id}/pause`),
    archive: (appId: string, id: string) =>
      this.request<{ ok: true }>("DELETE", `/v1/apps/${appId}/journeys/${id}`),
  };

  readonly analytics = {
    dashboard: (appId: string) =>
      this.request<DashboardData>("GET", `/v1/apps/${appId}/dashboard`),
    journeyReport: (appId: string, id: string) =>
      this.request<JourneyReport>("GET", `/v1/apps/${appId}/journeys/${id}/report`),
    usage: (appId: string) => this.request<UsageData>("GET", `/v1/apps/${appId}/usage`),
  };

  readonly appSettings = {
    get: (appId: string) => this.request<AppSettings>("GET", `/v1/apps/${appId}/settings`),
    update: (appId: string, input: AppSettings) =>
      this.request<{ ok: true }>("PUT", `/v1/apps/${appId}/settings`, input),
  };

  readonly messageLog = {
    list: (appId: string, params?: { status?: string; journey_id?: string; limit?: number }) => {
      const q = new URLSearchParams();
      if (params?.status) q.set("status", params.status);
      if (params?.journey_id) q.set("journey_id", params.journey_id);
      if (params?.limit) q.set("limit", String(params.limit));
      const qs = q.toString();
      return this.request<MessageLogResponse>(
        "GET",
        `/v1/apps/${appId}/message-log${qs ? `?${qs}` : ""}`,
      );
    },
  };

  readonly users = {
    search: (appId: string, q: string) =>
      this.request<{ users: UserSearchResult[] }>(
        "GET",
        `/v1/apps/${appId}/users?q=${encodeURIComponent(q)}`,
      ),
    detail: (appId: string, id: string) =>
      this.request<UserDetail>("GET", `/v1/apps/${appId}/users/${id}`),
  };

  readonly credentials = {
    list: (appId: string) =>
      this.request<{ credentials: CredentialSummary[] }>(
        "GET",
        `/v1/apps/${appId}/credentials`,
      ),
    upsert: (appId: string, input: FcmCredentialInput | ApnsCredentialInput) =>
      this.request<{ id: string; kind: string; status: string }>(
        "PUT",
        `/v1/apps/${appId}/credentials`,
        input,
      ),
    remove: (appId: string, kind: "push_fcm" | "push_apns") =>
      this.request<{ ok: true }>("DELETE", `/v1/apps/${appId}/credentials/${kind}`),
  };
}

export interface AppSummary {
  id: string;
  name: string;
  timezone: string;
  created_at: string;
}

export interface ApiKeySummary {
  id: string;
  kind: "sdk" | "server";
  scope: "full" | "ingest_only";
  prefix: string;
  status: "active" | "rotating" | "revoked";
  grace_expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface IngestStatus {
  events_total: number;
  last_event_at: string | null;
}

export interface CredentialSummary {
  id: string;
  kind: "push_fcm" | "push_apns";
  status: "unverified" | "verified" | "error";
  status_detail: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SegmentSummary {
  id: string;
  name: string;
  status: "active" | "broken";
  status_detail: string | null;
  last_count: number | null;
  last_evaluated_at: string | null;
  updated_at: string;
}

export interface SegmentDetail {
  id: string;
  name: string;
  definition: unknown;
  status: "active" | "broken";
  status_detail: string | null;
  last_count: number | null;
  updated_at: string;
}

export interface SegmentPreview {
  approx_count: number;
  sample: Array<{ user_id: string; external_id: string | null; platforms: string[] }>;
}

export interface JourneySummary {
  id: string;
  name: string;
  status: "draft" | "active" | "paused" | "archived";
  category: "marketing" | "transactional";
  active_version: number | null;
  updated_at: string;
}

export interface JourneyDetail extends JourneySummary {
  draft_definition: unknown;
}

export interface JourneyValidation {
  issues: Array<{ level: "error" | "warning"; message: string; node_index?: number }>;
  estimated_count: number | null;
}

export interface DashboardData {
  today: { sent: number; failed: number; skipped: number; by_status: Record<string, number> };
  active_journeys: number;
}

export interface JourneyReport {
  name: string;
  status: string;
  state_distribution: Record<string, number>;
  sends: Array<{ status: string; node_index: number; count: number }>;
}

export interface UsageData {
  mau_30d: number;
  sends_30d: Array<{ channel: string; sent: number }>;
}

export interface AppSettings {
  timezone: string;
  quiet_hours: {
    enabled: boolean;
    start: string;
    end: string;
    policy: "delay_until_open" | "skip";
  };
  frequency_cap: { enabled: boolean; max_per_24h: number };
}

export interface MessageLogEntry {
  message_id: string;
  idempotency_key: string;
  journey_id: string;
  journey_version: number;
  node_index: number;
  campaign_ref: string;
  user_id: string;
  device_id: string;
  channel: string;
  status: string;
  failure_class: string;
  failure_detail: string;
  sent_at: string;
}

export interface MessageLogResponse {
  messages: MessageLogEntry[];
  recent_hour: { total: number; failed: number; failure_rate: number };
}

export interface UserSearchResult {
  id: string;
  external_id: string | null;
  email: string | null;
  status: string;
  last_seen_at: string | null;
}

export interface UserDetail {
  user: {
    id: string;
    external_id: string | null;
    std_attrs: Record<string, unknown>;
    custom_attrs: Record<string, unknown>;
    subscriptions: Record<string, unknown>;
    status: string;
    last_seen_at: string | null;
    created_at: string;
  };
  devices: Array<{
    id: string;
    platform: string;
    token_status: string;
    os_permission: string;
    has_token: boolean;
    device_meta: Record<string, unknown>;
    last_active_at: string | null;
    updated_at: string;
  }>;
  journeys: Array<{
    journey_id: string;
    name: string;
    journey_version: number;
    current_node: number;
    status: string;
    next_wake_at: string | null;
    entered_at: string;
  }>;
  events: Array<{ event_name: string; ts: string }>;
  messages: Array<{
    channel: string;
    status: string;
    failure_class: string;
    failure_detail: string;
    journey_id: string;
    sent_at: string;
  }>;
}

export interface FcmCredentialInput {
  kind: "push_fcm";
  service_account: Record<string, unknown>;
}

export interface ApnsCredentialInput {
  kind: "push_apns";
  p8: string;
  key_id: string;
  team_id: string;
  bundle_id: string;
  environment?: "production" | "sandbox";
}
