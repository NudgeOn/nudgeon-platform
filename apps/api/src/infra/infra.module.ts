import { Global, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import Redis from "ioredis";
import { Pool } from "pg";
import { QueueProducer } from "@nudgeon/libqueue";
import { loadConfig, type AppConfig } from "../config";

export const CONFIG = "CONFIG";
export const PG = "PG";
export const REDIS = "REDIS";
export const CLICKHOUSE = "CLICKHOUSE";
export const QUEUE = "QUEUE";

/** 인프라 클라이언트 전역 제공 — 연결은 여기서만 만든다 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: PG,
      inject: [CONFIG],
      useFactory: (cfg: AppConfig) =>
        new Pool({ connectionString: cfg.databaseUrl, max: 10 }),
    },
    {
      provide: REDIS,
      inject: [CONFIG],
      useFactory: (cfg: AppConfig) =>
        new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2 }),
    },
    {
      provide: CLICKHOUSE,
      inject: [CONFIG],
      useFactory: (cfg: AppConfig): ClickHouseClient =>
        createClient({
          url: cfg.clickhouseUrl,
          clickhouse_settings: {
            // 작은 파트 난립 방지 — API는 응답을 기다리지 않는다 (PRD-01 6.3)
            async_insert: 1,
            wait_for_async_insert: 0,
          },
        }),
    },
    {
      provide: QUEUE,
      inject: [REDIS],
      useFactory: (redis: Redis) => new QueueProducer(redis),
    },
  ],
  exports: [CONFIG, PG, REDIS, CLICKHOUSE, QUEUE],
})
export class InfraModule implements OnApplicationShutdown {
  constructor() {}
  async onApplicationShutdown() {
    // 연결 종료는 Nest lifecycle에서 개별 provider가 담당하지 않으므로 생략(프로세스 종료와 함께 정리)
  }
}
