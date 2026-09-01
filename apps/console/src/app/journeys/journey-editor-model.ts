import type { JourneyDefinition, JourneyGraphDefinition, JourneyNode } from "@onda/journey-model";
import type { JourneyIconName } from "./journey-ui";

export const NODE_TOOLS: { type: JourneyNode["type"]; label: string; description: string; icon: JourneyIconName }[] = [
  { type: "message", label: "푸시 메시지", description: "고객에게 알림 보내기", icon: "message" },
  { type: "delay", label: "시간 대기", description: "정해진 시간만큼 기다리기", icon: "clock" },
  { type: "branch", label: "조건 분기", description: "조건 충족 여부로 나누기", icon: "branch" },
  { type: "event_wait", label: "이벤트 대기", description: "이벤트 또는 시간 초과", icon: "event-wait" },
  { type: "ab_split", label: "A/B 분기", description: "고객을 일정 비율로 나누기", icon: "split" },
];

export const newJourneyId = (kind = "node") => `${kind}-${crypto.randomUUID()}`;

export const DURATION_UNITS = [
  { value: 1, label: "초" },
  { value: 60, label: "분" },
  { value: 3600, label: "시간" },
  { value: 86400, label: "일" },
] as const;

export function durationUnit(seconds: number): number {
  return [...DURATION_UNITS].reverse().find((unit) => seconds > 0 && seconds % unit.value === 0)?.value ?? 1;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "대기 시간 미설정";
  let remaining = seconds;
  return [...DURATION_UNITS].reverse().flatMap((unit) => {
    const count = Math.floor(remaining / unit.value);
    remaining %= unit.value;
    return count ? [`${count.toLocaleString()}${unit.label}`] : [];
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

export function checkDraft(name: string, definition: JourneyDefinition): void {
  if (!name.trim()) throw new Error("저니 이름을 입력해 주세요.");
  if (name.length > 200) throw new Error("저니 이름은 200자까지 입력할 수 있습니다.");
  if (definition.nodes.some((node) => node.type === "delay" &&
    (!Number.isSafeInteger(node.duration_seconds) || node.duration_seconds <= 0))) {
    throw new Error("대기 시간은 1초 이상의 정수로 설정해 주세요.");
  }
  if (definition.nodes.some((node) => node.type === "event_wait" &&
    (!Number.isSafeInteger(node.timeout_seconds) || node.timeout_seconds <= 0))) {
    throw new Error("이벤트 대기의 시간 제한은 1초 이상의 정수로 설정해 주세요.");
  }
  if (definition.nodes.some((node) => node.type === "ab_split" && node.variants.some((variant) =>
    !Number.isSafeInteger(variant.weight) || variant.weight < 1 || variant.weight > 99))) {
    throw new Error("A/B 비율은 각 경로에 1~99%의 정수로 입력해 주세요.");
  }
  const reentry = definition.settings.reentry;
  if (reentry && typeof reentry === "object" && (!Number.isSafeInteger(reentry.after_days) || reentry.after_days <= 0)) {
    throw new Error("재진입 대기는 1일 이상의 정수로 설정해 주세요.");
  }
  JSON.stringify(definition, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("조건의 숫자와 조회 기간을 확인해 주세요. 비어 있는 숫자 항목이 있습니다.");
    return value;
  });
}
