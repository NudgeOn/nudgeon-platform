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
  /** Enable only after every worker understands graph schema v2. */
  journeyGraphV2Enabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // fail-fast: 외부 연결 설정은 누락 시 에러. 조용한 localhost 기본값은 프로덕션에서
  // 엉뚱한 대상(로컬)으로 붙는 예측 불가 동작을 낳으므로 금지한다.
  const missing: string[] = [];
  const required = (key: string): string => {
    const v = env[key];
    if (!v || v.trim() === "") {
      missing.push(key);
      return "";
    }
    return v;
  };
  const databaseUrl = required("DATABASE_URL");
  const redisUrl = required("REDIS_URL");
  const clickhouseUrl = required("CLICKHOUSE_URL");
  if (missing.length > 0) {
    throw new Error(
      `필수 환경변수 누락: ${missing.join(", ")} — 설정 없이 기동 불가(조용한 기본값 금지). ` +
        `.env.example 또는 deploy/.env.example를 참고해 설정하세요.`,
    );
  }
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl,
    redisUrl,
    clickhouseUrl,
    mode: env.MODE === "single_tenant" ? "single_tenant" : "multi_tenant",
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 72),
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:3000",
    journeyGraphV2Enabled: env.JOURNEY_GRAPH_V2_ENABLED === "true",
  };
}
