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
import { QueueProducer } from "@onda/libqueue";
import { STREAMS, type SendEmailPayload } from "@onda/queue-schemas";
import { PG, QUEUE } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";
import { renderTemplate } from "../util/template";

const testEmailSchema = z
  .object({
    to_email: z.string().email(),
    template_id: z.string().uuid().optional(),
    subject: z.string().min(1).max(998).optional(),
    html: z.string().min(1).max(1_000_000).optional(),
    provider: z.enum(["email_smtp", "email_nhn", "email_resend"]).optional(),
    variables: z.record(z.unknown()).default({}),
  })
  .refine((b) => b.template_id || (b.subject && b.html), {
    message: "template_id 또는 (subject+html) 중 하나는 필수입니다",
  });

/**
 * 테스트 이메일 발송 — 템플릿(또는 인라인)을 {{ }} 치환 후 send.email 발행 → email 워커가 실전송.
 * 실제 공급자 전송을 유발하므로 journeys:activate 권한(테스트 발송과 동일 게이팅).
 */
@Controller("v1/apps/:appId")
@UseGuards(SessionGuard, PermissionGuard)
export class TestEmailController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(QUEUE) private readonly queue: QueueProducer,
  ) {}

  @Post("test-email")
  @HttpCode(202)
  @RequirePermission("journeys:activate")
  async testEmail(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    const parsed = testEmailSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const app = await this.pg.query(`SELECT 1 FROM apps WHERE id = $1 AND tenant_id = $2`, [
      appId,
      req.member.tenantId,
    ]);
    if (!app.rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");

    let subjectTpl = parsed.data.subject ?? "";
    let htmlTpl = parsed.data.html ?? "";
    if (parsed.data.template_id) {
      const { rows } = await this.pg.query(
        `SELECT subject, html FROM email_templates WHERE tenant_id = $1 AND app_id = $2 AND id = $3`,
        [req.member.tenantId, appId, parsed.data.template_id],
      );
      if (!rows[0]) throw new NotFoundException("템플릿을 찾을 수 없습니다");
      subjectTpl = rows[0].subject;
      htmlTpl = rows[0].html;
    }
    const vars = parsed.data.variables as Record<string, unknown>;
    const subject = renderTemplate(subjectTpl, vars);
    const html = renderTemplate(htmlTpl, vars);

    const testRunId = randomUUID();
    const payload: SendEmailPayload = {
      idempotency_key: `test:${testRunId}`,
      message_id: randomUUID(),
      email: parsed.data.to_email,
      ...(parsed.data.provider ? { provider: parsed.data.provider } : {}),
      content: { email: { subject, html } },
      category: "transactional",
      campaign_ref: `test:${testRunId}`,
    };
    await this.queue.publish(STREAMS.sendEmail, {
      type: "send.email",
      tenantId: req.member.tenantId,
      appId,
      payload: payload as unknown as Record<string, unknown>,
    });
    return { queued: 1, test_run_id: testRunId };
  }
}
