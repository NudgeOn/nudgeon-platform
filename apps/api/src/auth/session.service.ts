import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { CONFIG, PG } from "../infra/infra.module";
import type { AppConfig } from "../config";

export interface SessionMember {
  memberId: string;
  tenantId: string;
  email: string;
  name: string;
  role: string;
  /** 2FA 등록 여부 + 테넌트 강제 정책 — 등록 강제 게이트(T-5)에서 사용 */
  totpEnabled: boolean;
  requires2fa: boolean;
}

/**
 * DB 세션 (ADR-8: JWT 비채택 — 즉시 폐기 요건).
 * 토큰 원문은 쿠키로만 전달, 저장은 SHA-256 해시.
 * TODO(S2): Redis 캐시 계층 추가 (조회 경로 최적화).
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  async create(tenantId: string, memberId: string, meta: { ip?: string; userAgent?: string }) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.cfg.sessionTtlHours * 3600_000);
    await this.pg.query(
      `INSERT INTO sessions (tenant_id, member_id, token_hash, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, memberId, hashToken(token), meta.ip ?? null, meta.userAgent ?? null, expiresAt],
    );
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<SessionMember | null> {
    if (!token) return null;
    const { rows } = await this.pg.query(
      `SELECT s.tenant_id, m.id AS member_id, m.email, m.name, m.role,
              (m.totp_enabled_at IS NOT NULL) AS totp_enabled,
              COALESCE(t.require_2fa, false) AS requires_2fa
         FROM sessions s
         JOIN members m ON m.id = s.member_id AND m.status = 'active'
         JOIN tenants t ON t.id = s.tenant_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      memberId: row.member_id,
      tenantId: row.tenant_id,
      email: row.email,
      name: row.name,
      role: row.role,
      totpEnabled: row.totp_enabled,
      requires2fa: row.requires_2fa,
    };
  }

  async revoke(token: string): Promise<void> {
    await this.pg.query(
      `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
  }

  /**
   * 멤버의 활성 세션 일괄 폐기 (R-09: 2FA 리셋/해제 시 세션 정책).
   * tenant_id를 함께 필터해 테넌트 경계를 강제한다(멤버 UUID는 전역 유일하지만 격리 불변식 준수).
   * exceptToken 지정 시 해당 세션(보통 요청자 본인)은 유지한다. resolve가 매 요청
   * PG를 조회하므로(Redis 캐시 미사용) 폐기는 즉시 반영된다. 반환값=폐기된 세션 수.
   */
  async revokeAllForMember(tenantId: string, memberId: string, exceptToken?: string): Promise<number> {
    const params: unknown[] = [tenantId, memberId];
    let sql = `UPDATE sessions SET revoked_at = now()
                WHERE tenant_id = $1 AND member_id = $2 AND revoked_at IS NULL`;
    if (exceptToken) {
      params.push(hashToken(exceptToken));
      sql += ` AND token_hash <> $3`;
    }
    const { rowCount } = await this.pg.query(sql, params);
    return rowCount ?? 0;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
