import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import * as argon2 from "argon2";
import type { Pool, PoolClient } from "pg";
import { PG } from "../infra/infra.module";
import { SessionService } from "./session.service";
import {
  decryptEnvelope,
  encryptEnvelope,
  loadMasterKey,
  type Envelope,
} from "../crypto/envelope";
import {
  base32Encode,
  generateBackupCodes,
  generateSecret,
  normalizeBackupCode,
  otpauthUri,
  verifyTotp,
} from "./totp";

const MAX_FAILED = 5; // 5회 실패 시 잠금 (PRD-06 2.1)
const LOCK_MINUTES = 15;

/** Envelope(2 버퍼) → 단일 bytea 직렬화: [len32(ciphertext)][ciphertext][dekWrapped]. */
function packEnvelope(env: Envelope): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(env.ciphertext.length, 0);
  return Buffer.concat([len, env.ciphertext, env.dekWrapped]);
}
function unpackEnvelope(buf: Buffer): Envelope {
  const n = buf.readUInt32BE(0);
  return { ciphertext: buf.subarray(4, 4 + n), dekWrapped: buf.subarray(4 + n) };
}
function decryptSecret(buf: Buffer): Buffer {
  return Buffer.from(decryptEnvelope(loadMasterKey(), unpackEnvelope(buf)), "base64");
}

/**
 * TOTP 2FA (PRD-06 2.1, DEV-sub-07 T-4).
 * 등록→로그인→드리프트±1→재사용 방지→5회 실패 잠금→백업 코드→Owner/Admin 리셋.
 * 시크릿은 봉투 암호화(NUDGEON_MASTER_KEY)로 저장, 백업 코드는 Argon2id 해시.
 */
