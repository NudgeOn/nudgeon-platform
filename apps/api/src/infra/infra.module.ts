import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import Redis from "ioredis";
import { Pool } from "pg";
import { QueueProducer } from "@nudgeon/libqueue";
import { loadConfig, type AppConfig } from "../config";
import { ShutdownState } from "./shutdown-state";
import { bounded, SHUTDOWN_BUDGET } from "./shutdown";
import { CapacityMetrics } from "./capacity-metrics";

export const CONFIG = "CONFIG";
export const PG = "PG";
export const REDIS = "REDIS";
export const CLICKHOUSE = "CLICKHOUSE";
export const QUEUE = "QUEUE";

/** 인프라 클라이언트 전역 제공 — 연결은 여기서만 만든다 */
@Global()
@Module({
  providers: [
    ShutdownState,
    CapacityMetrics,
    { provide: CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: PG,
      inject: [CONFIG, CapacityMetrics],
      useFactory: (cfg: AppConfig, metrics: CapacityMetrics) => {
        const pool = new Pool({ connectionString: cfg.databaseUrl, max: 10 });
        metrics.registerPool(pool);
        return pool;
      },
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
  exports: [CONFIG, PG, REDIS, CLICKHOUSE, QUEUE, ShutdownState, CapacityMetrics],
})
export class InfraModule implements OnApplicationShutdown {
  private readonly logger = new Logger(InfraModule.name);
  private closing?: Promise<void>;
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLICKHOUSE) private readonly clickhouse: ClickHouseClient,
  ) {}
  onApplicationShutdown(): Promise<void> {
    return this.closing ??= this.closeClients();
  }
  private async closeClients() {
    const close = async (client: string, work: () => Promise<unknown>) => {
      const complete = await bounded(Promise.resolve().then(work), SHUTDOWN_BUDGET.clientsMs - 100);
      this.logger.log(JSON.stringify({ event: "shutdown_client_closed", client, complete }));
      return complete;
    };
    const results = await Promise.all([
      close("postgres", () => this.pg.end()),
      close("redis", async () => {
        try { await this.redis.quit(); }
        finally { this.redis.disconnect(); }
      }),
      close("clickhouse", () => this.clickhouse.close()),
    ]);
    // quit may wait on an unavailable Redis. Stop reconnect/offline work even then.
    this.redis.disconnect();
    if (results.some(complete => !complete)) throw new Error("Infrastructure shutdown incomplete");
  }
}
