import { describe, expect, it } from "vitest";
import { outputPorts, toGraphDefinition, validateJourney } from "@nudgeon/journey-model";
import { createJourneyNode } from "./journey-editor-model";
import { canMoveNode, connectRoute, connectionIssue, ENTRY_EDGE_ID, entryEdgeId, graphReadIssue, insertOnEdge,
  moveLinearNode, pathDurationRange, previewRemoval, reachableNodes, renewExperiment, type GraphDefinition } from "./journey-graph";
import { journeyStructureKey, layoutJourney } from "./journey-layout";

function fork(): GraphDefinition {
  return {
    schema_version: 2, start_node_id: "split", entry: { type: "trigger", trigger_event: "signed_up" },
    settings: { category: "marketing", reentry: "always" }, exit: {},
    nodes: [
      { id: "split", type: "ab_split", variants: [{ id: "a", label: "A", weight: 50 }, { id: "b", label: "B", weight: 50 }] },
      { id: "fast", type: "delay", duration_seconds: 60 },
      { id: "slow", type: "delay", duration_seconds: 600 },
      { id: "shared", type: "message", push: { title: "공통 알림", body: "한 경로로 진행합니다." } },
    ],
    edges: [
      { id: "a-edge", source: "split", source_port: "a", target: "fast" },
      { id: "b-edge", source: "split", source_port: "b", target: "slow" },
      { id: "fast-edge", source: "fast", source_port: "next", target: "shared" },
      { id: "slow-edge", source: "slow", source_port: "next", target: "shared" },
      { id: "shared-edge", source: "shared", source_port: "next", target: null },
    ],
  };
}

