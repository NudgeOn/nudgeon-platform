import { describe, expect, it } from "vitest";
import { pickLocale } from "./locales";

describe("pickLocale", () => {
  it("쿠키가 우선한다", () => {
    expect(pickLocale("en", "ko-KR")).toBe("en");
    expect(pickLocale("ko", "en-US")).toBe("ko");
  });
  it("쿠키가 없으면 Accept-Language 첫 언어, 모르면 ko", () => {
    expect(pickLocale(undefined, "en-US,en;q=0.9,ko;q=0.8")).toBe("en");
    expect(pickLocale(undefined, "ko-KR,ko;q=0.9")).toBe("ko");
    expect(pickLocale(undefined, "ja")).toBe("ko");
    expect(pickLocale(undefined, null)).toBe("ko");
  });
  it("알 수 없는 쿠키 값은 무시한다", () => {
    expect(pickLocale("fr", "en")).toBe("en");
  });
});
