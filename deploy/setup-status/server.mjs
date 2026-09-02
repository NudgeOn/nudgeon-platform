import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";

const port = Number(process.env.PORT ?? 9091);
const timeoutMs = Number(process.env.CHECK_TIMEOUT_MS ?? 1200);

const files = new Map(
  await Promise.all(
    [
      ["/setup", "setup.html", "text/html; charset=utf-8"],
      ["/setup/", "setup.html", "text/html; charset=utf-8"],
      ["/setup.js", "setup.js", "text/javascript; charset=utf-8"],
      ["/setup-diagnostics.mjs", "setup-diagnostics.mjs", "text/javascript; charset=utf-8"],
      ["/setup.css", "setup.css", "text/css; charset=utf-8"],
    ].map(async ([route, file, type]) => [
      route,
      { body: await readFile(new URL(`./public/${file}`, import.meta.url)), type },
    ]),
  ),
);

function safeCode(value) {
  const normalized = String(value ?? "UNKNOWN")
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]/g, "_")
    .slice(0, 64);
  return normalized || "UNKNOWN";
}

async function checkTcp(name, host, targetPort) {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = connect({ host, port: Number(targetPort) });
    const finish = (state, code) => {
      socket.destroy();
      resolve({ name, state, code, latency_ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("ready", "TCP_OK"));
    socket.once("timeout", () => finish("waiting", "TCP_TIMEOUT"));
    socket.once("error", (error) => finish("waiting", safeCode(error.code ?? "TCP_ERROR")));
  });
}

async function checkHttp(name, url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      name,
      state: response.ok ? "ready" : response.status === 503 ? "blocked" : "waiting",
      code: `HTTP_${response.status}`,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      name,
      state: "waiting",
      code: safeCode(error?.cause?.code ?? error?.name ?? "HTTP_ERROR"),
      latency_ms: Date.now() - started,
    };
  }
}

export async function collectStatus(env = process.env) {
  const components = await Promise.all([
    checkTcp("postgres", env.POSTGRES_HOST ?? "postgres", env.POSTGRES_PORT ?? 5432),
    checkTcp("redis", env.REDIS_HOST ?? "redis", env.REDIS_PORT ?? 6379),
    checkTcp("clickhouse", env.CLICKHOUSE_HOST ?? "clickhouse", env.CLICKHOUSE_PORT ?? 8123),
    checkHttp("api", env.API_READY_URL ?? "http://api:8080/readyz"),
    checkHttp("worker", env.WORKER_READY_URL ?? "http://worker:9090/readyz"),
    checkHttp("console", env.CONSOLE_READY_URL ?? "http://console:3000/"),
  ]);
  const ready = components.every((component) => component.state === "ready");
  const blocked = components.some((component) => component.state === "blocked");
  return {
    schema_version: 1,
    installation_id: env.NUDGEON_INSTALLATION_ID ?? "unknown",
    version: env.NUDGEON_VERSION ?? "development",
    state: ready ? "ready" : blocked ? "blocked" : "waiting",
    checked_at: new Date().toISOString(),
    components,
  };
}

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export function createStatusServer() {
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://setup-status").pathname;
    for (const [key, value] of Object.entries(securityHeaders)) response.setHeader(key, value);

    if (path === "/livez" || path === "/readyz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, service: "setup-status" }));
      return;
    }
    if (path === "/setup-status/v1/state") {
      const status = await collectStatus();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(status));
      return;
    }
    const asset = files.get(path);
    if (asset) {
      response.writeHead(200, { "content-type": asset.type });
      response.end(asset.body);
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  createStatusServer().listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "setup_status_started", port }));
  });
}
