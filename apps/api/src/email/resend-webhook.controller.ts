import {
  Controller,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Request } from "express";
import type { Pool } from "pg";
import { QueueProducer } from "@nudgeon/libqueue";
import { STREAMS, type MessageLifecyclePayload } from "@nudgeon/queue-schemas";
import { CLICKHOUSE, PG, QUEUE } from "../infra/infra.module";
import { decryptEnvelope, loadMasterKey } from "../crypto/envelope";
import {
  extractMessageId,
  mapResendEvent,
  parseResendEvent,
  resolveOccurredAt,
  verifySvixSignature,
} from "./resend-webhook.service";

export const RESEND_CONNECTOR_ID = "email_resend";

/**
 * Resend 이벤트 웹훅 → message.lifecycle 발행.
 * 세션 가드 없음(공개 URL) — 인증은 앱별 크리덴셜(email_resend.webhook_secret)의 Svix 서명으로만 한다.
 * 테넌트는 세션이 아니라 credentials 행에서 확정한다. 본문은 main.ts의 express.json verify 훅이
 * `/v1/webhooks/*` 경로에 한해 req.rawBody(Buffer)로 보존한다 (서명은 원문 바이트 기준, 1MB 상한 유지).
 *
 * 응답 정책: 서명/크리덴셜 문제만 401. 매핑 불가 타입·message_id 미해석은 200 {accepted:false} —
 * 4xx/5xx면 Resend가 무한 재시도하므로. 재시도 중복은 CH message_lifecycle(ReplacingMergeTree)이 흡수.
 */
@Controller("v1/webhooks/resend")
export class ResendWebhookController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
    @Inject(QUEUE) private readonly queue: QueueProducer,
  ) {}

  @Post(":appId")
  @HttpCode(200)
  async receive(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: RawBodyRequest<Request>) {
    const rawBody = req.rawBody ?? (typeof req.body === "string" ? Buffer.from(req.body, "utf8") : null);
    if (!rawBody) throw new InternalServerErrorException("웹훅 원문 본문(rawBody)을 사용할 수 없습니다");

    const { tenantId, webhookSecret } = await this.loadCredential(appId);
    const verdict = verifySvixSignature({
      secret: webhookSecret,
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody,
    });
    if (!verdict.ok) throw new UnauthorizedException(`Resend 웹훅 서명 검증 실패: ${verdict.reason}`);

    const event = parseResendEvent(req.body ?? JSON.parse(rawBody.toString("utf8")));
    if (!event) return { accepted: false, reason: "invalid_event" };
    const mapped = mapResendEvent(event);
    if (!mapped) return { accepted: false, ignored: event.type };

    const providerMessageId = event.data.email_id ?? null;
    const messageId =
      extractMessageId(event.data.tags) ??
      (providerMessageId ? await this.lookupMessageId(tenantId, appId, providerMessageId) : null);
    if (!messageId) return { accepted: false, reason: "message_id_unresolved" };

    const occurredAt = resolveOccurredAt(event);
    const payload: MessageLifecyclePayload = {
      message_id: messageId,
      status: mapped.status,
      occurred_at: occurredAt,
      source: "provider_callback",
      channel: "email",
      connector_id: RESEND_CONNECTOR_ID,
      provider_message_id: providerMessageId,
      user_id: null,
      endpoint_id: null,
      failure_class: mapped.failure_class,
      failure_detail: mapped.failure_detail,
      fallback_index: 0,
      attempt: null,
      cost: null,
      click_ref: mapped.click_ref,
    };
    await this.queue.publish(STREAMS.messageLifecycle, {
      type: "message.lifecycle",
      tenantId,
      appId,
      occurredAt: new Date(occurredAt),
      payload: payload as unknown as Record<string, unknown>,
    });
    return { accepted: true, status: mapped.status };
  }

  /** email_resend 크리덴셜 복호화 → tenant_id + webhook_secret. 없거나 비밀 미등록이면 401. */
  private async loadCredential(appId: string): Promise<{ tenantId: string; webhookSecret: string }> {
    // app_id는 uuid PK로 단일 테넌트 소속 — tenant_id는 이 행에서 확정한다 (세션 없음, allowlist 등록).
    const { rows } = await this.pg.query(
      `SELECT tenant_id, ciphertext, dek_wrapped FROM credentials WHERE app_id = $1 AND kind = 'email_resend'`,
      [appId],
    );
    const row = rows[0] as { tenant_id: string; ciphertext: Buffer; dek_wrapped: Buffer } | undefined;
    if (!row) throw new UnauthorizedException("이 앱에는 Resend(email_resend) 크리덴셜이 없습니다");
    let secret: unknown;
    try {
      const plain = decryptEnvelope(loadMasterKey(), { ciphertext: row.ciphertext, dekWrapped: row.dek_wrapped });
      secret = (JSON.parse(plain) as { webhook_secret?: unknown }).webhook_secret;
    } catch {
      throw new UnauthorizedException("Resend 크리덴셜을 복호화할 수 없습니다");
    }
    if (typeof secret !== "string" || !secret) {
      throw new UnauthorizedException("Resend 크리덴셜에 webhook_secret(Svix 서명 비밀)이 등록되지 않았습니다");
    }
    return { tenantId: row.tenant_id, webhookSecret: secret };
  }

  /** 태그가 없을 때 — 발송 워커가 기록한 provider_message_id(Resend email id)로 역조회 */
  private async lookupMessageId(tenantId: string, appId: string, providerMessageId: string): Promise<string | null> {
    const res = await this.ch.query({
      query: `SELECT toString(message_id) AS message_id FROM message_log
               WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
                 AND provider_message_id = {pid:String} LIMIT 1`,
      query_params: { tid: tenantId, aid: appId, pid: providerMessageId },
      format: "JSONEachRow",
    });
    const rows = (await res.json()) as Array<{ message_id: string }>;
    return rows[0]?.message_id ?? null;
  }
}
