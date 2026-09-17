import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestPushService } from "./test-push.service";
import { TestPushController } from "./test-push.controller";
import type { SessionRequest } from "../auth/session.guard";

const url = process.env.NUDGEON_TEST_PUSH_DATABASE_URL;
if (url && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Test push QA requires a loopback database");
describe.skipIf(!url)("durable test push on PostgreSQL", () => {
  const schema = `test_push_${randomUUID().replaceAll("-", "")}`;
  const tenant = randomUUID(), app = randomUUID(), user = randomUUID(), device = randomUUID(), otherDevice = randomUUID();
  const foreignTenant = randomUUID(), foreignApp = randomUUID();
  const req = { member: { tenantId: tenant } } as SessionRequest;
  const input = { external_id: "qa-customer", device_id: device, title: "QA", body: "Synthetic test" };
  let admin: Pool, pg: Pool, service: TestPushService, controller: TestPushController;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pg = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 6 });
    await pg.query(readFileSync(resolve(__dirname, "../../../../db/postgres/schema.sql"), "utf8"));
    // The additive upgrade must also work after a fresh schema bootstrap.
    await pg.query(readFileSync(resolve(__dirname, "../../../../db/postgres/upgrades/0009_test_push_runs.sql"), "utf8"));
    await pg.query("INSERT INTO tenants(id,name) VALUES($1,'QA'),($2,'Foreign QA')", [tenant, foreignTenant]);
    await pg.query("INSERT INTO apps(id,tenant_id,name) VALUES($1,$2,'QA'),($3,$4,'Foreign QA')", [app, tenant, foreignApp, foreignTenant]);
    await pg.query("INSERT INTO users(id,tenant_id,app_id,external_id) VALUES($1,$2,$3,'qa-customer')", [user, tenant, app]);
    for (const id of [device, otherDevice]) await pg.query(
      "INSERT INTO devices(id,tenant_id,app_id,user_id,platform,push_token,os_permission) VALUES($1,$2,$3,$4,'android',$5,'granted')", [id,tenant,app,user,`synthetic-${id}`]);
    await pg.query("INSERT INTO credentials(tenant_id,app_id,kind,ciphertext,dek_wrapped,status) VALUES($1,$2,'push_fcm','fake','fake','verified')", [tenant,app]);
    service = new TestPushService(pg); controller = new TestPushController(pg, service);
  });
  afterAll(async () => { if (pg) await pg.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  it("serializes concurrent retries and survives a new service instance with stable message IDs", async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({length: 5}, () => service.accept(tenant,app,key,input)));
    expect(new Set(results.map(r => r.test_run_id)).size).toBe(1);
    expect(results[0]!.messages.map(m => m.device_id)).toEqual([device]);
    expect(results[0]!.state).toBe("accepted");
    expect(await new TestPushService(pg).accept(tenant,app,key,input)).toEqual(results[0]);
    const rows = await pg.query("SELECT payload FROM journey_outbox WHERE tenant_id=$1 AND app_id=$2 AND idempotency_key=$3", [tenant,app,`test:${results[0]!.test_run_id}:${device}`]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].payload.message_id).toBe(results[0]!.messages[0]!.message_id);
    await expect(service.accept(tenant,app,key,{...input,body:"Changed"})).rejects.toMatchObject({status:409});
  });
  it("returns durable history separately from actual queue publication", async () => {
    const run = await service.accept(tenant,app,randomUUID(),input);
    let history = await controller.runs(app,req);
    expect(history.runs.find(r => r.test_run_id === run.test_run_id).queued_count).toBe(0);
    await pg.query("UPDATE journey_outbox SET published_at=now() WHERE tenant_id=$1 AND app_id=$2 AND payload->>'campaign_ref'=$3", [tenant,app,`test:${run.test_run_id}`]);
    history = await controller.runs(app,req);
    expect(history.runs.find(r => r.test_run_id === run.test_run_id).queued_count).toBe(1);
    expect(JSON.stringify(history)).not.toContain("synthetic-");
    // Customer erasure removes payloads, so missing jobs must not look perpetually pending.
    await pg.query("DELETE FROM journey_outbox WHERE tenant_id=$1 AND app_id=$2 AND payload->>'campaign_ref'=$3", [tenant,app,`test:${run.test_run_id}`]);
    const removed = (await controller.runs(app,req)).runs.find(r => r.test_run_id === run.test_run_id);
    expect(removed).toMatchObject({ pending_count: 0, queued_count: 0, removed_count: 1 });
  });
  it("checks tenant ownership before invalid bodies and never leaks targets or history", async () => {
    await expect(controller.testPush(foreignApp,{},req)).rejects.toMatchObject({status:404});
    await expect(controller.targets(foreignApp,"qa-customer",req)).rejects.toMatchObject({status:404});
    await expect(controller.runs(foreignApp,req)).rejects.toMatchObject({status:404});
    await expect(service.accept(tenant,app,randomUUID(),{...input,device_id:randomUUID()})).rejects.toMatchObject({status:400});
  });
  it("does not expose tokens and revalidates permission and credentials at send time", async () => {
    const targets = await controller.targets(app,"qa-customer",req);
    expect(targets.devices).toHaveLength(2); expect(targets.devices.every(d => d.eligible)).toBe(true);
    expect(JSON.stringify(targets)).not.toContain("synthetic-");
    await pg.query("UPDATE devices SET os_permission='denied' WHERE tenant_id=$1 AND id=$2", [tenant,device]);
    await expect(service.accept(tenant,app,randomUUID(),input)).rejects.toMatchObject({status:400});
    await pg.query("UPDATE devices SET os_permission='granted' WHERE tenant_id=$1 AND id=$2", [tenant,device]);
    await pg.query("UPDATE credentials SET status='error' WHERE tenant_id=$1 AND app_id=$2", [tenant,app]);
    await expect(service.accept(tenant,app,randomUUID(),input)).rejects.toMatchObject({status:400});
    await pg.query("UPDATE credentials SET status='verified' WHERE tenant_id=$1 AND app_id=$2", [tenant,app]);
  });
  it("rolls back the outbox if saving the ledger fails", async () => {
    const key = randomUUID();
    await pg.query(`ALTER TABLE test_push_runs ADD CONSTRAINT simulate_failure CHECK (request_key <> '${key}'::uuid)`);
    const count = () => pg.query("SELECT count(*) FROM journey_outbox WHERE tenant_id=$1 AND app_id=$2", [tenant,app]);
    const before = (await count()).rows;
    await expect(service.accept(tenant,app,key,input)).rejects.toThrow();
    expect((await count()).rows).toEqual(before);
    await pg.query("ALTER TABLE test_push_runs DROP CONSTRAINT simulate_failure");
    expect((await service.accept(tenant,app,key,input)).queued).toBe(1);
  });
  it("keeps legacy all-device requests compatible and validates idempotency keys", async () => {
    const { device_id: _device, ...legacy } = input;
    expect((await controller.testPush(app,legacy,req)).queued).toBe(2);
    await expect(controller.testPush(app,input,req,"bad-key")).rejects.toMatchObject({status:400});
    await expect(controller.targets(app," ",req)).rejects.toMatchObject({status:400});
  });
});
