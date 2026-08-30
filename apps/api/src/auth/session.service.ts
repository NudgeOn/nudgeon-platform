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
      `SELECT s.tenant_id, m.id AS member_id, m.email, m.name, m.role
         FROM sessions s
         JOIN members m ON m.id = s.member_id AND m.status = 'active'
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
    };
  }

  async revoke(token: string): Promise<void> {
    await this.pg.query(
      `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
