import type { SegmentDSL } from "@onda/segment-dsl";

/** v1 remains an immutable linear definition. v2 stores an exclusive DAG. */
export type MessageCategory = "marketing" | "transactional";
export interface JourneyDefinition {
  schema_version?: 1 | 2;
  entry: EntryRule;
  nodes: JourneyNode[];
  start_node_id?: string | null;
  edges?: JourneyEdge[];
  exit: ExitRule;
  settings: JourneySettings;
}
export interface JourneyGraphDefinition extends JourneyDefinition {
  schema_version: 2;
  nodes: Array<JourneyNode & { id: string }>;
  start_node_id: string | null;
  edges: JourneyEdge[];
}
export interface EntryRule {
  type: "blast" | "trigger";
  segment_id?: string;
  trigger_event?: string;
}
interface NodeIdentity { id?: string }
export type JourneyNode = MessageNode | DelayNode | BranchNode | EventWaitNode | ABSplitNode;
export interface MessageNode extends NodeIdentity {
  type: "message";
  push: { title: string; body: string; image_url?: string; deep_link?: string };
}
export interface DelayNode extends NodeIdentity {
  type: "delay";
  duration_seconds: number;
}
export interface BranchNode extends NodeIdentity {
  type: "branch";
  condition: SegmentDSL;
}
export interface EventWaitNode extends NodeIdentity {
  type: "event_wait";
  event_name: string;
  timeout_seconds: number;
}
export interface ABVariant { id: string; label: string; weight: number }
export interface ABSplitNode extends NodeIdentity {
  type: "ab_split";
  variants: ABVariant[];
}
export interface JourneyEdge {
  id: string;
  source: string;
  source_port: string;
  target: string | null;
}
export interface ExitRule { conversion_event?: string }
export interface JourneySettings {
  category: MessageCategory;
  reentry: "never" | "always" | { after_days: number };
}
export interface ValidationIssue {
  level: "error" | "warning";
  message: string;
  node_index?: number;
  node_id?: string;
  edge_id?: string;
  field?: string;
}
export type PublishedABNodes = Record<string, { variants: ABVariant[] }>;

export function outputPorts(node: JourneyNode): Array<{ id: string; label: string }> {
  switch (node.type) {
    case "branch": return [{ id: "true", label: "충족" }, { id: "false", label: "미충족" }];
    case "event_wait": return [{ id: "matched", label: "이벤트 발생" }, { id: "timeout", label: "시간 초과" }];
    case "ab_split": return (node.variants ?? []).map(v => ({ id: v.id, label: `${v.label} · ${v.weight}%` }));
    default: return [{ id: "next", label: "다음" }];
  }
}

/** Presentation adapter only. Never flattens or repairs a persisted v2 graph. */
export function toGraphDefinition(def: JourneyDefinition): JourneyGraphDefinition {
  if (def.schema_version === 2) return structuredClone(def) as JourneyGraphDefinition;
  if (def.schema_version !== undefined && def.schema_version !== 1) {
    throw new Error("지원하지 않는 저니 정의 버전입니다");
  }
  const copy = structuredClone(def);
  const nodes = copy.nodes.map((node, i) => ({ ...node, id: node.id ?? `legacy-${i}` }));
  return {
    ...copy, schema_version: 2, nodes, start_node_id: nodes[0]?.id ?? null,
    edges: nodes.map((node, i) => ({
      id: `legacy-edge-${i}`, source: node.id, source_port: "next", target: nodes[i + 1]?.id ?? null,
    })),
  };
}

export { validateJourney, validateBranchCondition } from "./validation";
export { collectPublishedABNodes, validatePublishedABNodes } from "./published";
export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some(issue => issue.level === "error");
}
export function campaignToJourney(input: {
  segment_id: string; push: MessageNode["push"]; category: MessageCategory;
}): JourneyDefinition {
  return {
    entry: { type: "blast", segment_id: input.segment_id },
    nodes: [{ type: "message", push: input.push }], exit: {},
    settings: { category: input.category, reentry: "never" },
  };
}