describe("exclusive DAG editing", () => {
  it("inserts into exactly the chosen route and keeps the other branch and shared continuation", () => {
    const original = fork();
    const snapshot = structuredClone(original);
    const message = { id: "extra", type: "message" as const, push: { title: "경로 A", body: "한 경로에만 추가" } };
    const next = insertOnEdge(original, "a-edge", message);
    expect(next.edges.find((edge) => edge.id === "a-edge")?.target).toBe("extra");
    expect(next.edges.find((edge) => edge.source === "extra")?.target).toBe("fast");
    expect(next.edges.find((edge) => edge.id === "b-edge")).toEqual(original.edges[1]);
    expect(reachableNodes(next).size).toBe(5);
    expect(validateJourney(next).filter((issue) => issue.level === "error")).toEqual([]);
    expect(original).toEqual(snapshot);
  });

  it.each(["branch", "event_wait", "ab_split"] as const)("inserts %s before the start without dropping the original continuation", (type) => {
    const original = fork();
    const node = createJourneyNode(type);
    const next = insertOnEdge(original, ENTRY_EDGE_ID, node);
    expect(next.start_node_id).toBe(node.id);
    const outputs = next.edges.filter((edge) => edge.source === node.id);
    expect(outputs.map((edge) => edge.source_port)).toEqual(outputPorts(node).map((port) => port.id));
    expect(outputs.every((edge) => edge.target === "split")).toBe(true);
    expect(graphReadIssue(next)).toBeNull();
  });

  it("keeps persisted edge identities distinct from the virtual entry connector", () => {
    const original = fork();
    original.edges[0]!.id = ENTRY_EDGE_ID;
    const node = createJourneyNode("delay");
    const routeEdit = insertOnEdge(original, ENTRY_EDGE_ID, node);
    expect(routeEdit.start_node_id).toBe("split");
    expect(routeEdit.edges.find((edge) => edge.source === node.id)?.target).toBe("fast");
    const entryEdit = insertOnEdge(original, entryEdgeId(original), node);
    expect(entryEdit.start_node_id).toBe(node.id);
    expect(entryEdit.edges.find((edge) => edge.source === node.id)?.target).toBe("split");
  });

  it("rejects loops and route changes that would silently orphan a live branch", () => {
    const definition = fork();
    expect(connectionIssue(definition, "shared", "next", "split")).toContain("되돌아가는");
    expect(connectionIssue(definition, "split", "a", "shared")).toContain("분리");
    expect(() => connectRoute(definition, "shared", "next", "split")).toThrow();
    expect(connectionIssue(definition, "fast", "next", "slow")).toBeNull();
    const merged = connectRoute(definition, "fast", "next", "slow");
    expect(graphReadIssue(merged)).toBeNull();
  });

  it("previews branch deletion, removes only its exclusive discarded descendants, and preserves the merge", () => {
    const original = fork();
    expect(() => previewRemoval(original, "split")).toThrow("보존할 경로");
    const result = previewRemoval(original, "split", "a");
    expect(result.removed.map((node) => node.id)).toEqual(["split", "slow"]);
    expect(result.sharedKept.map((node) => node.id)).toEqual(["shared"]);
    expect(result.definition.start_node_id).toBe("fast");
    expect(result.definition.nodes.map((node) => node.id)).toEqual(["fast", "shared"]);
    expect(graphReadIssue(result.definition)).toBeNull();
    expect(original.nodes).toHaveLength(4);
  });

  it("preserves descendants also reached by an upstream route when deleting a nested decision", () => {
    const original = fork();
    const branch = createJourneyNode("branch");
    const nested = insertOnEdge(original, "a-edge", branch);
    nested.edges.find((edge) => edge.source === branch.id && edge.source_port === "false")!.target = "slow";
    const result = previewRemoval(nested, branch.id!, "true");
    expect(result.removed.map((node) => node.id)).toEqual([branch.id]);
    expect(result.definition.nodes.some((node) => node.id === "slow")).toBe(true);
    expect(result.definition.edges.find((edge) => edge.id === "b-edge")?.target).toBe("slow");
  });

  it("cannot delete the final remaining stage", () => {
    const graph = toGraphDefinition({ entry: { type: "trigger", trigger_event: "event" },
      settings: { category: "marketing", reentry: "never" }, exit: {},
      nodes: [{ type: "message", push: { title: "hello", body: "world" } }] });
    expect(() => previewRemoval(graph, graph.start_node_id!)).toThrow("최소 하나");
  });

  it("swaps adjacent linear stages by rewiring without reassigning their identities", () => {
    const original = toGraphDefinition({ entry: { type: "trigger", trigger_event: "event" },
      settings: { category: "marketing", reentry: "never" }, exit: {},
      nodes: [{ id: "first", type: "delay", duration_seconds: 60 },
        { id: "second", type: "message", push: { title: "hello", body: "world" } },
        { id: "third", type: "delay", duration_seconds: 90 }] });
    expect(canMoveNode(original, "second", -1)).toBe(true);
    const moved = moveLinearNode(original, "second", -1);
    expect(moved.start_node_id).toBe("second");
    expect(moved.edges.find((edge) => edge.source === "second")?.target).toBe("first");
    expect(moved.edges.find((edge) => edge.source === "first")?.target).toBe("third");
    expect(moved.nodes).toEqual(original.nodes);
    expect(graphReadIssue(moved)).toBeNull();
  });

  it("does not move across a decision or a shared merge", () => {
    expect(canMoveNode(fork(), "fast", -1)).toBe(false);
    expect(canMoveNode(fork(), "fast", 1)).toBe(false);
    expect(canMoveNode(fork(), "shared", -1)).toBe(false);
  });

  it("starts a new experiment with a new node ID while keeping variants, routes and old data intact", () => {
    const original = fork();
    const next = renewExperiment(original, "split", "new-experiment");
    expect(next.start_node_id).toBe("new-experiment");
    expect(next.nodes[0]).toEqual({ ...original.nodes[0], id: "new-experiment" });
    expect(next.edges.filter((edge) => edge.source === "new-experiment").map((edge) => [edge.source_port, edge.target])).toEqual([["a", "fast"], ["b", "slow"]]);
    expect(original.start_node_id).toBe("split");
    expect(graphReadIssue(next)).toBeNull();
  });

  it("measures the shortest and longest single route, never summing sibling waits", () => {
    const original = fork();
    expect(pathDurationRange(original)).toEqual({ min: 60, max: 600 });
    const wait = { id: "wait", type: "event_wait" as const, event_name: "purchased", timeout_seconds: 3600 };
    const next = insertOnEdge(original, "shared-edge", wait);
    expect(pathDurationRange(next)).toEqual({ min: 60, max: 4200 });
    next.edges.find((edge) => edge.source === "wait" && edge.source_port === "timeout")!.target = "split";
    expect(pathDurationRange(next)).toBeNull();
  });

  it("rejects malformed topology without treating unfinished message content as a broken graph", () => {
    const original = fork();
    const message = original.nodes.find((node) => node.type === "message")!;
    if (message.type === "message") message.push = { title: "", body: "" };
    expect(graphReadIssue(original)).toBeNull();
    original.edges.pop();
    expect(graphReadIssue(original)).not.toBeNull();
  });

  it("includes the required timeout on the timeout path when calculating the minimum duration", () => {
    const definition = fork();
    definition.nodes[0] = { id: "split", type: "event_wait", event_name: "purchase", timeout_seconds: 3600 };
    definition.edges[0]!.source_port = "matched";
    definition.edges[1] = { ...definition.edges[1]!, source_port: "timeout", target: "shared" };
    definition.nodes = definition.nodes.filter((node) => node.id !== "slow");
    definition.edges = definition.edges.filter((edge) => edge.source !== "slow");
    const fast = definition.nodes.find((node) => node.id === "fast")!;
    if (fast.type === "delay") fast.duration_seconds = 7200;
    expect(pathDurationRange(definition)).toEqual({ min: 3600, max: 10800 });
  });

  it("handles long saved paths without recursively overflowing the call stack", () => {
    const definition = fork();
    const count = 10000;
    definition.start_node_id = "delay-0";
    definition.nodes = Array.from({ length: count }, (_, index) => ({ id: `delay-${index}`, type: "delay", duration_seconds: 1 }));
    definition.edges = definition.nodes.map((node, index) => ({ id: `edge-${index}`, source: node.id, source_port: "next", target: index + 1 < count ? `delay-${index + 1}` : null }));
    expect(pathDurationRange(definition)).toEqual({ min: count, max: count });
  });
});

