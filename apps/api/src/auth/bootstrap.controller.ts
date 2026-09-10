import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { CONFIG } from "../infra/infra.module";
import type { AppConfig } from "../config";
import { BOOTSTRAP_COOKIE, BootstrapService } from "./bootstrap.service";
import { SessionService } from "./session.service";

const claimSchema = z.object({ token: z.string().min(32).max(256) });
const setupSchema = z.object({
  workspace_name: z.string().min(1).max(100),
  app_name: z.string().min(1).max(100).default("Default App"),
  owner: z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    password: z.string().min(8).max(128),
  }),
  timezone: z.string().max(64).optional(),
});

const SESSION_COOKIE = "nudgeon_session";
const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost" || ip.startsWith("127.");

/** 아주 단순한 per-IP 슬라이딩 윈도 — claim 시도 무차별 대입 완화 (S1 수용 기준 "rate limit"). */
class ClaimRateLimit {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit = 10, private readonly windowMs = 60_000) {}
  allow(ip: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) { this.hits.set(ip, list); return false; }
    list.push(now); this.hits.set(ip, list);
    return true;
  }
}

/**
 * 설치 소유권 claim → 최초 Owner 원자 생성 (Slice B). 흐름과 상태 권위는 BootstrapService.
 * 보안 헤더: 응답은 no-store, Referrer 없음, 프레임 금지 (S1 수용 기준).
 */
@Controller("v1/bootstrap")
export class BootstrapController {
  private readonly limiter = new ClaimRateLimit();

  constructor(
    private readonly bootstrap: BootstrapService,
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  private harden(res: Response) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  }

  /** 비-loopback 평문 HTTP에서는 claim/setup 자체를 거부한다 (S1: 원격은 TLS reverse proxy나 SSH 터널만). */
  private assertLoopbackOrTls(req: Request) {
    const proto = ((req.header("x-forwarded-proto") ?? req.protocol ?? "http").split(",")[0] ?? "http").trim();
    if (proto === "https") return;
    // Safe Boot: 유일한 published 포트가 127.0.0.1에 바인딩돼 있으면 어떤 요청도 호스트 loopback에서 왔다
    // (컨테이너가 보는 X-Forwarded-For는 도커 게이트웨이 IP라 쓸 수 없다).
    if (isLoopback(this.cfg.publicBindAddress ?? "")) return;
    const forwarded = (req.header("x-forwarded-for")?.split(",")[0] ?? "").trim();
    if (isLoopback(forwarded || req.ip || "")) return;
    throw new ForbiddenException("평문 HTTP로는 loopback(localhost)에서만 설치할 수 있습니다 — 원격은 TLS reverse proxy 또는 SSH 터널을 쓰세요");
  }

  private single() {
    if (this.cfg.mode !== "single_tenant") throw new BadRequestException("셀프호스팅(MODE=single_tenant) 전용입니다");
  }

  /** 모드·설치 상태·버전의 최소 정보 (인증 없음). 콘솔·setup 화면이 분기에 쓴다. */
  @Get("status")
  async status(@Res({ passthrough: true }) res: Response) {
    this.harden(res);
    return this.bootstrap.status();
  }

  /** 설치 코드 교환 → 15분 Bootstrap cookie. 원문은 body로만 받는다(URL·로그에 남기지 않는다). */
  @Post("claim")
  @HttpCode(204)
  async claim(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.harden(res);
    this.single();
    this.assertLoopbackOrTls(req);
    if (!this.limiter.allow((req.header("x-forwarded-for")?.split(",")[0] ?? "").trim() || req.ip || "?")) {
      throw new HttpException("설치 코드 시도가 너무 많습니다 — 잠시 후 다시", 429);
    }
    const parsed = claimSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("설치 코드 형식이 올바르지 않습니다");
    const { cookie, expiresAt } = await this.bootstrap.claim(parsed.data.token);
    res.cookie(BOOTSTRAP_COOKIE, cookie, { httpOnly: true, sameSite: "strict", secure: req.header("x-forwarded-proto") === "https", expires: expiresAt, path: "/" });
    res.setHeader("X-Bootstrap-Expires-At", expiresAt.toISOString());
  }

  /** Owner·workspace·app 원자 생성. Idempotency-Key 필수 — commit 뒤 응답 유실은 같은 key로 재요청. */
  @Post("setup")
  @HttpCode(201)
  async setup(
    @Body() body: unknown,
    @Headers("idempotency-key") idem: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.harden(res);
    this.single();
    this.assertLoopbackOrTls(req);
    if (!idem || idem.length < 8 || idem.length > 128) throw new BadRequestException("Idempotency-Key 헤더가 필요합니다");
    const parsed = setupSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    if (parsed.data.timezone) {
      try { new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.timezone }); } catch { throw new BadRequestException(`알 수 없는 시간대: ${parsed.data.timezone}`); }
    }
    const out = await this.bootstrap.setup(req.cookies?.[BOOTSTRAP_COOKIE], idem, {
      workspaceName: parsed.data.workspace_name, appName: parsed.data.app_name, owner: parsed.data.owner, timezone: parsed.data.timezone,
    });
    await this.issueSession(out.result.tenant_id, out.result.member_id, req, res);
    if (out.replayed) res.status(200);
    return { ...out.result, ...(out.keys ?? {}), replayed: out.replayed };
  }

  /** 응답 유실 복구 — 키 원문은 없다(Owner가 인증된 회전 경로로 재발급). 일반 세션은 다시 발급한다. */
  @Get("setup-result")
  async setupResult(@Headers("idempotency-key") idem: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.harden(res);
    this.single();
    if (!idem) throw new BadRequestException("Idempotency-Key 헤더가 필요합니다");
    const result = await this.bootstrap.setupResult(req.cookies?.[BOOTSTRAP_COOKIE], idem);
    await this.issueSession(result.tenant_id, result.member_id, req, res);
    return { ...result, replayed: true };
  }

  private async issueSession(tenantId: string, memberId: string, req: Request, res: Response) {
    const { token, expiresAt } = await this.sessions.create(tenantId, memberId, { ip: req.ip, userAgent: req.header("user-agent") ?? undefined });
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", expires: expiresAt, path: "/" });
  }
}
