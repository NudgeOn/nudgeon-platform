import {
  BadRequestException,
  Body,
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
import { z } from "zod";
import { QueueProducer } from "@nudgeon/libqueue";
import { STREAMS, type SendPushPayload } from "@nudgeon/queue-schemas";
import { PG, QUEUE } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";

const testPushSchema = z.object({
  external_id: z.string().min(1).max(256),
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(2048),
});

/**
 * 테스트 발송 (온보딩 위저드 4단계·M-1의 백엔드).
 * 대상 유저의 push 가능 디바이스 전부에 send.push 발행 — channel 워커가 실전송.
 * 테스트 발송은 transactional 취급 (정책 검사에 걸려 사라지지 않도록, PRD-03 6.3).
 */
@Controller("v1/apps/:appId")
@UseGuards(SessionGuard, PermissionGuard)
export class TestPushController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(QUEUE) private readonly queue: QueueProducer,
  ) {}

  // 실제 공급자 전송을 유발하는 작업 — 조회 전용(Viewer) 권한으로는 불가 (재검증: Viewer 발송 허용)
  @Post("test-push")
  @HttpCode(202)
  @RequirePermission("journeys:activate")
  async testPush(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    const parsed = testPushSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const app = await this.pg.query(
      `SELECT 1 FROM apps WHERE id = $1 AND tenant_id = $2`,
      [appId, req.member.tenantId],
    );
    if (!app.rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");

    // push 가능 디바이스: 토큰 active + OS 권한 granted (PRD-02 2.3 구성 요소)
    const { rows } = await this.pg.query(
      `SELECT d.id AS device_id, d.user_id, d.push_token, d.platform
         FROM devices d
         JOIN users u ON u.id = d.user_id
        WHERE u.app_id = $1 AND u.external_id = $2 AND u.status = 'active'
          AND d.push_token IS NOT NULL AND d.token_status = 'active'
          AND d.os_permission = 'granted'`,
      [appId, parsed.data.external_id],
    );
    if (rows.length === 0) {
      throw new BadRequestException(
        "발송 가능한 디바이스가 없습니다 (토큰 active + OS 권한 granted 필요)",
      );
    }

    const testRunId = randomUUID();
    for (const device of rows) {
      const payload: SendPushPayload = {
        idempotency_key: `test:${testRunId}:${device.device_id}`,
        message_id: randomUUID(), // 안정 발송 ID — message_log·SDK 도달/오픈 연결 (재검증 F)
        user_id: device.user_id,
        device_id: device.device_id,
        push_token: device.push_token,
        platform: device.platform,
        content: {
          push: { title: parsed.data.title, body: parsed.data.body },
        },
        category: "transactional",
        campaign_ref: `test:${testRunId}`,
      };
      await this.queue.publish(STREAMS.sendPush, {
        type: "send.push",
        tenantId: req.member.tenantId,
        appId,
        payload: payload as unknown as Record<string, unknown>,
      });
    }
    return { queued: rows.length, test_run_id: testRunId };
  }
}
