import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import {
  ApiKeyService,
  type ApiKeyKind,
  type ApiKeyScope,
  type ResolvedApiKey,
} from "./api-key.service";

export const API_KEY_KINDS = "api_key_kinds";
export const API_KEY_SCOPE = "api_key_scope";

/** 엔드포인트가 허용하는 키 종류 선언 (PRD-01 6.1 인증 컬럼) */
export const RequireApiKey = (...kinds: ApiKeyKind[]) =>
  SetMetadata(API_KEY_KINDS, kinds);

/**
 * 엔드포인트가 요구하는 최소 키 스코프 선언. `full`을 요구하면 ingest_only 키는 거부.
 * 관리성 작업(개인정보 삭제 등)에 적용 — 수집 전용 키의 권한 상승 방지 (재검증: ingest_only 삭제 허용).
 */
export const RequireScope = (scope: ApiKeyScope) => SetMetadata(API_KEY_SCOPE, scope);

export interface AuthedRequest extends Request {
  apiKey: ResolvedApiKey;
}

/**
 * Ingestion 인증 미들웨어 (DEV-sub-07 S1).
 * `Authorization: Bearer <key>` 또는 `X-Api-Key: <key>`.
 * 키 종류별 스코프 가드 — sdk는 쓰기 전용 엔드포인트만 (T-1의 대상).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const kinds = this.reflector.get<ApiKeyKind[] | undefined>(
      API_KEY_KINDS,
      ctx.getHandler(),
    );
    if (!kinds || kinds.length === 0) return true; // API 키 비대상 엔드포인트

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.header("authorization");
    const raw =
      header?.replace(/^Bearer\s+/i, "") ?? req.header("x-api-key") ?? "";
    if (!raw) throw new UnauthorizedException("API 키가 필요합니다");

    const resolved = await this.apiKeys.resolve(raw);
    if (!resolved) throw new UnauthorizedException("유효하지 않은 API 키");
    if (!kinds.includes(resolved.kind)) {
      throw new UnauthorizedException("이 엔드포인트에서 허용되지 않는 키 종류");
    }
    // 스코프 강제 — full 요구 엔드포인트에 ingest_only 키 접근 차단 (재검증)
    const requiredScope = this.reflector.get<ApiKeyScope | undefined>(
      API_KEY_SCOPE,
      ctx.getHandler(),
    );
    if (requiredScope === "full" && resolved.scope !== "full") {
      throw new ForbiddenException("이 엔드포인트는 full 스코프 키가 필요합니다");
    }
    req.apiKey = resolved;
    return true;
  }
}
