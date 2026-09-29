import "reflect-metadata";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../config";
import type { SessionMember } from "../auth/session.service";
import { McpOAuth } from "./mcp-oauth.service";
import { McpRead } from "./mcp-read.service";
import type { McpActor, McpScope } from "./mcp-policy";

const databaseUrl = process.env.NUDGEON_MCP_TEST_DATABASE_URL;
const clickhouseUrl = process.env.NUDGEON_MCP_TEST_CLICKHOUSE_URL;
for (const url of [databaseUrl, clickhouseUrl]) if (url && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) throw new Error("MCP access tests require loopback databases");
const config = { mcpEnabled: true, mcpPublicUrl: "http://127.0.0.1:18080", mcpConsoleUrl: "http://127.0.0.1:13100", corsOrigin: "http://127.0.0.1:13100" } as AppConfig;

describe.skipIf(!databaseUrl)("MCP connection boundaries on PostgreSQL", () => {
  const schema = `mcp_access_${randomUUID().replaceAll("-", "")}`;
  const tenantId = randomUUID(), appId = randomUUID(), foreignTenant = randomUUID(), foreignApp = randomUUID();
  const member = (role: string, tenant = tenantId): SessionMember => ({ memberId: randomUUID(), tenantId: tenant, role,
    email: `${randomUUID()}@test.invalid`, name: "Synthetic member", totpEnabled: false, requires2fa: false });
  const editor = member("editor"), admin = member("admin"), colleague = member("editor"), outsider = member("admin", foreignTenant);
  let owner: Pool, pg: Pool, oauth: McpOAuth;

  beforeAll(async () => {
    owner = new Pool({ connectionString: databaseUrl });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pg = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
    await pg.query(readFileSync(resolve(__dirname, "../../../../db/postgres/schema.sql"), "utf8"));
    await pg.query(readFileSync(resolve(__dirname, "../../../../db/postgres/upgrades/0013_mcp_oauth.sql"), "utf8"));
    await pg.query("INSERT INTO tenants(id,name) VALUES($1,'MCP access QA'),($2,'Foreign MCP QA')", [tenantId, foreignTenant]);
    await pg.query("INSERT INTO apps(id,tenant_id,name) VALUES($1,$2,'App'),($3,$4,'Foreign app')", [appId, tenantId, foreignApp, foreignTenant]);
    for (const actor of [editor, admin, colleague, outsider]) await pg.query(
      "INSERT INTO members(id,tenant_id,email,name,role,status) VALUES($1,$2,$3,$4,$5,'active')",
      [actor.memberId, actor.tenantId, actor.email, actor.name, actor.role]);
    oauth = new McpOAuth(pg, config);
  });
  afterAll(async () => {
    if (pg) await pg.end();
    if (owner) { await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });
  const newClient = () => oauth.register({ client_name: "Access test", redirect_uris: ["http://127.0.0.1:19999/callback"] });
  async function start(client: Awaited<ReturnType<typeof newClient>>, scopes: McpScope[]) {
    const verifier = randomBytes(32).toString("base64url");
    const redirect = await oauth.authorize({ client_id: client.client_id, response_type: "code", redirect_uri: client.redirect_uris[0],
      state: randomUUID(), scope: scopes.join(" "), resource: oauth.resource, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url") });
    return { requestId: new URL(redirect).searchParams.get("request_id")!, verifier, client, scopes };
  }
  async function grant(actor: SessionMember, flow: Awaited<ReturnType<typeof start>>) {
    const accepted = await oauth.consent(actor, flow.requestId, { app_id: appId, scopes: flow.scopes, approve: true });
    const tokens = await oauth.token({ client_id: flow.client.client_id, grant_type: "authorization_code", resource: oauth.resource,
      redirect_uri: flow.client.redirect_uris[0], code_verifier: flow.verifier, code: new URL(accepted.redirect_uri).searchParams.get("code") });
    return { tokens, actor: await oauth.resolve(tokens.access_token) };
  }

  it("requires fresh user consent after admin approval and removes approval immediately", async () => {
    const client = await newClient();
    const initial = await grant(editor, await start(client, ["mcp:read"]));
    const connection = initial.actor.connectionId;
    await expect(oauth.changeConnection(editor, connection, true)).rejects.toMatchObject({ status: 403 });
    await oauth.changeConnection(admin, connection, true);
    expect((await oauth.resolve(initial.tokens.access_token)).scopes).toEqual(["mcp:read"]);
    const approved = await grant(editor, await start(client, ["mcp:read", "mcp:customers:read"]));
    expect(approved.actor.connectionId).toBe(connection);
    expect(approved.actor.scopes).toContain("mcp:customers:read");
    await oauth.changeConnection(admin, connection, false);
    expect((await oauth.resolve(approved.tokens.access_token)).scopes).toEqual(["mcp:read"]);
    await expect(oauth.consent(editor, (await start(client, ["mcp:read", "mcp:customers:read"])).requestId,
      { app_id: appId, scopes: ["mcp:read", "mcp:customers:read"], approve: true })).rejects.toMatchObject({ status: 403 });
  });

  it("does not turn admin read-only reconsent into future profile approval", async () => {
    const client = await newClient();
    await grant(admin, await start(client, ["mcp:read"]));
    const repeated = await grant(admin, await start(client, ["mcp:read"]));
    expect(repeated.actor.customerAccessApproved).toBe(false);
    await pg.query("UPDATE members SET role='viewer' WHERE tenant_id=$1 AND id=$2", [tenantId, admin.memberId]);
    try {
      const flow = await start(client, ["mcp:read", "mcp:customers:read"]);
      await expect(oauth.consent({ ...admin, role: "viewer" }, flow.requestId,
        { app_id: appId, scopes: flow.scopes, approve: true })).rejects.toMatchObject({ status: 403 });
    } finally { await pg.query("UPDATE members SET role='admin' WHERE tenant_id=$1 AND id=$2", [tenantId, admin.memberId]); }
  });

  it("limits connection management by member and tenant even for foreign administrators", async () => {
    const granted = await grant(editor, await start(await newClient(), ["mcp:read"]));
    await expect(oauth.changeConnection(colleague, granted.actor.connectionId)).rejects.toMatchObject({ status: 404 });
    await expect(oauth.changeConnection(outsider, granted.actor.connectionId, true)).rejects.toMatchObject({ status: 404 });
    await expect(oauth.changeConnection(outsider, granted.actor.connectionId)).rejects.toMatchObject({ status: 404 });
    expect((await oauth.connections(colleague)).connections).toEqual([]);
    expect((await oauth.connections(outsider)).connections).toEqual([]);
    await expect(oauth.consent(editor, (await start(await newClient(), ["mcp:read"])).requestId,
      { app_id: foreignApp, scopes: ["mcp:read"], approve: true })).rejects.toMatchObject({ status: 404 });
    await oauth.changeConnection(admin, granted.actor.connectionId);
    await expect(oauth.resolve(granted.tokens.access_token)).rejects.toMatchObject({ status: 401 });
  });

  it("checks current 2FA policy for both existing access and refresh tokens", async () => {
    const flow = await start(await newClient(), ["mcp:read", "mcp:drafts:write"]);
    const granted = await grant(editor, flow);
    await pg.query("UPDATE tenants SET require_2fa=true WHERE id=$1", [tenantId]);
    try {
      await expect(oauth.resolve(granted.tokens.access_token)).rejects.toMatchObject({ status: 401 });
      await expect(oauth.token({ grant_type: "refresh_token", client_id: flow.client.client_id, resource: oauth.resource,
        refresh_token: granted.tokens.refresh_token })).rejects.toMatchObject({ status: 400 });
      await pg.query("UPDATE members SET totp_enabled_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, editor.memberId]);
      expect((await oauth.resolve(granted.tokens.access_token)).scopes).toContain("mcp:drafts:write");
      await pg.query("UPDATE members SET role='viewer' WHERE tenant_id=$1 AND id=$2", [tenantId, editor.memberId]);
      expect((await oauth.resolve(granted.tokens.access_token)).scopes).toEqual(["mcp:read"]);
    } finally {
      await pg.query("UPDATE tenants SET require_2fa=false WHERE id=$1", [tenantId]);
      await pg.query("UPDATE members SET totp_enabled_at=NULL,role='editor' WHERE tenant_id=$1 AND id=$2", [tenantId, editor.memberId]);
    }
  });
});

describe.skipIf(!databaseUrl || !clickhouseUrl)("MCP limited projections on actual PostgreSQL and ClickHouse", () => {
  const schema = `mcp_read_${randomUUID().replaceAll("-", "")}`;
  const tenantId = randomUUID(), appId = randomUUID(), otherTenant = randomUUID(), otherApp = randomUUID();
  const userId = randomUUID(), foreignUser = randomUUID(), deviceId = randomUUID(), journeyId = randomUUID();
  const actor: McpActor = { tenantId, appId, memberId: randomUUID(), connectionId: randomUUID(), role: "viewer", email: "synthetic@example.test",
    name: "Synthetic", totpEnabled: false, requires2fa: false, scopes: ["mcp:read"], customerAccessApproved: false };
  let owner: Pool, pg: Pool, ch: ClickHouseClient, read: McpRead;
  beforeAll(async () => {
    owner = new Pool({ connectionString: databaseUrl });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pg = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pg.query(readFileSync(resolve(__dirname, "../../../../db/postgres/schema.sql"), "utf8"));
    await pg.query("INSERT INTO tenants(id,name) VALUES($1,'Read QA'),($2,'Foreign read QA')", [tenantId, otherTenant]);
    await pg.query("INSERT INTO apps(id,tenant_id,name) VALUES($1,$2,'Read app'),($3,$4,'Foreign app')", [appId, tenantId, otherApp, otherTenant]);
    await pg.query(`INSERT INTO users(id,tenant_id,app_id,external_id,std_attrs,custom_attrs) VALUES
      ($1,$2,$3,'private-external','{"email":"private-email@example.test","phone":"private-phone"}','{"internal_note":"private-note"}'),
      ($4,$5,$6,'foreign-external','{}','{}')`, [userId, tenantId, appId, foreignUser, otherTenant, otherApp]);
    await pg.query("INSERT INTO devices(id,tenant_id,app_id,user_id,platform,push_token,device_meta) VALUES($1,$2,$3,$4,'ios','private-push-token','{\"model\":\"private-model\"}')", [deviceId, tenantId, appId, userId]);
    const url = new URL(clickhouseUrl!);
    ch = createClient({ url: url.origin, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) || "nudgeon", clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 } });
    const at = new Date().toISOString().replace("T", " ").replace("Z", "");
    await ch.insert({ table: "message_log", format: "JSONEachRow", values: [
      { tenant_id: tenantId, app_id: appId, message_id: randomUUID(), journey_id: journeyId, journey_version: 1, user_id: userId, device_id: deviceId,
        idempotency_key: "private-idempotency", channel: "push_apns", status: "failed", failure_class: "invalid_target", failure_detail: "private-vendor-detail", sent_at: at },
      { tenant_id: otherTenant, app_id: otherApp, message_id: randomUUID(), journey_id: journeyId, user_id: foreignUser, device_id: randomUUID(), channel: "push_apns", status: "sent", sent_at: at },
    ] });
    await ch.insert({ table: "ingestion_errors", format: "JSONEachRow", values: [
      { tenant_id: tenantId, app_id: appId, endpoint: "track", reason: "schema_invalid", detail: "private-error-detail", payload: "private-raw-payload", request_id: randomUUID(), received_at: at },
    ] });
    read = new McpRead(pg, ch);
  });
  afterAll(async () => {
    if (ch) {
      for (const table of ["message_log", "ingestion_errors", "usage_sends_daily"]) await ch.command({ query: `ALTER TABLE ${table} DELETE WHERE tenant_id IN ({tenant:UUID},{foreign:UUID})`, query_params: { tenant: tenantId, foreign: otherTenant }, clickhouse_settings: { mutations_sync: "1" } });
      await ch.close();
    }
    if (pg) await pg.end();
    if (owner) { await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });
  it("does not expose arbitrary profile, token or device metadata on limited customer reads", async () => {
    const result = await read.customer(actor, { user_ref: userId });
    expect(result).toMatchObject({ privacy: "operational_fields_only", devices: [{ platform: "ios" }] });
    expect(JSON.stringify(result)).not.toContain("private-");
    await expect(read.customers(actor, { query: "private-external" })).rejects.toMatchObject({ status: 403 });
    await expect(read.customer(actor, { user_ref: userId }, true)).rejects.toMatchObject({ status: 403 });
    await expect(read.customer(actor, { user_ref: foreignUser })).rejects.toMatchObject({ status: 404 });
  });
  it("requires both approval and granted profile scope while keeping raw tokens out even with approval", async () => {
    await expect(read.customer({ ...actor, scopes: ["mcp:read", "mcp:customers:read"] }, { user_ref: userId }, true)).rejects.toMatchObject({ status: 403 });
    const approved = { ...actor, customerAccessApproved: true, scopes: ["mcp:read", "mcp:customers:read"] };
    expect((await read.customers(approved, { query: "private-external" })).users[0]).toMatchObject({ user_ref: userId, email: "private-email@example.test" });
    const result = await read.customer(approved, { user_ref: userId }, true);
    expect(result.user.std_attrs.email).toBe("private-email@example.test");
    expect(JSON.stringify(result)).not.toContain("private-push-token");
    expect(JSON.stringify(result)).not.toContain("private-model");
  });
  it("redacts raw error fields and confines message logs to the connection app", async () => {
    const messages = await read.messages(actor, {});
    expect(messages.messages).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain("private-");
    expect(JSON.stringify(messages)).not.toContain(foreignUser);
    const errors = await read.errors(actor);
    expect(errors.errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain("private-");
  });
});
