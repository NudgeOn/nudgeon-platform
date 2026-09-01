import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { SessionGuard, type SessionRequest } from "./session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";
import { TotpService } from "./totp.service";
import { AuditService } from "../audit/audit.service";

/** 6자리 TOTP 또는 백업 코드(XXXXX-XXXXX) 모두 허용. */
const codeSchema = z.object({ code: z.string().min(6).max(20) });

function parseCode(body: unknown): string {
  const parsed = codeSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data.code;
}

/** 본인 2FA 관리 (콘솔 설정 — 세션 인증) */
@Controller("v1/auth/totp")
@UseGuards(SessionGuard)
export class TotpController {
  constructor(
    private readonly totp: TotpService,
    private readonly audit: AuditService,
  ) {}

  @Get("status")
  status(@Req() req: SessionRequest) {
    return this.totp.status(req.member.tenantId, req.member.memberId);
  }

  /** 등록 시작 — otpauth URI + base32 시크릿 반환(1회) */
  @Post("enroll")
  @HttpCode(200)
  enroll(@Req() req: SessionRequest) {
    return this.totp.startEnrollment(req.member.tenantId, req.member.memberId, req.member.email);
  }

  /** 등록 확인 — 코드 검증 후 활성화 + 백업코드 반환(1회) */
  @Post("enroll/verify")
  @HttpCode(200)
  async confirm(@Body() body: unknown, @Req() req: SessionRequest) {
    const result = await this.totp.confirmEnrollment(
      req.member.tenantId,
      req.member.memberId,
      parseCode(body),
    );
    await this.audit.recordAs(req.member, req.ip, "member.totp_enable", {
      targetType: "member",
      targetId: req.member.memberId,
    });
    return result;
  }

  /** 본인 2FA 해제 — 코드 재인증 */
  @Post("disable")
  @HttpCode(200)
  async disable(@Body() body: unknown, @Req() req: SessionRequest) {
    const currentToken = (req.cookies?.["onda_session"] as string | undefined) ?? undefined;
    const result = await this.totp.disable(
      req.member.tenantId,
      req.member.memberId,
      parseCode(body),
      currentToken,
    );
    await this.audit.recordAs(req.member, req.ip, "member.totp_disable", {
      targetType: "member",
      targetId: req.member.memberId,
    });
    return result;
  }
}

/** 관리자 2FA 리셋 (분실 복구) — member:reset_2fa 권한 필요 (Owner/Admin) */
@Controller("v1/members")
@UseGuards(SessionGuard, PermissionGuard)
export class MemberTotpController {
  constructor(
    private readonly totp: TotpService,
    private readonly audit: AuditService,
  ) {}

  @Post(":memberId/totp/reset")
  @HttpCode(200)
  @RequirePermission("member:reset_2fa")
  async reset(
    @Param("memberId", ParseUUIDPipe) memberId: string,
    @Req() req: SessionRequest,
  ) {
    const result = await this.totp.resetForMember(req.member.tenantId, memberId);
    await this.audit.recordAs(req.member, req.ip, "member.totp_reset", {
      targetType: "member",
      targetId: memberId,
    });
    return result;
  }
}
