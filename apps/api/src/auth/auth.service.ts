import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import * as argon2 from "argon2";
import type { Pool } from "pg";
import { CONFIG, PG } from "../infra/infra.module";
import type { AppConfig } from "../config";
import { generateApiKey } from "./api-key.service";

export interface SignupInput {
  email: string;
  password: string;
  name: string;
  tenantName: string;
}

/**
 * 가입·로그인 (DEV-sub-07 S1).
 * 가입 = 테넌트 자동 생성 + Owner 멤버 + 기본 앱 + SDK/Server 키 발급 (PRD-06 2장).
 */
@Injectable()
export class AuthService {
  private readonly mode: AppConfig["mode"];

  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CONFIG) cfg: AppConfig,
  ) {
    this.mode = cfg.mode;
  }

  /** 전체 멤버 수 — single_tenant 부트스트랩 잠금 판정용 */
  async countMembers(): Promise<number> {
    const { rows } = await this.pg.query(`SELECT count(*)::int AS n FROM members`);
    return rows[0].n as number;
  }

  async signup(input: SignupInput) {
    if (this.mode === "single_tenant") {
      // 셀프호스팅은 부트스트랩 경로로만 계정 생성 (가입 비활성)
      const existing = await this.countMembers();
      if (existing > 0) {
        throw new ConflictException("셀프호스팅 모드에서는 추가 가입이 비활성화됩니다");
      }
    }
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const dup = await client.query(
        `SELECT 1 FROM members WHERE lower(email) = lower($1)`,
        [input.email],
      );
      if (dup.rowCount) throw new ConflictException("이미 가입된 이메일입니다");

      const tenant = await client.query(
        `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
        [input.tenantName],
      );
      const tenantId: string = tenant.rows[0].id;

      const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
      const member = await client.query(
        `INSERT INTO members (tenant_id, email, password_hash, name, role, status)
         VALUES ($1, lower($2), $3, $4, 'owner', 'active') RETURNING id`,
        [tenantId, input.email, passwordHash, input.name],
      );
      const memberId: string = member.rows[0].id;

      // 기본 앱 + 키 발급 — 온보딩 위저드(S2)의 출발점
      const app = await client.query(
        `INSERT INTO apps (tenant_id, name) VALUES ($1, $2) RETURNING id`,
        [tenantId, "Default App"],
      );
      const appId: string = app.rows[0].id;
      const sdkKey = generateApiKey("sdk");
      const serverKey = generateApiKey("server");
      await client.query(
        `INSERT INTO api_keys (tenant_id, app_id, kind, scope, prefix, key_hash)
         VALUES ($1, $2, 'sdk', 'full', $3, $4), ($1, $2, 'server', 'full', $5, $6)`,
        [tenantId, appId, sdkKey.prefix, sdkKey.hash, serverKey.prefix, serverKey.hash],
      );

      await client.query("COMMIT");
      return {
        tenantId,
        memberId,
        appId,
        // 키 원문은 이 응답에서 1회만 노출 (PRD-06 3장)
        sdkKey: sdkKey.key,
        serverKey: serverKey.key,
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async verifyLogin(email: string, password: string) {
    const { rows } = await this.pg.query(
      `SELECT id, tenant_id, password_hash FROM members
        WHERE lower(email) = lower($1) AND status = 'active'`,
      [email],
    );
    const row = rows[0];
    // 계정 존재 여부를 응답 시간으로 노출하지 않도록 항상 해시 검증 수행
    const hash =
      row?.password_hash ??
      "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!row || !ok) throw new UnauthorizedException("이메일 또는 비밀번호가 올바르지 않습니다");
    return { memberId: row.id as string, tenantId: row.tenant_id as string };
  }
}
