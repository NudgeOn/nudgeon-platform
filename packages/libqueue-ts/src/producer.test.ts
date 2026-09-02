import { describe, expect, it, vi } from "vitest";
import { STREAMS } from "@onda/queue-schemas";
import { EnvelopeValidationError, QueueProducer } from "./producer.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const INSERT = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const DEVICE = "55555555-5555-4555-8555-555555555555";

function makeProducer() {
  const xadd = vi.fn().mockResolvedValue("1-0");
  const producer = new QueueProducer({ xadd });
  return { producer, xadd };
}

const validPayload = {
  endpoint: "track",
  request_id: REQUEST,
  device: { device_id: DEVICE, platform: "ios" },
  events: [
    {
      insert_id: INSERT,
      anon_id: null,
      external_id: "user-1",
      event: "product_viewed",
      properties: { price: 12900 },
      client_ts: "2026-08-30T09:12:33.120+09:00",
    },
  ],
};

describe("QueueProducer.publish", () => {
  it("유효한 ingest.batch를 envelope으로 감싸 XADD한다", async () => {
    const { producer, xadd } = makeProducer();
    const envelope = await producer.publish(STREAMS.ingest, {
      type: "ingest.batch",
      tenantId: TENANT,
      appId: APP,
      payload: validPayload,
    });

    expect(envelope.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(envelope.schema_ver).toBe(1);
    expect(envelope.trace_id).toBeTruthy();
    expect(xadd).toHaveBeenCalledOnce();

    const args = xadd.mock.calls[0]!;
    expect(args[0]).toBe("stream:ingest");
    // MAXLEN ~ <n> * envelope <json>
    expect(args.slice(1, 4)).toEqual(["MAXLEN", "~", 1_000_000]);
    const stored = JSON.parse(args[6] as string);
    expect(stored).toEqual(envelope);
  });

  it("trace_id를 넘기면 그대로 전파한다", async () => {
    const { producer } = makeProducer();
    const envelope = await producer.publish(STREAMS.ingest, {
      type: "ingest.batch",
      tenantId: TENANT,
      appId: APP,
      traceId: "trace-abc",
      payload: validPayload,
    });
    expect(envelope.trace_id).toBe("trace-abc");
  });

  it("payload 스키마 위반은 EnvelopeValidationError로 거부한다", async () => {
    const { producer, xadd } = makeProducer();
    await expect(
      producer.publish(STREAMS.ingest, {
        type: "ingest.batch",
        tenantId: TENANT,
        appId: APP,
        payload: { endpoint: "nope", request_id: REQUEST },
      }),
    ).rejects.toThrow(EnvelopeValidationError);
    expect(xadd).not.toHaveBeenCalled();
  });

  it("tenant_id가 uuid가 아니면 envelope 검증에서 거부한다", async () => {
    const { producer, xadd } = makeProducer();
    await expect(
      producer.publish(STREAMS.ingest, {
        type: "ingest.batch",
        tenantId: "not-a-uuid",
        appId: APP,
        payload: validPayload,
      }),
    ).rejects.toThrow(EnvelopeValidationError);
    expect(xadd).not.toHaveBeenCalled();
  });

  it("message.lifecycle payload는 v1 스키마로 검증한다 (공급자 콜백 경로)", async () => {
    const { producer, xadd } = makeProducer();
    const payload = {
      message_id: INSERT,
      status: "delivered",
      occurred_at: "2026-09-02T11:00:01.000Z",
      source: "provider_callback",
      channel: "email",
      connector_id: "email_resend",
      provider_message_id: "re_abc",
      user_id: null,
      endpoint_id: null,
      failure_class: null,
      failure_detail: null,
      fallback_index: 0,
      attempt: null,
      cost: null,
      click_ref: null,
    };
    const envelope = await producer.publish(STREAMS.messageLifecycle, {
      type: "message.lifecycle",
      tenantId: TENANT,
      appId: APP,
      payload,
    });
    expect(envelope.type).toBe("message.lifecycle");
    expect(xadd.mock.calls[0]![0]).toBe("stream:message.lifecycle");
    await expect(
      producer.publish(STREAMS.messageLifecycle, {
        type: "message.lifecycle",
        tenantId: TENANT,
        appId: APP,
        payload: { ...payload, status: "exploded" },
      }),
    ).rejects.toThrow(EnvelopeValidationError);
  });

  it("이벤트 배치 100건 초과는 거부한다", async () => {
    const { producer } = makeProducer();
    const events = Array.from({ length: 101 }, (_, i) => ({
      insert_id: `${String(i).padStart(8, "0")}-3333-4333-8333-333333333333`,
      event: "e",
      client_ts: "2026-08-30T00:00:00Z",
    }));
    await expect(
      producer.publish(STREAMS.ingest, {
        type: "ingest.batch",
        tenantId: TENANT,
        appId: APP,
        payload: { endpoint: "track", request_id: REQUEST, events },
      }),
    ).rejects.toThrow(EnvelopeValidationError);
  });
});
