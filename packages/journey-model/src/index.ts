/**
 * 저니 정의 모델 (PRD-03 2.1). 단발 캠페인 = entry.blast + [message] 1노드.
 * Go scheduler(apps/worker/internal/journey)와 동형 구조를 유지한다.
 * MVP: 선형 체인(분기 없음). 노드 타입은 message | delay.
 */

export type MessageCategory = "marketing" | "transactional";

export interface JourneyDefinition {
  entry: EntryRule;
  nodes: JourneyNode[];
  exit: ExitRule;
  settings: JourneySettings;
}

export interface EntryRule {
  /** MVP: blast(세그먼트 일괄 진입) | trigger(이벤트, S5) */
  type: "blast" | "trigger";
  segment_id?: string; // blast·trigger 필터
  trigger_event?: string; // trigger (S5)
}

export type JourneyNode = MessageNode | DelayNode;

export interface MessageNode {
  type: "message";
  /** push 콘텐츠 블록 (PRD-04 2.3). MVP는 push만 */
  push: {
    title: string;
    body: string;
    image_url?: string;
    deep_link?: string;
  };
}

export interface DelayNode {
  type: "delay";
  /** 고정 시간 대기 */
  duration_seconds: number;
}

export interface ExitRule {
  /** 목표 달성 이탈 이벤트 (conversion exit, S5에서 매칭). 없으면 완료까지 진행 */
  conversion_event?: string;
}

export interface JourneySettings {
  category: MessageCategory;
  reentry: "never" | "always" | { after_days: number };
}

export interface ValidationIssue {
  level: "error" | "warning";
  message: string;
  node_index?: number;
}

/** 활성화 전 검증 (PRD-03 7장). error가 있으면 활성화 차단. */
export function validateJourney(def: JourneyDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!def.entry || !def.entry.type) {
    issues.push({ level: "error", message: "진입(entry) 규칙이 설정되지 않았습니다" });
  } else if (def.entry.type === "blast" && !def.entry.segment_id) {
    issues.push({ level: "error", message: "일괄 진입은 대상 세그먼트가 필요합니다" });
  } else if (def.entry.type === "trigger" && !def.entry.trigger_event) {
    issues.push({ level: "error", message: "트리거 진입은 이벤트가 필요합니다" });
  }

  if (!def.nodes || def.nodes.length === 0) {
    issues.push({ level: "error", message: "노드가 하나 이상 필요합니다" });
  } else {
    let hasMessage = false;
    def.nodes.forEach((node, i) => {
      if (node.type === "message") {
        hasMessage = true;
        if (!node.push?.title?.trim() || !node.push?.body?.trim()) {
          issues.push({ level: "error", message: "빈 메시지 노드입니다", node_index: i });
        }
      } else if (node.type === "delay") {
        if (!(node.duration_seconds > 0)) {
          issues.push({ level: "error", message: "대기 시간은 0보다 커야 합니다", node_index: i });
        }
      }
    });
    if (!hasMessage) {
      issues.push({ level: "error", message: "메시지 노드가 하나 이상 필요합니다" });
    }
    // 마지막 노드가 delay면 경고 (PRD-03 7장)
    const last = def.nodes[def.nodes.length - 1];
    if (last?.type === "delay") {
      issues.push({
        level: "warning",
        message: "마지막 노드가 대기입니다 — 발송 없이 종료됩니다",
        node_index: def.nodes.length - 1,
      });
    }
  }

  if (!def.settings?.category) {
    issues.push({ level: "error", message: "메시지 카테고리(marketing/transactional)가 필요합니다" });
  }
  return issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}

/** 단발 캠페인 → 1노드 저니 정의 (통합 모델, PRD-03 1장) */
export function campaignToJourney(input: {
  segment_id: string;
  push: MessageNode["push"];
  category: MessageCategory;
}): JourneyDefinition {
  return {
    entry: { type: "blast", segment_id: input.segment_id },
    nodes: [{ type: "message", push: input.push }],
    exit: {},
    settings: { category: input.category, reentry: "never" },
  };
}
