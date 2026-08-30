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
}
