import type { SegmentDSL, Condition } from "@nudgeon/segment-dsl";

/**
 * 빌더 UI 상태 ↔ DSL 무손실 왕복 (U-3).
 * 빌더는 DSL을 그대로 상태로 쓰되, 편집 편의를 위한 얕은 헬퍼만 둔다 —
 * 별도 중간 표현을 만들지 않아야 왕복 무손실이 구조적으로 보장된다.
 */

export function emptyDSL(): SegmentDSL {
  return {
    version: 1,
    operator: "AND",
    groups: [{ operator: "AND", conditions: [newCondition("attribute")] }],
  };
}

export function newCondition(type: Condition["type"]): Condition {
  switch (type) {
    case "attribute":
      return { type: "attribute", key: "", op: "eq", value: "" };
    case "event":
      return { type: "event", event: "", op: "count_gte", value: 1, window_days: 30 };
    case "channel":
      return { type: "channel", op: "push_reachable" };
    case "device":
      return { type: "device", key: "app_version", op: "gte", value: "" };
  }
}

export const ATTR_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "exists",
  "not_exists",
  "contains",
  "in_last_days",
  "not_in_last_days",
] as const;

export const EVENT_OPS = ["count_gte", "count_lte", "performed", "not_performed"] as const;

/** 연산자가 value 입력을 요구하는가 */
export function opNeedsValue(op: string): boolean {
  return !["exists", "not_exists", "performed", "not_performed"].includes(op);
}

/** 조건 요약에 쓰는 메시지 키(segmentBuilder.summary.*) — 번역은 렌더 측 t()가 한다. */
export type SummaryTranslator = (key: "summary.attribute" | "summary.event" | "summary.pushReachable" | "summary.days", params?: { n: number }) => string;

/** 조건 요약 (목록·칩 표시용). 순수 모듈이라 next-intl을 들이지 않고 번역기를 주입받는다. */
export function conditionSummary(c: Condition, tr: SummaryTranslator): string {
  switch (c.type) {
    case "attribute":
      return `${c.key || tr("summary.attribute")} ${c.op}${opNeedsValue(c.op) ? ` ${fmtValue(c.value)}` : ""}`;
    case "event":
      return `${c.event || tr("summary.event")} ${c.op}${
        c.op.startsWith("count") ? ` ${fmtValue(c.value)}` : ""
      }${c.window_days ? ` (${tr("summary.days", { n: c.window_days })})` : ""}`;
    case "channel":
      return tr("summary.pushReachable");
    case "device":
      return `${c.key} ${c.op} ${fmtValue(c.value)}`;
  }
}

function fmtValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  return String(v ?? "");
}
