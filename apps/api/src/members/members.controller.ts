import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";
import { AuditService } from "../audit/audit.service";
import { MembersService } from "./members.service";
import type { Role } from "../authz/permissions";

const roleSchema = z.enum(["owner", "admin", "editor", "viewer"]);
const createSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  role: roleSchema,
  password: z.string().min(8).max(128),
});
const changeRoleSchema = z.object({ role: roleSchema });

/** 팀 멤버 관리 (R-16). team:read 조회 / team:write 생성·역할변경·삭제. */
@Controller("v1/members")
@UseGuards(SessionGuard, PermissionGuard)
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission("team:read")
  async list(@Req() req: SessionRequest) {
    return { members: await this.members.list(req.member.tenantId) };
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("team:write")
  async create(@Body() body: unknown, @Req() req: SessionRequest) {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const created = await this.members.create(req.member.tenantId, req.member.role, {
      email: parsed.data.email,
      name: parsed.data.name,
      role: parsed.data.role as Role,
      password: parsed.data.password,
    });
    await this.audit.recordAs(req.member, req.ip, "member.create", {
      targetType: "member",
      targetId: created.id,
      detail: { email: created.email, role: created.role },
    });
    return created;
  }

  @Patch(":memberId/role")
  @HttpCode(200)
  @RequirePermission("team:write")
  async changeRole(
    @Param("memberId", ParseUUIDPipe) memberId: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    const parsed = changeRoleSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const result = await this.members.changeRole(
      req.member.tenantId,
      req.member.role,
      memberId,
      parsed.data.role as Role,
    );
    await this.audit.recordAs(req.member, req.ip, "member.role_change", {
      targetType: "member",
      targetId: memberId,
      detail: { role: parsed.data.role, sessions_revoked: result.revoked },
    });
    return result;
  }

  @Delete(":memberId")
  @HttpCode(200)
  @RequirePermission("team:write")
  async remove(
    @Param("memberId", ParseUUIDPipe) memberId: string,
    @Req() req: SessionRequest,
  ) {
    const result = await this.members.remove(
      req.member.tenantId,
      req.member.role,
      req.member.memberId,
      memberId,
    );
    await this.audit.recordAs(req.member, req.ip, "member.remove", {
      targetType: "member",
      targetId: memberId,
      detail: { sessions_revoked: result.revoked },
    });
    return result;
  }
}
