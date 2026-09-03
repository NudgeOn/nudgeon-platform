import { randomBytes } from "node:crypto";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { ClickHouseClient } from "@clickhouse/client";
import type Redis from "ioredis";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import { encryptEnvelope } from "../crypto/envelope";
import { HealthController } from "./health.controller";
import { ShutdownState } from "../infra/shutdown-state";

interface Mocks {
  pg: { query: ReturnType<typeof vi.fn> };
  redis: { ping: ReturnType<typeof vi.fn> };
  clickhouse: {
    ping: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
}

const POSTGRES_RELATION_COUNT = 23;
const CLICKHOUSE_TABLE_COUNT = 12;

function readyMocks(): Mocks {
  return {
    pg: {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("unnest")) return { rows: [{ present: POSTGRES_RELATION_COUNT }] };
        if (sql.includes("information_schema.columns")) return { rows: [{ present: 4 }] };
        if (sql.includes("pg_enum")) return { rows: [{ present: 5 }] };
        if (sql.includes("FROM credentials")) return { rows: [] };
        return { rows: [{ "?column?": 1 }] };
      }),
    },
    redis: { ping: vi.fn().mockResolvedValue("PONG") },
    clickhouse: {
      ping: vi.fn().mockResolvedValue({ success: true }),
      query: vi.fn().mockImplementation(async ({ query }: { query: string }) => ({
        json: vi
          .fn()
          .mockResolvedValue([{ present: query.includes("system.columns") ? "1" : String(CLICKHOUSE_TABLE_COUNT) }]),
      })),
    },
  };
}

function controller(mocks: Mocks, timeoutMs = 100, shutdown = new ShutdownState()): HealthController {
  return new HealthController(
    mocks.pg as unknown as Pool,
    mocks.redis as unknown as Redis,
    mocks.clickhouse as unknown as ClickHouseClient,
    { readinessTimeoutMs: timeoutMs } as AppConfig,
    shutdown,
  );
}

