import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Pool } from "pg";
import { z } from "zod";
import { PG } from "../infra/infra.module";
import { SessionGuard, type SessionRequest } from "../auth/session.guard";
import { PermissionGuard } from "../authz/permission.guard";
import { RequirePermission } from "../authz/require-permission.decorator";
import { AuditService } from "../audit/audit.service";
import { renderTemplate } from "../util/template";

const upsertSchema = z.object({
  name: z.string().trim().min(1).max(200),
  subject: z.string().min(1).max(998),
  html: z.string().min(1).max(1_000_000),
});
const previewSchema = z.object({
  subject: z.string().max(998).optional(),
  html: z.string().max(1_000_000),
  variables: z.record(z.unknown()).default({}),
});

/** 이메일 HTML 템플릿 CRUD + 미리보기. journeys:read 조회 / journeys:write 편집. */
@Controller("v1/apps/:appId/email-templates")
@UseGuards(SessionGuard, PermissionGuard)
export class EmailTemplatesController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly audit: AuditService,
  ) {}

  private async assertApp(appId: string, req: SessionRequest) {
    const { rowCount } = await this.pg.query(
      `SELECT 1 FROM apps WHERE id = $1 AND tenant_id = $2`,
      [appId, req.member.tenantId],
    );
    if (!rowCount) throw new NotFoundException("앱을 찾을 수 없습니다");
  }

  @Get()
  @RequirePermission("journeys:read")
  async list(@Param("appId", ParseUUIDPipe) appId: string, @Req() req: SessionRequest) {
    await this.assertApp(appId, req);
    const { rows } = await this.pg.query(
      `SELECT id, name, subject, updated_at FROM email_templates
        WHERE tenant_id = $1 AND app_id = $2 ORDER BY updated_at DESC`,
      [req.member.tenantId, appId],
    );
    return { templates: rows };
  }

  @Get(":id")
  @RequirePermission("journeys:read")
  async get(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const { rows } = await this.pg.query(
      `SELECT id, name, subject, html, created_at, updated_at FROM email_templates
        WHERE tenant_id = $1 AND app_id = $2 AND id = $3`,
      [req.member.tenantId, appId, id],
    );
    if (!rows[0]) throw new NotFoundException("템플릿을 찾을 수 없습니다");
    return rows[0];
  }

  @Post()
  @RequirePermission("journeys:write")
  async create(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const data = parse(upsertSchema, body);
    const { rows } = await this.pg
      .query(
        `INSERT INTO email_templates (tenant_id, app_id, name, subject, html, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.member.tenantId, appId, data.name, data.subject, data.html, req.member.memberId],
      )
      .catch(mapUnique);
    await this.audit.recordAs(req.member, req.ip, "email_template.create", {
      targetType: "email_template",
      targetId: rows[0].id,
      detail: { name: data.name },
    });
    return { id: rows[0].id };
  }

  @Patch(":id")
  @RequirePermission("journeys:write")
  async update(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const data = parse(upsertSchema, body);
    const { rowCount } = await this.pg
      .query(
        `UPDATE email_templates SET name = $4, subject = $5, html = $6, updated_at = now()
          WHERE tenant_id = $1 AND app_id = $2 AND id = $3`,
        [req.member.tenantId, appId, id, data.name, data.subject, data.html],
      )
      .catch(mapUnique);
    if (!rowCount) throw new NotFoundException("템플릿을 찾을 수 없습니다");
    await this.audit.recordAs(req.member, req.ip, "email_template.update", {
      targetType: "email_template",
      targetId: id,
    });
    return { ok: true as const };
  }

  @Delete(":id")
  @RequirePermission("journeys:write")
  async remove(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const { rowCount } = await this.pg.query(
      `DELETE FROM email_templates WHERE tenant_id = $1 AND app_id = $2 AND id = $3`,
      [req.member.tenantId, appId, id],
    );
    if (!rowCount) throw new NotFoundException("템플릿을 찾을 수 없습니다");
    await this.audit.recordAs(req.member, req.ip, "email_template.delete", {
      targetType: "email_template",
      targetId: id,
    });
    return { ok: true as const };
  }

  /** 서버측 미리보기 렌더 — 발송과 동일 {{ }} 치환 결과를 반환(콘솔은 iframe으로 표시). */
  @Post("preview")
  @RequirePermission("journeys:read")
  async preview(
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body() body: unknown,
    @Req() req: SessionRequest,
  ) {
    await this.assertApp(appId, req);
    const data = parse(previewSchema, body);
    const vars = data.variables as Record<string, unknown>;
    return {
      subject: data.subject ? renderTemplate(data.subject, vars) : undefined,
      html: renderTemplate(data.html, vars),
    };
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.flatten());
  return r.data;
}

function mapUnique(e: unknown): never {
  if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "23505") {
    throw new BadRequestException("이미 같은 이름의 템플릿이 있습니다");
  }
  throw e;
}
