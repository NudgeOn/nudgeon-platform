import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Pool } from "pg";
import { z } from "zod";
import { PG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";
import { AuditService } from "../audit/audit.service";

const securitySchema = z.object({ require_2fa: z.boolean() });

/** 테넌트 조직 설정 (보안 정책) — DEV-sub-07 T-5. */
@Controller("v1/tenant")
@UseGuards(SessionGuard, PermissionGuard)
export class TenantController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async get(@Req() req: SessionRequest) {
    const { rows } = await this.pg.query(
      `SELECT name, require_2fa, delete_requested_at, purge_after FROM tenants WHERE id = $1`,
      [req.member.tenantId],
    );
    const t = rows[0];
    return {
      name: t?.name ?? null,
      require_2fa: t?.require_2fa ?? false,
      delete_requested_at: t?.delete_requested_at ?? null,
      purge_after: t?.purge_after ?? null,
    };
  }

  /** 테넌트 삭제 요청 — 7일 유예(복구 가능) 후 워커가 파기 (T-10). Owner만. */
  @Delete()
  @HttpCode(202)
  @RequirePermission("tenant:delete")
  async requestDeletion(@Req() req: SessionRequest) {
    const { rows } = await this.pg.query(
      `UPDATE tenants
          SET delete_requested_at = COALESCE(delete_requested_at, now()),
              purge_after = COALESCE(purge_after, now() + interval '7 days'),
              updated_at = now()
        WHERE id = $1
        RETURNING purge_after`,
      [req.member.tenantId],
    );
    await this.audit.recordAs(req.member, req.ip, "tenant.delete_requested", {
      targetType: "tenant",
      targetId: req.member.tenantId,
      detail: { purge_after: rows[0]?.purge_after },
    });
    return { ok: true as const, purge_after: rows[0]?.purge_after ?? null };
  }

  /** 삭제 취소 — 유예 기간 내 복구 (T-10). Owner만. */
  @Post("restore")
  @HttpCode(200)
  @RequirePermission("tenant:delete")
  async restore(@Req() req: SessionRequest) {
    await this.pg.query(
      `UPDATE tenants SET delete_requested_at = NULL, purge_after = NULL, updated_at = now()
        WHERE id = $1`,
      [req.member.tenantId],
    );
    await this.audit.recordAs(req.member, req.ip, "tenant.delete_cancelled", {
      targetType: "tenant",
      targetId: req.member.tenantId,
    });
    return { ok: true as const };
  }

  /** 조직 전체 2FA 강제 on/off (Admin/Owner). 켜면 미등록 멤버는 다음 요청부터 등록 강제. */
  @Put("security")
  @RequirePermission("team:write")
  async setSecurity(@Body() body: unknown, @Req() req: SessionRequest) {
    const parsed = securitySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.pg.query(
      `UPDATE tenants SET require_2fa = $2, updated_at = now() WHERE id = $1`,
      [req.member.tenantId, parsed.data.require_2fa],
    );
    await this.audit.recordAs(req.member, req.ip, "tenant.require_2fa", {
      targetType: "tenant",
      targetId: req.member.tenantId,
      detail: { require_2fa: parsed.data.require_2fa },
    });
    return { ok: true as const, require_2fa: parsed.data.require_2fa };
  }
}
