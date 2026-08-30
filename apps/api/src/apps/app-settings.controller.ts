import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Pool } from "pg";
import { z } from "zod";
import { PG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const settingsSchema = z.object({
  timezone: z.string().min(1).max(64),
  quiet_hours: z.object({
    enabled: z.boolean(),
    start: z.string().regex(HHMM, "HH:MM 형식이어야 합니다"),
    end: z.string().regex(HHMM, "HH:MM 형식이어야 합니다"),
    policy: z.enum(["delay_until_open", "skip"]),
  }),
  frequency_cap: z.object({
    enabled: z.boolean(),
    max_per_24h: z.number().int().min(1).max(100),
  }),
});

/** 앱 발송 설정 (PRD-05 3.6 앱 설정, PRD-03 6장) */
@Controller("v1/apps/:appId/settings")
@UseGuards(SessionGuard)
export class AppSettingsController {
  constructor(@Inject(PG) private readonly pg: Pool) {}

  @Get()
  async get(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    const { rows } = await this.pg.query(
      `SELECT timezone, quiet_hours, frequency_cap FROM apps WHERE id = $1 AND tenant_id = $2`,
      [appId, req.member.tenantId],
    );
    if (!rows[0]) throw new NotFoundException("앱을 찾을 수 없습니다");
    return rows[0];
  }

  @Put()
  async update(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    if (!["owner", "admin"].includes(req.member.role)) {
      throw new ForbiddenException("앱 설정은 Owner/Admin만 변경할 수 있습니다");
    }
    // 유효한 IANA 시간대인지 검증 (quiet hours 계산의 전제)
    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.timezone });
    } catch {
      throw new BadRequestException(`알 수 없는 시간대: ${parsed.data.timezone}`);
    }

    const { rowCount } = await this.pg.query(
      `UPDATE apps SET timezone = $3, quiet_hours = $4, frequency_cap = $5, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [
        appId,
        req.member.tenantId,
        parsed.data.timezone,
        parsed.data.quiet_hours,
        parsed.data.frequency_cap,
      ],
    );
    if (!rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");
    return { ok: true };
  }
}
