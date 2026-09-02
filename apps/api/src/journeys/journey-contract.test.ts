import { describe, expect, it } from "vitest";
import { toGraphDefinition, type JourneyDefinition } from "@nudgeon/journey-model";
import { activationSchema, draftRevision, upsertSchema } from "./journey-contract";

const legacy: JourneyDefinition = { entry: { type: "trigger", trigger_event: "start" }, nodes: [{ type: "message", push: { title: "hi", body: "there", deep_link: "nudgeon://home" } }], exit: {}, settings: { category: "transactional", reentry: "never" } };
describe("journey HTTP contract", () => {
  it("retains IDs, edges, condition DSL and event timing across API parsing", () => {
    const definition = toGraphDefinition(legacy);
    definition.nodes.unshift({ id: "wait", type: "event_wait", event_name: "purchase", timeout_seconds: 86400 });
    definition.start_node_id = "wait";
    definition.edges.push({ id: "matched", source: "wait", source_port: "matched", target: "legacy-0" }, { id: "timeout", source: "wait", source_port: "timeout", target: null });
    expect(upsertSchema.parse({ name: "그래프", definition }).definition).toEqual(definition);
  });
  it("does not silently drop an unversioned graph or unknown schema versions", () => {
    const definition = toGraphDefinition(legacy);
    expect(upsertSchema.safeParse({ name: "x", definition: { ...definition, schema_version: undefined } }).success).toBe(false);
    expect(upsertSchema.safeParse({ name: "x", definition: { ...definition, schema_version: 3 } }).success).toBe(false);
    expect(upsertSchema.parse({ name: "v1", definition: legacy }).definition).toEqual(legacy);
  });
  it("rejects multibyte IDs that exceed the worker's byte limit", () => {
    const definition = toGraphDefinition(legacy);
    definition.nodes[0]!.id = "가".repeat(43);
    expect(upsertSchema.safeParse({ name: "x", definition }).success).toBe(false);
    definition.nodes[0]!.id = "가".repeat(42);
    expect(upsertSchema.safeParse({ name: "x", definition }).success).toBe(true);
  });
  it("draft revision is independent of JSON key order, but changes with graph or name", () => {
    const first = draftRevision("x", legacy);
    const reordered = { settings: legacy.settings, exit: {}, nodes: legacy.nodes, entry: legacy.entry };
    expect(draftRevision("x", reordered)).toBe(first);
    expect(draftRevision("renamed", legacy)).not.toBe(first);
    expect(draftRevision("x", toGraphDefinition(legacy))).not.toBe(first);
    expect(activationSchema.parse({ revision: first }).revision).toBe(first);
  });
});
