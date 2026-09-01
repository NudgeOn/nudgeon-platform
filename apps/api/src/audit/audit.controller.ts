import { Controller, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";
import type { Pool } from "pg";
import { PG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";

/** 감사 로그 조회 (Admin/Owner) — DEV-sub-07 T-9. 테넌트 격리 필수. */
@Controller("v1/audit")
@UseGuards(SessionGuard, PermissionGuard)
export class AuditController {
  constructor(@Inject(PG) private readonly pg: Pool) {}

  @Get()
  @RequirePermission("team:read")
  async list(@Req() req: SessionRequest, @Query("limit") limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const { rows } = await this.pg.query(
      `SELECT id, actor_member_id, actor_email, action, target_type, target_id, detail, ip, created_at
         FROM audit_logs
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.member.tenantId, n],
    );
    return { entries: rows };
  }
}
