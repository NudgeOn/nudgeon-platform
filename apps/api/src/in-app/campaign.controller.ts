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
import { InAppCampaigns } from "./campaign.service";
@Controller("v1/apps/:appId/in-app")
@UseGuards(SessionGuard, PermissionGuard)
export class InAppCampaignController {
  constructor(
    private readonly service: InAppCampaigns,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}
  private async scope(app: string, r: SessionRequest) {
    if (
      r.method !== "GET" &&
      r.headers.origin &&
      r.headers.origin !== this.config.corsOrigin
    )
      throw new ForbiddenException("Origin not allowed");
    await this.service.workbench.app(r.member.tenantId, app);
    return r.member.tenantId;
  }
  private async record(r: SessionRequest, action: string, id: string) {
    await this.audit.recordAs(r.member, r.ip, `in_app.${action}`, {
      targetType: "in_app_campaign",
      targetId: id,
    });
  }
  @Get("campaigns") @RequirePermission("journeys:read") async list(
    @Param("appId", ParseUUIDPipe) a: string,
    @Req() r: SessionRequest,
  ) {
    return this.service.list(await this.scope(a, r), a);
  }
  @Post("campaigns") @RequirePermission("journeys:write") async create(
    @Param("appId", ParseUUIDPipe) a: string,
    @Req() r: SessionRequest,
    @Body() b: unknown,
  ) {
    const c = await this.service.save(await this.scope(a, r), a, b);
    await this.record(r, "campaign.create", c.id);
    return c;
  }
  @Post("campaigns/:id") @RequirePermission("journeys:write") async save(
    @Param("appId", ParseUUIDPipe) a: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() r: SessionRequest,
    @Body() b: unknown,
  ) {
    const c = await this.service.save(await this.scope(a, r), a, b, id);
    await this.record(r, "campaign.update", id);
    return c;
  }
  @Post("campaigns/:id/publish")
  @RequirePermission("in_app:publish")
  async publish(
    @Param("appId", ParseUUIDPipe) a: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() r: SessionRequest,
    @Body() b: unknown,
  ) {
    const c = await this.service.transition(
      await this.scope(a, r),
      a,
      id,
      r.member.memberId,
      b,
      true,
    );
    await this.record(r, "campaign.publish", id);
    return c;
  }
  @Post("campaigns/:id/pause") @RequirePermission("in_app:publish") async pause(
    @Param("appId", ParseUUIDPipe) a: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() r: SessionRequest,
    @Body() b: unknown,
  ) {
    const c = await this.service.transition(
      await this.scope(a, r),
      a,
      id,
      r.member.memberId,
      b,
      false,
    );
    await this.record(r, "campaign.pause", id);
    return c;
  }
  @Get("campaigns/:id/report") @RequirePermission("journeys:read") async report(
    @Param("appId", ParseUUIDPipe) a: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() r: SessionRequest,
  ) {
    return this.service.report(await this.scope(a, r), a, id);
  }
  @Get("reviews") @RequirePermission("journeys:read") async reviews(
    @Param("appId", ParseUUIDPipe) a: string,
    @Req() r: SessionRequest,
  ) {
    return this.service.reviews(await this.scope(a, r), a);
  }
  @Post("reviews") @RequirePermission("in_app:publish") async review(
    @Param("appId", ParseUUIDPipe) a: string,
    @Req() r: SessionRequest,
    @Body() b: unknown,
  ) {
    const result = await this.service.review(
      await this.scope(a, r),
      a,
      r.member.memberId,
      b,
    );
    await this.record(r, "revision.review", a);
    return result;
  }
}
