import { readFileSync } from "node:fs";

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
  /** Individual readiness dependency probe timeout. */
  readinessTimeoutMs: number;
  /** Enable only after every worker understands graph schema v2. */
  journeyGraphV2Enabled: boolean;
  /** Opt-in coarse last_used_at writes; never caches authorization decisions. */
  apiKeyUsageCoalesceEnabled?: boolean;
  /**
   * 설치 소유권 claim용 setup 토큰 원문 (single_tenant, Slice B). `./nudgeon up`이 host-only 시크릿 파일로
   * 만들고 NUDGEON_SETUP_TOKEN_FILE로 넘긴다. 기동 시 해시만 installation 행에 올리고 원문은 어디에도 남기지 않는다.
   * 없으면 claim이 불가능하다(설치 잠금 해제 경로 없음) — 상태 API가 `setup_token_configured=false`로 알린다.
   */
  setupToken?: string;
  /** 설치 당시 버전 — installation.installed_version. */
  version: string;
  /**
   * 공개 게이트웨이가 바인딩한 호스트 주소 (Safe Boot: NUDGEON_BIND_ADDRESS). loopback이면 평문 HTTP claim을 허용한다 —
   * 컨테이너 안에서는 클라이언트 IP가 도커 게이트웨이로 보여 IP만으로는 loopback을 알 수 없다.
   * Safe Boot 스크립트와 doctor가 "게이트웨이만 published, 127.0.0.1 바인딩"을 강제한다.
   */
  publicBindAddress?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // fail-fast: 외부 연결 설정은 누락 시 에러. 조용한 localhost 기본값은 프로덕션에서
  // 엉뚱한 대상(로컬)으로 붙는 예측 불가 동작을 낳으므로 금지한다.
  const missing: string[] = [];
  const required = (key: string): string => {
    const inline = env[key]?.trim();
    const file = env[`${key}_FILE`]?.trim();
    if (inline && file) {
      throw new Error(`${key}와 ${key}_FILE은 동시에 설정할 수 없습니다.`);
    }
    const v = file ? readFileSync(file, "utf8").trim() : inline;
    if (!v) {
      missing.push(key);
      return "";
    }
    return v;
  };
  const databaseUrl = required("DATABASE_URL");
  const redisUrl = required("REDIS_URL");
  const clickhouseUrl = required("CLICKHOUSE_URL");
  const setupTokenFile = env.NUDGEON_SETUP_TOKEN_FILE?.trim();
  const setupToken = (setupTokenFile ? readFileSync(setupTokenFile, "utf8") : env.NUDGEON_SETUP_TOKEN ?? "").trim() || undefined;
  if (missing.length > 0) {
    throw new Error(
      `필수 환경변수 누락: ${missing.join(", ")} — 설정 없이 기동 불가(조용한 기본값 금지). ` +
        `.env.example 또는 *_FILE secret 설정을 확인하세요.`,
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
    readinessTimeoutMs: positiveNumber(env.READINESS_TIMEOUT_MS, 3_000),
    journeyGraphV2Enabled: env.JOURNEY_GRAPH_V2_ENABLED === "true",
    apiKeyUsageCoalesceEnabled: env.API_KEY_USAGE_COALESCE_ENABLED === "true",
    setupToken,
    version: env.NUDGEON_VERSION ?? "development",
    publicBindAddress: env.NUDGEON_PUBLIC_BIND_ADDRESS?.trim() || undefined,
  };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("READINESS_TIMEOUT_MS는 0보다 큰 숫자여야 합니다");
  }
  return parsed;
}
