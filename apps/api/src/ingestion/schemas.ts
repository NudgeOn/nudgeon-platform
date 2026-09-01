import { z } from "zod";

/**
 * Ingestion payload 검증 (PRD-01 6.2, DEV-sub-01 §2).
 * 배치 100건 상한 — 본문 1MB 상한은 express json limit에서 강제.
 */

export const deviceSchema = z
  .object({
    device_id: z.string().uuid(),
    platform: z.enum(["ios", "android"]),
    app_version: z.string().max(64).optional(),
    os_version: z.string().max(64).optional(),
    model: z.string().max(128).optional(),
    locale: z.string().max(32).optional(),
  })
  .strict();

export const trackEventSchema = z
  .object({
    insert_id: z.string().uuid(),
    anon_id: z.string().uuid().nullable().optional(),
    external_id: z.string().min(1).max(256).nullable().optional(),
    event: z.string().min(1).max(128),
    properties: z.record(z.unknown()).optional(),
    client_ts: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((e) => e.anon_id || e.external_id, {
    message: "anon_id 또는 external_id 중 하나는 필수입니다",
  });

export const trackBodySchema = z
  .object({
    batch: z.array(trackEventSchema).min(1).max(100),
    device: deviceSchema.optional(),
  })
  .strict();

export type TrackBody = z.infer<typeof trackBodySchema>;

/** 커스텀 속성: 키 128자·값 1KB 상한, null = unset (PRD-01 4.2) */
export const attributesRecordSchema = z
  .record(z.unknown())
  .superRefine((attrs, ctx) => {
    for (const [key, value] of Object.entries(attrs)) {
      if (key.length === 0 || key.length > 128) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `속성 키 길이 위반 (1~128자): ${key.slice(0, 20)}…`,
        });
      }
      if (value !== null && JSON.stringify(value).length > 1024) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `속성 값 1KB 초과: ${key}`,
        });
      }
    }
  });

export const identifyBodySchema = z
  .object({
    external_id: z.string().min(1).max(256),
    anon_id: z.string().uuid().nullable().optional(),
    attributes: attributesRecordSchema.optional(),
    device: deviceSchema.optional(),
  })
  .strict();

export type IdentifyBody = z.infer<typeof identifyBodySchema>;

export const attributesBodySchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            external_id: z.string().min(1).max(256),
            attributes: attributesRecordSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export type AttributesBody = z.infer<typeof attributesBodySchema>;

/**
 * OS 권한 값 정규화 — 플랫폼 SDK의 원시 문자열을 서버 표준(granted/denied/undetermined)으로 맞춘다.
 * iOS UNAuthorizationStatus(authorized/provisional/ephemeral/notDetermined)와 Android 값을 흡수한다
 * (재검증: iOS 토큰 권한 값 불일치로 정상 등록 실패). 알 수 없는 값은 그대로 두어 enum에서 400.
 */
const osPermissionSchema = z
  .preprocess((v) => {
    if (typeof v !== "string") return v;
    const map: Record<string, "granted" | "denied" | "undetermined"> = {
      granted: "granted",
      authorized: "granted",
      provisional: "granted",
      ephemeral: "granted",
      denied: "denied",
      undetermined: "undetermined",
      notdetermined: "undetermined",
    };
    return map[v.toLowerCase().replace(/[\s_-]/g, "")] ?? v;
  }, z.enum(["granted", "denied", "undetermined"]))
  .optional();

export const tokenBodySchema = z
  .object({
    device: deviceSchema,
    push_token: z.string().min(1).max(4096),
    os_permission: osPermissionSchema,
    anon_id: z.string().uuid().nullable().optional(),
    external_id: z.string().min(1).max(256).nullable().optional(),
  })
  .strict()
  .refine((b) => b.anon_id || b.external_id, {
    message: "anon_id 또는 external_id 중 하나는 필수입니다",
  });

export type TokenBody = z.infer<typeof tokenBodySchema>;

/** 수신 동의 변경 (setPushOptIn 서버 동기화 — R-03). anon_id/external_id 중 하나 필수. */
export const subscriptionBodySchema = z
  .object({
    channel: z.literal("push").default("push"),
    state: z.enum(["opted_in", "unsubscribed"]),
    anon_id: z.string().uuid().nullable().optional(),
    external_id: z.string().min(1).max(256).nullable().optional(),
  })
  .strict()
  .refine((b) => b.anon_id || b.external_id, {
    message: "anon_id 또는 external_id 중 하나는 필수입니다",
  });

export type SubscriptionBody = z.infer<typeof subscriptionBodySchema>;

/** 로그아웃/reset — 디바이스 토큰 분리(이후 이전 사용자 대상 발송 차단, R-03). */
export const logoutBodySchema = z
  .object({ device_id: z.string().uuid() })
  .strict();

export type LogoutBody = z.infer<typeof logoutBodySchema>;
