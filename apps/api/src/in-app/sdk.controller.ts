import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  UseGuards,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  ApiKeyGuard,
  RequireApiKey,
  type AuthedRequest,
} from "../auth/api-key.guard";
import { RateLimitGuard } from "../rate-limit/rate-limit.guard";
import { InAppWorkbench, parseInput } from "./workbench.service";
import { hash } from "./bundle";
@Controller("v1/in-app/test")
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class InAppTestSdkController {
  constructor(private readonly service: InAppWorkbench) {}
  private async auth(req: AuthedRequest) {
    this.service.assets.requireEnabled();
    const token = req.header("x-nudgeon-test-token") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedException();
    const { tenantId: tenant, appId: app } = req.apiKey;
    const result = await this.service.pg.query(
      "UPDATE in_app_test_devices SET last_seen_at=now() WHERE tenant_id=$1 AND app_id=$2 AND credential_hash=$3 AND expires_at>now() AND state IN ('claimed','active') RETURNING id,state,expires_at",
      [tenant, app, hash(token)],
    );
    if (!result.rowCount)
      throw new UnauthorizedException("TEST_SESSION_EXPIRED");
    return { tenant, app, ...result.rows[0] };
  }
  @Post("pair")
  @RequireApiKey("sdk")
  async pair(@Req() req: AuthedRequest, @Body() input: unknown) {
    this.service.assets.requireEnabled();
    const body = parseInput(
      z.object({
        token: z.string().max(100),
        label: z.string().trim().min(1).max(80),
        platform: z.enum(["ios", "android"]),
        sdk_version: z.string().max(40),
      }),
      input,
    );
    const [id, secret] = body.token.split(".");
    if (
      !z.string().uuid().safeParse(id).success ||
      !secret ||
      body.token.split(".").length !== 2
    )
      throw new UnauthorizedException();
    const credential = randomBytes(32).toString("base64url");
    const result = await this.service.pg.query(
      "UPDATE in_app_test_devices SET state='claimed',credential_hash=$5,label=$6,platform=$7,sdk_version=$8,last_seen_at=now() WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND pairing_hash=$4 AND state='waiting' AND expires_at>now() RETURNING id,confirmation_code,expires_at",
      [
        req.apiKey.tenantId,
        req.apiKey.appId,
        id,
        hash(secret),
        hash(credential),
        body.label,
        body.platform,
        body.sdk_version,
      ],
    );
    if (!result.rowCount)
      throw new UnauthorizedException("PAIRING_EXPIRED_OR_USED");
    return { ...result.rows[0], credential };
  }
  @Get("commands")
  @RequireApiKey("sdk")
  async commands(@Req() req: AuthedRequest) {
    const d = await this.auth(req);
    await this.service.expire(d.tenant, d.app);
    if (d.state !== "active")
      return { state: d.state, expires_at: d.expires_at, run: null };
    const rows = await this.service.pg.query(
      "SELECT id,revision_id,state,expires_at FROM in_app_test_runs WHERE tenant_id=$1 AND app_id=$2 AND device_id=$3 AND state IN ('queued','preparing','presented') ORDER BY created_at LIMIT 1",
      [d.tenant, d.app, d.id],
    );
    return {
      state: d.state,
      expires_at: d.expires_at,
      run: rows.rows[0] ?? null,
    };
  }
  @Post("runs/:id/claim")
  @RequireApiKey("sdk")
  async claim(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const d = await this.auth(req);
    if (d.state !== "active") throw new UnauthorizedException();
    // The UPDATE is the delivery lease. Retrying a claim never redisplays a run.
    const result = await this.service.pg.query(
      "UPDATE in_app_test_runs SET state='preparing',expires_at=now()+interval '5 minutes',updated_at=now() WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND device_id=$4 AND state='queued' AND expires_at>now() RETURNING revision_id,expires_at",
      [d.tenant, d.app, id, d.id],
    );
    if (!result.rowCount)
      throw new ConflictException("RUN_ALREADY_CLAIMED_OR_EXPIRED");
    const r = result.rows[0],
      a = await this.service.assets.read(d.tenant, d.app, r.revision_id);
    return {
      id,
      revision_id: r.revision_id,
      expires_at: r.expires_at,
      html: a.html,
      manifest: a.manifest,
      artifact_sha256: a.artifact_sha256,
    };
  }
  @Post("runs/:id/events")
  @RequireApiKey("sdk")
  async event(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    const d = await this.auth(req);
    if (d.state !== "active") throw new UnauthorizedException();
    const body = parseInput(
      z.object({
        event_id: z.string().uuid(),
        kind: z.enum([
          "bridge_ready",
          "content_ready",
          "presented",
          "impression",
          "action",
          "dismiss",
          "failed",
          "log",
        ]),
        detail: z.string().max(200).default(""),
      }),
      input,
    );
    const db = await this.service.pg.connect();
    try {
      await db.query("BEGIN");
      const run = (
        await db.query(
          "SELECT state,expires_at FROM in_app_test_runs WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND device_id=$4 FOR UPDATE",
          [d.tenant, d.app, id, d.id],
        )
      ).rows[0];
      if (!run) throw new NotFoundException();
      const old = await db.query(
        "SELECT kind,detail FROM in_app_test_events WHERE tenant_id=$1 AND app_id=$2 AND run_id=$3 AND event_id=$4",
        [d.tenant, d.app, id, body.event_id],
      );
      if (old.rowCount) {
        if (
          old.rows[0].kind !== body.kind ||
          old.rows[0].detail !== body.detail
        )
          throw new ConflictException("EVENT_ID_REUSED");
        await db.query("COMMIT");
        return { ok: true };
      }
      if (
        !["preparing", "presented"].includes(run.state) ||
        new Date(run.expires_at).getTime() <= Date.now()
      )
        throw new ConflictException("RUN_CLOSED");
      const count = await db.query(
        "SELECT count(*)::int AS n FROM in_app_test_events WHERE tenant_id=$1 AND app_id=$2 AND run_id=$3",
        [d.tenant, d.app, id],
      );
      if (count.rows[0].n >= 200) throw new ConflictException("EVENT_LIMIT");
      if (
        ["impression", "action"].includes(body.kind) &&
        run.state !== "presented"
      )
        throw new ConflictException("NOT_PRESENTED");
      await db.query(
        "INSERT INTO in_app_test_events(tenant_id,app_id,run_id,event_id,kind,detail) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [d.tenant, d.app, id, body.event_id, body.kind, body.detail],
      );
      const state =
        body.kind === "presented"
          ? "presented"
          : body.kind === "dismiss"
            ? "completed"
            : body.kind === "failed"
              ? "failed"
              : run.state;
      await db.query(
        "UPDATE in_app_test_runs SET state=$4,error_code=$5,updated_at=now() WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
        [
          d.tenant,
          d.app,
          id,
          state,
          body.kind === "failed" ? body.detail : null,
        ],
      );
      await db.query("COMMIT");
      return { ok: true };
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  @Post("end")
  @RequireApiKey("sdk")
  async end(@Req() req: AuthedRequest) {
    const d = await this.auth(req);
    return this.service.revoke(d.tenant, d.app, d.id);
  }
}
