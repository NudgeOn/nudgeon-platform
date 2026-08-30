import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Pool } from "pg";
import { z } from "zod";
import { PG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { encryptEnvelope, loadMasterKey } from "../crypto/envelope";

/** FCM: 서비스 계정 JSON (HTTP v1 API — PRD-04 3장) */
const fcmPayloadSchema = z.object({
  kind: z.literal("push_fcm"),
  service_account: z
    .object({
      type: z.literal("service_account"),
      project_id: z.string().min(1),
      private_key: z.string().includes("PRIVATE KEY"),
      client_email: z.string().email(),
    })
    .passthrough(),
});

/** APNs: p8 키 + Key ID + Team ID + Bundle ID */
const apnsPayloadSchema = z.object({
  kind: z.literal("push_apns"),
  p8: z.string().includes("PRIVATE KEY"),
  key_id: z.string().min(1).max(32),
  team_id: z.string().min(1).max(32),
  bundle_id: z.string().min(1).max(256),
  environment: z.enum(["production", "sandbox"]).default("production"),
});

const credentialSchema = z.discriminatedUnion("kind", [fcmPayloadSchema, apnsPayloadSchema]);

/** 크리덴셜 관리 (세션 인증 — 콘솔 온보딩 위저드의 백엔드) */
@Controller("v1/apps/:appId/credentials")
@UseGuards(SessionGuard)
export class CredentialsController {
  constructor(@Inject(PG) private readonly pg: Pool) {}

  /** 등록/교체 — 저장은 unverified, 검증은 channel 워커가 비동기 수행 (C-1) */
  @Put()
  async upsert(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    await this.assertAppOwnership(appId, req.member.tenantId);
    const parsed = credentialSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    if (!["owner", "admin"].includes(req.member.role)) {
      throw new ForbiddenException("크리덴셜은 Owner/Admin만 등록할 수 있습니다");
    }

    const { kind, ...payload } = parsed.data;
    const env = encryptEnvelope(loadMasterKey(), JSON.stringify(payload));
    const { rows } = await this.pg.query(
      `INSERT INTO credentials (tenant_id, app_id, kind, ciphertext, dek_wrapped, status, status_detail)
       VALUES ($1, $2, $3, $4, $5, 'unverified', NULL)
       ON CONFLICT (app_id, kind) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext, dek_wrapped = EXCLUDED.dek_wrapped,
         status = 'unverified', status_detail = NULL, updated_at = now()
       RETURNING id, status`,
      [req.member.tenantId, appId, kind, env.ciphertext, env.dekWrapped],
    );
    return { id: rows[0].id, kind, status: rows[0].status };
  }

  /** 목록 — 원문은 절대 반환하지 않는다 (마스킹 원칙, PRD-04 3장) */
  @Get()
  async list(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    await this.assertAppOwnership(appId, req.member.tenantId);
    const { rows } = await this.pg.query(
      `SELECT id, kind, status, status_detail, last_verified_at, created_at, updated_at
         FROM credentials WHERE tenant_id = $1 AND app_id = $2 ORDER BY kind`,
      [req.member.tenantId, appId],
    );
    return { credentials: rows };
  }

  @Delete(":kind")
  async remove(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("kind") kind: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertAppOwnership(appId, req.member.tenantId);
    if (!["owner", "admin"].includes(req.member.role)) {
      throw new ForbiddenException("크리덴셜은 Owner/Admin만 삭제할 수 있습니다");
    }
    const { rowCount } = await this.pg.query(
      `DELETE FROM credentials WHERE tenant_id = $1 AND app_id = $2 AND kind = $3`,
      [req.member.tenantId, appId, kind],
    );
    if (!rowCount) throw new NotFoundException();
    return { ok: true };
  }

  /** 테넌트 격리 — 타 테넌트 앱 접근은 404 (존재 여부 비노출, PRD-06 8장) */
  private async assertAppOwnership(appId: string, tenantId: string) {
    const { rowCount } = await this.pg.query(
      `SELECT 1 FROM apps WHERE id = $1 AND tenant_id = $2`,
      [appId, tenantId],
    );
    if (!rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");
  }
}
