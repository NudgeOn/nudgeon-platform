import { describe, expect, it } from "vitest";
import { checkDraft, durationUnit, emptyJourney, formatDuration } from "./journey-editor-model";

describe("journey duration editing", () => {
  it.each([1800, 90, 5400, 86400, 90061])("keeps all %i seconds when reopening a stored delay", (seconds) => {
    const unit = durationUnit(seconds);
    const displayedAmount = seconds / unit;
    expect(Number.isInteger(displayedAmount)).toBe(true);
    expect(displayedAmount * unit).toBe(seconds);
  });

  it("does not label a stored half-hour as one hour", () => {
    expect(durationUnit(1800)).toBe(60);
    expect(formatDuration(1800)).toBe("30분");
    expect(formatDuration(90)).toBe("1분 30초");
  });

  it.each([0, -1, Number.NaN, Infinity, 1.5])("rejects invalid delay %s before JSON serialization", (seconds) => {
    const definition = emptyJourney();
    definition.nodes.unshift({ id: "invalid-delay", type: "delay", duration_seconds: seconds });
    expect(() => checkDraft("가입 환영", definition)).toThrow("대기 시간");
  });

  it("allows incomplete message drafts but rejects an invalid reentry period", () => {
    const definition = emptyJourney();
    expect(() => checkDraft("가입 환영", definition)).not.toThrow();
    definition.settings.reentry = { after_days: 0.5 };
    expect(() => checkDraft("가입 환영", definition)).toThrow("재진입 대기");
  });
});
