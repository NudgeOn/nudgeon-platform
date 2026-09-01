import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { CONFIG } from "../infra/infra.module";
import type { AppConfig } from "../config";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";
import { TotpService } from "./totp.service";
import { permissionsForRole } from "../authz/permissions";

const COOKIE = "onda_session";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100),
  tenant_name: z.string().min(1).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // 2FA 활성 계정의 2단계 — 6자리 TOTP 또는 백업 코드
  totp: z.string().min(6).max(20).optional(),
});

@Controller("v1/auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly totp: TotpService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Post("signup")
  async signup(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = signupSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const result = await this.auth.signup({
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.name,
      tenantName: parsed.data.tenant_name,
    });
    await this.issueSession(result.tenantId, result.memberId, req, res);
    return {
      tenant_id: result.tenantId,
      app_id: result.appId,
      sdk_key: result.sdkKey,
      server_key: result.serverKey,
    };
  }

  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const { memberId, tenantId, totpEnabled, requires2fa } = await this.auth.verifyLogin(
      parsed.data.email,
      parsed.data.password,
    );
    // 2FA 활성 계정 — 비밀번호만으로는 세션을 발급하지 않는다 (PRD-06 2.1)
    if (totpEnabled) {
      if (!parsed.data.totp) return { totp_required: true };
      const ok = await this.totp.verifyForLogin(memberId, parsed.data.totp);
      if (!ok) throw new UnauthorizedException("2FA 코드가 올바르지 않습니다");
      await this.issueSession(tenantId, memberId, req, res);
      return { ok: true };
    }
    // 미등록 + 조직 2FA 강제(T-5) — 세션은 발급하되(등록을 위해) 등록 화면으로 강제.
    // SessionGuard가 등록 완료 전까지 /v1/auth/totp 외 모든 접근을 차단한다.
    if (requires2fa) {
      await this.issueSession(tenantId, memberId, req, res);
      return { enrollment_required: true };
    }
    await this.issueSession(tenantId, memberId, req, res);
    return { ok: true };
  }

  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies?.[COOKIE] as string | undefined) ?? "";
    if (token) await this.sessions.revoke(token);
    res.clearCookie(COOKIE);
    return { ok: true };
  }

  @Get("me")
  async me(@Req() req: Request) {
    const token = (req.cookies?.[COOKIE] as string | undefined) ?? "";
    const member = await this.sessions.resolve(token);
    if (!member) throw new UnauthorizedException();
    return {
      member_id: member.memberId,
      tenant_id: member.tenantId,
      email: member.email,
      name: member.name,
      role: member.role,
      // 콘솔 메뉴/버튼 게이팅용 — 서버가 최종 권한 결정자 (DEV-sub-09 §8).
      permissions: permissionsForRole(member.role),
    };
  }

  private async issueSession(
    tenantId: string,
    memberId: string,
    req: Request,
    res: Response,
  ) {
    const { token, expiresAt } = await this.sessions.create(tenantId, memberId, {
      ip: req.ip,
      userAgent: req.header("user-agent") ?? undefined,
    });
    // httpOnly SameSite 쿠키 (ADR-8)
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: expiresAt,
      path: "/",
    });
  }
}
