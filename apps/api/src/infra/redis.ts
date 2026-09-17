import Redis from "ioredis";
import type { AppConfig } from "../config";

/** Shared construction path for the API and isolated connection regressions. */
export function createRedisClient(cfg: Pick<AppConfig, "redisUrl">): Redis {
  return new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2 });
}
