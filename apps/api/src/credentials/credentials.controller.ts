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
import { AuditService } from "../audit/audit.service";

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

/** SMTP: 이메일 발송 릴레이 (자체호스팅 우선). security: starttls(587)|tls(465)|none(dev). */
const emailSmtpPayloadSchema = z.object({
  kind: z.literal("email_smtp"),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(320).default(""),
  password: z.string().max(1024).default(""),
  from_email: z.string().email(),
  from_name: z.string().max(128).default(""),
  security: z.enum(["starttls", "tls", "none"]).default("starttls"),
});

/** NHN Cloud(TOAST) Email API: appKey + secretKey + 발신자. */
const emailNhnPayloadSchema = z.object({
  kind: z.literal("email_nhn"),
  app_key: z.string().min(1).max(128),
  secret_key: z.string().min(1).max(256),
  from_email: z.string().email(),
  from_name: z.string().max(128).default(""),
});

/**
 * Resend Email API: API 키 + 발신자. webhook_secret = Resend(Svix) 서명 비밀(whsec_…) —
 * POST /v1/webhooks/resend/:appId 서명 검증에 사용. base_url은 테스트용 엔드포인트 오버라이드.
 */
const emailResendPayloadSchema = z.object({
  kind: z.literal("email_resend"),
  api_key: z.string().min(1).max(256),
  from_email: z.string().email(),
  from_name: z.string().max(128).default(""),
  webhook_secret: z.string().max(256).optional(),
  base_url: z.string().url().optional(),
});

const credentialSchema = z.discriminatedUnion("kind", [
  fcmPayloadSchema,
  apnsPayloadSchema,
  emailSmtpPayloadSchema,
  emailNhnPayloadSchema,
  emailResendPayloadSchema,
]);

/** 크리덴셜 관리 (세션 인증 — 콘솔 온보딩 위저드의 백엔드) */
@Controller("v1/apps/:appId/credentials")
@UseGuards(SessionGuard)
export class CredentialsController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly audit: AuditService,
  ) {}

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
    await this.audit.recordAs(req.member, req.ip, "credential.upsert", {
      targetType: "credential",
      targetId: `${appId}:${kind}`,
      detail: { app_id: appId, kind },
    });
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
    await this.audit.recordAs(req.member, req.ip, "credential.delete", {
      targetType: "credential",
      targetId: `${appId}:${kind}`,
      detail: { app_id: appId, kind },
    });
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
