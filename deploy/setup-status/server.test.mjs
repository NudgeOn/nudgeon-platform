import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createStatusServer } from "./server.mjs";

let server;
let origin;

before(async () => {
  process.env.POSTGRES_HOST = "127.0.0.1";
  process.env.POSTGRES_PORT = "9";
  process.env.REDIS_HOST = "127.0.0.1";
  process.env.REDIS_PORT = "9";
  process.env.CLICKHOUSE_HOST = "127.0.0.1";
  process.env.CLICKHOUSE_PORT = "9";
  process.env.API_READY_URL = "http://127.0.0.1:9/readyz";
  process.env.WORKER_READY_URL = "http://127.0.0.1:9/readyz";
  process.env.CONSOLE_READY_URL = "http://127.0.0.1:9/";
  server = createStatusServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
});

test("serves the setup shell with security headers", async () => {
  const response = await fetch(`${origin}/setup`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(await response.text(), /NudgeOn를 시작하고 있습니다/);
});

test("serves the redacted setup diagnostics module", async () => {
  const response = await fetch(`${origin}/setup-diagnostics.mjs`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/javascript/);
  assert.match(await response.text(), /export function buildAiPrompt/);
});

test("returns only redacted component codes", async () => {
  const response = await fetch(`${origin}/setup-status/v1/state`);
  const body = await response.json();
  assert.equal(body.schema_version, 1);
  assert.ok(["waiting", "blocked", "ready"].includes(body.state));
  assert.equal(body.components.length, 6);
  for (const component of body.components) {
    assert.match(component.code, /^[A-Z0-9_:-]+$/);
    assert.equal("detail" in component, false);
  }
});
