export type McpScope = "mcp:read" | "mcp:drafts:write" | "mcp:customers:read";
export type McpConsentInput = { approve: false } | { approve: true; app_id: string; scopes: McpScope[] };

export interface McpConnection {
  id: string;
  app_id: string;
  app_name: string;
  client_name: string;
  client_id: string;
  member_id: string;
  member_email: string;
  scopes: McpScope[];
  customer_access_approved: boolean;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface McpAuthorization {
  client_name: string;
  client_id: string;
  redirect_uri: string;
  client_verified: false;
  requested_scopes: McpScope[];
  apps: Array<{ id: string; name: string }>;
  expires_at: string;
}

export interface SegmentDraft {
  id: string;
  name: string;
  definition: unknown;
  revision: number;
  promoted_segment_id: string | null;
  created_at: string;
  updated_at: string;
}

type Request = <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<T>;
const part = encodeURIComponent;

export function mcpClient(request: Request) {
  return {
    status: () => request<{ enabled: boolean; endpoint: string }>("GET", "/v1/mcp/status"),
    connections: () => request<{ connections: McpConnection[] }>("GET", "/v1/mcp/connections"),
    revoke: (id: string) => request<{ ok: true }>("DELETE", `/v1/mcp/connections/${part(id)}`),
    approveCustomerAccess: (id: string, approved: boolean) =>
      request<{ ok: true }>("PATCH", `/v1/mcp/connections/${part(id)}`, { customer_access_approved: approved }),
    authorization: (requestId: string) =>
      request<McpAuthorization>("GET", `/v1/mcp/authorization/${part(requestId)}`),
    authorize: (requestId: string, input: McpConsentInput) =>
      request<{ redirect_uri: string }>("POST", `/v1/mcp/authorization/${part(requestId)}`, input),
  };
}

export function segmentDraftClient(request: Request) {
  const base = (appId: string) => `/v1/apps/${part(appId)}/segment-drafts`;
  return {
    list: (appId: string) => request<{ drafts: SegmentDraft[] }>("GET", base(appId)),
    get: (appId: string, id: string) => request<SegmentDraft>("GET", `${base(appId)}/${part(id)}`),
    create: (appId: string, input: { name: string; definition: unknown; request_id?: string }) =>
      request<SegmentDraft>("POST", base(appId), input),
    update: (appId: string, id: string, input: { name: string; definition: unknown; expected_revision: number }) =>
      request<SegmentDraft>("PATCH", `${base(appId)}/${part(id)}`, input),
    preview: (appId: string, id: string) =>
      request<{ approx_count: number; revision: number }>("POST", `${base(appId)}/${part(id)}/preview`),
    promote: (appId: string, id: string, expected_revision: number) =>
      request<{ segment_id: string; draft_id: string }>("POST", `${base(appId)}/${part(id)}/promote`, { expected_revision }),
  };
}
