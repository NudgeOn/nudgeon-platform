import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP + RFC 4648 base32 — 의존성 없는 표준 구현 (PRD-06 2.1, DEV-sub-07 T-4).
 *
 * otplib 대신 Node 내장 crypto를 쓰는 이유: 배포 이미지 빌드가 pnpm --frozen-lockfile이라
 * 신규 npm 의존성(otplib)을 추가하려면 lockfile 재생성이 필요하다. HMAC-SHA1·30초 스텝·6자리라는
 * 동일 표준을 내장 crypto로 만족시켜 "otplib 계열"(PRD-06 2.1)의 의도를 충족한다.
 */

export const TOTP_PERIOD = 30; // 초
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1; // 드리프트 ±1 스텝 허용 (PRD-06 2.1)
export const SECRET_BYTES = 20; // 160-bit (RFC 4226 권장)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** RFC 4648 base32 (padding 없음) — authenticator 앱·otpauth URI용. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** HOTP(RFC 4226) — counter는 8바이트 big-endian. */
function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac("sha1", secret).update(buf).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin =
    ((h[offset]! & 0x7f) << 24) |
    ((h[offset + 1]! & 0xff) << 16) |
    ((h[offset + 2]! & 0xff) << 8) |
    (h[offset + 3]! & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

export function counterAt(epochMs: number, period = TOTP_PERIOD): number {
  return Math.floor(epochMs / 1000 / period);
}

/** 현재 시각 기준 TOTP 코드 (테스트·클라이언트 계산 검증용). */
export function totpAt(secret: Buffer, epochMs: number, digits = TOTP_DIGITS): string {
  return hotp(secret, counterAt(epochMs), digits);
}

export interface VerifyResult {
  ok: boolean;
  counter: number; // 매칭된 스텝(재사용 방지용). ok=false면 -1.
}

/**
 * 윈도우 ±window 내 검증. afterCounter 이하 스텝은 거부(재사용/구코드 방지). timing-safe 비교.
 */
export function verifyTotp(
  secret: Buffer,
  token: string,
  opts: { epochMs: number; window?: number; digits?: number; afterCounter?: number },
): VerifyResult {
  const window = opts.window ?? TOTP_WINDOW;
  const digits = opts.digits ?? TOTP_DIGITS;
  const after = opts.afterCounter ?? -1;
  const clean = token.replace(/\s/g, "");
  if (clean.length !== digits || !/^\d+$/.test(clean)) return { ok: false, counter: -1 };
  const base = counterAt(opts.epochMs);
  for (let c = base - window; c <= base + window; c++) {
    if (c <= after) continue; // 재사용/오래된 스텝 거부
    const expected = Buffer.from(hotp(secret, c, digits));
    const got = Buffer.from(clean);
    if (expected.length === got.length && timingSafeEqual(expected, got)) {
      return { ok: true, counter: c };
    }
  }
  return { ok: false, counter: -1 };
}

export function otpauthUri(accountLabel: string, secretBase32: string, issuer = "Onda"): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 백업 코드 N개 — 각 10자리 base32(XXXXX-XXXXX). */
export function generateBackupCodes(n = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/** 저장·비교용 정규화 (하이픈·공백 제거, 대문자). */
export function normalizeBackupCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}
