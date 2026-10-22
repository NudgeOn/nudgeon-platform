import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { Pool } from "pg";
import Redis from "ioredis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { ConnectionController } from "./connection.controller";
import { ApiKeyService, generateApiKey } from "../auth/api-key.service";
import { ApiKeyGuard } from "../auth/api-key.guard";
import { RateLimitGuard } from "../rate-limit/rate-limit.guard";
import { RateLimitService } from "../rate-limit/rate-limit.service";
import { ShutdownState } from "../infra/shutdown-state";
import { PG, REDIS } from "../infra/infra.module";

const databaseUrl = process.env.NUDGEON_CONNECTION_DATABASE_URL;
const redisUrl = process.env.NUDGEON_CONNECTION_REDIS_URL;
const supple = process.env.SUPPLE_REPO;
for (const value of [databaseUrl, redisUrl]) {
  if (value && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname))
    throw new Error("Connection integration QA only permits loopback infrastructure");
}

describe.skipIf(!databaseUrl || !redisUrl || !supple)("Supple -> real NudgeOn HTTP handshake (no devices)", () => {
  const schema = `connection_${randomUUID().replaceAll("-", "")}`;
  const tenant = randomUUID(), appId = randomUUID();
  const server = generateApiKey("server"), sdk = generateApiKey("sdk");
  let pg: Pool, admin: Pool, redis: Redis, app: INestApplication, origin: string;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pg = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pg.query(readFileSync(resolve(__dirname, "../../../../db/postgres/schema.sql"), "utf8"));
    await pg.query("INSERT INTO tenants(id,name) VALUES($1,'Supple API QA')", [tenant]);
    await pg.query("INSERT INTO apps(id,tenant_id,name) VALUES($1,$2,'Supple API QA')", [appId, tenant]);
    for (const [kind, generated] of [["server", server], ["sdk", sdk]] as const)
      await pg.query("INSERT INTO api_keys(id,tenant_id,app_id,kind,scope,key_hash,prefix) VALUES($1,$2,$3,$4,'ingest_only',$5,$6)",
        [randomUUID(), tenant, appId, kind, generated.hash, generated.prefix]);
    redis = new Redis(redisUrl!);
    // Vitest/esbuild lacks emitted decorator metadata. Match production tsc constructor metadata.
    Reflect.defineMetadata("design:paramtypes", [Reflector, ApiKeyService], ApiKeyGuard);
    Reflect.defineMetadata("design:paramtypes", [RateLimitService], RateLimitGuard);
    @Module({ controllers: [ConnectionController], providers: [
      { provide: PG, useValue: pg }, { provide: REDIS, useValue: redis }, ShutdownState,
      ApiKeyService, ApiKeyGuard, RateLimitService, RateLimitGuard,
    ] })
    class ConnectionQA {}
    app = await NestFactory.create(ConnectionQA, { logger: false });
    await app.listen(0, "127.0.0.1");
    origin = await app.getUrl();
  }, 20000);
  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await pg?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  it("rejects missing, invalid, and SDK keys over real HTTP", async () => {
    for (const key of [null, "sk_invalid_credentials", sdk.key]) {
      const response = await fetch(origin + "/v1/integrations/connection", { headers: key ? { Authorization: `Bearer ${key}` } : {} });
      expect(response.status).toBe(401);
    }
  });
  it("connects and encrypts the key through Supple's real service, without sending anything", async () => {
    const script = `
import json,os
from app.platform.database import pool,transaction,uid
from app.domains.notifications import installation
from app.integrations.nudgeon.api import NudgeOnAPI
pool.open(wait=True)
try:
    user,org,member=uid(),uid(),uid()
    with transaction() as db:
        db.query("INSERT INTO organizations(id,name) VALUES($1,'API integration QA')",[org])
        db.query("INSERT INTO users(id,issuer,subject,name) VALUES($1,'urn:qa',$2,'QA')",[user,user])
        db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'OWNER')",[member,org,user])
    installation.save(user,org,installation.Installation(revision=0,consoleUrl='http://localhost:3999'))
    result=installation.connect(user,org,installation.APISettings(revision=1,apiUrl=os.environ['QA_ORIGIN'],appId=os.environ['QA_APP'],serverKey=os.environ['QA_KEY']))
    assert result['verified'] is True and result['apiKeyConfigured'] is True
    assert result['push']=={'fcm':False,'apns':False} and result['liveSending'] is False
    assert os.environ['QA_KEY'] not in json.dumps(result,default=str)
    again=installation.connect(user,org,installation.APISettings(revision=2,apiUrl=os.environ['QA_ORIGIN'],appId=os.environ['QA_APP']))
    assert again['verified'] is True
    client=NudgeOnAPI(os.environ['QA_ORIGIN'],os.environ['QA_KEY'])
    try:
        try: client.verify(uid())
        except Exception as error: assert getattr(error,'code',None)=='NUDGEON_APP_MISMATCH'
        else: raise AssertionError('Wrong app verified')
    finally: client.close()
    print(json.dumps({'verified':True,'fcm':False,'apns':False,'liveSending':False,'encryptedKeyReuse':True,'wrongAppRejected':True}))
finally: pool.close()
`;
    const result = await promisify(execFile)(resolve(supple!, "Server/.venv/bin/python"), ["-c", script], {
      cwd: resolve(supple!, "Server"), timeout: 20000,
      env: { ...process.env, DATABASE_URL: databaseUrl, NUDGEON_API_ORIGINS: origin,
        PUSH_CREDENTIAL_KEY: randomBytes(32).toString("base64"), QA_ORIGIN: origin, QA_APP: appId, QA_KEY: server.key },
    });
    expect(JSON.parse(result.stdout)).toEqual({ verified: true, fcm: false, apns: false, liveSending: false,
      encryptedKeyReuse: true, wrongAppRejected: true });
    for (const table of ["users", "devices", "journeys", "journey_outbox"]) {
      const result = await pg.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(result.rows[0].n).toBe(0);
    }
  }, 30000);
  it.skipIf(!process.env.SUPPLE_CONNECTION_UI_SCRIPT)("shows actual connection status in Supple settings", async () => {
    const result = await promisify(execFile)(process.execPath, [process.env.SUPPLE_CONNECTION_UI_SCRIPT!], {
      timeout: 60000,
      env: { ...process.env, DATABASE_URL: databaseUrl, NUDGEON_API_ORIGINS: origin,
        PUSH_CREDENTIAL_KEY: randomBytes(32).toString("base64"), QA_ORIGIN: origin, QA_APP: appId, QA_KEY: server.key },
    });
    expect(result.stdout).toContain("PASS: UI -> real Supple FastAPI");
    const devices = await pg.query("SELECT count(*)::int AS n FROM devices");
    const jobs = await pg.query("SELECT count(*)::int AS n FROM journey_outbox");
    expect(devices.rows[0].n).toBe(0);
    expect(jobs.rows[0].n).toBe(0);
  }, 65000);
  it("rejects a revoked key immediately", async () => {
    await pg.query("UPDATE api_keys SET status='revoked' WHERE tenant_id=$1 AND app_id=$2 AND key_hash=$3", [tenant, appId, server.hash]);
    const response = await fetch(origin + "/v1/integrations/connection", { headers: { Authorization: `Bearer ${server.key}` } });
    expect(response.status).toBe(401);
  });
});
