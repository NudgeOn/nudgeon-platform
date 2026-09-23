import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";
import { AnalysisService } from "./analysis.service";

@Controller("v1/apps/:appId/analytics")
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermission("analytics:read")
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Get("catalog")
  catalog(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    return this.analysis.appCatalog(req.member.tenantId, appId);
  }
  @Post("events")
  events(@Param("appId", ParseUUIDPipe) appId: string, @Body() input: unknown, @Req() req: SessionRequest) {
    return this.analysis.events(req.member.tenantId, appId, input);
  }
  @Post("messages")
  messages(@Param("appId", ParseUUIDPipe) appId: string, @Body() input: unknown, @Req() req: SessionRequest) {
    return this.analysis.messages(req.member.tenantId, appId, input);
  }
  @Post("funnel")
  funnel(@Param("appId", ParseUUIDPipe) appId: string, @Body() input: unknown, @Req() req: SessionRequest) {
    return this.analysis.funnel(req.member.tenantId, appId, input);
  }
  @Post("retention")
  retention(@Param("appId", ParseUUIDPipe) appId: string, @Body() input: unknown, @Req() req: SessionRequest) {
    return this.analysis.retention(req.member.tenantId, appId, input);
  }
  @Get("journey-report")
  journeyReport(@Param("appId", ParseUUIDPipe) appId: string, @Query("journey_id", ParseUUIDPipe) id: string,
    @Query("version") version: string | undefined, @Req() req: SessionRequest) {
    return this.analysis.journeyReport(req.member.tenantId, appId, id, version === undefined ? undefined : Number(version));
  }
}
