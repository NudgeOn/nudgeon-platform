import { describe, expect, it } from "vitest";
import {
  campaignToJourney,
  hasErrors,
  validateJourney,
  type JourneyDefinition,
} from "./index";

const valid: JourneyDefinition = {
  entry: { type: "blast", segment_id: "seg-1" },
  nodes: [
    { type: "message", push: { title: "안녕", body: "본문" } },
    { type: "delay", duration_seconds: 86400 },
    { type: "message", push: { title: "다시", body: "본문2" } },
  ],
  exit: { conversion_event: "purchase" },
  settings: { category: "marketing", reentry: "never" },
};

describe("validateJourney", () => {
  it("유효한 저니는 error 없음", () => {
    expect(hasErrors(validateJourney(valid))).toBe(false);
  });

  it("entry 미설정 error", () => {
    const d = { ...valid, entry: { type: "blast" } };
    expect(hasErrors(validateJourney(d))).toBe(true);
  });

  it("빈 메시지 error", () => {
    const d: JourneyDefinition = {
      ...valid,
      nodes: [{ type: "message", push: { title: "", body: "" } }],
    };
    const issues = validateJourney(d);
    expect(issues.some((i) => i.level === "error" && i.node_index === 0)).toBe(true);
  });

  it("메시지 노드 없이 delay만 → error", () => {
    const d: JourneyDefinition = {
      ...valid,
      nodes: [{ type: "delay", duration_seconds: 10 }],
    };
    expect(hasErrors(validateJourney(d))).toBe(true);
  });

  it("마지막 노드 delay → warning (error 아님)", () => {
    const d: JourneyDefinition = {
      ...valid,
      nodes: [
        { type: "message", push: { title: "t", body: "b" } },
        { type: "delay", duration_seconds: 10 },
      ],
    };
    const issues = validateJourney(d);
    expect(hasErrors(issues)).toBe(false);
    expect(issues.some((i) => i.level === "warning")).toBe(true);
  });

  it("delay 0 이하 error", () => {
    const d: JourneyDefinition = {
      ...valid,
      nodes: [
        { type: "message", push: { title: "t", body: "b" } },
        { type: "delay", duration_seconds: 0 },
        { type: "message", push: { title: "t2", body: "b2" } },
      ],
    };
    expect(hasErrors(validateJourney(d))).toBe(true);
  });
});

describe("campaignToJourney", () => {
  it("단발 캠페인을 1노드 blast 저니로 변환", () => {
    const j = campaignToJourney({
      segment_id: "seg-1",
      push: { title: "공지", body: "내용" },
      category: "transactional",
    });
    expect(j.entry.type).toBe("blast");
    expect(j.nodes).toHaveLength(1);
    expect(j.nodes[0]!.type).toBe("message");
    expect(hasErrors(validateJourney(j))).toBe(false);
  });
});