@Injectable()
export class TotpService {
  private readonly log = new Logger("TotpService");
  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly sessions: SessionService,
  ) {}

  async status(tenantId: string, memberId: string): Promise<{ enabled: boolean }> {
    const { rows } = await this.pg.query(
      `SELECT totp_enabled_at FROM members WHERE tenant_id = $1 AND id = $2`,
      [tenantId, memberId],
    );
    if (!rows[0]) throw new NotFoundException();
    return { enabled: !!rows[0].totp_enabled_at };
  }

  /** 등록 시작 — 시크릿 생성·저장(미활성). 이미 활성이면 거부. */
  async startEnrollment(tenantId: string, memberId: string, email: string) {
    const { rows } = await this.pg.query(
      `SELECT totp_enabled_at FROM members WHERE tenant_id = $1 AND id = $2`,
      [tenantId, memberId],
    );
    if (!rows[0]) throw new NotFoundException();
    if (rows[0].totp_enabled_at) {
      throw new BadRequestException("이미 2FA가 활성화되어 있습니다");
    }
    const secret = generateSecret();
    const env = encryptEnvelope(loadMasterKey(), secret.toString("base64"));
    await this.pg.query(
      `UPDATE members SET totp_secret_enc = $3, totp_enabled_at = NULL, totp_last_counter = NULL,
              totp_failed_count = 0, totp_locked_until = NULL, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, memberId, packEnvelope(env)],
    );
    const b32 = base32Encode(secret);
    return { secret: b32, otpauth_uri: otpauthUri(email, b32) };
  }

  /** 등록 확인 — 코드 검증 후 활성화 + 백업코드 발급(원문 1회 반환). */
  async confirmEnrollment(tenantId: string, memberId: string, token: string) {
    const { rows } = await this.pg.query(
      `SELECT totp_secret_enc, totp_enabled_at FROM members WHERE tenant_id = $1 AND id = $2`,
      [tenantId, memberId],
    );
    if (!rows[0]?.totp_secret_enc) throw new BadRequestException("먼저 2FA 등록을 시작하세요");
    if (rows[0].totp_enabled_at) throw new BadRequestException("이미 2FA가 활성화되어 있습니다");
    const secret = decryptSecret(rows[0].totp_secret_enc);
    const res = verifyTotp(secret, token, { epochMs: Date.now() });
    if (!res.ok) throw new BadRequestException("인증 코드가 올바르지 않습니다");

    const codes = generateBackupCodes();
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE members SET totp_enabled_at = now(), totp_last_counter = $3,
                totp_failed_count = 0, totp_locked_until = NULL, updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, memberId, res.counter],
      );
      await client.query(`DELETE FROM member_backup_codes WHERE member_id = $1`, [memberId]);
      for (const code of codes) {
        const hash = await argon2.hash(normalizeBackupCode(code), { type: argon2.argon2id });
        await client.query(
          `INSERT INTO member_backup_codes (tenant_id, member_id, code_hash) VALUES ($1, $2, $3)`,
          [tenantId, memberId, hash],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    this.log.log(`2FA enabled: member=${memberId}`);
    return { backup_codes: codes };
  }

  /**
   * 로그인 2FA 검증 — 잠금·드리프트±1·재사용 방지·백업 코드. 성공 시 true.
   * 잠금 상태면 UnauthorizedException.
   *
   * 원자성 (R-09): 멤버 행을 FOR UPDATE로 잠근 뒤 카운터·실패수·백업코드 소비를 모두
   * 같은 트랜잭션에서 처리한다. 동일 멤버에 대한 병렬 로그인 시도는 이 잠금으로 직렬화되어
   * (1) 같은 TOTP 코드의 재사용(counter 재생), (2) 같은 백업 코드의 이중 소비,
   * (3) 실패 카운트 lost-update가 모두 방지된다. 이전 구현은 read→verify→write가 분리되어
   * 병렬 요청이 같은 코드로 동시 통과할 수 있었다.
   */
  async verifyForLogin(memberId: string, token: string): Promise<boolean> {
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT totp_secret_enc, totp_enabled_at, totp_last_counter,
                totp_failed_count, totp_locked_until
           FROM members WHERE id = $1 FOR UPDATE`,
        [memberId],
      );
      const m = rows[0];
      if (!m || !m.totp_enabled_at || !m.totp_secret_enc) {
        await client.query("ROLLBACK");
        return false;
      }
      if (m.totp_locked_until && new Date(m.totp_locked_until) > new Date()) {
        await client.query("ROLLBACK");
        throw new UnauthorizedException("실패 횟수 초과로 잠금되었습니다. 잠시 후 다시 시도하세요");
      }

      const secret = decryptSecret(m.totp_secret_enc);
      const res = verifyTotp(secret, token, {
        epochMs: Date.now(),
        afterCounter: m.totp_last_counter ?? -1,
      });
      if (res.ok) {
        // 잠금 하에서 counter는 엄격 증가만 허용 — 재사용 코드는 afterCounter로 거부됨.
        await client.query(
          `UPDATE members SET totp_last_counter = $2, totp_failed_count = 0,
                  totp_locked_until = NULL, updated_at = now() WHERE id = $1`,
          [memberId, res.counter],
        );
        await client.query("COMMIT");
        return true;
      }

      // TOTP 실패 → 백업 코드 시도 (같은 잠금 하에서 조건부 소비 — 이중 사용 불가)
      if (await this.tryBackupCode(client, memberId, token)) {
        await client.query(
          `UPDATE members SET totp_failed_count = 0, totp_locked_until = NULL,
                  updated_at = now() WHERE id = $1`,
          [memberId],
        );
        await client.query("COMMIT");
        return true;
      }

      // 실패 카운트 증가 · 임계 도달 시 잠금(카운트 리셋)
      const failed = (m.totp_failed_count ?? 0) + 1;
      if (failed >= MAX_FAILED) {
        await client.query(
          `UPDATE members SET totp_failed_count = 0,
                  totp_locked_until = now() + ($2 || ' minutes')::interval, updated_at = now()
            WHERE id = $1`,
          [memberId, String(LOCK_MINUTES)],
        );
      } else {
        await client.query(
          `UPDATE members SET totp_failed_count = $2, updated_at = now() WHERE id = $1`,
          [memberId, failed],
        );
      }
      await client.query("COMMIT");
      return false;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * 본인 2FA 해제 — 코드 재인증 필요.
   * 세션 정책 (R-09): 해제는 보안 상태 변경이므로 현재 세션(currentToken)을 제외한
   * 나머지 세션을 모두 폐기한다(다른 기기/탈취 세션 강제 로그아웃).
   */
  async disable(tenantId: string, memberId: string, token: string, currentToken?: string) {
    const ok = await this.verifyForLogin(memberId, token);
    if (!ok) throw new BadRequestException("인증 코드가 올바르지 않습니다");
    await this.clear(tenantId, memberId);
    const revoked = await this.sessions.revokeAllForMember(tenantId, memberId, currentToken);
    this.log.log(`2FA disabled: member=${memberId} other_sessions_revoked=${revoked}`);
    return { ok: true as const };
  }

  /**
   * Owner/Admin이 멤버 2FA 리셋 (분실 복구). 같은 테넌트로 제한.
   * 세션 정책 (R-09): 리셋은 분실/탈취 복구 시나리오이므로 대상 멤버의 모든 세션을
   * 폐기해 재로그인·재등록을 강제한다.
   */
  async resetForMember(actorTenantId: string, targetMemberId: string) {
    const { rowCount } = await this.pg.query(
      `SELECT 1 FROM members WHERE tenant_id = $1 AND id = $2`,
      [actorTenantId, targetMemberId],
    );
    if (!rowCount) throw new NotFoundException("해당 멤버를 찾을 수 없습니다");
    await this.clear(actorTenantId, targetMemberId);
    const revoked = await this.sessions.revokeAllForMember(actorTenantId, targetMemberId);
    // 감사 로그 테이블은 별도(DEV-sub-07 감사 로그) — 우선 구조적 로그로 남긴다.
    this.log.warn(
      `2FA reset by admin: tenant=${actorTenantId} member=${targetMemberId} sessions_revoked=${revoked}`,
    );
    return { ok: true as const };
  }

  private async clear(tenantId: string, memberId: string) {
    await this.pg.query(
      `UPDATE members SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_counter = NULL,
              totp_failed_count = 0, totp_locked_until = NULL, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, memberId],
    );
    await this.pg.query(`DELETE FROM member_backup_codes WHERE member_id = $1`, [memberId]);
  }

  /**
   * 백업 코드 소비 — verifyForLogin의 멤버 행 잠금 트랜잭션(client) 안에서 호출된다.
   * UPDATE는 `used_at IS NULL` 조건부이며 rowCount===1일 때만 소비 성공으로 본다
   * (잠금과 조건부 UPDATE 이중 방어로 같은 코드의 이중 소비를 차단).
   */
  private async tryBackupCode(client: PoolClient, memberId: string, token: string): Promise<boolean> {
    const norm = normalizeBackupCode(token);
    if (norm.length < 8) return false;
    const { rows } = await client.query(
      `SELECT id, code_hash FROM member_backup_codes WHERE member_id = $1 AND used_at IS NULL`,
      [memberId],
    );
    for (const r of rows) {
      const match = await argon2.verify(r.code_hash, norm).catch(() => false);
      if (match) {
        const { rowCount } = await client.query(
          `UPDATE member_backup_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
          [r.id],
        );
        return (rowCount ?? 0) === 1;
      }
    }
    return false;
  }
}
