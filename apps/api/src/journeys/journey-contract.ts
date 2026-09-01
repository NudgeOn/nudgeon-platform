import { createHash } from "node:crypto";
import { z } from "zod";
import type { SegmentDSL } from "@onda/segment-dsl";
import type { JourneyDefinition } from "@onda/journey-model";

const identifierSchema = z.string().min(1).max(128).refine(value => Buffer.byteLength(value, "utf8") <= 128, {
  message: "ID는 UTF-8 최대 128바이트입니다",
});
const identity = { id: identifierSchema.optional() };
const nodeSchema = z.discriminatedUnion("type", [
  z.object({ ...identity, type: z.literal("message"), push: z.object({
    title: z.string().max(256), body: z.string().max(2048),
    image_url: z.string().optional(), deep_link: z.string().optional(),
  }) }).strict(),
  z.object({ ...identity, type: z.literal("delay"), duration_seconds: z.number().int() }).strict(),
  z.object({ ...identity, type: z.literal("branch"), condition: z.custom<SegmentDSL>(
    value => value !== null && typeof value === "object" && !Array.isArray(value),
  ) }).strict(),
  z.object({ ...identity, type: z.literal("event_wait"), event_name: z.string().max(200), timeout_seconds: z.number().int() }).strict(),
  z.object({ ...identity, type: z.literal("ab_split"), variants: z.array(z.object({
    id: identifierSchema, label: z.string().max(100), weight: z.number().int(),
  }).strict()).max(4) }).strict(),
]);

export const definitionSchema = z.object({
  schema_version: z.union([z.literal(1), z.literal(2)]).optional(),
  entry: z.object({
    type: z.enum(["blast", "trigger"]), segment_id: z.string().uuid().optional(),
    trigger_event: z.string().max(200).optional(),
  }),
  nodes: z.array(nodeSchema).max(65_535),
  start_node_id: identifierSchema.nullable().optional(),
  edges: z.array(z.object({
    id: identifierSchema, source: identifierSchema,
    source_port: identifierSchema, target: identifierSchema.nullable(),
  }).strict()).max(262_140).optional(),
  exit: z.object({ conversion_event: z.string().max(200).optional() }).default({}),
  settings: z.object({
    category: z.enum(["marketing", "transactional"]),
    reentry: z.union([z.literal("never"), z.literal("always"), z.object({ after_days: z.number().int().positive() })]).default("never"),
  }),
}).strict().superRefine((def, ctx) => {
  if (def.schema_version === 2) {
    if (def.start_node_id === undefined || !def.edges || def.nodes.some(node => !node.id)) {
      ctx.addIssue({ code: "custom", message: "v2 정의에는 단계 ID·시작 단계·연결 정보가 필요합니다" });
    }
  } else if (def.edges !== undefined || def.start_node_id !== undefined || def.nodes.some(node => !["message", "delay"].includes(node.type))) {
    ctx.addIssue({ code: "custom", message: "그래프 정의는 schema_version: 2가 필요합니다" });
  }
});

export const upsertSchema = z.object({ name: z.string().trim().min(1).max(200), definition: definitionSchema });
export const activationSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/).optional() });

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
export function draftRevision(name: string, definition: JourneyDefinition): string {
  return createHash("sha256").update(JSON.stringify(canonical({ name, definition }))).digest("hex");
}

export function journeyCapabilities(graphV2: boolean) {
  return { graph_v2: graphV2, supported_node_types: graphV2
    ? ["message", "delay", "branch", "event_wait", "ab_split"] : ["message", "delay"] };
}
