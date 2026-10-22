import { Controller, Get, Header, Inject, NotFoundException, Req, UseGuards } from "@nestjs/common";
import type { Pool } from "pg";
import { PG } from "../infra/infra.module";
import { ApiKeyGuard, RequireApiKey, type AuthedRequest } from "../auth/api-key.guard";
import { RateLimitGuard } from "../rate-limit/rate-limit.guard";

/** Read-only integration handshake. Never creates users, events, devices or messages. */
@Controller("v1/integrations")
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class ConnectionController {
  constructor(@Inject(PG) private readonly pg: Pool) {}

  @Get("connection")
  @RequireApiKey("server")
  @Header("Cache-Control", "no-store")
  async connection(@Req() req: AuthedRequest) {
    const { tenantId, appId } = req.apiKey;
    const { rows } = await this.pg.query(
      `SELECT a.id, a.name,
         EXISTS (SELECT 1 FROM credentials c WHERE c.tenant_id=a.tenant_id AND c.app_id=a.id
           AND c.kind='push_fcm' AND c.status='verified') AS fcm,
         EXISTS (SELECT 1 FROM credentials c WHERE c.tenant_id=a.tenant_id AND c.app_id=a.id
           AND c.kind='push_apns' AND c.status='verified') AS apns
       FROM apps a WHERE a.id=$1 AND a.tenant_id=$2`, [appId, tenantId]);
    if (!rows[0]) throw new NotFoundException("App not found");
    return { service: "nudgeon", contract_version: 1, tenant_id: tenantId,
      app: { id: rows[0].id, name: rows[0].name },
      capabilities: { track: true }, push: { fcm: rows[0].fcm, apns: rows[0].apns } };
  }
}
