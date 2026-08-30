import { Controller, Get, Inject } from "@nestjs/common";
import type Redis from "ioredis";
import type { Pool } from "pg";
import { PG, REDIS } from "../infra/infra.module";

@Controller()
export class HealthController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** liveness — 프로세스 생존만 확인 */
  @Get("healthz")
  healthz() {
    return { ok: true };
  }

  /** readiness — 의존 서비스 연결 확인 */
  @Get("readyz")
  async readyz() {
    const [pgOk, redisOk] = await Promise.all([
      this.pg
        .query("SELECT 1")
        .then(() => true)
        .catch(() => false),
      this.redis
        .ping()
        .then(() => true)
        .catch(() => false),
    ]);
    return { ok: pgOk && redisOk, postgres: pgOk, redis: redisOk };
  }
}
