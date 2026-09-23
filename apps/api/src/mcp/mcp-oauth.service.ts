import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CONFIG, PG } from "../infra/infra.module";
import type { AppConfig } from "../config";
import type { SessionMember } from "../auth/session.service";
import {
  MCP_SCOPES,
  assertEnabled,
  authorizeSchema,
  authorizeUrl,
  digest,
  isAdmin,
  parse,
  parseScopes,
  redirectAllowed,
  scopesFor,
  uuid,
  type McpActor,
} from "./mcp-policy";

const secret = () => randomBytes(32).toString("base64url");
const invalidGrant = () =>
  new BadRequestException({
    error: "invalid_grant",
    error_description: "Invalid, expired or consumed authorization",
  });
const consentSchema = z.discriminatedUnion("approve", [
  z.object({
    app_id: uuid,
    scopes: z.array(z.enum(MCP_SCOPES)).min(1).max(3),
    approve: z.literal(true),
  }),
  z.object({ approve: z.literal(false) }),
]);
const clientSchema = z.object({
  client_name: z.string().min(1).max(120).default("MCP client"),
  redirect_uris: z
    .array(z.string().max(2048).refine(redirectAllowed))
    .min(1)
    .max(5),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .optional(),
  response_types: z.array(z.literal("code")).optional(),
});

