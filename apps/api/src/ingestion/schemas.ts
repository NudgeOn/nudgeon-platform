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
