import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptEnvelope, encryptEnvelope, loadMasterKey } from "./envelope";

describe("봉투 암호화", () => {
  const master = randomBytes(32);

  it("암호화 → 복호화 왕복", () => {
    const secret = JSON.stringify({ private_key: "-----BEGIN PRIVATE KEY-----..." });
    const env = encryptEnvelope(master, secret);
    expect(decryptEnvelope(master, env)).toBe(secret);
  });

  it("평문이 ciphertext에 노출되지 않는다", () => {
    const env = encryptEnvelope(master, "super-secret-fcm-key");
    expect(env.ciphertext.toString("utf8")).not.toContain("super-secret");
    expect(env.dekWrapped.toString("utf8")).not.toContain("super-secret");
  });

  it("다른 마스터키로는 복호화 실패", () => {
    const env = encryptEnvelope(master, "x");
    expect(() => decryptEnvelope(randomBytes(32), env)).toThrow();
  });

  it("변조된 ciphertext는 GCM 태그 검증에서 실패", () => {
    const env = encryptEnvelope(master, "x");
    const last = env.ciphertext.length - 1;
    env.ciphertext[last] = env.ciphertext[last]! ^ 0xff;
    expect(() => decryptEnvelope(master, env)).toThrow();
  });

  it("loadMasterKey는 32바이트가 아니면 거부", () => {
    expect(() => loadMasterKey({ NUDGEON_MASTER_KEY: Buffer.from("short").toString("base64") })).toThrow();
    const good = randomBytes(32).toString("base64");
    expect(loadMasterKey({ NUDGEON_MASTER_KEY: good })).toHaveLength(32);
  });
});
