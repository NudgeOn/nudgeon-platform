import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import * as argon2 from "argon2";
import type { Pool, PoolClient } from "pg";
import { PG } from "../infra/infra.module";
import { SessionService } from "../auth/session.service";
import { isRole, type Role } from "../authz/permissions";

export interface MemberRow {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  totp_enabled: boolean;
  created_at: string;
}

/**
 * 팀 멤버 관리 (R-16, PRD-06 2장). 불변식:
 *  - 최소 1명의 활성 Owner 유지(마지막 Owner 강등·삭제 금지).
 *  - 권한 상승 방지: owner 역할 부여/변경 및 owner 대상 수정·삭제는 Owner만.
 *  - 역할 변경·삭제 즉시 반영: resolve가 매 요청 role·status를 재조회하므로 다음 요청부터 적용되고,
 *    추가로 대상의 세션을 폐기해 진행 중 세션도 강제 종료(강등/삭제 = 보안 상태 변경).
 * 모든 쿼리는 tenant_id로 스코프한다.
 */
@Injectable()
export class MembersService {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly sessions: SessionService,
  ) {}

  async list(tenantId: string): Promise<MemberRow[]> {
    const { rows } = await this.pg.query(
      `SELECT id, email, name, role::text AS role, status::text AS status,
              (totp_enabled_at IS NOT NULL) AS totp_enabled, created_at
         FROM members WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows as MemberRow[];
  }

  /** 멤버 생성 (self-host: 관리자가 초기 비밀번호 지정). owner 부여는 Owner만. */
  async create(
    tenantId: string,
    actorRole: string,
    input: { email: string; name: string; role: Role; password: string },
  ): Promise<MemberRow> {
    this.assertAssignableRole(actorRole, input.role);
    const dup = await this.pg.query(
      `SELECT 1 FROM members WHERE tenant_id = $1 AND lower(email) = lower($2)`,
      [tenantId, input.email],
    );
    if (dup.rowCount) throw new ConflictException("이미 존재하는 이메일입니다");
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const { rows } = await this.pg.query(
      `INSERT INTO members (tenant_id, email, password_hash, name, role, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING id, email, name, role::text AS role, status::text AS status,
                 (totp_enabled_at IS NOT NULL) AS totp_enabled, created_at`,
      [tenantId, input.email, passwordHash, input.name, input.role],
    );
    return rows[0] as MemberRow;
  }

  /** 역할 변경 — 마지막 Owner 강등 금지·권한 상승 방지·세션 폐기. */
  async changeRole(
    tenantId: string,
    actorRole: string,
    targetId: string,
    newRole: Role,
  ): Promise<{ ok: true; revoked: number }> {
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const target = await this.lockMember(client, tenantId, targetId);
      // owner 부여/변경, owner 대상 수정은 Owner만 (권한 상승 방지)
      this.assertAssignableRole(actorRole, newRole);
      this.assertCanManageTarget(actorRole, target.role);
      if (target.role === "owner" && newRole !== "owner") {
        await this.assertNotLastOwner(client, tenantId, targetId);
      }
      await client.query(
        `UPDATE members SET role = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, targetId, newRole],
      );
      await client.query("COMMIT");
      // 세션 폐기(권한 변경 반영 보강) — resolve가 role을 재조회하므로 즉시 반영되지만
      // 진행 중 세션도 강제 재로그인시켜 상태를 확정한다.
      const revoked = await this.sessions.revokeAllForMember(tenantId, targetId);
      return { ok: true, revoked };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** 멤버 제거 — soft(status=disabled). 마지막 Owner·본인 삭제 금지·세션 폐기. */
  async remove(
    tenantId: string,
    actorRole: string,
    actorId: string,
    targetId: string,
  ): Promise<{ ok: true; revoked: number }> {
    if (actorId === targetId) {
      throw new BadRequestException("본인 계정은 삭제할 수 없습니다");
    }
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const target = await this.lockMember(client, tenantId, targetId);
      this.assertCanManageTarget(actorRole, target.role);
      if (target.role === "owner") {
        await this.assertNotLastOwner(client, tenantId, targetId);
      }
      await client.query(
        `UPDATE members SET status = 'disabled', updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, targetId],
      );
      await client.query("COMMIT");
      const revoked = await this.sessions.revokeAllForMember(tenantId, targetId);
      return { ok: true, revoked };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  // --- 내부 불변식 ---

  private async lockMember(
    client: PoolClient,
    tenantId: string,
    targetId: string,
  ): Promise<{ role: string; status: string }> {
    const { rows } = await client.query(
      `SELECT role::text AS role, status::text AS status FROM members
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, targetId],
    );
    if (!rows[0]) throw new NotFoundException("해당 멤버를 찾을 수 없습니다");
    return rows[0] as { role: string; status: string };
  }

  /**
   * 마지막 활성 Owner 강등/삭제 방지 — 다른 활성 Owner 행을 FOR UPDATE로 잠가 경합을 직렬화한다.
   * (집계 함수에는 FOR UPDATE를 못 쓰므로 행을 직접 잠그고 rowCount로 판정.)
   */
  private async assertNotLastOwner(client: PoolClient, tenantId: string, targetId: string) {
    const { rowCount } = await client.query(
      `SELECT id FROM members
        WHERE tenant_id = $1 AND role = 'owner' AND status = 'active' AND id <> $2 FOR UPDATE`,
      [tenantId, targetId],
    );
    if ((rowCount ?? 0) === 0) {
      throw new BadRequestException("최소 1명의 Owner가 필요합니다");
    }
  }

  /** owner 역할의 부여/전환은 Owner만 허용 (admin의 권한 상승 방지). */
  private assertAssignableRole(actorRole: string, newRole: Role) {
    if (!isRole(newRole)) throw new BadRequestException("알 수 없는 역할입니다");
    if (newRole === "owner" && actorRole !== "owner") {
      throw new ForbiddenException("Owner 역할 지정은 Owner만 가능합니다");
    }
  }

  /** owner 멤버의 수정/삭제는 Owner만 허용. */
  private assertCanManageTarget(actorRole: string, targetRole: string) {
    if (targetRole === "owner" && actorRole !== "owner") {
      throw new ForbiddenException("Owner 멤버 관리는 Owner만 가능합니다");
    }
  }
}
