import type { JourneyDefinition, JourneyGraphDefinition, JourneyNode } from "@nudgeon/journey-model";
import type { JourneyIconName } from "./journey-ui";

/**
 * 순수 모듈이라 next-intl을 쓰지 않는다 — 사용자에게 보이는 문구는 `journeyEditor` 네임스페이스의 키로 돌려주고
 * 렌더 지점에서 `useTranslations("journeyEditor")`의 t로 번역한다. 아래 Translate는 그 t와 호환되는 최소 형태.
 */
export type Translate = (key: string, values?: Record<string, string | number | Date>) => string;

export const NODE_TOOLS: { type: JourneyNode["type"]; icon: JourneyIconName }[] = [
  { type: "message", icon: "message" },
  { type: "delay", icon: "clock" },
  { type: "branch", icon: "branch" },
  { type: "event_wait", icon: "event-wait" },
  { type: "ab_split", icon: "split" },
];

/** 단계 종류의 표시 이름·설명 — 카탈로그 `journeyEditor.model.tools.<type>.{label,description}`. */
export const nodeToolLabel = (t: Translate, type: JourneyNode["type"]) => t(`model.tools.${type}.label`);
export const nodeToolDescription = (t: Translate, type: JourneyNode["type"]) => t(`model.tools.${type}.description`);

export const newJourneyId = (kind = "node") => `${kind}-${crypto.randomUUID()}`;

/** 초 단위 값. 표시 이름은 `journeyEditor.model.unit.<value>`, 수량 표기는 `journeyEditor.model.duration.<value>`. */
export const DURATION_UNITS = [1, 60, 3600, 86400] as const;

export function durationUnit(seconds: number): number {
  return [...DURATION_UNITS].reverse().find((unit) => seconds > 0 && seconds % unit === 0) ?? 1;
}

export function formatDuration(seconds: number, t: Translate): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return t("model.duration.unset");
  let remaining = seconds;
  return [...DURATION_UNITS].reverse().flatMap((unit) => {
    const count = Math.floor(remaining / unit);
    remaining %= unit;
    return count ? [t(`model.duration.${unit}`, { count })] : [];
  }).join(" ");
}

export function createJourneyNode(type: JourneyNode["type"]): JourneyNode & { id: string } {
  const id = newJourneyId();
  switch (type) {
    case "message": return { id, type, push: { title: "", body: "" } };
    case "delay": return { id, type, duration_seconds: 86400 };
    case "branch": return { id, type, condition: { version: 1, operator: "AND", groups: [
      { operator: "AND", conditions: [{ type: "attribute", key: "", op: "eq", value: "" }] },
    ] } };
    case "event_wait": return { id, type, event_name: "", timeout_seconds: 86400 };
    case "ab_split": return { id, type, variants: [
      { id: newJourneyId("variant"), label: "A", weight: 50 },
      { id: newJourneyId("variant"), label: "B", weight: 50 },
    ] };
  }
}

export function emptyJourney(): JourneyGraphDefinition {
  const node = createJourneyNode("message");
  return {
    schema_version: 2,
    start_node_id: node.id,
    entry: { type: "blast" },
    nodes: [node],
    edges: [{ id: newJourneyId("edge"), source: node.id, source_port: "next", target: null }],
    exit: {},
    settings: { category: "marketing", reentry: "never" },
  };
}

/** checkDraft 실패 — message는 `journeyEditor` 카탈로그 키(`model.check.*`)라 렌더 지점에서 t(error.message)로 번역한다. */
export class DraftCheckError extends Error {
  constructor(readonly key: `model.check.${string}`) { super(key); this.name = "DraftCheckError"; }
}

export function checkDraft(name: string, definition: JourneyDefinition): void {
  if (!name.trim()) throw new DraftCheckError("model.check.nameRequired");
  if (name.length > 200) throw new DraftCheckError("model.check.nameTooLong");
  if (definition.nodes.some((node) => node.type === "delay" &&
    (!Number.isSafeInteger(node.duration_seconds) || node.duration_seconds <= 0))) {
    throw new DraftCheckError("model.check.delay");
  }
  if (definition.nodes.some((node) => node.type === "event_wait" &&
    (!Number.isSafeInteger(node.timeout_seconds) || node.timeout_seconds <= 0))) {
    throw new DraftCheckError("model.check.eventWaitTimeout");
  }
  if (definition.nodes.some((node) => node.type === "ab_split" && node.variants.some((variant) =>
    !Number.isSafeInteger(variant.weight) || variant.weight < 1 || variant.weight > 99))) {
    throw new DraftCheckError("model.check.abWeight");
  }
  const reentry = definition.settings.reentry;
  if (reentry && typeof reentry === "object" && (!Number.isSafeInteger(reentry.after_days) || reentry.after_days <= 0)) {
    throw new DraftCheckError("model.check.reentry");
  }
  JSON.stringify(definition, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new DraftCheckError("model.check.nonFiniteNumber");
    return value;
  });
}
