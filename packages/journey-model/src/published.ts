import type { JourneyDefinition, PublishedABNodes, ValidationIssue } from "./index";

export function collectPublishedABNodes(definitions: JourneyDefinition[]): PublishedABNodes {
  const published: PublishedABNodes = Object.create(null);
  for (const def of definitions) for (const node of def.nodes ?? []) {
    if (node.type === "ab_split" && node.id && !Object.hasOwn(published, node.id)) {
      published[node.id] = { variants: structuredClone(node.variants) };
    }
  }
  return published;
}

/** IDs, order and weights are allocation identity; display labels may evolve. */
export function validatePublishedABNodes(def: JourneyDefinition, published: PublishedABNodes): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [index, node] of def.nodes.entries()) {
    if (node.type !== "ab_split" || !node.id || !Object.hasOwn(published, node.id)) continue;
    const allocation = (variants: typeof node.variants) => JSON.stringify(variants.map(v => [v.id, v.weight]));
    if (allocation(node.variants) !== allocation(published[node.id]!.variants)) {
      issues.push({ level: "error", node_id: node.id, node_index: index, field: "variants", message: "활성화한 A/B 배정은 변경할 수 없습니다. ‘새 실험으로 시작’을 사용하세요" });
    }
  }
  return issues;
}
