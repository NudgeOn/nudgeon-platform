import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiKeyGuard, RequireApiKey, type AuthedRequest } from "../auth/api-key.guard";
import { IngestionService } from "./ingestion.service";
import { trackBodySchema } from "./schemas";

@Controller("v1")
@UseGuards(ApiKeyGuard)
export class TrackController {
  constructor(private readonly ingestion: IngestionService) {}

  /** 이벤트 배치 수집 — SDK Key 또는 Server Key (PRD-01 6.1) */
  @Post("track")
  @HttpCode(202)
  @RequireApiKey("sdk", "server")
  async track(@Body() body: unknown, @Req() req: AuthedRequest) {
    const parsed = trackBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.ingestion.track(req.apiKey, parsed.data, body);
  }
}
