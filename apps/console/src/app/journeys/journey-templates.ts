import type { JourneyGraphDefinition } from "@nudgeon/journey-model";

export const JOURNEY_TEMPLATES = ["welcome", "return", "update"] as const;
export type JourneyTemplate = (typeof JOURNEY_TEMPLATES)[number];

export function isJourneyTemplate(value: string | null): value is JourneyTemplate {
  return JOURNEY_TEMPLATES.some((template) => template === value);
}

/** Fresh, editable drafts only; choosing a starter never saves or activates it. */
export function createJourneyTemplate(
  template: JourneyTemplate,
  push: { title: string; body: string },
): JourneyGraphDefinition {
  const delay = template === "welcome" ? 600 : template === "return" ? 86400 : 0;
  const event = { welcome: "sign_up", return: "product_viewed", update: "playlist_updated" }[template];
  return {
    schema_version: 2,
    entry: { type: "trigger", trigger_event: event },
    start_node_id: delay ? "wait" : "message",
    nodes: [
      ...(delay ? [{ id: "wait", type: "delay" as const, duration_seconds: delay }] : []),
      { id: "message", type: "message", push: { ...push } },
    ],
    edges: [
      ...(delay ? [{ id: "wait-message", source: "wait", source_port: "next", target: "message" }] : []),
      { id: "message-exit", source: "message", source_port: "next", target: null },
    ],
    exit: template === "return" ? { conversion_event: "purchase_completed" } : {},
    settings: {
      category: template === "update" ? "transactional" : "marketing",
      reentry: template === "update" ? "always" : "never",
    },
  };
}
