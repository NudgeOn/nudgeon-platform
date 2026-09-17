export type InAppAction =
  | { type: "dismiss" }
  | { type: "deep_link" | "open_url"; url: string }
  | { type: "copy"; text: string };
export interface InAppManifest {
  format_version: 1;
  entrypoint: "index.html";
  bridge_version: 1;
  display: {
    type: "modal" | "fullscreen" | "bottom" | "transparent";
    backdrop_opacity: number;
  };
  actions: Record<string, InAppAction>;
}
export interface InAppFile {
  path: string;
  base64: string;
}
export interface InAppRevision {
  id: string;
  name: string;
  artifact_sha256: string;
  manifest: InAppManifest;
  source_bytes?: number;
  created_at?: string;
}
export interface InAppDevice {
  id: string;
  label: string | null;
  platform: "ios" | "android" | null;
  sdk_version: string | null;
  state: "waiting" | "claimed" | "active" | "revoked";
  confirmation_code: string;
  expires_at: string;
  last_seen_at: string | null;
}
export interface InAppRun {
  id: string;
  revision_id: string;
  device_id: string;
  state:
    | "queued"
    | "preparing"
    | "presented"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired";
  error_code: string | null;
  retry_of: string | null;
  created_at: string;
  label: string;
  platform: string;
  name: string;
}
type Request = <T>(method: string, path: string, body?: unknown) => Promise<T>;
export function inAppClient(request: Request) {
  const path = (app: string) => `/v1/apps/${encodeURIComponent(app)}/in-app`;
  return {
    status: (app: string) =>
      request<{
        enabled: boolean;
        campaigns_enabled: boolean;
        content_origin: string;
        format_version: number;
      }>("GET", `${path(app)}/status`),
    list: (app: string) =>
      request<{ revisions: InAppRevision[] }>("GET", `${path(app)}/revisions`),
    create: (
      app: string,
      input: {
        name: string;
        files?: InAppFile[];
        archive_base64?: string;
        manifest?: InAppManifest;
      },
    ) => request<InAppRevision>("POST", `${path(app)}/revisions`, input),
    get: (app: string, id: string) =>
      request<
        Pick<InAppRevision, "id" | "manifest" | "artifact_sha256"> & {
          files: InAppFile[];
        }
      >("GET", `${path(app)}/revisions/${id}`),
    preview: (app: string, id: string) =>
      request<{ url: string; expires_at: string }>(
        "POST",
        `${path(app)}/revisions/${id}/preview`,
        {},
      ),
    devices: (app: string) =>
      request<{ devices: InAppDevice[] }>("GET", `${path(app)}/devices`),
    pair: (app: string) =>
      request<{
        id: string;
        token: string;
        confirmation_code: string;
        expires_at: string;
      }>("POST", `${path(app)}/pairings`, {}),
    confirm: (app: string, id: string) =>
      request<{ ok: true }>("POST", `${path(app)}/devices/${id}/confirm`, {}),
    revoke: (app: string, id: string) =>
      request<{ ok: true }>("POST", `${path(app)}/devices/${id}/revoke`, {}),
    runs: (app: string) =>
      request<{ runs: InAppRun[] }>("GET", `${path(app)}/runs`),
    run: (
      app: string,
      input: {
        revision_id: string;
        device_id: string;
        request_key: string;
        retry_of?: string;
      },
    ) => request<InAppRun>("POST", `${path(app)}/runs`, input),
    events: (app: string, id: string) =>
      request<{
        events: Array<{
          event_id: string;
          kind: string;
          detail: string;
          created_at: string;
        }>;
      }>("GET", `${path(app)}/runs/${id}/events`),
    cancel: (app: string, id: string) =>
      request<{ ok: true }>("POST", `${path(app)}/runs/${id}/cancel`, {}),
  };
}
