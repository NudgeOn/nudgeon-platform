import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Pool } from "pg";
import { CONFIG, PG } from "../infra/infra.module";
import { ShutdownState } from "../infra/shutdown-state";
import type { AppConfig } from "../config";
import { CapacityMetrics } from "../infra/capacity-metrics";
import { ApiKeyUsage } from "./api-key-usage";

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
  private readonly usage: ApiKeyUsage;
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(ShutdownState) shutdown: ShutdownState,
    @Optional() @Inject(CapacityMetrics) metrics?: CapacityMetrics,
    @Optional() @Inject(CONFIG) cfg?: AppConfig,
  ) { this.usage = new ApiKeyUsage(pg, shutdown, cfg?.apiKeyUsageCoalesceEnabled ?? false, metrics); }

  /**
   * 키 원문 → 유효 키 해석. 무효/폐기/유예 만료는 null.
   * 회전 유예(rotating): grace_expires_at 전까지 병행 유효 (PRD-06 3장).
   */
  async resolve(rawKey: string): Promise<ResolvedApiKey | null> {
    if (!/^(pk|sk)_[A-Za-z0-9_-]{20,}$/.test(rawKey)) return null;
    const { rows } = await this.pg.query(
      `SELECT id, tenant_id, app_id, kind, scope, status, grace_expires_at,
              (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') AS usage_due
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
    const resolved: ResolvedApiKey = {
      id: row.id,
      tenantId: row.tenant_id,
      appId: row.app_id,
      kind: row.kind,
      scope: row.scope,
    };
    // Always perform the DB validity check above, including after a recent touch.
    // Only last_used_at writes may be coalesced; authorization is never cached.
    this.usage.record(resolved, row.usage_due === true);
    return resolved;
  }
}
