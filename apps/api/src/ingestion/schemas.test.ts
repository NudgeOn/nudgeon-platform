import { describe, expect, it } from "vitest";
import { trackBodySchema } from "./schemas";

const validEvent = {
  insert_id: "33333333-3333-4333-8333-333333333333",
  anon_id: "55555555-5555-4555-8555-555555555555",
  event: "product_viewed",
  properties: { price: 12900 },
  client_ts: "2026-08-30T09:12:33.120+09:00",
};

describe("trackBodySchema", () => {
  it("유효한 배치를 통과시킨다", () => {
    const r = trackBodySchema.safeParse({
      batch: [validEvent],
      device: { device_id: "44444444-4444-4444-8444-444444444444", platform: "ios" },
    });
    expect(r.success).toBe(true);
  });

  it("빈 배치를 거부한다", () => {
    expect(trackBodySchema.safeParse({ batch: [] }).success).toBe(false);
  });

  it("101건 배치를 거부한다 (상한 100)", () => {
    const batch = Array.from({ length: 101 }, () => validEvent);
    expect(trackBodySchema.safeParse({ batch }).success).toBe(false);
  });

  it("anon_id·external_id 둘 다 없으면 거부한다", () => {
    const r = trackBodySchema.safeParse({
      batch: [{ ...validEvent, anon_id: undefined, external_id: undefined }],
    });
    expect(r.success).toBe(false);
  });

  it("알 수 없는 필드를 거부한다 (strict)", () => {
    const r = trackBodySchema.safeParse({
      batch: [{ ...validEvent, unknown_field: 1 }],
    });
    expect(r.success).toBe(false);
  });

  it("client_ts가 ISO8601이 아니면 거부한다", () => {
    const r = trackBodySchema.safeParse({
      batch: [{ ...validEvent, client_ts: "어제" }],
    });
    expect(r.success).toBe(false);
  });
});
