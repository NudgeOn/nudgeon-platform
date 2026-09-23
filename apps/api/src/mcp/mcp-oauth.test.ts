import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { McpOAuth } from "./mcp-oauth.service";
import { redirectAllowed, scopesFor } from "./mcp-policy";
import type { AppConfig } from "../config";
import type { SessionMember } from "../auth/session.service";

describe("MCP grant policy", () => {
  it("never expands the current console role and requires profile approval", () => {
    expect(
      scopesFor(
        { role: "viewer" },
        ["mcp:read", "mcp:drafts:write", "mcp:customers:read"],
        false,
      ),
    ).toEqual(["mcp:read"]);
    expect(
      scopesFor(
        { role: "editor" },
        ["mcp:read", "mcp:drafts:write", "mcp:customers:read"],
        true,
      ),
    ).toHaveLength(3);
    expect(scopesFor({ role: "unknown" }, ["mcp:read"], true)).toEqual([]);
  });
  it("rejects callback credentials/fragments and non-loopback HTTP", () => {
    for (const value of [
      "javascript:alert(1)",
      "http://example.com/callback",
      "https://user:pass@example.com/callback",
      "https://example.com/#fragment",
    ])
      expect(redirectAllowed(value)).toBe(false);
    expect(redirectAllowed("https://example.com/callback")).toBe(true);
    expect(redirectAllowed("http://127.0.0.1:54321/callback")).toBe(true);
  });
});

const connectionString = process.env.NUDGEON_MCP_TEST_DATABASE_URL;
if (
  connectionString &&
  !["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(connectionString).hostname,
  )
)
  throw new Error(
    "MCP integration tests require an isolated loopback database",
  );
