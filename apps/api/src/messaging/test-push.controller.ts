import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException,
  Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { PG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";
import { TestPushService } from "./test-push.service";

const testPushSchema = z.object({
  external_id: z.string().trim().min(1).max(256), title: z.string().min(1).max(256), body: z.string().min(1).max(2048),
  device_id: z.string().uuid().optional(),
});

@Controller("v1/apps/:appId")
@UseGuards(SessionGuard, PermissionGuard)
export class TestPushController {
  constructor(@Inject(PG) private readonly pg: Pool, private readonly tests: TestPushService) {}

  @Post("test-push")
  @HttpCode(202)
  @RequirePermission("journeys:activate")
  async testPush(@Param("appId", ParseUUIDPipe) appId: string, @Body() body: unknown,
    @Req() req: SessionRequest, @Headers("idempotency-key") requestKey?: string) {
    await this.assertApp(appId, req);
    const parsed = testPushSchema.safeParse(body);
    const key = z.string().uuid().safeParse(requestKey ?? randomUUID());
    if (!parsed.success || !key.success) throw new BadRequestException("Invalid test push request");
    return this.tests.accept(req.member.tenantId, appId, key.data.toLowerCase(), parsed.data);
  }

  @Get("test-push-targets")
  @RequirePermission("journeys:activate")
  async targets(@Param("appId", ParseUUIDPipe) appId: string, @Query("external_id") externalId: string,
    @Req() req: SessionRequest) {
    await this.assertApp(appId, req);
    const parsed = z.string().trim().min(1).max(256).safeParse(externalId);
    if (!parsed.success) throw new BadRequestException("Invalid test customer ID");
    const { rows } = await this.pg.query(
      `SELECT d.id AS device_id, d.platform, d.token_status, d.os_permission, d.last_active_at,
              (d.push_token IS NOT NULL AND d.push_token <> '') AS has_token,
              EXISTS (SELECT 1 FROM credentials c WHERE c.tenant_id = $1 AND c.app_id = $2
                AND c.status = 'verified' AND c.kind::text =
                CASE WHEN d.platform = 'ios' THEN 'push_apns' ELSE 'push_fcm' END) AS channel_verified
         FROM devices d JOIN users u ON u.id = d.user_id
        WHERE d.tenant_id = $1 AND d.app_id = $2 AND u.tenant_id = $1 AND u.app_id = $2
          AND u.external_id = $3 AND u.status = 'active'
        ORDER BY d.last_active_at DESC NULLS LAST, d.id LIMIT 100`,
      [req.member.tenantId, appId, parsed.data],
    );
    return { devices: rows.map((row) => ({ ...row,
      eligible: row.has_token && row.token_status === "active" && row.os_permission === "granted" && row.channel_verified,
    })) };
  }

  @Get("test-push-runs")
  @RequirePermission("analytics:read")
  async runs(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    await this.assertApp(appId, req);
    const { rows } = await this.pg.query(
      `SELECT r.id AS test_run_id, r.messages, r.accepted_at,
              (SELECT count(*)::int FROM journey_outbox o WHERE o.tenant_id = $1 AND o.app_id = $2
                AND o.id = ANY(r.outbox_ids) AND o.published_at IS NOT NULL) AS queued_count,
              (SELECT count(*)::int FROM journey_outbox o WHERE o.tenant_id = $1 AND o.app_id = $2
                AND o.id = ANY(r.outbox_ids) AND o.published_at IS NULL) AS pending_count,
              (jsonb_array_length(r.messages) - (SELECT count(*)::int FROM journey_outbox o
                WHERE o.tenant_id = $1 AND o.app_id = $2 AND o.id = ANY(r.outbox_ids))) AS removed_count
         FROM test_push_runs r WHERE r.tenant_id = $1 AND r.app_id = $2
        ORDER BY r.accepted_at DESC, r.id DESC LIMIT 20`, [req.member.tenantId, appId],
    );
    return { runs: rows };
  }

  private async assertApp(appId: string, req: SessionRequest) {
    const app = await this.pg.query(`SELECT 1 FROM apps WHERE id = $1 AND tenant_id = $2`, [appId, req.member.tenantId]);
    if (!app.rowCount) throw new NotFoundException("App not found");
  }
}
