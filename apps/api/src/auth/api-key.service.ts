import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { PG } from "../infra/infra.module";

export type ApiKeyKind = "sdk" | "server";
export type ApiKeyScope = "full" | "ingest_only";

export interface ResolvedApiKey {
  id: string;
  tenantId: string;
  appId: string;
  kind: ApiKeyKind;
  scope: ApiKeyScope;
}

/** `pk_`/`sk_` + 랜덤 32B. 저장은 SHA-256 해시만 (PRD-06 3장) */
export function generateApiKey(kind: ApiKeyKind): { key: string; hash: string; prefix: string } {
  const raw = randomBytes(32).toString("base64url");
  const key = `${kind === "sdk" ? "pk" : "sk"}_${raw}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 11) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

@Injectable()
export class ApiKeyService {
  constructor(@Inject(PG) private readonly pg: Pool) {}

  /**
   * 키 원문 → 유효 키 해석. 무효/폐기/유예 만료는 null.
   * 회전 유예(rotating): grace_expires_at 전까지 병행 유효 (PRD-06 3장).
   */
  async resolve(rawKey: string): Promise<ResolvedApiKey | null> {
    if (!/^(pk|sk)_[A-Za-z0-9_-]{20,}$/.test(rawKey)) return null;
    const { rows } = await this.pg.query(
      `SELECT id, tenant_id, app_id, kind, scope, status, grace_expires_at
         FROM api_keys
        WHERE key_hash = $1`,
      [hashApiKey(rawKey)],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.status === "revoked") return null;
    if (
      row.status === "rotating" &&
      row.grace_expires_at &&
      new Date(row.grace_expires_at).getTime() < Date.now()
    ) {
      return null;
    }
    // 마지막 사용 시각 — 응답 지연에 얹지 않음 (fire-and-forget)
    void this.pg
      .query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id])
      .catch(() => undefined);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      appId: row.app_id,
      kind: row.kind,
      scope: row.scope,
    };
  }
}
