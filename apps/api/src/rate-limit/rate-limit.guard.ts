import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import type { Response } from "express";
import type { AuthedRequest } from "../auth/api-key.guard";
import { RateLimitService, type LayerConfig } from "./rate-limit.service";

/** 계층별 한도 — env 조정 가능 (테넌트 기본 1,000 req/s, PRD-01 6.3) */
function limits(env: NodeJS.ProcessEnv = process.env) {
  const n = (v: string | undefined, d: number) => {
    const parsed = Number(v);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : d;
  };
  return {
    tenantRps: n(env.RATE_LIMIT_TENANT_RPS, 1000),
    keyRps: n(env.RATE_LIMIT_KEY_RPS, 500),
    deviceRps: n(env.RATE_LIMIT_DEVICE_RPS, 20),
  };
}

/**
 * Ingestion rate limit (PRD-06 4장): 테넌트 → 키 → 디바이스 3계층 토큰 버킷.
 * ApiKeyGuard 뒤에서 실행된다 (req.apiKey 필요). 미인증 요청은 통과 —
 * 그 경우는 ApiKeyGuard가 이미 거부했거나 rate limit 비대상 엔드포인트다.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly rateLimit: RateLimitService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    if (!req.apiKey) return true;

    const cfg = limits();
    const layers: LayerConfig[] = [
      {
        name: "tenant",
        key: `t:${req.apiKey.tenantId}`,
        rps: cfg.tenantRps,
        burst: cfg.tenantRps * 2,
      },
      {
        name: "key",
        key: `k:${req.apiKey.id}`,
        rps: cfg.keyRps,
        burst: cfg.keyRps * 2,
      },
    ];
    // 디바이스 계층 — SDK 트래픽에서 단말 폭주 방어 (body에 device가 있을 때만)
    const deviceId = (req.body as { device?: { device_id?: string } } | undefined)
      ?.device?.device_id;
    if (req.apiKey.kind === "sdk" && deviceId) {
      layers.push({
        name: "device",
        key: `d:${deviceId}`,
        rps: cfg.deviceRps,
        burst: cfg.deviceRps * 2,
      });
    }

    const decision = await this.rateLimit.check(layers);
    // 표준 헤더 (DEV-sub-07 §1)
    res.setHeader("X-RateLimit-Limit", decision.limit);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, decision.remaining));
    if (!decision.allowed) {
      res.setHeader("Retry-After", decision.retryAfterSec);
      throw new HttpException(
        {
          statusCode: 429,
          message: `rate limit 초과 (${decision.layer} 계층)`,
          retry_after: decision.retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
