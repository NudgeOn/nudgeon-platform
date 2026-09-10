import { describe, expect, it } from "vitest";
import { checkDraft, DraftCheckError, durationUnit, emptyJourney, formatDuration, type Translate } from "./journey-editor-model";

// 카탈로그 없이 ko 문구를 흉내 내는 최소 번역기 — 키·플레이스홀더 계약만 검증한다.
const t: Translate = (key, values) => {
  const unit: Record<string, string> = { "model.duration.1": "초", "model.duration.60": "분", "model.duration.3600": "시간", "model.duration.86400": "일" };
  if (key in unit) return `${Number(values?.count).toLocaleString()}${unit[key]}`;
  if (key === "model.duration.unset") return "대기 시간 미설정";
  throw new Error(`unknown key ${key}`);
};

describe("journey duration editing", () => {
  it.each([1800, 90, 5400, 86400, 90061])("keeps all %i seconds when reopening a stored delay", (seconds) => {
    const unit = durationUnit(seconds);
    const displayedAmount = seconds / unit;
    expect(Number.isInteger(displayedAmount)).toBe(true);
    expect(displayedAmount * unit).toBe(seconds);
  });

  it("does not label a stored half-hour as one hour", () => {
    expect(durationUnit(1800)).toBe(60);
    expect(formatDuration(1800, t)).toBe("30분");
    expect(formatDuration(90, t)).toBe("1분 30초");
    expect(formatDuration(0, t)).toBe("대기 시간 미설정");
  });

  it.each([0, -1, Number.NaN, Infinity, 1.5])("rejects invalid delay %s before JSON serialization", (seconds) => {
    const definition = emptyJourney();
    definition.nodes.unshift({ id: "invalid-delay", type: "delay", duration_seconds: seconds });
    expect(() => checkDraft("가입 환영", definition)).toThrow(new DraftCheckError("model.check.delay"));
  });

  it("allows incomplete message drafts but rejects an invalid reentry period", () => {
    const definition = emptyJourney();
    expect(() => checkDraft("가입 환영", definition)).not.toThrow();
    definition.settings.reentry = { after_days: 0.5 };
    expect(() => checkDraft("가입 환영", definition)).toThrow(new DraftCheckError("model.check.reentry"));
    expect(() => checkDraft(" ", definition)).toThrow(new DraftCheckError("model.check.nameRequired"));
  });
});
