import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { CLICKHOUSE, PG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { AuditService } from "../audit/audit.service";

/** 데이터 섹션 (PRD-05 3.7): 수집 오류 + 속성 사전 */
@Controller("v1/apps/:appId/data")
@UseGuards(SessionGuard)
export class DataController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
    private readonly audit: AuditService,
  ) {}

  /** 수집 오류 뷰 — 타입 불일치 등 거부 건 (고객사 개발자 디버깅) */
  @Get("ingestion-errors")
  async ingestionErrors(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Query("limit") limit: string | undefined,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const max = Math.min(Number(limit) || 100, 500);
    const res = await this.ch.query({
      query: `SELECT endpoint, reason, detail, payload, request_id,
                     formatDateTime(received_at, '%Y-%m-%dT%H:%M:%S') AS received_at
                FROM ingestion_errors
               WHERE tenant_id = {tid:UUID} AND app_id = {aid:UUID}
               ORDER BY received_at DESC LIMIT ${max}`,
      query_params: { tid: req.member.tenantId, aid: appId },
      format: "JSONEachRow",
    });
    return { errors: await res.json() };
  }

  /** 속성 사전 — 키·타입·최초/최근·참조 세그먼트 수 */
  @Get("attributes")
  async attributes(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    await this.assertApp(appId, req);
    const { rows } = await this.pg.query(
      `SELECT key, type, first_seen_at, last_seen_at, seg_ref_count
         FROM attribute_registry WHERE tenant_id = $1 AND app_id = $2 ORDER BY key`,
      [req.member.tenantId, appId],
    );
    return { attributes: rows };
  }

  /**
   * 속성 삭제 — 참조 중인 세그먼트가 있으면 목록과 함께 거부(확인 요구, PRD-02 6장).
   * force=true로 재요청 시 삭제.
   */
  @Delete("attributes/:key")
  async deleteAttribute(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("key") key: string,
    @Query("force") force: string | undefined,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    if (!["owner", "admin", "editor"].includes(req.member.role)) {
      throw new ForbiddenException("속성 삭제는 Editor 이상만 가능합니다");
    }
    // 참조 세그먼트 탐색 (definition jsonb에서 key 사용 여부)
    const { rows: segs } = await this.pg.query(
      `SELECT id, name FROM segments
        WHERE tenant_id = $1 AND app_id = $2 AND definition::text LIKE $3`,
      [req.member.tenantId, appId, `%"key":"${key}"%`],
    );
    if (segs.length > 0 && force !== "true") {
      return { deleted: false, referencing_segments: segs };
    }
    const { rowCount } = await this.pg.query(
      `DELETE FROM attribute_registry WHERE app_id = $1 AND key = $2`,
      [appId, key],
    );
    if (!rowCount) throw new NotFoundException("속성을 찾을 수 없습니다");
    await this.audit.recordAs(req.member, req.ip, "attribute.delete", {
      targetType: "attribute",
      targetId: `${appId}:${key}`,
      detail: { app_id: appId, key, forced: force === "true" },
    });
    return { deleted: true };
  }

  private async assertApp(appId: string, req: SessionRequest) {
    const { rowCount } = await this.pg.query(`SELECT 1 FROM apps WHERE id = $1 AND tenant_id = $2`, [
      appId,
      req.member.tenantId,
    ]);
    if (!rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");
  }
}
