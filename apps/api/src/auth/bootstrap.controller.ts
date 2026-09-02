import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { CONFIG } from "../infra/infra.module";
import type { AppConfig } from "../config";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";

const setupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100),
});

const COOKIE = "nudgeon_session";

/**
 * 셀프호스팅 초기 관리자 셋업 (PRD-06 2.1, MODE=single_tenant).
 * 가입(멀티테넌트) 대신 최초 1회 관리자를 만들고 테넌트 1개로 고정한다.
 * 이미 관리자가 있으면 셋업을 거부한다(잠금).
 */
@Controller("v1/bootstrap")
export class BootstrapController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** 셋업 필요 여부 — 콘솔이 로그인 vs 초기 셋업 화면을 분기하는 데 사용 */
  @Get("status")
  async status() {
    if (this.cfg.mode !== "single_tenant") {
      return { mode: "multi_tenant", needs_setup: false };
    }
    const memberCount = await this.auth.countMembers();
    return { mode: "single_tenant", needs_setup: memberCount === 0 };
  }

  @Post("setup")
  @HttpCode(201)
  async setup(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (this.cfg.mode !== "single_tenant") {
      throw new BadRequestException("셀프호스팅(MODE=single_tenant) 전용입니다");
    }
    if ((await this.auth.countMembers()) > 0) {
      throw new ConflictException("이미 초기 관리자가 설정되었습니다");
    }
    const parsed = setupSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    // 단일 테넌트로 고정 — signup 로직 재사용(테넌트명은 조직 기본값)
    const result = await this.auth.signup({
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.name,
      tenantName: "NudgeOn (self-hosted)",
    });
    const { token, expiresAt } = await this.sessions.create(result.tenantId, result.memberId, {
      ip: req.ip,
      userAgent: req.header("user-agent") ?? undefined,
    });
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: expiresAt,
      path: "/",
    });
    return {
      tenant_id: result.tenantId,
      app_id: result.appId,
      sdk_key: result.sdkKey,
      server_key: result.serverKey,
    };
  }
}
