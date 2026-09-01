import { describe, expect, it } from "vitest";
import {
  base32Encode,
  counterAt,
  generateBackupCodes,
  normalizeBackupCode,
  totpAt,
  verifyTotp,
} from "./totp";

describe("base32Encode (RFC 4648 벡터)", () => {
  it.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("%j → %s", (input, expected) => {
    expect(base32Encode(Buffer.from(input))).toBe(expected);
  });
});

describe("TOTP (RFC 6238 벡터, SHA1·6자리)", () => {
  // RFC 6238 Appendix B의 시드 "12345678901234567890"
  const seed = Buffer.from("12345678901234567890");
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("T=%is → %s", (t, expected) => {
    expect(totpAt(seed, t * 1000)).toBe(expected);
  });
});

describe("verifyTotp — 윈도우·재사용·형식", () => {
  const seed = Buffer.from("12345678901234567890");
  const now = 1111111109000;

  it("현재 코드는 통과하고 매칭 counter를 돌려준다", () => {
    const code = totpAt(seed, now);
    const res = verifyTotp(seed, code, { epochMs: now });
    expect(res.ok).toBe(true);
    expect(res.counter).toBe(counterAt(now));
  });

  it("드리프트 -1 스텝 코드도 윈도우 내면 통과", () => {
    const prev = totpAt(seed, now - 30_000);
    expect(verifyTotp(seed, prev, { epochMs: now }).ok).toBe(true);
  });

  it("재사용 방지: afterCounter 이하 스텝은 거부", () => {
    const c = counterAt(now);
    const code = totpAt(seed, now);
    expect(verifyTotp(seed, code, { epochMs: now, afterCounter: c }).ok).toBe(false);
  });

  it("틀린 코드·형식 오류 거부", () => {
    expect(verifyTotp(seed, "000000", { epochMs: now }).ok).toBe(false);
    expect(verifyTotp(seed, "12345", { epochMs: now }).ok).toBe(false);
    expect(verifyTotp(seed, "abcdef", { epochMs: now }).ok).toBe(false);
  });
});

describe("백업 코드", () => {
  it("N개 생성·형식 XXXXX-XXXXX·정규화", () => {
    const codes = generateBackupCodes(10);
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(normalizeBackupCode("abcde-12345")).toBe("ABCDE12345");
  });
});
