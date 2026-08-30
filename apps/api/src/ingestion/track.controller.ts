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
import type { ZodSchema } from "zod";
import { ApiKeyGuard, RequireApiKey, type AuthedRequest } from "../auth/api-key.guard";
import { IngestionService } from "./ingestion.service";
import {
  attributesBodySchema,
  identifyBodySchema,
  tokenBodySchema,
  trackBodySchema,
} from "./schemas";

function parse<T>(schema: ZodSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

/** Ingestion API 5종 (PRD-01 6.1) */
@Controller("v1")
@UseGuards(ApiKeyGuard)
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

  /** 삭제 요청 (개인정보) — Server Key만 */
  @Delete("users/:externalId")
  @HttpCode(202)
  @RequireApiKey("server")
  async userDelete(@Param("externalId") externalId: string, @Req() req: AuthedRequest) {
    if (!externalId || externalId.length > 256) {
      throw new BadRequestException("external_id가 올바르지 않습니다");
    }
    return this.ingestion.userDelete(req.apiKey, externalId);
  }
}
