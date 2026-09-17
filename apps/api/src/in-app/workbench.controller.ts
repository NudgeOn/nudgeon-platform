import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  ForbiddenException,
  Inject,
} from "@nestjs/common";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";
import { AuditService } from "../audit/audit.service";
import { CONFIG } from "../infra/infra.module";
import type { AppConfig } from "../config";
import { InAppWorkbench } from "./workbench.service";
@Controller("v1/apps/:appId/in-app")
@UseGuards(SessionGuard, PermissionGuard)
export class InAppWorkbenchController {
  constructor(
    private readonly service: InAppWorkbench,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}
  private async scope(app: string, req: SessionRequest) {
    if (
      req.method !== "GET" &&
      req.headers.origin &&
      req.headers.origin !== this.cfg.corsOrigin
    )
      throw new ForbiddenException("Origin not allowed");
    await this.service.app(req.member.tenantId, app);
    return req.member.tenantId;
  }
  private async record(req: SessionRequest, action: string, id: string) {
    await this.audit.recordAs(req.member, req.ip, `in_app.${action}`, {
      targetType: "in_app",
      targetId: id,
    });
  }
  @Get("status")
  @RequirePermission("journeys:read")
  status() {
    return this.service.assets.status();
  }
  @Get("revisions")
  @RequirePermission("journeys:read")
  async list(
    @Param("appId", ParseUUIDPipe) app: string,
    @Req() req: SessionRequest,
  ) {
    return this.service.list(await this.scope(app, req), app);
  }
  @Post("revisions")
  @RequirePermission("journeys:write")
  async create(
    @Param("appId", ParseUUIDPipe) app: string,
    @Req() req: SessionRequest,
    @Body() body: unknown,
  ) {
    const result = await this.service.create(
      await this.scope(app, req),
      app,
      req.member.memberId,
      body,
    );
    await this.record(req, "revision.create", result.id);
    return result;
  }
  @Get("revisions/:id")
  @RequirePermission("journeys:read")
  async get(
    @Param("appId", ParseUUIDPipe) app: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    const a = await this.service.assets.read(
      await this.scope(app, req),
      app,
      id,
    );
    return {
      id,
      files: a.files,
      manifest: a.manifest,
      artifact_sha256: a.artifact_sha256,
    };
  }
  @Post("revisions/:id/preview")
  @RequirePermission("journeys:read")
  async preview(
    @Param("appId", ParseUUIDPipe) app: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    const tenant = await this.scope(app, req);
    await this.service.assets.read(tenant, app, id);
    return this.service.assets.preview(tenant, app, id);
  }
  @Get("devices")
  @RequirePermission("journeys:read")
  async devices(
    @Param("appId", ParseUUIDPipe) app: string,
    @Req() req: SessionRequest,
  ) {
    return this.service.devices(await this.scope(app, req), app);
  }
  @Post("pairings")
  @RequirePermission("journeys:write")
  async pair(
    @Param("appId", ParseUUIDPipe) app: string,
    @Req() req: SessionRequest,
  ) {
    const result = await this.service.pairing(
      await this.scope(app, req),
      app,
      req.member.memberId,
    );
    await this.record(req, "pairing.create", result.id);
    return result;
  }
  @Post("devices/:id/confirm")
  @RequirePermission("journeys:write")
  async confirm(
    @Param("appId", ParseUUIDPipe) app: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    const result = await this.service.confirm(
      await this.scope(app, req),
      app,
      id,
    );
    await this.record(req, "device.confirm", id);
    return result;
  }
  @Post("devices/:id/revoke")
  @RequirePermission("journeys:write")
  async revoke(
    @Param("appId", ParseUUIDPipe) app: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    const result = await this.service.revoke(
      await this.scope(app, req),
      app,
      id,
    );
    await this.record(req, "device.revoke", id);
    return result;
  }
  @Get("runs")
  @RequirePermission("journeys:read")
  async runs(
    @Param("appId", ParseUUIDPipe) app: string,
    @Req() req: SessionRequest,
  ) {
    return this.service.runs(await this.scope(app, req), app);
  }
  @Post("runs")
  @RequirePermission("journeys:write")
  async run(
    @Param("appId", ParseUUIDPipe) app: string,
    @Req() req: SessionRequest,
    @Body() body: unknown,
  ) {
    const result = await this.service.run(
      await this.scope(app, req),
      app,
      body,
    );
    await this.record(req, "test.create", result.id);
    return result;
  }
  @Get("runs/:id/events")
  @RequirePermission("journeys:read")
  async events(
    @Param("appId", ParseUUIDPipe) app: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    return this.service.events(await this.scope(app, req), app, id);
  }
  @Post("runs/:id/cancel")
  @RequirePermission("journeys:write")
  async cancel(
    @Param("appId", ParseUUIDPipe) app: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    return this.service.cancel(await this.scope(app, req), app, id);
  }
}
