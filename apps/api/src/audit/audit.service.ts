import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { PG } from "../infra/infra.module";
import type { SessionMember } from "../auth/session.service";

export interface AuditEntry {
  tenantId: string;
  actorMemberId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * 감사 로그 기록 (DEV-sub-07 T-9). 크리덴셜 변경·2FA 리셋·키 작업·속성 편집 등 민감 행위를
 * 행위자·일시·대상과 함께 append-only로 남긴다.
 *
 * 기록 실패가 주 작업(이미 커밋됨)을 되돌리지는 않되, 조용히 삼키지 않고 ERROR로 표면화한다
 * (감사 유실은 컴플라이언스 이슈 — 관찰성 지표/로그로 반드시 드러낸다).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger("AuditService");

  constructor(@Inject(PG) private readonly pg: Pool) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.pg.query(
        `INSERT INTO audit_logs
           (tenant_id, actor_member_id, actor_email, action, target_type, target_id, detail, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.tenantId,
          entry.actorMemberId ?? null,
          entry.actorEmail ?? null,
          entry.action,
          entry.targetType ?? null,
          entry.targetId ?? null,
          JSON.stringify(entry.detail ?? {}),
          entry.ip ?? null,
        ],
      );
    } catch (err) {
      this.logger.error(
        `감사 로그 기록 실패 (action=${entry.action}, target=${entry.targetType}:${entry.targetId}): ${String(err)}`,
      );
    }
  }

  /** 세션 행위자 + IP를 채워 기록하는 편의 헬퍼. */
  async recordAs(
    actor: SessionMember,
    ip: string | undefined,
    action: string,
    fields: { targetType?: string; targetId?: string; detail?: Record<string, unknown> } = {},
  ): Promise<void> {
    await this.record({
      tenantId: actor.tenantId,
      actorMemberId: actor.memberId,
      actorEmail: actor.email,
      action,
      ip: ip ?? null,
      ...fields,
    });
  }
}
