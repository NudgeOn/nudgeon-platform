import "reflect-metadata";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InAppAssets } from "./assets.service";
import { InAppWorkbench } from "./workbench.service";
import { InAppTestSdkController } from "./sdk.controller";
import type { AuthedRequest } from "../auth/api-key.guard";
import type { AppConfig } from "../config";
const url = process.env.NUDGEON_IN_APP_TEST_DATABASE_URL;
if (url && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname))
  throw Error("Loopback QA database only");
describe.skipIf(!url)(
  "in-app immutable source and device test transactions",
  () => {
    const schema = `in_app_${randomUUID().replaceAll("-", "")}`,
      tenant = randomUUID(),
      app = randomUUID(),
      other = randomUUID(),
      member = randomUUID();
    let admin: Pool,
      pg: Pool,
      assets: InAppAssets,
      service: InAppWorkbench,
      sdk: InAppTestSdkController,
      dir: string;
    const cfg = { corsOrigin: "http://localhost:3300" } as AppConfig;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "nudgeon-in-app-"));
      process.env.IN_APP_ASSET_DIR = dir;
      process.env.IN_APP_ENABLED = "true";
      process.env.CONTENT_PUBLIC_ORIGIN = "http://127.0.0.1:8082";
      admin = new Pool({ connectionString: url });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pg = new Pool({
        connectionString: url,
        options: `-c search_path=${schema}`,
        max: 8,
      });
      await pg.query(
        readFileSync(
          resolve(__dirname, "../../../../db/postgres/schema.sql"),
          "utf8",
        ),
      );
      const migration = readFileSync(
        resolve(
          __dirname,
          "../../../../db/postgres/upgrades/0010_in_app_workbench.sql",
        ),
        "utf8",
      );
      await pg.query(migration);
      await pg.query(migration);
      await pg.query(
        "INSERT INTO tenants(id,name) VALUES($1,'In-app QA'),($2,'Other QA')",
        [tenant, other],
      );
      await pg.query("INSERT INTO apps(id,tenant_id,name) VALUES($1,$2,'QA')", [
        app,
        tenant,
      ]);
      assets = new InAppAssets(pg, cfg);
      service = new InAppWorkbench(pg, assets);
      sdk = new InAppTestSdkController(service);
    }, 30000);
    afterAll(async () => {
      await pg?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
      if (dir) await rm(dir, { recursive: true, force: true });
    });
    function request(credential = "", t = tenant): AuthedRequest {
      return {
        apiKey: { tenantId: t, appId: app, kind: "sdk" },
        header: (key: string) =>
          key === "x-nudgeon-test-token" ? credential : undefined,
      } as unknown as AuthedRequest;
    }
    it("stores a validated immutable revision and blocks other tenants", async () => {
      const r = await service.create(tenant, app, member, {
        name: "QA",
        files: [
          {
            path: "index.html",
            base64: Buffer.from("<h1>Event</h1>").toString("base64"),
          },
        ],
      });
      expect((await assets.read(tenant, app, r.id)).artifact_sha256).toBe(
        r.artifact_sha256,
      );
      await expect(assets.read(other, app, r.id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.list(other, app)).rejects.toMatchObject({
        status: 404,
      });
    }, 30000);
    it("pairs once, requires operator confirmation, claims once and preserves retry history", async () => {
      const r = (await service.list(tenant, app)).revisions[0];
      const p = await service.pairing(tenant, app, member);
      await expect(
        sdk.pair(request("", other), {
          token: p.token,
          label: "Foreign",
          platform: "ios",
          sdk_version: "1",
        }),
      ).rejects.toMatchObject({ status: 401 });
      const d = await sdk.pair(request(), {
        token: p.token,
        label: "iPhone QA",
        platform: "ios",
        sdk_version: "1",
      });
      await expect(
        sdk.pair(request(), {
          token: p.token,
          label: "Duplicate",
          platform: "ios",
          sdk_version: "1",
        }),
      ).rejects.toMatchObject({ status: 401 });
      const req = request(d.credential);
      expect((await sdk.commands(req)).state).toBe("claimed");
      const input = {
        revision_id: r.id,
        device_id: d.id,
        request_key: randomUUID(),
      };
      await expect(service.run(tenant, app, input)).rejects.toMatchObject({
        status: 400,
      });
      await service.confirm(tenant, app, d.id);
      const results = await Promise.all(
        Array.from({ length: 3 }, () => service.run(tenant, app, input)),
      );
      expect(new Set(results.map((x) => x.id)).size).toBe(1);
      const run = results[0];
      await expect(
        service.run(tenant, app, { ...input, revision_id: randomUUID() }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(sdk.commands(request("fake"))).rejects.toMatchObject({
        status: 401,
      });
      const artifact = await sdk.claim(req, run.id);
      expect(artifact.artifact_sha256).toBe(r.artifact_sha256);
      await expect(sdk.claim(req, run.id)).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        sdk.event(req, run.id, { event_id: randomUUID(), kind: "impression" }),
      ).rejects.toMatchObject({ status: 409 });
      const event = {
        event_id: randomUUID(),
        kind: "failed",
        detail: "CONTENT_TIMEOUT",
      };
      await sdk.event(req, run.id, event);
      await sdk.event(req, run.id, event);
      expect((await service.events(tenant, app, run.id)).events).toHaveLength(
        1,
      );
      await expect(
        sdk.event(req, run.id, { event_id: randomUUID(), kind: "presented" }),
      ).rejects.toMatchObject({ status: 409 });
      const retry = await service.run(tenant, app, {
        ...input,
        request_key: randomUUID(),
        retry_of: run.id,
      });
      expect(retry.retry_of).toBe(run.id);
      await service.cancel(tenant, app, retry.id);
      await expect(sdk.claim(req, retry.id)).rejects.toMatchObject({
        status: 409,
      });
      await service.revoke(tenant, app, d.id);
      await expect(sdk.commands(req)).rejects.toMatchObject({ status: 401 });
      expect(
        (await service.runs(tenant, app)).runs.some(
          (x) => x.id === run.id && x.error_code === "CONTENT_TIMEOUT",
        ),
      ).toBe(true);
    });
    it("records one impression and cannot revive a closed run", async () => {
      const r = (await service.list(tenant, app)).revisions[0];
      const p = await service.pairing(tenant, app, member);
      const d = await sdk.pair(request(), {
        token: p.token,
        label: "Android QA",
        platform: "android",
        sdk_version: "1",
      });
      await service.confirm(tenant, app, d.id);
      const req = request(d.credential);
      const run = await service.run(tenant, app, {
        revision_id: r.id,
        device_id: d.id,
        request_key: randomUUID(),
      });
      await sdk.claim(req, run.id);
      await sdk.event(req, run.id, {
        event_id: randomUUID(),
        kind: "presented",
      });
      await sdk.event(req, run.id, {
        event_id: randomUUID(),
        kind: "impression",
      });
      await sdk.event(req, run.id, {
        event_id: randomUUID(),
        kind: "impression",
      });
      expect(
        (await service.events(tenant, app, run.id)).events.filter(
          (e) => e.kind === "impression",
        ),
      ).toHaveLength(1);
      await sdk.event(req, run.id, {
        event_id: randomUUID(),
        kind: "dismiss",
        detail: "close_button",
      });
      await expect(
        sdk.event(req, run.id, { event_id: randomUUID(), kind: "presented" }),
      ).rejects.toMatchObject({ status: 409 });
    });
  },
);
