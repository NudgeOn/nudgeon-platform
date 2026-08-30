import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "./api-key.service";

describe("generateApiKey", () => {
  it("sdk 키는 pk_, server 키는 sk_ 접두를 갖는다", () => {
    expect(generateApiKey("sdk").key).toMatch(/^pk_/);
    expect(generateApiKey("server").key).toMatch(/^sk_/);
  });

  it("해시는 키 원문의 SHA-256이고, 원문과 다르다", () => {
    const { key, hash } = generateApiKey("sdk");
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(key);
  });

  it("prefix는 콘솔 표시용 앞 11자다", () => {
    const { key, prefix } = generateApiKey("server");
    expect(prefix).toBe(key.slice(0, 11));
  });

  it("매 호출 서로 다른 키를 만든다", () => {
    expect(generateApiKey("sdk").key).not.toBe(generateApiKey("sdk").key);
  });
});
