/**
 * RBAC 권한 매트릭스 — 단일 출처 (DEV-sub-09 §2·§3, PRD-05 §4).
 * 가드·테스트·(콘솔 게이팅)이 이 매핑을 공유한다. deny-by-default.
 */

export type Role = "owner" | "admin" | "editor" | "viewer";

export type Permission =
  | "segments:read"
  | "segments:write"
  | "journeys:read"
  | "journeys:write"
  | "journeys:activate"
  | "credentials:read"
  | "credentials:write"
  | "apikeys:read"
  | "apikeys:write"
  | "apps:read"
  | "apps:write"
  | "team:read"
  | "team:write"
  | "settings:write"
  | "billing:manage"
  | "tenant:delete"
  | "member:reset_2fa"
  | "users:read"
  | "analytics:read";

/** 전 리소스 조회 권한 (Viewer 기준선). */
const READ_ALL: Permission[] = [
  "segments:read",
  "journeys:read",
  "apps:read",
  "users:read",
  "analytics:read",
];

/** Editor = 조회 + 세그먼트·저니 작성/실행 (크리덴셜·키·팀 제외). */
const EDITOR: Permission[] = [
  ...READ_ALL,
  "segments:write",
  "journeys:write",
  "journeys:activate",
];

/** Admin = 전부 (빌링·테넌트 삭제 제외). */
const ADMIN: Permission[] = [
  ...EDITOR,
  "credentials:read",
  "credentials:write",
  "apikeys:read",
  "apikeys:write",
  "apps:write",
  "team:read",
  "team:write",
  "settings:write",
  "member:reset_2fa",
];

/** Owner = Admin + 빌링·테넌트 삭제. */
const OWNER: Permission[] = [...ADMIN, "billing:manage", "tenant:delete"];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  viewer: READ_ALL,
  editor: EDITOR,
  admin: ADMIN,
  owner: OWNER,
};

const KNOWN_ROLES = new Set<Role>(["owner", "admin", "editor", "viewer"]);

export function isRole(value: string): value is Role {
  return KNOWN_ROLES.has(value as Role);
}

/** 역할이 권한을 보유하는지 — 미지의 역할/권한은 거부. */
export function can(role: string, perm: Permission): boolean {
  if (!isRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(perm);
}

/** 역할의 전 권한 목록 (콘솔 게이팅용 — /v1/auth/me 노출). */
export function permissionsForRole(role: string): Permission[] {
  return isRole(role) ? [...ROLE_PERMISSIONS[role]] : [];
}
