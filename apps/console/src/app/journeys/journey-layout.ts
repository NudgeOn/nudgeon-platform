import { graphlib, layout } from "@dagrejs/dagre";
import { outputPorts, type JourneyNode } from "@nudgeon/journey-model";
import type { GraphDefinition } from "./journey-graph";

export type CardKind = "entry" | "exit" | JourneyNode["type"];
export const CARD_WIDTH = 280;
export const CARD_HEIGHT: Record<CardKind, number> = {
  entry: 92, message: 116, delay: 90, branch: 124, event_wait: 142, ab_split: 124, exit: 46,
};

/** Content edits, validation and selection never change this key or rerun Dagre. */
export function journeyStructureKey(definition: GraphDefinition, withMetrics = false): string {
  return JSON.stringify({
    withMetrics,
    start: definition.start_node_id,
    nodes: definition.nodes.map((node) => ({ id: node.id, type: node.type, ports: outputPorts(node).map((port) => port.id) })),
    edges: definition.edges.map((edge) => ({ id: edge.id, source: edge.source, port: edge.source_port, target: edge.target })),
  });
}

export type JourneyLayout = Map<string, { x: number; y: number; width: number; height: number }>;

export function layoutJourney(structureKey: string): JourneyLayout {
  const structure = JSON.parse(structureKey) as {
    start: string | null; withMetrics: boolean; nodes: { id: string; type: CardKind; ports: string[] }[];
    edges: { id: string; source: string; port: string; target: string | null }[];
  };
  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "TB", ranker: "network-simplex", nodesep: 64, edgesep: 26, ranksep: 84, marginx: 28, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));
  // Prefixing graphlib's actual nodes prevents stored IDs from colliding with the two virtual nodes.
  graph.setNode("entry", { width: CARD_WIDTH, height: CARD_HEIGHT.entry });
  for (const node of structure.nodes) graph.setNode(`node:${node.id}`, { width: CARD_WIDTH, height: CARD_HEIGHT[node.type] + (structure.withMetrics ? 23 : 0) });
  graph.setNode("exit", { width: 232, height: CARD_HEIGHT.exit });
  graph.setEdge("entry", structure.start ? `node:${structure.start}` : "exit", {}, "entry");
  for (const edge of structure.edges) {
    if (!graph.hasNode(`node:${edge.source}`) || (edge.target && !graph.hasNode(`node:${edge.target}`))) continue;
    graph.setEdge(`node:${edge.source}`, edge.target ? `node:${edge.target}` : "exit", {}, edge.id);
  }
  layout(graph);
  return new Map(graph.nodes().map((id) => {
    const node = graph.node(id);
    return [id, { x: node.x - node.width / 2, y: node.y - node.height / 2, width: node.width, height: node.height }];
  }));
}
