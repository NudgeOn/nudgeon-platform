import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { LifecycleFailureClass, LifecycleStatus } from "@onda/queue-schemas";

/**
 * Resend 웹훅 → message.lifecycle 변환의 순수 함수 모음 (컨트롤러와 분리해 단위 테스트).
 * - 서명: Resend는 Svix 규약 — headers svix-id / svix-timestamp / svix-signature,
 *   signed = `${id}.${timestamp}.${rawBody}`, key = base64(secret without "whsec_"), HMAC-SHA256 → base64.
 * - 이벤트 → 상태 매핑은 message.lifecycle.v1 enum으로 수렴한다.
 */

/** svix-timestamp 허용 오차(초). 양방향(시계 skew) 허용. */
export const SVIX_TOLERANCE_SECONDS = 300;

export interface SvixHeaders {
  "svix-id"?: string | string[];
  "svix-timestamp"?: string | string[];
  "svix-signature"?: string | string[];
}

export type SvixVerifyResult = { ok: true } | { ok: false; reason: string };

function header(h: SvixHeaders, name: keyof SvixHeaders): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

/** whsec_ 접두 제거 후 base64 디코드 — Svix 서명 키 */
export function svixKey(secret: string): Buffer {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(raw, "base64");
}

export function svixSign(secret: string, id: string, timestamp: string, rawBody: Buffer | string): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return createHmac("sha256", svixKey(secret))
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, "utf8"), body]))
    .digest("base64");
}

/**
 * Svix 서명 검증. 어떤 `v1,<sig>` 항목이든 하나만 일치하면 통과(키 회전 중 복수 서명).
 * 비교는 상수 시간(timingSafeEqual).
 */
export function verifySvixSignature(input: {
  secret: string;
  headers: SvixHeaders;
  rawBody: Buffer | string;
  nowMs?: number;
}): SvixVerifyResult {
  const id = header(input.headers, "svix-id");
  const ts = header(input.headers, "svix-timestamp");
  const sigHeader = header(input.headers, "svix-signature");
  if (!id || !ts || !sigHeader) {
    return { ok: false, reason: "svix 헤더(svix-id/svix-timestamp/svix-signature) 누락" };
  }
  if (!/^\d+$/.test(ts)) return { ok: false, reason: "svix-timestamp 형식 오류" };
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - Number(ts)) > SVIX_TOLERANCE_SECONDS) {
    return { ok: false, reason: `svix-timestamp가 허용 오차(${SVIX_TOLERANCE_SECONDS}s)를 벗어남` };
  }
  if (svixKey(input.secret).length === 0) return { ok: false, reason: "webhook_secret 형식 오류" };
  const expected = Buffer.from(svixSign(input.secret, id, ts, input.rawBody), "utf8");
  for (const entry of sigHeader.split(/\s+/)) {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const candidate = Buffer.from(sig, "utf8");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: "서명 불일치" };
}

// ---------------------------------------------------------------------------
// 이벤트 파싱·매핑
// ---------------------------------------------------------------------------

const resendEventSchema = z
  .object({
    type: z.string().min(1),
    created_at: z.string().optional(),
    data: z
      .object({
        email_id: z.string().optional(),
        created_at: z.string().optional(),
        tags: z.unknown().optional(),
        click: z.object({ link: z.string().optional() }).passthrough().optional(),
        bounce: z
          .object({ message: z.string().optional(), type: z.string().optional(), subType: z.string().optional() })
          .passthrough()
          .optional(),
        failed: z.object({ reason: z.string().optional() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type ResendEvent = z.infer<typeof resendEventSchema>;

export function parseResendEvent(body: unknown): ResendEvent | null {
  const parsed = resendEventSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export interface MappedLifecycle {
  status: LifecycleStatus;
  failure_class: LifecycleFailureClass | null;
  failure_detail: string | null;
  click_ref: string | null;
}

const clip = (s: string | undefined | null, max = 1024): string | null => (s ? s.slice(0, max) : null);

/**
 * Resend 이벤트 타입 → lifecycle 상태. 매핑 없는 타입(email.delivery_delayed 등)은 null → 무시(200).
 */
export function mapResendEvent(event: ResendEvent): MappedLifecycle | null {
  const base: MappedLifecycle = { status: "sent", failure_class: null, failure_detail: null, click_ref: null };
  switch (event.type) {
    case "email.sent":
      return { ...base, status: "sent" };
    case "email.delivered":
      return { ...base, status: "delivered" };
    case "email.opened":
      return { ...base, status: "opened" };
    case "email.clicked":
      return { ...base, status: "clicked", click_ref: clip(event.data.click?.link) };
    case "email.bounced": {
      const b = event.data.bounce;
      const detail = b?.message ?? [b?.type, b?.subType].filter(Boolean).join("/");
      return { ...base, status: "bounced", failure_class: "invalid_target", failure_detail: clip(detail) };
    }
    case "email.complained":
      return { ...base, status: "unsubscribed", failure_detail: "complained" };
    case "email.failed":
      return {
        ...base,
        status: "failed",
        failure_class: "permanent_content",
        failure_detail: clip(event.data.failed?.reason),
      };
    default:
      return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 발송 시 실은 태그에서 Onda message_id 추출.
 * Resend는 객체 형태 `{onda_message_id: "<uuid>"}`(웹훅 payload)와
 * 배열 형태 `[{name, value}]`(API 요청 형식) 둘 다 존재하므로 모두 수용한다.
 */
export function extractMessageId(tags: unknown): string | null {
  let value: unknown;
  if (Array.isArray(tags)) {
    const hit = tags.find(
      (t) => t && typeof t === "object" && (t as { name?: unknown }).name === "onda_message_id",
    ) as { value?: unknown } | undefined;
    value = hit?.value;
  } else if (tags && typeof tags === "object") {
    value = (tags as Record<string, unknown>).onda_message_id;
  }
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
}

/** 발생 시각: data.created_at → event.created_at → now. ISO 8601로 정규화 (스키마 date-time). */
export function resolveOccurredAt(event: ResendEvent, nowMs: number = Date.now()): string {
  for (const candidate of [event.data.created_at, event.created_at]) {
    if (!candidate) continue;
    const ms = Date.parse(candidate);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return new Date(nowMs).toISOString();
}
