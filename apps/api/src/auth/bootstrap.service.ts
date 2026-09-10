import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { CONFIG, PG } from "../infra/infra.module";
import type { AppConfig } from "../config";
import { AuthService } from "./auth.service";
import { masterKeyFingerprint } from "../crypto/envelope";

/**
 * 설치 소유권 claim → 최초 Owner 원자 생성 → 영구 잠금 (Slice B, docs-public/DOCKER-SETUP-WIZARD-PRD.md 7·8장).
 *
 * 권위는 `installation` 싱글턴 행의 state다 — count(members)가 아니다.
 *   unclaimed → claimed(lease 15분, cookie holder에 결박) → secured(토큰 해시 제거, 새 mutation 영구 차단)
 * 모든 전이는 그 행을 FOR UPDATE로 잠근 트랜잭션 안에서 한 번만 성공한다. 동시 claim은 하나만 lease를 얻고,
 * 동시 setup은 하나만 Owner를 만든다. commit 뒤 응답이 유실되면 같은 cookie+Idempotency-Key로 결과를 다시 받는다.
 */
export type InstallationState = "unclaimed" | "claimed" | "secured" | "recovery_required";

export interface SetupInput {
  workspaceName: string;
  appName: string;
  owner: { name: string; email: string; password: string };
  timezone?: string;
}

export interface SetupResult {
  tenant_id: string;
  app_id: string;
  member_id: string;
  installation_id: string;
  secured_at: string;
}

