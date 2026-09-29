import {
  All,
  Controller,
  HttpException,
  Inject,
  Logger,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { REDIS } from "../infra/infra.module";
import { RateLimitService } from "../rate-limit/rate-limit.service";
import { AuditService } from "../audit/audit.service";
import { AnalysisService } from "../analytics/analysis.service";
import { SegmentDrafts } from "../segments/segment-drafts.service";
import { JourneyDrafts } from "../journeys/journey-drafts.service";
import { McpOAuth } from "./mcp-oauth.service";
import { McpRead } from "./mcp-read.service";
import { buildMcpServer } from "./mcp-tools";
import { requireScope, type McpActor } from "./mcp-policy";

@Controller("mcp")
export class McpController {
  private readonly logger = new Logger("MCP");
  constructor(
    private readonly oauth: McpOAuth,
    private readonly analytics: AnalysisService,
    private readonly segments: SegmentDrafts,
    private readonly journeys: JourneyDrafts,
    private readonly read: McpRead,
    private readonly rate: RateLimitService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}
  @All()
  async handle(@Req() req: Request, @Res() res: Response) {
    this.oauth.enabled();
    res.setHeader("Cache-Control", "no-store");
    const validOrigins = [
      new URL(this.oauth.issuer).origin,
      new URL(this.oauth.consoleUrl).origin,
    ];
    if (req.headers.origin && !validOrigins.includes(req.headers.origin)) {
      res.status(403).json({ error: "invalid_origin" });
      return;
    }
    // Trust configured issuer, never use untrusted Host to build discovery/redirect addresses.
    if (req.headers.host !== new URL(this.oauth.issuer).host) {
      res.status(403).json({ error: "invalid_host" });
      return;
    }
    let actor: McpActor;
    try {
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(
        req.headers.authorization ?? "",
      )?.[1];
      if (!token) throw new UnauthorizedException();
      actor = await this.oauth.resolve(token);
    } catch (error) {
      if (!(error instanceof HttpException) || error.getStatus() !== 401)
        throw error;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${this.oauth.issuer}/.well-known/oauth-protected-resource/mcp", scope="mcp:read"`,
      );
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    const decision = await this.rate.check([
      {
        name: "mcp_connection",
        key: `mcp:${actor.tenantId}:${actor.connectionId}`,
        rps: 2,
        burst: 60,
      },
      { name: "mcp_tenant", key: `mcp:${actor.tenantId}`, rps: 20, burst: 120 },
    ]);
    if (!decision.allowed) {
      res.setHeader("Retry-After", decision.retryAfterSec);
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    const token = req.headers.authorization!.slice(7);
    const handler = createMcpHandler(() =>
      buildMcpServer(
        actor,
        {
          analytics: this.analytics,
          segments: this.segments,
          journeys: this.journeys,
          read: this.read,
          consoleUrl: this.oauth.consoleUrl,
        },
        async (name, scope, args, run) => {
          const started = Date.now();
          let release: (() => Promise<unknown>) | undefined;
          try {
            // Do not rely on a cached tool list after a role, scope or approval change.
            requireScope(await this.oauth.resolve(token), scope);
            if (
              name.startsWith("query_") ||
              [
                "preview_segment_draft",
                "validate_journey_draft",
                "get_metric_catalog",
                "get_journey_report",
              ].includes(name)
            ) {
              const allowed = await this.rate.check([
                {
                  name: "mcp_analysis",
                  key: `mcp:analysis:${actor.tenantId}:${actor.appId}`,
                  rps: 0.5,
                  burst: 10,
                },
              ]);
              if (!allowed.allowed)
                throw new HttpException(
                  {
                    code: "QUERY_RATE_LIMIT",
                    retry_after: allowed.retryAfterSec,
                  },
                  429,
                );
              const key = `mcp:query:${actor.tenantId}:${actor.connectionId}`,
                owner = randomUUID();
              const acquired = await this.redis.set(
                key,
                owner,
                "PX",
                45_000,
                "NX",
              );
              if (!acquired)
                throw new HttpException({ code: "QUERY_IN_PROGRESS" }, 429);
              release = () =>
                this.redis.eval(
                  "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
                  1,
                  key,
                  owner,
                );
            }
            const value = await run();
            const output =
              value && typeof value === "object" && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : { data: value };
            await this.record(actor, name, "success", Date.now() - started);
            return output;
          } catch (error) {
            const status =
              error instanceof HttpException ? error.getStatus() : 500;
            // Do not echo SQL, raw arguments, profile values or upstream exception messages.
            const code =
              status === 412
                ? "REVISION_CONFLICT"
                : status === 409
                  ? "CONFLICT"
                  : status === 403
                    ? "INSUFFICIENT_SCOPE"
                    : status === 401
                      ? "CONNECTION_EXPIRED"
                      : status === 404
                        ? "NOT_FOUND"
                        : status === 429
                          ? "QUERY_LIMIT"
                          : status === 400
                            ? "INVALID_INPUT"
                            : "INTERNAL_ERROR";
            await this.record(actor, name, code, Date.now() - started);
            return {
              isError: true,
              error: {
                code,
                retryable: [429, 503].includes(status),
                message:
                  status === 412
                    ? "Read the latest draft before retrying."
                    : status === 400
                      ? "Check the tool schema, metric catalog and query limits."
                      : code,
              },
            };
          } finally {
            await release?.();
          }
        },
      ),
    );
    await toNodeHandler(handler)(req, res, req.body);
  }
  private async record(
    actor: McpActor,
    tool: string,
    result: string,
    duration: number,
  ) {
    this.logger.log(
      JSON.stringify({
        event: "mcp_tool",
        tool,
        result,
        duration_ms: duration,
      }),
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorMemberId: actor.memberId,
      action: `mcp.tool.${tool}`,
      targetType: "mcp_connection",
      targetId: actor.connectionId,
      detail: { app_id: actor.appId, result, duration_ms: duration },
    });
  }
}
