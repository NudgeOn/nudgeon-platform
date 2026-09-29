import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { SegmentDrafts } from "./segment-drafts.service";

@Controller("v1/apps/:appId/segment-drafts")
@UseGuards(SessionGuard)
export class SegmentDraftsController {
  constructor(private readonly drafts: SegmentDrafts) {}

  @Get()
  list(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    return this.drafts.list(req.member, appId);
  }
  @Post()
  create(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest, @Body() body: unknown) {
    return this.drafts.create(req.member, appId, body);
  }
  @Get(":id")
  get(@Param("appId", ParseUUIDPipe) appId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    return this.drafts.get(req.member, appId, id);
  }
  @Patch(":id")
  update(@Param("appId", ParseUUIDPipe) appId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: SessionRequest, @Body() body: unknown) {
    return this.drafts.update(req.member, appId, id, body);
  }
  @Post(":id/preview")
  preview(@Param("appId", ParseUUIDPipe) appId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    return this.drafts.preview(req.member, appId, id);
  }
  @Post(":id/promote")
  promote(@Param("appId", ParseUUIDPipe) appId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: SessionRequest, @Body() body: unknown) {
    return this.drafts.promote(req.member, appId, id, body);
  }
}