export const CLAIM_TTL_MS = 15 * 60_000;
export const BOOTSTRAP_COOKIE = "nudgeon_bootstrap";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const same = (a: string | null | undefined, b: string) => {
  if (!a) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly log = new Logger(BootstrapService.name);

  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly auth: AuthService,
  ) {}

  /** 기동 시 installation 행을 만들고 setup 토큰 해시를 올린다. 토큰이 바뀌었으면 rotate(이전 lease 폐기). */
  async onModuleInit() {
    if (this.cfg.mode !== "single_tenant") return;
    try {
      await this.ensureInstallation();
    } catch (e) {
      // 테이블이 아직 없는 환경(구 마이그레이션)에서도 API는 떠야 한다 — 상태 API가 recovery_required로 알린다.
      this.log.error(`installation 초기화 실패: ${(e as Error).message}`);
    }
  }

  async ensureInstallation(): Promise<void> {
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO installation (installed_version) VALUES ($1) ON CONFLICT (singleton) DO NOTHING`, [this.cfg.version]);
      const { rows } = await client.query(`SELECT state, setup_token_hash, setup_token_version FROM installation FOR UPDATE`);
      const row = rows[0];
      if (row.state !== "secured" && this.cfg.setupToken) {
        const hash = sha256(this.cfg.setupToken);
        if (!same(row.setup_token_hash, hash)) {
          // 새 토큰 = rotate: 이전 코드와 모든 claim lease는 즉시 폐기된다 (S1 수용 기준).
          await client.query(
            `UPDATE installation SET setup_token_hash=$1, setup_token_version=setup_token_version+1, state='unclaimed',
               claim_session_hash=NULL, claim_expires_at=NULL, claimed_at=NULL, record_version=record_version+1, updated_at=now()`,
            [hash],
          );
          this.log.log(`setup 토큰 등록 (version ${row.setup_token_version + 1})`);
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async status(): Promise<{ mode: string; state: InstallationState; installation_id?: string; version: string; setup_token_configured: boolean; needs_setup: boolean; master_key_fingerprint?: string }> {
    if (this.cfg.mode !== "single_tenant") {
      return { mode: "multi_tenant", state: "secured", version: this.cfg.version, setup_token_configured: false, needs_setup: false };
    }
    const fingerprint = masterKeyFingerprint();
    const { rows } = await this.pg.query(`SELECT installation_id, state, setup_token_hash FROM installation`).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
    const row = rows[0];
    if (!row) return { mode: "single_tenant", state: "recovery_required", version: this.cfg.version, setup_token_configured: false, needs_setup: true };
    return {
      mode: "single_tenant",
      state: row.state as InstallationState,
      installation_id: row.installation_id as string,
      version: this.cfg.version,
      setup_token_configured: !!row.setup_token_hash,
      needs_setup: row.state !== "secured",
      master_key_fingerprint: fingerprint, // 원문이 아니다 — ./nudgeon secrets backup의 fingerprint와 대조용
    };
  }

  /**
   * 설치 코드 교환 → Bootstrap cookie 값. 활성 lease가 있으면 409, 이미 secured면 410.
   * 만료된 lease는 새 claim이 가져간다(브라우저 종료 복구).
   */
  async claim(rawToken: string): Promise<{ cookie: string; expiresAt: Date }> {
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT state, setup_token_hash, claim_expires_at FROM installation FOR UPDATE`);
      const row = rows[0];
      if (!row) throw new NotFoundException("설치 상태가 없습니다");
      if (row.state === "secured") throw new GoneException("설치가 이미 완료됐습니다");
      if (!row.setup_token_hash) throw new ForbiddenException("setup 토큰이 설정되지 않았습니다 — ./nudgeon setup-token rotate 또는 NUDGEON_SETUP_TOKEN_FILE");
      if (!same(row.setup_token_hash, sha256(rawToken))) throw new UnauthorizedException("설치 코드가 올바르지 않습니다");
      if (row.state === "claimed" && row.claim_expires_at && new Date(row.claim_expires_at) > new Date()) {
        throw new ConflictException("다른 브라우저가 설치를 진행 중입니다 — lease가 만료된 뒤 다시 시도하세요");
      }
      const cookie = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
      await client.query(
        `UPDATE installation SET state='claimed', claim_session_hash=$1, claim_expires_at=$2, claimed_at=now(),
           record_version=record_version+1, updated_at=now()`,
        [sha256(cookie), expiresAt],
      );
      await client.query("COMMIT");
      return { cookie, expiresAt };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Owner·workspace·app 원자 생성 + secured 전이. 같은 cookie+Idempotency-Key의 재요청은 저장된 결과를 돌려준다
   * (키 원문은 다시 주지 않는다 — 인증된 키 회전 경로로 복구). 다른 key로의 새 setup은 410.
   */
  async setup(cookie: string | undefined, idempotencyKey: string, input: SetupInput): Promise<{ result: SetupResult; keys?: { sdk_key: string; server_key: string }; replayed: boolean }> {
    if (!cookie) throw new UnauthorizedException("Bootstrap cookie가 없습니다 — 설치 코드를 먼저 교환하세요");
    const requestHash = sha256(JSON.stringify({ w: input.workspaceName, a: input.appName, e: input.owner.email.toLowerCase(), n: input.owner.name, tz: input.timezone ?? "" }));
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT * FROM installation FOR UPDATE`);
      const row = rows[0];
      if (!row) throw new NotFoundException("설치 상태가 없습니다");
      const holder = same(row.claim_session_hash, sha256(cookie));
      if (row.state === "secured") {
        // exact replay: 같은 cookie holder + 같은 Idempotency-Key + 원래 lease TTL 안
        if (holder && same(row.setup_idempotency_key_hash, sha256(idempotencyKey)) && row.claim_expires_at && new Date(row.claim_expires_at) > new Date()) {
          if (!same(row.setup_request_hash, requestHash)) throw new ConflictException("같은 Idempotency-Key로 다른 요청이 왔습니다");
          await client.query("COMMIT");
          return { result: row.setup_result as SetupResult, replayed: true };
        }
        throw new GoneException("설치가 이미 완료됐습니다 — 새 bootstrap 요청은 받지 않습니다");
      }
      if (row.state !== "claimed" || !holder) throw new UnauthorizedException("이 Bootstrap 세션은 설치 lease를 갖고 있지 않습니다");
      if (!row.claim_expires_at || new Date(row.claim_expires_at) <= new Date()) throw new UnauthorizedException("Bootstrap 세션이 만료됐습니다 — 설치 코드를 다시 교환하세요");

      const created = await this.auth.createWorkspace(client as PoolClient, {
        email: input.owner.email, password: input.owner.password, name: input.owner.name, tenantName: input.workspaceName, appName: input.appName,
      });
      if (input.timezone) {
        await client.query(`UPDATE apps SET timezone=$3 WHERE id=$1 AND tenant_id=$2`, [created.appId, created.tenantId, input.timezone]);
      }
      const securedAt = new Date().toISOString();
      const result: SetupResult = { tenant_id: created.tenantId, app_id: created.appId, member_id: created.memberId, installation_id: row.installation_id, secured_at: securedAt };
      await client.query(
        `UPDATE installation SET state='secured', setup_token_hash=NULL, secured_at=$1, tenant_id=$2, owner_id=$3, app_id=$4,
           setup_idempotency_key_hash=$5, setup_request_hash=$6, setup_result=$7, record_version=record_version+1, updated_at=now()`,
        [securedAt, created.tenantId, created.memberId, created.appId, sha256(idempotencyKey), requestHash, JSON.stringify(result)],
      );
      await client.query("COMMIT");
      return { result, keys: { sdk_key: created.sdkKey, server_key: created.serverKey }, replayed: false };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /** Bootstrap 세션 연장 — 같은 cookie holder가 만료 전에 부르면 lease를 15분 더 준다 (S1 수용 기준 "연장 CTA"). */
  async extend(cookie: string | undefined): Promise<Date> {
    if (!cookie) throw new UnauthorizedException("Bootstrap cookie가 없습니다");
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT state, claim_session_hash, claim_expires_at FROM installation FOR UPDATE`);
      const row = rows[0];
      if (!row || row.state !== "claimed" || !same(row.claim_session_hash, sha256(cookie))) throw new UnauthorizedException("이 세션은 설치 lease를 갖고 있지 않습니다");
      if (!row.claim_expires_at || new Date(row.claim_expires_at) <= new Date()) throw new UnauthorizedException("Bootstrap 세션이 만료됐습니다 — 설치 코드를 다시 교환하세요");
      const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
      await client.query(`UPDATE installation SET claim_expires_at=$1, record_version=record_version+1, updated_at=now()`, [expiresAt]);
      await client.query("COMMIT");
      return expiresAt;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /** 응답 유실 복구: secured 뒤 원래 lease TTL 안에서 같은 cookie holder가 같은 key로 결과를 다시 읽는다. */
  async setupResult(cookie: string | undefined, idempotencyKey: string): Promise<SetupResult> {
    if (!cookie) throw new UnauthorizedException("Bootstrap cookie가 없습니다");
    const { rows } = await this.pg.query(`SELECT state, claim_session_hash, claim_expires_at, setup_idempotency_key_hash, setup_result FROM installation`);
    const row = rows[0];
    if (!row || row.state !== "secured") throw new NotFoundException("완료된 설치 결과가 없습니다");
    if (!same(row.claim_session_hash, sha256(cookie)) || !same(row.setup_idempotency_key_hash, sha256(idempotencyKey))) throw new UnauthorizedException("이 세션의 설치 결과가 아닙니다");
    if (!row.claim_expires_at || new Date(row.claim_expires_at) <= new Date()) throw new GoneException("복구 창이 지났습니다 — 로그인으로 진행하세요");
    return row.setup_result as SetupResult;
  }
}
