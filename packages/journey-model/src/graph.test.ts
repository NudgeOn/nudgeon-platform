import { describe, expect, it } from "vitest";
import { collectPublishedABNodes, hasErrors, toGraphDefinition, validateBranchCondition, validateJourney, validatePublishedABNodes, type JourneyGraphDefinition, type JourneyDefinition } from "./index";

function graph(): JourneyGraphDefinition {
  return {
    schema_version: 2, entry: { type: "trigger", trigger_event: "start" }, start_node_id: "branch",
    nodes: [
      { id: "branch", type: "branch", condition: { version: 1, operator: "AND", groups: [{ operator: "AND", conditions: [{ type: "event", event: "purchase", op: "performed", window_days: 30 }] }] } },
      { id: "wait", type: "event_wait", event_name: "purchase", timeout_seconds: 86400 },
      { id: "split", type: "ab_split", variants: [{ id: "a", label: "A", weight: 50 }, { id: "b", label: "B", weight: 50 }] },
      { id: "thanks", type: "message", push: { title: "감사합니다", body: "구매 완료" } },
      { id: "reminder", type: "message", push: { title: "다시 만나세요", body: "혜택 확인" } },
    ],
    edges: [
      { id: "1", source: "branch", source_port: "true", target: "thanks" },
      { id: "2", source: "branch", source_port: "false", target: "wait" },
      { id: "3", source: "wait", source_port: "matched", target: "thanks" },
      { id: "4", source: "wait", source_port: "timeout", target: "split" },
      { id: "5", source: "split", source_port: "a", target: "reminder" },
      { id: "6", source: "split", source_port: "b", target: "reminder" },
      { id: "7", source: "thanks", source_port: "next", target: null },
      { id: "8", source: "reminder", source_port: "next", target: null },
    ], exit: {}, settings: { category: "transactional", reentry: "always" },
  };
}

describe("exclusive journey DAG", () => {
  it("accepts condition, event timeout and A/B paths with OR merges", () => {
    expect(validateJourney(graph())).toEqual([]);
  });
  it.each([
    ["cycle", (g: JourneyGraphDefinition) => { g.edges[7]!.target = "branch"; }],
    ["missing output", (g: JourneyGraphDefinition) => { g.edges.splice(5, 1); }],
    ["fan-out", (g: JourneyGraphDefinition) => { g.edges.push({ ...g.edges[0]!, id: "dup-port", target: "reminder" }); }],
    ["unknown target", (g: JourneyGraphDefinition) => { g.edges[0]!.target = "deleted"; }],
    ["orphan", (g: JourneyGraphDefinition) => { g.nodes.push({ id: "orphan", type: "message", push: { title: "x", body: "y" } }); g.edges.push({ id: "orphan-edge", source: "orphan", source_port: "next", target: null }); }],
    ["duplicate ID", (g: JourneyGraphDefinition) => { g.nodes[1]!.id = "branch"; }],
    ["invalid ratio", (g: JourneyGraphDefinition) => { const n = g.nodes[2]!; if (n.type === "ab_split") n.variants[0]!.weight = 40; }],
  ])("rejects %s before activation", (_, mutate) => {
    const def = graph(); mutate(def); expect(hasErrors(validateJourney(def))).toBe(true);
  });
  it("preserves all legacy settings, assets and ordering without mutating the source", () => {
    const legacy: JourneyDefinition = {
      entry: { type: "blast", segment_id: "old-segment" },
      nodes: [{ type: "message", push: { title: "t", body: "b", deep_link: "onda://offer", image_url: "https://example.test/img.png" } }, { type: "delay", duration_seconds: 12 }],
      settings: { category: "marketing", reentry: { after_days: 3 } }, exit: { conversion_event: "purchase" },
    };
    const before = JSON.stringify(legacy); const converted = toGraphDefinition(legacy);
    expect(converted.edges).toEqual([{ id: "legacy-edge-0", source: "legacy-0", source_port: "next", target: "legacy-1" }, { id: "legacy-edge-1", source: "legacy-1", source_port: "next", target: null }]);
    expect(converted.nodes[0]).toMatchObject(legacy.nodes[0]!);
    expect(converted.exit).toEqual(legacy.exit); expect(converted.settings).toEqual(legacy.settings);
    expect(JSON.stringify(legacy)).toBe(before);
  });
  it("does not linearize or repair persisted graph data", () => {
    const def = graph(); def.edges[0]!.target = "missing";
    expect(toGraphDefinition(def)).toEqual(def);
    expect(hasErrors(validateJourney(toGraphDefinition(def)))).toBe(true);
  });
  it("requires v2 for all non-linear node types", () => {
    const def: JourneyDefinition = graph(); delete def.schema_version;
    expect(hasErrors(validateJourney(def))).toBe(true);
  });
  it("uses the worker's UTF-8 byte limit for persistent node IDs", () => {
    for (const [id, accepted] of [["가".repeat(42), true], ["가".repeat(43), false], ["a".repeat(128), true]] as const) {
      const def = graph();
      def.nodes[0]!.id = id; def.start_node_id = id;
      for (const edge of def.edges) if (edge.source === "branch") edge.source = id;
      expect(hasErrors(validateJourney(def))).toBe(!accepted);
    }
  });
  it("warns that global conversion exit wins over event wait", () => {
    const def = graph(); def.exit.conversion_event = "purchase";
    expect(validateJourney(def)).toContainEqual(expect.objectContaining({ level: "warning", node_id: "wait" }));
  });
  it("rejects unsafe reentry day ranges for new graph versions", () => {
    const def = graph(); def.settings.reentry = { after_days: 106_751 };
    expect(hasErrors(validateJourney(def))).toBe(false);
    def.settings.reentry.after_days = Number.MAX_SAFE_INTEGER;
    expect(validateJourney(def)).toContainEqual(expect.objectContaining({ level: "error", field: "settings.reentry.after_days" }));
  });
});

