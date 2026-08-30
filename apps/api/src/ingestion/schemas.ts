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

export const tokenBodySchema = z
  .object({
    device: deviceSchema,
    push_token: z.string().min(1).max(4096),
    os_permission: z.enum(["granted", "denied", "undetermined"]).optional(),
    anon_id: z.string().uuid().nullable().optional(),
    external_id: z.string().min(1).max(256).nullable().optional(),
  })
  .strict()
  .refine((b) => b.anon_id || b.external_id, {
    message: "anon_id 또는 external_id 중 하나는 필수입니다",
  });

export type TokenBody = z.infer<typeof tokenBodySchema>;
