import { describe, expect, it } from "vitest";
import { can, permissionsForRole, ROLE_PERMISSIONS, type Permission, type Role } from "./permissions";

/** 매트릭스 표 주도 테스트 (DEV-sub-09 §9, PRD-05 §4 수용 기준 회귀). */
describe("RBAC 권한 매트릭스", () => {
  // PRD-05 §4 핵심 경계 — (역할, 권한) → 기대 허용 여부.
  const cases: Array<[Role, Permission, boolean]> = [
    // Editor 접근 불가 (크리덴셜·API 키·팀)
    ["editor", "credentials:write", false],
    ["editor", "credentials:read", false],
    ["editor", "apikeys:write", false],
    ["editor", "team:write", false],
    // Editor 허용 (세그먼트·저니 작성/실행)
    ["editor", "segments:write", true],
    ["editor", "journeys:write", true],
    ["editor", "journeys:activate", true],
    // Viewer 조회만
    ["viewer", "segments:read", true],
    ["viewer", "segments:write", false],
    ["viewer", "journeys:activate", false],
    // Admin 전부(빌링·삭제 제외)
    ["admin", "credentials:write", true],
    ["admin", "team:write", true],
    ["admin", "member:reset_2fa", true],
    ["admin", "billing:manage", false],
    ["admin", "tenant:delete", false],
    // Owner 전용
    ["owner", "billing:manage", true],
    ["owner", "tenant:delete", true],
  ];

  it.each(cases)("%s → %s = %s", (role, perm, expected) => {
    expect(can(role, perm)).toBe(expected);
  });

  it("미지의 역할은 전부 거부", () => {
    expect(can("superuser", "segments:read")).toBe(false);
    expect(permissionsForRole("superuser")).toEqual([]);
  });

  it("역할 위계: viewer ⊂ editor ⊂ admin ⊂ owner", () => {
    const chain: Role[] = ["viewer", "editor", "admin", "owner"];
    for (let i = 1; i < chain.length; i++) {
      const lower = new Set(ROLE_PERMISSIONS[chain[i - 1]!]);
      const higher = new Set(ROLE_PERMISSIONS[chain[i]!]);
      for (const p of lower) expect(higher.has(p)).toBe(true);
    }
  });

  it("permissionsForRole는 역할 권한 전체를 반환", () => {
    expect(permissionsForRole("viewer")).toContain("users:read");
    expect(permissionsForRole("owner")).toContain("tenant:delete");
  });
});
