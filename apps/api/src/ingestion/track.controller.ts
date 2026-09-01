import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  ApiKeyGuard,
  RequireApiKey,
  RequireScope,
  type AuthedRequest,
} from "../auth/api-key.guard";
import { RateLimitGuard } from "../rate-limit/rate-limit.guard";
import { IngestionService } from "./ingestion.service";
import {
  attributesBodySchema,
  identifyBodySchema,
  logoutBodySchema,
  subscriptionBodySchema,
  tokenBodySchema,
  trackBodySchema,
} from "./schemas";

// 스키마 제네릭 — 입력≠출력(z.preprocess 등)인 스키마도 출력 타입으로 안전하게 파싱한다.
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

/** Ingestion API 5종 (PRD-01 6.1). 가드 순서: 키 인증 → rate limit (3계층) */
@Controller("v1")
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class TrackController {
  constructor(private readonly ingestion: IngestionService) {}

  /** 이벤트 배치 수집 — SDK Key 또는 Server Key */
  @Post("track")
  @HttpCode(202)
  @RequireApiKey("sdk", "server")
  async track(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.ingestion.track(req.apiKey, parse(trackBodySchema, body), body);
  }

  /** identify + 속성 갱신 — SDK Key 또는 Server Key */
  @Post("identify")
  @HttpCode(202)
  @RequireApiKey("sdk", "server")
  async identify(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.ingestion.identify(req.apiKey, parse(identifyBodySchema, body), body);
  }

  /** 서버사이드 속성 배치 갱신 — Server Key만 */
  @Post("users/attributes")
  @HttpCode(202)
  @RequireApiKey("server")
  async attributes(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.ingestion.attributes(req.apiKey, parse(attributesBodySchema, body), body);
  }

  /** 토큰 등록/갱신 — SDK Key */
  @Post("devices/token")
  @HttpCode(202)
  @RequireApiKey("sdk")
  async deviceToken(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.ingestion.deviceToken(req.apiKey, parse(tokenBodySchema, body), body);
  }

  /** 수신 동의 변경 (setPushOptIn 서버 동기화 — R-03) — SDK/Server Key */
  @Post("subscriptions")
  @HttpCode(202)
  @RequireApiKey("sdk", "server")
  async subscriptions(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.ingestion.subscriptions(req.apiKey, parse(subscriptionBodySchema, body), body);
  }

  /** 로그아웃/reset — 디바이스 토큰 분리(발송 차단 — R-03) — SDK Key */
  @Post("devices/logout")
  @HttpCode(202)
  @RequireApiKey("sdk")
  async deviceLogout(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.ingestion.deviceLogout(req.apiKey, parse(logoutBodySchema, body), body);
  }

  /** 삭제 요청 (개인정보) — Server Key + full 스코프만 (ingest_only 거부) */
  @Delete("users/:externalId")
  @HttpCode(202)
  @RequireApiKey("server")
  @RequireScope("full")
  async userDelete(@Param("externalId") externalId: string, @Req() req: AuthedRequest) {
    if (!externalId || externalId.length > 256) {
      throw new BadRequestException("external_id가 올바르지 않습니다");
    }
    return this.ingestion.userDelete(req.apiKey, externalId);
  }
}
