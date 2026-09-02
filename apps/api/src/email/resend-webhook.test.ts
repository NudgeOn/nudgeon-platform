import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { QueueProducer } from "@onda/libqueue";
import { STREAMS } from "@onda/queue-schemas";
import { encryptEnvelope, loadMasterKey } from "../crypto/envelope";
import { ResendWebhookController } from "./resend-webhook.controller";
import {
  extractMessageId,
  mapResendEvent,
  parseResendEvent,
  resolveOccurredAt,
  svixSign,
  verifySvixSignature,
} from "./resend-webhook.service";

const SECRET = "whsec_" + randomBytes(24).toString("base64");
const OTHER_SECRET = "whsec_" + randomBytes(24).toString("base64");
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const ts = (offsetSec = 0) => String(Math.floor(NOW / 1000) + offsetSec);

function signed(secret: string, body: string, timestamp = ts(), id = "msg_1") {
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${svixSign(secret, id, timestamp, body)}`,
  };
}

describe("verifySvixSignature", () => {
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });

  it("올바른 비밀·현재 타임스탬프 → 통과", () => {
    expect(verifySvixSignature({ secret: SECRET, headers: signed(SECRET, body), rawBody: body, nowMs: NOW })).toEqual({ ok: true });
  });

  it("다른 비밀로 서명 → 실패", () => {
    const r = verifySvixSignature({ secret: SECRET, headers: signed(OTHER_SECRET, body), rawBody: body, nowMs: NOW });
    expect(r.ok).toBe(false);
  });

  it("본문이 1바이트라도 다르면 실패 (원문 바이트 기준)", () => {
    const r = verifySvixSignature({ secret: SECRET, headers: signed(SECRET, body), rawBody: body + " ", nowMs: NOW });
    expect(r.ok).toBe(false);
  });

  it("타임스탬프 300s 초과(과거·미래 모두) → 실패, 300s 이내 skew는 허용", () => {
    for (const off of [-301, 301, -3600]) {
      const r = verifySvixSignature({ secret: SECRET, headers: signed(SECRET, body, ts(off)), rawBody: body, nowMs: NOW });
      expect(r.ok, `offset ${off}`).toBe(false);
    }
    for (const off of [-299, 299]) {
      const r = verifySvixSignature({ secret: SECRET, headers: signed(SECRET, body, ts(off)), rawBody: body, nowMs: NOW });
      expect(r.ok, `offset ${off}`).toBe(true);
    }
  });

  it("복수 v1 항목 중 하나만 맞아도 통과 (키 회전)", () => {
    const stale = svixSign(OTHER_SECRET, "msg_1", ts(), body);
    const good = svixSign(SECRET, "msg_1", ts(), body);
    const headers = { "svix-id": "msg_1", "svix-timestamp": ts(), "svix-signature": `v1,${stale} v1,${good}` };
    expect(verifySvixSignature({ secret: SECRET, headers, rawBody: body, nowMs: NOW })).toEqual({ ok: true });
    const onlyStale = { ...headers, "svix-signature": `v1,${stale} v0,${good}` };
    expect(verifySvixSignature({ secret: SECRET, headers: onlyStale, rawBody: body, nowMs: NOW }).ok).toBe(false);
  });

  it("헤더 누락 → 실패", () => {
    const h = signed(SECRET, body);
    expect(verifySvixSignature({ secret: SECRET, headers: { ...h, "svix-signature": undefined }, rawBody: body, nowMs: NOW }).ok).toBe(false);
    expect(verifySvixSignature({ secret: SECRET, headers: {}, rawBody: body, nowMs: NOW }).ok).toBe(false);
  });
});

describe("mapResendEvent", () => {
  const ev = (type: string, data: Record<string, unknown> = {}) => parseResendEvent({ type, data: { email_id: "re_1", ...data } })!;

  it.each([
    ["email.sent", "sent", null, null],
    ["email.delivered", "delivered", null, null],
    ["email.opened", "opened", null, null],
    ["email.clicked", "clicked", null, null],
    ["email.bounced", "bounced", "invalid_target", "mailbox full"],
    ["email.complained", "unsubscribed", null, "complained"],
    ["email.failed", "failed", "permanent_content", "blocked by policy"],
  ] as const)("%s → %s", (type, status, failureClass, detail) => {
    const m = mapResendEvent(ev(type, { bounce: { message: "mailbox full", type: "Permanent" }, failed: { reason: "blocked by policy" } }));
    expect(m?.status).toBe(status);
    expect(m?.failure_class).toBe(failureClass);
    expect(m?.failure_detail).toBe(detail);
  });

  it("clicked는 click.link를 click_ref로 싣는다", () => {
    expect(mapResendEvent(ev("email.clicked", { click: { link: "https://example.com/a" } }))?.click_ref).toBe("https://example.com/a");
  });

  it("bounce message 없으면 type/subType으로 대체", () => {
    expect(mapResendEvent(ev("email.bounced", { bounce: { type: "Permanent", subType: "General" } }))?.failure_detail).toBe("Permanent/General");
  });

  it("delivery_delayed·미지 타입은 null(무시)", () => {
    expect(mapResendEvent(ev("email.delivery_delayed"))).toBeNull();
    expect(mapResendEvent(ev("contact.created"))).toBeNull();
  });
});

describe("extractMessageId", () => {
  const id = randomUUID();
  it("객체 형태 태그", () => expect(extractMessageId({ onda_message_id: id, campaign: "x" })).toBe(id));
  it("배열 형태 태그", () => expect(extractMessageId([{ name: "campaign", value: "x" }, { name: "onda_message_id", value: id }])).toBe(id));
  it("없거나 UUID가 아니면 null", () => {
    expect(extractMessageId(undefined)).toBeNull();
    expect(extractMessageId({ onda_message_id: "not-a-uuid" })).toBeNull();
    expect(extractMessageId([{ name: "other", value: id }])).toBeNull();
    expect(extractMessageId("string")).toBeNull();
  });
});

describe("resolveOccurredAt", () => {
  it("data.created_at → created_at → now 순으로 ISO 정규화", () => {
    expect(resolveOccurredAt(parseResendEvent({ type: "email.sent", created_at: "2026-01-01T00:00:00Z", data: { created_at: "2026-02-02T03:04:05.000Z" } })!, NOW)).toBe("2026-02-02T03:04:05.000Z");
    expect(resolveOccurredAt(parseResendEvent({ type: "email.sent", created_at: "2026-01-01T00:00:00Z", data: {} })!, NOW)).toBe("2026-01-01T00:00:00.000Z");
    expect(resolveOccurredAt(parseResendEvent({ type: "email.sent", data: { created_at: "garbage" } })!, NOW)).toBe(new Date(NOW).toISOString());
  });
});

// ---------------------------------------------------------------------------
// 컨트롤러: PG/CH/큐 fake로 종단 흐름 검증
// ---------------------------------------------------------------------------

describe("ResendWebhookController", () => {
  const tenantId = randomUUID();
  const appId = randomUUID();
  const messageId = randomUUID();

  beforeAll(() => {
    process.env.ONDA_MASTER_KEY = randomBytes(32).toString("base64");
  });

  function harness(opts: { secret?: string | null; credential?: boolean; chHit?: string | null } = {}) {
    const cred = { api_key: "re_key", from_email: "noreply@example.com", ...(opts.secret === null ? {} : { webhook_secret: opts.secret ?? SECRET }) };
    const env = encryptEnvelope(loadMasterKey(), JSON.stringify(cred));
    const pg = {
      query: vi.fn(async () =>
        opts.credential === false
          ? { rows: [], rowCount: 0 }
          : { rows: [{ tenant_id: tenantId, ciphertext: env.ciphertext, dek_wrapped: env.dekWrapped }], rowCount: 1 },
      ),
    };
    const ch = {
      query: vi.fn(async () => ({ json: async () => (opts.chHit ? [{ message_id: opts.chHit }] : []) })),
    };
    const queue = { publish: vi.fn(async () => ({})) };
    const ctrl = new ResendWebhookController(pg as unknown as Pool, ch as unknown as ClickHouseClient, queue as unknown as QueueProducer);
    return { ctrl, pg, ch, queue };
  }

  function request(event: Record<string, unknown>, secret = SECRET, extraHeaders: Record<string, string> = {}) {
    const raw = JSON.stringify(event);
    return {
      rawBody: Buffer.from(raw, "utf8"),
      body: JSON.parse(raw),
      headers: { ...signed(secret, raw, String(Math.floor(Date.now() / 1000))), ...extraHeaders },
    } as unknown as Parameters<ResendWebhookController["receive"]>[1];
  }

  it("태그의 onda_message_id로 lifecycle 발행 (source=provider_callback, connector=email_resend)", async () => {
    const { ctrl, queue, ch } = harness();
    const res = await ctrl.receive(appId, request({
      type: "email.clicked", created_at: "2026-09-02T11:00:00.000Z",
      data: { email_id: "re_abc", created_at: "2026-09-02T11:00:01.000Z", tags: { onda_message_id: messageId }, click: { link: "https://x.test/p" } },
    }));
    expect(res).toEqual({ accepted: true, status: "clicked" });
    expect(ch.query).not.toHaveBeenCalled();
    expect(queue.publish).toHaveBeenCalledTimes(1);
    const [stream, input] = queue.publish.mock.calls[0] as unknown as [string, { type: string; tenantId: string; appId: string; payload: Record<string, unknown> }];
    expect(stream).toBe(STREAMS.messageLifecycle);
    expect(input.type).toBe("message.lifecycle");
    expect(input.tenantId).toBe(tenantId);
    expect(input.appId).toBe(appId);
    expect(input.payload).toMatchObject({
      message_id: messageId, status: "clicked", occurred_at: "2026-09-02T11:00:01.000Z",
      source: "provider_callback", channel: "email", connector_id: "email_resend",
      provider_message_id: "re_abc", click_ref: "https://x.test/p", fallback_index: 0, failure_class: null,
    });
  });

  it("태그가 없으면 CH message_log.provider_message_id로 역조회", async () => {
    const { ctrl, queue, ch } = harness({ chHit: messageId });
    const res = await ctrl.receive(appId, request({ type: "email.delivered", data: { email_id: "re_abc" } }));
    expect(res).toEqual({ accepted: true, status: "delivered" });
    const call = (ch.query as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { query: string; query_params: Record<string, string> };
    expect(call.query).toMatch(/tenant_id = \{tid:UUID\}/);
    expect(call.query).toMatch(/provider_message_id = \{pid:String\}/);
    expect(call.query_params).toEqual({ tid: tenantId, aid: appId, pid: "re_abc" });
    expect((queue.publish.mock.calls[0] as unknown as [string, { payload: { message_id: string } }])[1].payload.message_id).toBe(messageId);
  });

  it("message_id를 해석하지 못하면 200 {accepted:false} (Resend 재시도 방지)", async () => {
    const { ctrl, queue } = harness({ chHit: null });
    const res = await ctrl.receive(appId, request({ type: "email.delivered", data: { email_id: "re_unknown" } }));
    expect(res).toEqual({ accepted: false, reason: "message_id_unresolved" });
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it("매핑 없는 타입(delivery_delayed)은 200 {accepted:false, ignored}", async () => {
    const { ctrl, queue } = harness();
    const res = await ctrl.receive(appId, request({ type: "email.delivery_delayed", data: { email_id: "re_abc", tags: { onda_message_id: messageId } } }));
    expect(res).toEqual({ accepted: false, ignored: "email.delivery_delayed" });
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it("서명 불일치 → 401, 발행 없음", async () => {
    const { ctrl, queue } = harness();
    await expect(ctrl.receive(appId, request({ type: "email.sent", data: { tags: { onda_message_id: messageId } } }, OTHER_SECRET)))
      .rejects.toMatchObject({ status: 401 });
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it("크리덴셜 없음 / webhook_secret 미등록 → 401", async () => {
    await expect(harness({ credential: false }).ctrl.receive(appId, request({ type: "email.sent", data: {} })))
      .rejects.toMatchObject({ status: 401 });
    await expect(harness({ secret: null }).ctrl.receive(appId, request({ type: "email.sent", data: {} })))
      .rejects.toMatchObject({ status: 401 });
  });

  it("bounced는 failure_class=invalid_target로 실린다", async () => {
    const { ctrl, queue } = harness();
    await ctrl.receive(appId, request({ type: "email.bounced", data: { email_id: "re_b", tags: [{ name: "onda_message_id", value: messageId }], bounce: { message: "User unknown" } } }));
    expect((queue.publish.mock.calls[0] as unknown as [string, { payload: Record<string, unknown> }])[1].payload).toMatchObject({
      status: "bounced", failure_class: "invalid_target", failure_detail: "User unknown",
    });
  });
});
