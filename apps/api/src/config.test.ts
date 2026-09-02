import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function secret(value: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nudgeon-config-"));
  tempDirs.push(dir);
  const path = join(dir, "value");
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return path;
}

describe("loadConfig *_FILE support", () => {
  it("loads required connection settings from secret files", () => {
    const config = loadConfig({
      DATABASE_URL_FILE: secret("postgres://nudgeon:secret@postgres:5432/nudgeon"),
      REDIS_URL_FILE: secret("redis://:secret@redis:6379"),
      CLICKHOUSE_URL_FILE: secret("http://nudgeon:secret@clickhouse:8123/nudgeon"),
      MODE: "single_tenant",
    });

    expect(config.databaseUrl).toContain("postgres://nudgeon:secret");
    expect(config.redisUrl).toContain("redis://:secret");
    expect(config.clickhouseUrl).toContain("http://nudgeon:secret");
    expect(config.mode).toBe("single_tenant");
  });

  it("rejects ambiguous inline and file values", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://inline",
        DATABASE_URL_FILE: secret("postgres://file"),
        REDIS_URL: "redis://redis:6379",
        CLICKHOUSE_URL: "http://clickhouse:8123",
      }),
    ).toThrow("DATABASE_URL와 DATABASE_URL_FILE은 동시에 설정할 수 없습니다");
  });
});
