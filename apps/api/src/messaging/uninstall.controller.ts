import {
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { QueueProducer } from "@onda/libqueue";
import { STREAMS, type SendPushPayload } from "@onda/queue-schemas";
import { PG, QUEUE } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";

/**
 * 앱 삭제 감지 스윕 — 활성 토큰 디바이스에 무음(silent) 푸시를 발행한다.
 * 죽은 토큰은 공급자 UNREGISTERED/410 → 워커가 token invalid 전이 + app_uninstalls 기록.
 * 실제 공급자 전송을 유발하므로 journeys:activate 권한.
 */
@Controller("v1/apps/:appId")
@UseGuards(SessionGuard, PermissionGuard)
export class UninstallController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(QUEUE) private readonly queue: QueueProducer,
  ) {}

  @Post("uninstall-sweep")
  @HttpCode(202)
  @RequirePermission("journeys:activate")
  async sweep(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    const app = await this.pg.query(`SELECT 1 FROM apps WHERE id = $1 AND tenant_id = $2`, [
      appId,
      req.member.tenantId,
    ]);
    if (!app.rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");

    const { rows } = await this.pg.query(
      `SELECT d.id AS device_id, d.user_id, d.push_token, d.platform
         FROM devices d JOIN users u ON u.id = d.user_id
        WHERE u.app_id = $1 AND u.status = 'active'
          AND d.push_token IS NOT NULL AND d.token_status = 'active'`,
      [appId],
    );
    const runId = randomUUID();
    for (const d of rows) {
      const payload: SendPushPayload = {
        idempotency_key: `uninstall-sweep:${runId}:${d.device_id}`,
        message_id: randomUUID(),
        user_id: d.user_id,
        device_id: d.device_id,
        push_token: d.push_token,
        platform: d.platform,
        content: { push: { title: "", body: "", silent: true } },
        category: "transactional",
        campaign_ref: `uninstall-sweep:${runId}`,
      };
      await this.queue.publish(STREAMS.sendPush, {
        type: "send.push",
        tenantId: req.member.tenantId,
        appId,
        payload: payload as unknown as Record<string, unknown>,
      });
    }
    return { queued: rows.length, run_id: runId };
  }
}
