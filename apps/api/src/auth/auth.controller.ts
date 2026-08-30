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
});

@Controller("v1/auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
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
    const { memberId, tenantId } = await this.auth.verifyLogin(
      parsed.data.email,
      parsed.data.password,
    );
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
