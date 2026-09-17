import { z } from "zod";
export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("foreground") }).strict(),
  z
    .object({
      type: z.literal("screen"),
      name: z.string().trim().min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("event"),
      name: z.string().trim().min(1).max(100),
    })
    .strict(),
]);
export const campaignConfigSchema = z
  .object({
    platforms: z
      .array(z.enum(["ios", "android"]))
      .min(1)
      .max(2)
      .refine((v) => new Set(v).size === v.length),
    trigger: triggerSchema,
    starts_at: z.string().datetime({ offset: true }),
    ends_at: z.string().datetime({ offset: true }),
    cooldown_seconds: z.number().int().min(60).max(31536000),
    max_per_day: z.number().int().min(1).max(10),
    max_total: z.number().int().min(1).max(100),
    priority: z.number().int().min(0).max(100).default(0),
  })
  .strict()
  .refine((c) => Date.parse(c.ends_at) > Date.parse(c.starts_at), {
    message: "End must be after start",
  });
export const campaignSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    revision_id: z.string().uuid(),
    config: campaignConfigSchema,
  })
  .strict();
export const decisionSchema = z
  .object({
    request_key: z.string().uuid(),
    session_id: z.string().uuid(),
    trigger: triggerSchema,
  })
  .strict();
export type CampaignConfig = z.infer<typeof campaignConfigSchema>;
export interface Installation {
  id: string;
  tenant: string;
  app: string;
  platform: "ios" | "android";
}