@Injectable()
export class McpOAuth {
  readonly issuer: string;
  readonly resource: string;
  readonly consoleUrl: string;
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {
    this.issuer = cfg.mcpPublicUrl ?? "http://localhost:8080";
    this.resource = `${this.issuer}/mcp`;
    this.consoleUrl = cfg.mcpConsoleUrl ?? cfg.corsOrigin;
    const validOrigin = (value: string) =>
      redirectAllowed(value) && new URL(value).origin === value;
    if (
      cfg.mcpEnabled &&
      (!cfg.mcpPublicUrl ||
        !cfg.mcpConsoleUrl ||
        !validOrigin(this.issuer) ||
        !validOrigin(this.consoleUrl))
    )
      throw new Error(
        "MCP requires explicit MCP_PUBLIC_URL and MCP_CONSOLE_URL origins (HTTPS or loopback, without a path/query)",
      );
  }
  enabled() {
    assertEnabled(this.cfg.mcpEnabled);
  }
  status() {
    return { enabled: this.cfg.mcpEnabled === true, endpoint: this.resource };
  }
  metadata() {
    this.enabled();
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      scopes_supported: MCP_SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    };
  }
  protectedMetadata() {
    this.enabled();
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: MCP_SCOPES,
      bearer_methods_supported: ["header"],
    };
  }
  async register(body: unknown) {
    this.enabled();
    const input = parse(clientSchema, body);
    const { rows } = await this.pg.query(
      `INSERT INTO mcp_oauth_clients(name,redirect_uris) VALUES($1,$2) RETURNING id,created_at`,
      [input.client_name, input.redirect_uris],
    );
    return {
      ...input,
      client_id: rows[0].id,
      client_id_issued_at: Math.floor(
        new Date(rows[0].created_at).getTime() / 1000,
      ),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }
  async authorize(query: unknown) {
    this.enabled();
    const input = parse(authorizeSchema, query);
    const scopes = parseScopes(input.scope);
    if (input.resource !== this.resource)
      throw new BadRequestException({ error: "invalid_target" });
    const { rows: clients } = await this.pg.query(
      `SELECT id FROM mcp_oauth_clients WHERE id=$1 AND $2=ANY(redirect_uris)`,
      [input.client_id, input.redirect_uri],
    );
    if (!clients[0]) throw new BadRequestException({ error: "invalid_client" });
    const { rows } = await this.pg.query(
      `INSERT INTO mcp_oauth_requests(client_id,redirect_uri,state,challenge,scopes,resource) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        input.client_id,
        input.redirect_uri,
        input.state,
        input.code_challenge,
        scopes,
        this.resource,
      ],
    );
    return `${this.consoleUrl}/mcp/authorize?request_id=${rows[0].id}`;
  }
  async authorization(member: SessionMember, id: string) {
    this.enabled();
    parse(uuid, id);
    const { rows } = await this.pg.query(
      `SELECT r.client_id,r.redirect_uri,r.scopes,r.expires_at,c.name AS client_name FROM mcp_oauth_requests r
      JOIN mcp_oauth_clients c ON c.id=r.client_id WHERE r.id=$1 AND r.decided_at IS NULL AND r.expires_at>now()`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException("Authorization expired");
    const apps = await this.pg.query(
      `SELECT id,name FROM apps WHERE tenant_id=$1 ORDER BY name`,
      [member.tenantId],
    );
    return {
      client_id: rows[0].client_id,
      client_name: rows[0].client_name,
      client_verified: false as const,
      redirect_uri: rows[0].redirect_uri,
      requested_scopes: rows[0].scopes,
      expires_at: rows[0].expires_at,
      apps: apps.rows,
    };
  }
  async consent(member: SessionMember, id: string, body: unknown) {
    this.enabled();
    parse(uuid, id);
    const input = parse(consentSchema, body);
    const db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      const { rows } = await db.query(
        `SELECT * FROM mcp_oauth_requests WHERE id=$1 AND decided_at IS NULL AND expires_at>now() FOR UPDATE`,
        [id],
      );
      const request = rows[0];
      if (!request) throw invalidGrant();
      if (!input.approve) {
        await db.query(
          `UPDATE mcp_oauth_requests SET decided_at=now(),tenant_id=$2 WHERE id=$1`,
          [id, member.tenantId],
        );
        await db.query("COMMIT");
        return {
          redirect_uri: authorizeUrl(request.redirect_uri, request.state, {
            error: "access_denied",
            iss: this.issuer,
          }),
        };
      }
      const app = await db.query(
        `SELECT id FROM apps WHERE id=$1 AND tenant_id=$2`,
        [input.app_id, member.tenantId],
      );
      if (!app.rows[0]) throw new NotFoundException("App not found");
      // Approval is bound to the same member/client/app; granting scope always requires fresh consent.
      const previous = await db.query(
        `SELECT id,customer_access_approved FROM mcp_connections
        WHERE tenant_id=$1 AND app_id=$2 AND member_id=$3 AND client_id=$4 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [member.tenantId, input.app_id, member.memberId, request.client_id],
      );
      const approved =
        previous.rows[0]?.customer_access_approved === true ||
        (isAdmin(member.role) && input.scopes.includes("mcp:customers:read"));
      const scopes = [...new Set(input.scopes)];
      if (
        !scopes.includes("mcp:read") ||
        scopes.some((s) => !request.scopes.includes(s)) ||
        scopesFor(member, scopes, approved).length !== scopes.length
      )
        throw new ForbiddenException({
          code: "SCOPE_NOT_ALLOWED",
          message:
            "Customer access requires administrator approval; draft editing requires Editor.",
        });
      let connectionId = previous.rows[0]?.id as string | undefined;
      if (connectionId)
        await db.query(
          `UPDATE mcp_connections SET scopes=$3,customer_access_approved=$4 WHERE id=$1 AND tenant_id=$2`,
          [connectionId, member.tenantId, scopes, approved],
        );
      else {
        const connection = await db.query(
          `INSERT INTO mcp_connections(tenant_id,app_id,member_id,client_id,scopes,customer_access_approved)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            member.tenantId,
            input.app_id,
            member.memberId,
            request.client_id,
            scopes,
            approved && scopes.includes("mcp:customers:read"),
          ],
        );
        connectionId = connection.rows[0].id;
      }
      const code = secret();
      await db.query(
        `UPDATE mcp_oauth_requests SET tenant_id=$2,connection_id=$3,scopes=$4,code_hash=$5,
        code_expires_at=now()+interval '60 seconds',decided_at=now() WHERE id=$1`,
        [id, member.tenantId, connectionId, scopes, digest(code)],
      );
      await this.audit(
        db,
        member.tenantId,
        member.memberId,
        "mcp.connection.authorize",
        connectionId!,
        { scopes },
      );
      await db.query("COMMIT");
      return {
        redirect_uri: authorizeUrl(request.redirect_uri, request.state, {
          code,
          iss: this.issuer,
        }),
      };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  async token(body: unknown) {
    this.enabled();
    const input = parse(
      z.object({
        grant_type: z.enum(["authorization_code", "refresh_token"]),
        client_id: uuid,
        resource: z.string().url(),
        code: z.string().max(256).optional(),
        redirect_uri: z.string().max(2048).optional(),
        code_verifier: z
          .string()
          .regex(/^[A-Za-z0-9._~-]{43,128}$/)
          .optional(),
        refresh_token: z.string().max(256).optional(),
      }),
      body,
    );
    if (input.resource !== this.resource)
      throw new BadRequestException({ error: "invalid_target" });
    const db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      let tenantId: string;
      let connectionId: string;
      let scopes: string[];
      if (input.grant_type === "authorization_code") {
        const { rows } = await db.query(
          `SELECT * FROM mcp_oauth_requests WHERE code_hash=$1 AND client_id=$2 AND consumed_at IS NULL
          AND code_expires_at>now() AND resource=$3 FOR UPDATE`,
          [digest(input.code ?? ""), input.client_id, this.resource],
        );
        const row = rows[0];
        if (
          !row ||
          !input.code_verifier ||
          row.redirect_uri !== input.redirect_uri
        )
          throw invalidGrant();
        const challenge = createHash("sha256")
          .update(input.code_verifier)
          .digest("base64url");
        if (
          challenge.length !== row.challenge.length ||
          !timingSafeEqual(Buffer.from(challenge), Buffer.from(row.challenge))
        )
          throw invalidGrant();
        tenantId = row.tenant_id;
        connectionId = row.connection_id;
        scopes = row.scopes;
        await db.query(
          `UPDATE mcp_oauth_requests SET consumed_at=now() WHERE id=$1 AND tenant_id=$2`,
          [row.id, tenantId],
        );
      } else {
        const { rows } = await db.query(
          `SELECT t.*,c.client_id FROM mcp_oauth_tokens t JOIN mcp_connections c
          ON c.id=t.connection_id AND c.tenant_id=t.tenant_id WHERE t.token_hash=$1 AND t.kind='refresh' AND c.client_id=$2 FOR UPDATE OF t`,
          [digest(input.refresh_token ?? ""), input.client_id],
        );
        const row = rows[0];
        if (!row) throw invalidGrant();
        if (row.consumed_at) {
          await db.query(
            `UPDATE mcp_connections SET revoked_at=now() WHERE id=$1 AND tenant_id=$2`,
            [row.connection_id, row.tenant_id],
          );
          await this.audit(
            db,
            row.tenant_id,
            null,
            "mcp.connection.refresh_reuse",
            row.connection_id,
            {},
          );
          await db.query("COMMIT");
          throw invalidGrant();
        }
        if (new Date(row.expires_at).getTime() <= Date.now())
          throw invalidGrant();
        tenantId = row.tenant_id;
        connectionId = row.connection_id;
        scopes = row.scopes;
        await db.query(
          `UPDATE mcp_oauth_tokens SET consumed_at=now() WHERE token_hash=$1 AND tenant_id=$2`,
          [row.token_hash, tenantId],
        );
      }
      const actor = await this.resolveConnection(
        db,
        tenantId,
        connectionId,
        scopes,
      );
      if (!actor) throw invalidGrant();
      const access = secret(),
        refresh = secret();
      await db.query(
        `INSERT INTO mcp_oauth_tokens(token_hash,tenant_id,connection_id,kind,scopes,expires_at) VALUES
        ($1,$3,$4,'access',$5,now()+interval '15 minutes'),($2,$3,$4,'refresh',$5,now()+interval '30 days')`,
        [digest(access), digest(refresh), tenantId, connectionId, actor.scopes],
      );
      await db.query("COMMIT");
      return {
        access_token: access,
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: refresh,
        scope: actor.scopes.join(" "),
      };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  async resolve(token: string): Promise<McpActor> {
    this.enabled();
    const { rows } = await this.pg.query(
      `SELECT tenant_id,connection_id,scopes FROM mcp_oauth_tokens
      WHERE token_hash=$1 AND kind='access' AND expires_at>now() AND consumed_at IS NULL`,
      [digest(token)],
    );
    const row = rows[0];
    const actor = row
      ? await this.resolveConnection(
          this.pg,
          row.tenant_id,
          row.connection_id,
          row.scopes,
        )
      : null;
    if (!actor) throw new UnauthorizedException({ error: "invalid_token" });
    await this.pg.query(
      `UPDATE mcp_connections SET last_used_at=now() WHERE id=$1 AND tenant_id=$2`,
      [actor.connectionId, actor.tenantId],
    );
    return actor;
  }
  private async resolveConnection(
    db: Pick<Pool, "query"> | PoolClient,
    tenantId: string,
    id: string,
    issuedScopes: string[],
  ): Promise<McpActor | null> {
    const { rows } = await db.query(
      `SELECT c.*,m.email,m.name,m.role,(m.totp_enabled_at IS NOT NULL) AS totp_enabled,
      COALESCE(t.require_2fa,false) AS requires_2fa FROM mcp_connections c
      JOIN members m ON m.id=c.member_id AND m.tenant_id=c.tenant_id AND m.status='active'
      JOIN tenants t ON t.id=c.tenant_id JOIN apps a ON a.id=c.app_id AND a.tenant_id=c.tenant_id
      WHERE c.id=$1 AND c.tenant_id=$2 AND c.revoked_at IS NULL`,
      [id, tenantId],
    );
    const row = rows[0];
    if (!row || (row.requires_2fa && !row.totp_enabled)) return null;
    const scopes = scopesFor(
      row,
      issuedScopes.filter((s) => row.scopes.includes(s)),
      row.customer_access_approved,
    );
    if (!scopes.includes("mcp:read")) return null;
    return {
      tenantId,
      memberId: row.member_id,
      appId: row.app_id,
      connectionId: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      totpEnabled: row.totp_enabled,
      requires2fa: row.requires_2fa,
      scopes,
      customerAccessApproved: row.customer_access_approved,
    };
  }
  async revokeToken(body: unknown) {
    this.enabled();
    const input = parse(
      z.object({ token: z.string().max(256), client_id: uuid }),
      body,
    );
    const db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      const { rows } = await db.query(
        `UPDATE mcp_connections c SET revoked_at=now() FROM mcp_oauth_tokens t
        WHERE t.connection_id=c.id AND t.tenant_id=c.tenant_id AND t.token_hash=$1 AND c.client_id=$2
          AND c.revoked_at IS NULL RETURNING c.id,c.tenant_id`,
        [digest(input.token), input.client_id],
      );
      for (const row of rows)
        await this.audit(
          db,
          row.tenant_id,
          null,
          "mcp.connection.token_revoke",
          row.id,
          {},
        );
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  async connections(member: SessionMember) {
    this.enabled();
    const { rows } = await this.pg.query(
      `SELECT c.id,c.client_id,c.app_id,a.name AS app_name,c.member_id,m.email AS member_email,
      cl.name AS client_name,c.scopes,c.customer_access_approved,c.last_used_at,c.created_at,c.revoked_at
      FROM mcp_connections c JOIN apps a ON a.id=c.app_id AND a.tenant_id=c.tenant_id
      JOIN members m ON m.id=c.member_id AND m.tenant_id=c.tenant_id JOIN mcp_oauth_clients cl ON cl.id=c.client_id
      WHERE c.tenant_id=$1 AND ($2::boolean OR c.member_id=$3) ORDER BY c.created_at DESC LIMIT 100`,
      [member.tenantId, isAdmin(member.role), member.memberId],
    );
    return { connections: rows };
  }
  async changeConnection(
    member: SessionMember,
    id: string,
    approved?: boolean,
  ) {
    this.enabled();
    parse(uuid, id);
    if (approved !== undefined && !isAdmin(member.role))
      throw new ForbiddenException();
    const db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      const result =
        approved === undefined
          ? await db.query(
              `UPDATE mcp_connections SET revoked_at=now()
        WHERE id=$1 AND tenant_id=$2 AND ($3::boolean OR member_id=$4) RETURNING id`,
              [id, member.tenantId, isAdmin(member.role), member.memberId],
            )
          : await db.query(
              `UPDATE mcp_connections SET customer_access_approved=$3,
          scopes=CASE WHEN $3 THEN scopes ELSE array_remove(scopes,'mcp:customers:read') END
          WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL RETURNING id`,
              [id, member.tenantId, approved],
            );
      if (!result.rows[0]) throw new NotFoundException();
      await this.audit(
        db,
        member.tenantId,
        member.memberId,
        approved === undefined
          ? "mcp.connection.revoke"
          : "mcp.connection.customer_access",
        id,
        { approved },
      );
      await db.query("COMMIT");
      return { ok: true };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  private async audit(
    db: PoolClient,
    tenantId: string,
    memberId: string | null,
    action: string,
    id: string,
    detail: unknown,
  ) {
    await db.query(
      `INSERT INTO audit_logs(tenant_id,actor_member_id,action,target_type,target_id,detail)
      VALUES($1,$2,$3,'mcp_connection',$4,$5)`,
      [tenantId, memberId, action, id, JSON.stringify(detail)],
    );
  }
}
