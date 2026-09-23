import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
  HttpException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { CONFIG } from "../infra/infra.module";
import type { AppConfig } from "../config";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { RateLimitService } from "../rate-limit/rate-limit.service";
import { McpOAuth } from "./mcp-oauth.service";
import { digest, parse } from "./mcp-policy";

@Controller()
export class McpOAuthController {
  constructor(
    private readonly oauth: McpOAuth,
    private readonly rate: RateLimitService,
  ) {}
  @Get(".well-known/oauth-authorization-server") metadata() {
    return this.oauth.metadata();
  }
  @Get(".well-known/oauth-protected-resource/mcp") resource() {
    return this.oauth.protectedMetadata();
  }
  @Get(".well-known/oauth-protected-resource") resourceRoot() {
    return this.oauth.protectedMetadata();
  }
  @Post("oauth/register") async register(
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.limit(req, "register", 10);
    return this.oauth.register(body);
  }
  @Get("oauth/authorize") async authorize(
    @Query() query: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.limit(req, "authorize", 30);
    res.setHeader("Cache-Control", "no-store");
    res.redirect(await this.oauth.authorize(query));
  }
  @Post("oauth/token") @HttpCode(200) async token(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    await this.limit(req, "token", 60);
    try {
      return await this.oauth.token(body);
    } catch (error) {
      if (error instanceof HttpException) {
        const data = error.getResponse();
        res.status(error.getStatus());
        return typeof data === "object" && "error" in data
          ? data
          : { error: "invalid_request" };
      }
      throw error;
    }
  }
  @Post("oauth/revoke") @HttpCode(200) async revoke(
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.limit(req, "revoke", 60);
    await this.oauth.revokeToken(body);
    return {};
  }
  private async limit(req: Request, kind: string, burst: number) {
    const decision = await this.rate.check([
      {
        name: "mcp_oauth",
        key: `mcp:oauth:${kind}:${digest(req.ip ?? "unknown")}`,
        rps: burst / 60,
        burst,
      },
    ]);
    if (!decision.allowed)
      throw new HttpException(
        {
          error: "temporarily_unavailable",
          retry_after: decision.retryAfterSec,
        },
        429,
      );
  }
}

@Controller("v1/mcp")
@UseGuards(SessionGuard)
export class McpConnectionsController {
  constructor(
    private readonly oauth: McpOAuth,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}
  @Get("status") status() {
    return this.oauth.status();
  }
  @Get("connections") list(@Req() req: SessionRequest) {
    return this.oauth.connections(req.member);
  }
  @Delete("connections/:id") revoke(
    @Param("id") id: string,
    @Req() req: SessionRequest,
  ) {
    this.origin(req);
    return this.oauth.changeConnection(req.member, id);
  }
  @Patch("connections/:id") approve(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    this.origin(req);
    const input = parse(
      z.object({ customer_access_approved: z.boolean() }),
      body,
    );
    return this.oauth.changeConnection(
      req.member,
      id,
      input.customer_access_approved,
    );
  }
  @Get("authorization/:id") request(
    @Param("id") id: string,
    @Req() req: SessionRequest,
  ) {
    return this.oauth.authorization(req.member, id);
  }
  @Post("authorization/:id") @HttpCode(200) consent(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    this.origin(req);
    return this.oauth.consent(req.member, id, body);
  }
  private origin(req: Request) {
    const allowed = new URL(this.config.mcpConsoleUrl ?? this.config.corsOrigin)
      .origin;
    if (req.headers.origin && req.headers.origin !== allowed)
      throw new ForbiddenException("Invalid origin");
  }
}