describe("structural DAG layout", () => {
  it("leaves the layout key and positions unchanged when content, labels and weights change", () => {
    const original = fork();
    const edited = structuredClone(original);
    const message = edited.nodes.find((node) => node.type === "message")!;
    if (message.type === "message" && message.push) message.push.title = "긴 제목을 작성하는 중에도 화면 위치는 그대로";
    const split = edited.nodes[0]!;
    if (split.type === "ab_split") {
      split.variants[0]!.label = "변경한 이름";
      split.variants[0]!.weight = 30;
      split.variants[1]!.weight = 70;
    }
    expect(journeyStructureKey(edited)).toBe(journeyStructureKey(original));
    expect(layoutJourney(journeyStructureKey(edited))).toEqual(layoutJourney(journeyStructureKey(original)));
  });

  it("lays every edge downward and separates sibling stages horizontally", () => {
    const graph = fork();
    const layout = layoutJourney(journeyStructureKey(graph));
    for (const edge of graph.edges) {
      const from = layout.get(`node:${edge.source}`)!;
      const to = layout.get(edge.target ? `node:${edge.target}` : "exit")!;
      expect(to.y).toBeGreaterThanOrEqual(from.y + from.height);
    }
    const fast = layout.get("node:fast")!;
    const slow = layout.get("node:slow")!;
    expect(Math.abs(fast.x - slow.x)).toBeGreaterThanOrEqual(fast.width);
  });
});
