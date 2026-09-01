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
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { CLICKHOUSE, PG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { AuditService } from "../audit/audit.service";
import { generateApiKey } from "../auth/api-key.service";

const KEY_ADMIN_ROLES = ["owner", "admin"];
const SDK_ROTATION_GRACE_DAYS = 30; // 구키 병행 유효 기간 (PRD-06 3장)

/** 앱·API 키 관리 (세션 인증) — 온보딩 위저드의 백엔드 */
@Controller("v1/apps")
@UseGuards(SessionGuard)
export class AppsController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() req: SessionRequest) {
    const { rows } = await this.pg.query(
      `SELECT id, name, timezone, created_at FROM apps WHERE tenant_id = $1 ORDER BY created_at`,
      [req.member.tenantId],
    );
    return { apps: rows };
  }

  /** API 키 목록 — 원문은 발급 응답에서만 1회 노출, 목록은 prefix만 */
  @Get(":appId/keys")
  async keys(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    await this.assertApp(appId, req);
    this.assertKeyAdmin(req); // Editor는 API 키 접근 불가 (PRD-05 4장, U-10)
    const { rows } = await this.pg.query(
      `SELECT id, kind, scope, prefix, status, grace_expires_at, last_used_at, created_at
         FROM api_keys WHERE tenant_id = $1 AND app_id = $2
        ORDER BY kind, created_at DESC`,
      [req.member.tenantId, appId],
    );
    return { keys: rows };
  }

  /**
   * SDK Key 회전 (T-2): 새 키 발급 + 구키는 30일 유예 병행 유효.
   * 유예 만료·폐기 판정은 ApiKeyService.resolve가 수행.
   */
  @Post(":appId/keys/:keyId/rotate")
  async rotate(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("keyId", ParseUUIDPipe) keyId: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    this.assertKeyAdmin(req);

    const { rows } = await this.pg.query(
      `SELECT kind, status FROM api_keys
        WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
      [keyId, req.member.tenantId, appId],
    );
    const key = rows[0];
    if (!key) throw new NotFoundException("키를 찾을 수 없습니다");
    if (key.kind !== "sdk") {
      throw new BadRequestException("회전은 SDK Key 전용 — Server Key는 발급/폐기로 관리");
    }
    if (key.status !== "active") {
      throw new BadRequestException("active 상태의 키만 회전할 수 있습니다");
    }

    const newKey = generateApiKey("sdk");
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE api_keys SET status = 'rotating',
                grace_expires_at = now() + interval '${SDK_ROTATION_GRACE_DAYS} days',
                updated_at = now()
          WHERE id = $1`,
        [keyId],
      );
      await client.query(
        `INSERT INTO api_keys (tenant_id, app_id, kind, scope, prefix, key_hash)
         VALUES ($1, $2, 'sdk', 'full', $3, $4)`,
        [req.member.tenantId, appId, newKey.prefix, newKey.hash],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    await this.audit.recordAs(req.member, req.ip, "apikey.rotate", {
      targetType: "apikey",
      targetId: keyId,
      detail: { app_id: appId, kind: "sdk" },
    });
    return {
      sdk_key: newKey.key, // 1회 노출
      grace_days: SDK_ROTATION_GRACE_DAYS,
    };
  }

  /** Server Key 추가 발급 (복수 허용 — PRD-06 3장) */
  @Post(":appId/keys")
  async createServerKey(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    this.assertKeyAdmin(req);
    const newKey = generateApiKey("server");
    const { rows } = await this.pg.query(
      `INSERT INTO api_keys (tenant_id, app_id, kind, scope, prefix, key_hash)
       VALUES ($1, $2, 'server', 'full', $3, $4) RETURNING id`,
      [req.member.tenantId, appId, newKey.prefix, newKey.hash],
    );
    await this.audit.recordAs(req.member, req.ip, "apikey.create", {
      targetType: "apikey",
      targetId: rows[0].id,
      detail: { app_id: appId, kind: "server" },
    });
    return { id: rows[0].id, server_key: newKey.key }; // 1회 노출
  }

  /** 즉시 폐기 — resolve가 매 요청 PG 조회하므로 폐기 즉시 401 (≤5s 요건 충족) */
  @Delete(":appId/keys/:keyId")
  async revoke(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("keyId", ParseUUIDPipe) keyId: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    this.assertKeyAdmin(req);
    const { rowCount } = await this.pg.query(
      `UPDATE api_keys SET status = 'revoked', revoked_at = now(), updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND app_id = $3 AND status <> 'revoked'`,
      [keyId, req.member.tenantId, appId],
    );
    if (!rowCount) throw new NotFoundException();
    await this.audit.recordAs(req.member, req.ip, "apikey.revoke", {
      targetType: "apikey",
      targetId: keyId,
      detail: { app_id: appId },
    });
    return { ok: true };
  }

  /** 첫 이벤트 수신 감지 (위저드 3단계 폴링) */
  @Get(":appId/ingest-status")
  async ingestStatus(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const result = await this.ch.query({
      query: `SELECT count(*) AS total, max(server_ts) AS last_event_at
                FROM events WHERE tenant_id = {tenant:UUID} AND app_id = {app:UUID}`,
      query_params: { tenant: req.member.tenantId, app: appId },
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Array<{
      total: string;
      last_event_at: string | null;
    }>;
    const row = rows[0];
    const total = Number(row?.total ?? 0);
    return {
      events_total: total,
      last_event_at: total > 0 ? row?.last_event_at : null,
    };
  }

  private async assertApp(appId: string, req: SessionRequest) {
    const { rowCount } = await this.pg.query(
      `SELECT 1 FROM apps WHERE id = $1 AND tenant_id = $2`,
      [appId, req.member.tenantId],
    );
    if (!rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");
  }

  private assertKeyAdmin(req: SessionRequest) {
    if (!KEY_ADMIN_ROLES.includes(req.member.role)) {
      throw new ForbiddenException("API 키는 Owner/Admin만 관리할 수 있습니다");
    }
  }
}