async function failedReadiness(subject: HealthController): Promise<Record<string, unknown>> {
  try {
    await subject.readyz();
    throw new Error("expected /readyz to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    expect(exception.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    return exception.getResponse() as Record<string, unknown>;
  }
}

describe("HealthController", () => {
  it("rejects readiness without touching dependencies once draining", async () => {
    const mocks = readyMocks(), shutdown = new ShutdownState();
    shutdown.beginDrain();
    expect(await failedReadiness(controller(mocks, 100, shutdown))).toEqual({ ok: false, code: "shutting_down" });
    expect(mocks.pg.query).not.toHaveBeenCalled();
    expect(mocks.redis.ping).not.toHaveBeenCalled();
    expect(mocks.clickhouse.ping).not.toHaveBeenCalled();
  });

  it("does not return ready if shutdown begins during its probes", async () => {
    const mocks = readyMocks(), shutdown = new ShutdownState();
    mocks.redis.ping.mockImplementation(async () => { shutdown.beginDrain(); return "PONG"; });
    expect(await failedReadiness(controller(mocks, 100, shutdown))).toEqual({ ok: false, code: "shutting_down" });
  });
  beforeEach(() => {
    vi.stubEnv("NUDGEON_MASTER_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("KMS_MASTER_KEY_FILE", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps /healthz compatible and adds dependency-free /livez", () => {
    const mocks = readyMocks();
    const subject = controller(mocks);

    expect(subject.livez()).toEqual({ ok: true });
    expect(subject.healthz()).toEqual({ ok: true });
    expect(mocks.pg.query).not.toHaveBeenCalled();
    expect(mocks.redis.ping).not.toHaveBeenCalled();
    expect(mocks.clickhouse.ping).not.toHaveBeenCalled();
  });

  it("reports ready only after stores, required schemas and master key pass", async () => {
    const result = await controller(readyMocks()).readyz();

    expect(result).toEqual({
      ok: true,
      postgres: true,
      redis: true,
      clickhouse: true,
      schema: true,
      master_key: true,
      components: {
        postgres: { status: "ready" },
        redis: { status: "ready" },
        clickhouse: { status: "ready" },
        postgres_schema: { status: "ready" },
        clickhouse_schema: { status: "ready" },
        master_key: { status: "ready" },
      },
    });
  });

  it("returns 503 and blocks PostgreSQL schema when PostgreSQL is unavailable", async () => {
    const mocks = readyMocks();
    mocks.pg.query.mockRejectedValueOnce(new Error("postgres://user:secret@db/nudgeon"));

    const response = await failedReadiness(controller(mocks));

    expect(response).toMatchObject({
      ok: false,
      postgres: false,
      schema: false,
      components: {
        postgres: { status: "not_ready", code: "unavailable" },
        postgres_schema: { status: "blocked", code: "dependency_unavailable" },
      },
    });
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(JSON.stringify(response)).not.toContain("postgres://");
  });

  it("returns 503 when Redis or ClickHouse is unavailable", async () => {
    const redisMocks = readyMocks();
    redisMocks.redis.ping.mockRejectedValue(new Error("redis://:password@redis"));
    const redisResponse = await failedReadiness(controller(redisMocks));
    expect(redisResponse).toMatchObject({
      ok: false,
      redis: false,
      components: { redis: { status: "not_ready", code: "unavailable" } },
    });

    const clickhouseMocks = readyMocks();
    clickhouseMocks.clickhouse.ping.mockResolvedValue({ success: false, error: new Error("ch-password") });
    const clickhouseResponse = await failedReadiness(controller(clickhouseMocks));
    expect(clickhouseResponse).toMatchObject({
      ok: false,
      clickhouse: false,
      schema: false,
      components: {
        clickhouse: { status: "not_ready", code: "unavailable" },
        clickhouse_schema: { status: "blocked", code: "dependency_unavailable" },
      },
    });
    expect(JSON.stringify({ redisResponse, clickhouseResponse })).not.toContain("password");
  });

  it("returns 503 when either required schema is incomplete", async () => {
    const pgMocks = readyMocks();
    pgMocks.pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes("unnest")) return { rows: [{ present: POSTGRES_RELATION_COUNT - 1 }] };
      if (sql.includes("information_schema.columns")) return { rows: [{ present: 4 }] };
      if (sql.includes("pg_enum")) return { rows: [{ present: 5 }] };
      return { rows: [{ "?column?": 1 }] };
    });
    const pgResponse = await failedReadiness(controller(pgMocks));
    expect(pgResponse).toMatchObject({
      schema: false,
      components: { postgres_schema: { status: "not_ready", code: "schema_missing" } },
    });

    const clickhouseMocks = readyMocks();
    clickhouseMocks.clickhouse.query.mockImplementation(async ({ query }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue([{ present: query.includes("system.columns") ? "1" : String(CLICKHOUSE_TABLE_COUNT - 1) }]),
    }));
    const clickhouseResponse = await failedReadiness(controller(clickhouseMocks));
    expect(clickhouseResponse).toMatchObject({
      schema: false,
      components: { clickhouse_schema: { status: "not_ready", code: "schema_missing" } },
    });
  });

  it("returns 503 for invalid key material without echoing it", async () => {
    vi.stubEnv("NUDGEON_MASTER_KEY", "definitely-not-a-key");

    const response = await failedReadiness(controller(readyMocks()));

    expect(response).toMatchObject({
      ok: false,
      master_key: false,
      components: { master_key: { status: "not_ready", code: "self_test_failed" } },
    });
    expect(JSON.stringify(response)).not.toContain("definitely-not-a-key");
  });

  it("detects a configured key that cannot decrypt a persisted credential", async () => {
    const configuredKey = randomBytes(32);
    vi.stubEnv("NUDGEON_MASTER_KEY", configuredKey.toString("base64"));
    const stored = encryptEnvelope(randomBytes(32), "provider-secret");
    const mocks = readyMocks();
    mocks.pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes("unnest")) return { rows: [{ present: POSTGRES_RELATION_COUNT }] };
      if (sql.includes("information_schema.columns")) return { rows: [{ present: 4 }] };
      if (sql.includes("pg_enum")) return { rows: [{ present: 5 }] };
      if (sql.includes("FROM credentials")) {
        return { rows: [{ ciphertext: stored.ciphertext, dek_wrapped: stored.dekWrapped }] };
      }
      return { rows: [{ "?column?": 1 }] };
    });

    const response = await failedReadiness(controller(mocks));

    expect(response).toMatchObject({
      master_key: false,
      components: { master_key: { status: "not_ready", code: "self_test_failed" } },
    });
    expect(JSON.stringify(response)).not.toContain("provider-secret");
  });

  it("bounds a stalled dependency and returns a redacted timeout status", async () => {
    const mocks = readyMocks();
    mocks.redis.ping.mockReturnValue(new Promise(() => undefined));

    const response = await failedReadiness(controller(mocks, 5));

    expect(response).toMatchObject({
      ok: false,
      redis: false,
      components: { redis: { status: "not_ready", code: "timeout" } },
    });
  });
});
