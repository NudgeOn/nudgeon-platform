import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { can, type Permission } from "../authz/permissions";

export interface DraftActor { tenantId: string; memberId: string; role: string; email?: string }
export type DraftDatabase = Pick<Pool, "query">;

export async function assertDraftAccess(db: DraftDatabase, actor: DraftActor, appId: string, permission: Permission) {
  if (!can(actor.role, permission)) throw new ForbiddenException(`권한 없음: ${permission}`);
  const found = await db.query("SELECT 1 FROM apps WHERE tenant_id = $1 AND id = $2", [actor.tenantId, appId]);
  if (!found.rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");
}

export function parseDraft<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

export async function createDraftOnce<T>(
  pg: Pool, actor: DraftActor, appId: string, kind: "segment" | "journey", body: unknown,
  requestId: string | undefined, create: (db: PoolClient) => Promise<T>,
): Promise<T> {
  if (requestId !== undefined) requestId = parseDraft(z.string().uuid(), requestId).toLowerCase();
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex");
  const db = await pg.connect();
  try {
    await db.query("BEGIN");
    if (requestId) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `draft:${actor.tenantId}:${appId}:${actor.memberId}:${kind}:${requestId}`,
      ]);
      const existing = await db.query(
        `SELECT fingerprint, result FROM draft_create_requests
          WHERE tenant_id=$1 AND app_id=$2 AND actor_member_id=$3 AND kind=$4 AND request_id=$5`,
        [actor.tenantId, appId, actor.memberId, kind, requestId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].fingerprint !== fingerprint) throw new ConflictException("REQUEST_ID_REUSED");
        await db.query("COMMIT");
        return existing.rows[0].result as T;
      }
    }
    const result = await create(db);
    if (requestId) await db.query(
      `INSERT INTO draft_create_requests(tenant_id,app_id,actor_member_id,kind,request_id,fingerprint,result)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [actor.tenantId, appId, actor.memberId, kind, requestId, fingerprint, JSON.stringify(result)],
    );
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") throw new ConflictException("NAME_ALREADY_EXISTS");
    throw error;
  } finally { db.release(); }
}

export async function recordDraftAudit(db: DraftDatabase, actor: DraftActor, appId: string, action: string, id: string) {
  await db.query(
    `INSERT INTO audit_logs(tenant_id,actor_member_id,actor_email,action,target_type,target_id,detail)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [actor.tenantId, actor.memberId, actor.email ?? null, action, action.split(".")[0], id, JSON.stringify({ app_id: appId })],
  );
}