describe.skipIf(!connectionString)("OAuth grants on PostgreSQL", () => {
  const schema = `mcp_oauth_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const pg = new Pool({
    connectionString,
    options: `-c search_path=${schema}`,
  });
  const tenantId = randomUUID(),
    appId = randomUUID(),
    memberId = randomUUID();
  const config = {
    mcpEnabled: true,
    mcpPublicUrl: "http://127.0.0.1:18080",
    mcpConsoleUrl: "http://127.0.0.1:13100",
    corsOrigin: "http://127.0.0.1:13100",
  } as AppConfig;
  const oauth = new McpOAuth(pg, config);
  const member: SessionMember = {
    tenantId,
    memberId,
    email: `${memberId}@test.invalid`,
    name: "MCP test",
    role: "editor",
    totpEnabled: false,
    requires2fa: false,
  };
  const clientIds: string[] = [];
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pg.query(
      readFileSync(
        resolve(__dirname, "../../../../db/postgres/schema.sql"),
        "utf8",
      ),
    );
    await pg.query(
      readFileSync(
        resolve(
          __dirname,
          "../../../../db/postgres/upgrades/0013_mcp_oauth.sql",
        ),
        "utf8",
      ),
    );
    await pg.query(
      "INSERT INTO tenants(id,name) VALUES($1,'MCP integration')",
      [tenantId],
    );
    await pg.query(
      "INSERT INTO members(id,tenant_id,email,name,role,status) VALUES($1,$2,$3,'MCP test','editor','active')",
      [memberId, tenantId, member.email],
    );
    await pg.query(
      "INSERT INTO apps(id,tenant_id,name) VALUES($1,$2,'MCP test')",
      [appId, tenantId],
    );
  });
  afterAll(async () => {
    await pg.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  async function begin(scopes = ["mcp:read", "mcp:drafts:write"]) {
    const client = await oauth.register({
      client_name: "Integration client",
      redirect_uris: ["http://127.0.0.1:19090/callback"],
    });
    clientIds.push(client.client_id);
    const verifier = randomBytes(32).toString("base64url");
    const url = await oauth.authorize({
      client_id: client.client_id,
      response_type: "code",
      redirect_uri: client.redirect_uris[0],
      state: "original-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: oauth.resource,
      scope: scopes.join(" "),
    });
    return {
      client,
      verifier,
      id: new URL(url).searchParams.get("request_id")!,
      scopes,
    };
  }
  async function grant() {
    const ctx = await begin();
    const approved = await oauth.consent(member, ctx.id, {
      app_id: appId,
      scopes: ctx.scopes,
      approve: true,
    });
    const result = new URL(approved.redirect_uri);
    expect(result.searchParams.get("state")).toBe("original-state");
    const request = {
      grant_type: "authorization_code",
      client_id: ctx.client.client_id,
      redirect_uri: ctx.client.redirect_uris[0],
      code: result.searchParams.get("code"),
      code_verifier: ctx.verifier,
      resource: oauth.resource,
    };
    return { ctx, request, tokens: await oauth.token(request) };
  }
  it("allows denial without selecting an app and consumes the pending request", async () => {
    const ctx = await begin();
    const denied = new URL(
      (await oauth.consent(member, ctx.id, { approve: false })).redirect_uri,
    );
    expect(denied.origin).toBe("http://127.0.0.1:19090");
    expect(denied.searchParams.get("state")).toBe("original-state");
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.has("code")).toBe(false);
    await expect(
      oauth.consent(member, ctx.id, {
        app_id: appId,
        scopes: ctx.scopes,
        approve: true,
      }),
    ).rejects.toThrow();
  });
  it("binds PKCE, redirect URI and resource; a code can be redeemed once", async () => {
    const ctx = await begin();
    const approved = await oauth.consent(member, ctx.id, {
      app_id: appId,
      scopes: ctx.scopes,
      approve: true,
    });
    const input = {
      grant_type: "authorization_code",
      client_id: ctx.client.client_id,
      redirect_uri: ctx.client.redirect_uris[0],
      code: new URL(approved.redirect_uri).searchParams.get("code"),
      code_verifier: ctx.verifier,
      resource: oauth.resource,
    };
    await expect(
      oauth.token({
        ...input,
        code_verifier: randomBytes(32).toString("base64url"),
      }),
    ).rejects.toThrow();
    await expect(
      oauth.token({ ...input, resource: "https://wrong.invalid/mcp" }),
    ).rejects.toThrow();
    const tokens = await oauth.token(input);
    expect((await oauth.resolve(tokens.access_token)).appId).toBe(appId);
    await expect(oauth.token(input)).rejects.toThrow();
    const stored = await pg.query(
      "SELECT token_hash FROM mcp_oauth_tokens WHERE tenant_id=$1",
      [tenantId],
    );
    expect(
      stored.rows.every((row) => row.token_hash !== tokens.access_token),
    ).toBe(true);
  });
  it("immediately applies role demotion, disable and revocation", async () => {
    const { tokens } = await grant();
    await pg.query(
      "UPDATE members SET role='viewer' WHERE id=$1 AND tenant_id=$2",
      [memberId, tenantId],
    );
    expect((await oauth.resolve(tokens.access_token)).scopes).toEqual([
      "mcp:read",
    ]);
    await pg.query(
      "UPDATE members SET status='disabled' WHERE id=$1 AND tenant_id=$2",
      [memberId, tenantId],
    );
    await expect(oauth.resolve(tokens.access_token)).rejects.toThrow();
    await pg.query(
      "UPDATE members SET status='active',role='editor' WHERE id=$1 AND tenant_id=$2",
      [memberId, tenantId],
    );
    const actor = await oauth.resolve(tokens.access_token);
    await oauth.changeConnection(member, actor.connectionId);
    await expect(oauth.resolve(tokens.access_token)).rejects.toThrow();
  });
  it("rejects other-app consent and unapproved profile scopes", async () => {
    const ctx = await begin(["mcp:read", "mcp:customers:read"]);
    await expect(
      oauth.consent(member, ctx.id, {
        app_id: randomUUID(),
        scopes: ["mcp:read"],
        approve: true,
      }),
    ).rejects.toThrow();
    await expect(
      oauth.consent(member, ctx.id, {
        app_id: appId,
        scopes: ctx.scopes,
        approve: true,
      }),
    ).rejects.toThrow();
  });
  it("revokes only the token's client grant and audits once without storing the token", async () => {
    const { ctx, tokens } = await grant();
    const actor = await oauth.resolve(tokens.access_token);
    await oauth.revokeToken({
      client_id: randomUUID(),
      token: tokens.access_token,
    });
    expect((await oauth.resolve(tokens.access_token)).connectionId).toBe(
      actor.connectionId,
    );
    await oauth.revokeToken({
      client_id: ctx.client.client_id,
      token: tokens.access_token,
    });
    await oauth.revokeToken({
      client_id: ctx.client.client_id,
      token: tokens.access_token,
    });
    await expect(oauth.resolve(tokens.access_token)).rejects.toThrow();
    const audit = await pg.query(
      "SELECT detail FROM audit_logs WHERE tenant_id=$1 AND target_id=$2 AND action='mcp.connection.token_revoke'",
      [tenantId, actor.connectionId],
    );
    expect(audit.rows).toEqual([{ detail: {} }]);
  });
  it("rotates refresh tokens and revokes the connection on reuse", async () => {
    const { ctx, tokens } = await grant();
    const request = {
      grant_type: "refresh_token",
      client_id: ctx.client.client_id,
      refresh_token: tokens.refresh_token,
      resource: oauth.resource,
    };
    const rotated = await oauth.token(request);
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    await expect(oauth.token(request)).rejects.toThrow();
    await expect(oauth.resolve(rotated.access_token)).rejects.toThrow();
    const audit = await pg.query(
      "SELECT detail FROM audit_logs WHERE tenant_id=$1 AND action='mcp.connection.refresh_reuse'",
      [tenantId],
    );
    expect(audit.rows).toEqual([{ detail: {} }]);
  });
});
