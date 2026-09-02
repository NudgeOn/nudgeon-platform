import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS } from "../infra/infra.module";

/**
 * Redis 토큰 버킷 (PRD-06 4장) — 테넌트·키·디바이스 3계층.
 * Lua로 갱신·판정을 원자화한다 (경합 시 초과 허용 방지).
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])      -- 초당 충전량
local burst = tonumber(ARGV[2])     -- 버킷 용량
local now_ms = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = burst
  ts = now_ms
end
tokens = math.min(burst, tokens + (now_ms - ts) / 1000 * rate)

local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / rate * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now_ms)
redis.call('PEXPIRE', key, math.max(60000, math.ceil(burst / rate * 2000)))
return {allowed, math.floor(tokens), retry_ms}
`;

export interface RateLimitDecision {
  allowed: boolean;
  /** 가장 제약이 큰 계층 기준 */
  limit: number;
  remaining: number;
  retryAfterSec: number;
  layer: string;
}

export interface LayerConfig {
  name: string;
  key: string;
  rps: number;
  burst: number;
}

@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {
    this.redis.defineCommand("nudgeonTokenBucket", {
      numberOfKeys: 1,
      lua: TOKEN_BUCKET_LUA,
    });
  }

  /**
   * 여러 계층을 순서대로 검사한다. 하나라도 거부되면 즉시 거부.
   * (선행 계층에서 이미 차감된 토큰은 반환하지 않는다 — 초과 시도 자체가 소비)
   */
  async check(layers: LayerConfig[]): Promise<RateLimitDecision> {
    const now = Date.now();
    let tightest: RateLimitDecision | null = null;
    for (const layer of layers) {
      const [allowed, remaining, retryMs] = (await (
        this.redis as Redis & {
          nudgeonTokenBucket: (
            key: string,
            rps: number,
            burst: number,
            now: number,
            cost: number,
          ) => Promise<[number, number, number]>;
        }
      ).nudgeonTokenBucket(`rl:${layer.key}`, layer.rps, layer.burst, now, 1)) as [
        number,
        number,
        number,
      ];

      const decision: RateLimitDecision = {
        allowed: allowed === 1,
        limit: layer.rps,
        remaining,
        retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)),
        layer: layer.name,
      };
      if (!decision.allowed) return decision;
      if (!tightest || remaining < tightest.remaining) tightest = decision;
    }
    return (
      tightest ?? {
        allowed: true,
        limit: 0,
        remaining: 0,
        retryAfterSec: 0,
        layer: "none",
      }
    );
  }
}