describe("published experiments", () => {
  it("allows label edits but locks weights, variant identities and order", () => {
    const initial = graph(); const published = collectPublishedABNodes([initial]);
    const changed = graph(); const node = changed.nodes[2]!;
    if (node.type !== "ab_split") throw new Error("fixture");
    node.variants[0]!.label = "새 이름";
    expect(validatePublishedABNodes(changed, published)).toEqual([]);
    node.variants.reverse();
    expect(validatePublishedABNodes(changed, published)[0]?.node_id).toBe("split");
    node.id = "new-experiment";
    expect(validatePublishedABNodes(changed, published)).toEqual([]);
    expect(initial.nodes[2]).not.toEqual(node);
  });
});

describe("branch condition scope", () => {
  const dsl = (condition: unknown) => ({ version: 1, operator: "AND", groups: [{ operator: "AND", conditions: [condition] }] }) as Parameters<typeof validateBranchCondition>[0];
  it("defaults event lookback to 30 days, but rejects unsupported counts and properties", () => {
    expect(validateBranchCondition(dsl({ type: "event", event: "purchase", op: "performed" }))).toEqual([]);
    for (const condition of [
      { type: "event", event: "purchase", op: "count_lte", value: 0 },
      { type: "event", event: "purchase", op: "performed", window_days: 181 },
      { type: "event", event: "purchase", op: "performed", properties: { order: 1 } },
      { type: "attribute", key: "score", op: "gte", value: "100" },
      { type: "attribute", key: "date", op: "before", value: "not a date" },
    ]) expect(validateBranchCondition(dsl(condition)).length).toBeGreaterThan(0);
  });
  it("accepts exactly the worker's ISO date forms, never locale dates or missing offsets", () => {
    for (const value of ["2026-08-31", "2026-08-31T12:00:00+09:00", "2026-08-31T03:00:00.123456789Z"]) {
      expect(validateBranchCondition(dsl({ type: "attribute", key: "joined", op: "before", value }))).toEqual([]);
    }
    for (const value of ["08/31/2026", "2026-08-31T12:00", "2026-08-31T12:00:00", "2026-02-30", "2026-08-31T24:00:00Z"]) {
      expect(validateBranchCondition(dsl({ type: "attribute", key: "joined", op: "before", value })).length).toBeGreaterThan(0);
    }
  });
  it("rejects extra DSL and group keys before the strict worker decoder sees them", () => {
    const value = dsl({ type: "event", event: "purchase", op: "performed" });
    expect(validateBranchCondition({ ...value, extra: true } as typeof value).length).toBeGreaterThan(0);
    const nested = structuredClone(value);
    Object.assign(nested.groups[0]!, { extra: true });
    expect(validateBranchCondition(nested).length).toBeGreaterThan(0);
  });
});
