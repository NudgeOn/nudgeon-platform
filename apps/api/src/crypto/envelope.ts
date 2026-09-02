import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * 크리덴셜 봉투 암호화 (PRD-06 4장, DEV-sub-04).
 * - DEK(32B 랜덤)로 평문 암호화, 마스터키로 DEK 래핑. 모두 AES-256-GCM.
 * - 저장 레이아웃: nonce(12B) || ciphertext || tag(16B) — Go crypto/cipher GCM Seal과 호환.
 * - 마스터키: NUDGEON_MASTER_KEY(base64 32B) 또는 KMS_MASTER_KEY_FILE. SaaS는 v1.5에 KMS 교체.
 */

const NONCE_LEN = 12;

export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const inline = env.NUDGEON_MASTER_KEY;
  if (inline) {
    const key = Buffer.from(inline, "base64");
    if (key.length !== 32) throw new Error("NUDGEON_MASTER_KEY는 base64 32바이트여야 합니다");
    return key;
  }
  const file = env.KMS_MASTER_KEY_FILE;
  if (file) {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error("마스터키 파일은 base64 32바이트여야 합니다");
    return key;
  }
  throw new Error("마스터키 미설정 — NUDGEON_MASTER_KEY 또는 KMS_MASTER_KEY_FILE 필요");
}

function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer): Buffer {
  const nonce = sealed.subarray(0, NONCE_LEN);
  const tag = sealed.subarray(sealed.length - 16);
  const body = sealed.subarray(NONCE_LEN, sealed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export interface Envelope {
  ciphertext: Buffer;
  dekWrapped: Buffer;
}

export function encryptEnvelope(masterKey: Buffer, plaintext: string): Envelope {
  const dek = randomBytes(32);
  return {
    ciphertext: seal(dek, Buffer.from(plaintext, "utf8")),
    dekWrapped: seal(masterKey, dek),
  };
}

export function decryptEnvelope(masterKey: Buffer, env: Envelope): string {
  const dek = open(masterKey, env.dekWrapped);
  return open(dek, env.ciphertext).toString("utf8");
}
