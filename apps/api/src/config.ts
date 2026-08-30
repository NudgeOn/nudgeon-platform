/** 12-Factor 설정 — 모든 외부 의존은 환경변수 (PRD-08 1장) */
export interface AppConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  clickhouseUrl: string;
  /** multi_tenant(SaaS) | single_tenant(셀프호스팅) — 코드 경로 분기는 금지 (PRD-06 2장) */
  mode: "multi_tenant" | "single_tenant";
  sessionTtlHours: number;
  corsOrigin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl:
      env.DATABASE_URL ?? "postgres://onda:onda@localhost:5433/onda",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    clickhouseUrl: env.CLICKHOUSE_URL ?? "http://onda:onda@localhost:8123/onda",
    mode: env.MODE === "single_tenant" ? "single_tenant" : "multi_tenant",
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 72),
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:3000",
  };
}
