import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAiPrompt,
  componentHelp,
  recoveryActions,
  safeDiagnostic,
} from "./public/setup-diagnostics.mjs";

const status = {
  schema_version: 1,
  installation_id: "installation-secret-123",
  version: "0.1.0",
  state: "blocked",
  checked_at: "2026-09-02T01:23:45.000Z",
  password: "password-leak-123",
  database_url: "postgres://admin:database-secret@example.test/nudgeon",
  setup_token: "setup-token-leak-123",
  NUDGEON_MASTER_KEY: "master-key-leak-123",
  api_key: "api-key-leak-123",
  raw_error: "request failed at https://secret.example.test/path",
  components: [
    {
      name: "postgres",
      state: "ready",
      code: "TCP_OK",
      latency_ms: 7,
      dsn: "postgres://component-secret@example.test/nudgeon",
      error: "raw component failure",
    },
    {
      name: "api",
      state: "blocked",
      code: "HTTP_503",
      latency_ms: 18,
      token: "component-token-leak",
    },
    {
      name: "console",
      state: "waiting",
      code: "PASSWORD_SUPERSECRET",
      latency_ms: 4,
      url: "https://console-secret.example.test",
    },
    {
      name: "https://unknown-secret.example.test",
      state: "waiting",
      code: "HTTP_500",
      latency_ms: 1,
    },
  ],
};

test("explains component states in simple Korean without echoing untrusted values", () => {
  assert.match(
    componentHelp({ name: "api", state: "waiting", code: "ECONNREFUSED" }),
    /API 서비스가 아직 연결을 받을 준비가 되지 않았어요/,
  );
  assert.match(
    componentHelp({ name: "console", state: "blocked", code: "HTTP_503" }),
    /켜졌지만 내부 준비 확인/,
  );
  assert.match(
    componentHelp({ name: "redis", state: "ready", code: "TCP_OK" }),
    /정상적으로 연결됐어요/,
  );
  assert.equal(
    componentHelp({
      name: "<img src=x onerror=secret()>",
      state: "waiting",
      code: "PASSWORD_DO_NOT_ECHO",
    }),
    "이 서비스가 시작되는 중이에요.",
  );
});

test("safeDiagnostic returns only normalized whitelisted fields", () => {
  const safe = safeDiagnostic(status);

  assert.deepEqual(Object.keys(safe), [
    "schema_version",
    "version",
    "state",
    "checked_at",
    "components",
  ]);
  assert.deepEqual(safe.components.map((component) => component.name), [
    "postgres",
    "api",
    "console",
  ]);
  for (const component of safe.components) {
    assert.deepEqual(Object.keys(component), ["name", "state", "code", "latency_ms"]);
  }
  assert.equal(safe.components[2].code, "UNKNOWN");

  const serialized = JSON.stringify(safe);
  for (const leakedValue of [
    "installation-secret-123",
    "password-leak-123",
    "database-secret",
    "setup-token-leak-123",
    "master-key-leak-123",
    "api-key-leak-123",
    "secret.example.test",
    "raw component failure",
    "component-token-leak",
    "PASSWORD_SUPERSECRET",
  ]) {
    assert.equal(serialized.includes(leakedValue), false, `must not include ${leakedValue}`);
  }
});

test("safeDiagnostic rejects URL-like versions, invalid timestamps, and unsafe codes", () => {
  const safe = safeDiagnostic({
    schema_version: "not-a-number",
    version: "https://secret.example.test/release?token=leak",
    state: "mystery",
    checked_at: "database-password-leak",
    components: [
      { name: "worker", state: "mystery", code: "API_KEY_LEAK", latency_ms: -1 },
    ],
  });

  assert.deepEqual(safe, {
    schema_version: 1,
    version: "unknown",
    state: "waiting",
    checked_at: null,
    components: [{ name: "worker", state: "waiting", code: "UNKNOWN", latency_ms: null }],
  });
});

test("safeDiagnostic keeps starting and removes duplicate component names", () => {
  const safe = safeDiagnostic({
    state: "starting",
    components: [
      { name: "api", state: "starting", code: "ECONNREFUSED", latency_ms: 3 },
      { name: "api", state: "ready", code: "TCP_OK", latency_ms: 1 },
    ],
  });

  assert.equal(safe.state, "starting");
  assert.deepEqual(safe.components, [
    { name: "api", state: "starting", code: "ECONNREFUSED", latency_ms: 3 },
  ]);
});

test("safeDiagnostic only accepts ready when all six known services are ready", () => {
  const incomplete = safeDiagnostic({
    state: "ready",
    components: [{ name: "api", state: "ready", code: "HTTP_200" }],
  });
  assert.equal(incomplete.state, "waiting");

  const complete = safeDiagnostic({
    state: "ready",
    components: ["postgres", "redis", "clickhouse", "api", "worker", "console"].map((name) => ({
      name,
      state: "ready",
      code: name === "postgres" || name === "redis" || name === "clickhouse" ? "TCP_OK" : "HTTP_200",
    })),
  });
  assert.equal(complete.state, "ready");
});

test("recoveryActions keeps troubleshooting safe and reversible", () => {
  const blocked = recoveryActions(status);
  assert.match(blocked.join("\n"), /\.\/nudgeon status/);
  assert.match(blocked.join("\n"), /\.\/nudgeon logs api/);
  assert.match(blocked.join("\n"), /볼륨을 삭제하지 마세요/);

  const connectionFailed = recoveryActions({}, { connectionFailed: true });
  assert.match(connectionFailed.join("\n"), /\.\/nudgeon doctor/);
  assert.match(connectionFailed.join("\n"), /\.\/nudgeon logs setup-status/);

  const blockedAfterWaiting = recoveryActions({
    state: "blocked",
    components: [
      { name: "api", state: "waiting", code: "ECONNREFUSED" },
      { name: "worker", state: "blocked", code: "HTTP_503" },
    ],
  });
  assert.match(blockedAfterWaiting.join("\n"), /\.\/nudgeon logs worker/);
});

test("buildAiPrompt contains only redacted status and asks for one safe step", () => {
  const prompt = buildAiPrompt(status);

  assert.match(prompt, /자동으로 전송되지 않았고/);
  assert.match(prompt, /쉬운 한국어로 한 번에 한 단계씩/);
  assert.match(prompt, /데이터나 Docker 볼륨을 삭제하는 명령은 제안하지 마세요/);
  assert.match(prompt, /비밀값을 요청하지 마세요/);
  assert.match(prompt, /docker compose down -v/);
  assert.match(prompt, /rm -rf/);
  assert.match(prompt, /"code": "HTTP_503"/);

  for (const leakedValue of [
    "installation-secret-123",
    "password-leak-123",
    "database-secret",
    "setup-token-leak-123",
    "master-key-leak-123",
    "api-key-leak-123",
    "secret.example.test",
    "raw component failure",
    "component-token-leak",
    "PASSWORD_SUPERSECRET",
  ]) {
    assert.equal(prompt.includes(leakedValue), false, `must not include ${leakedValue}`);
  }
});
