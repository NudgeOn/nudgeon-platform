import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiKeyGuard,
  RequireApiKey,
  type AuthedRequest,
} from "../auth/api-key.guard";
import { RateLimitGuard } from "../rate-limit/rate-limit.guard";
import { InAppDelivery } from "./delivery.service";
@Controller("v1/in-app/live")
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class InAppDeliveryController {
  constructor(private readonly service: InAppDelivery) {}
  private auth(r: AuthedRequest) {
    return this.service.auth(
      r.apiKey.tenantId,
      r.apiKey.appId,
      r.header("x-nudgeon-installation") ?? "",
    );
  }
  @Post("installations") @RequireApiKey("sdk") register(
    @Req() r: AuthedRequest,
    @Body() b: unknown,
  ) {
    return this.service.register(r.apiKey.tenantId, r.apiKey.appId, b);
  }
  @Post("decisions") @RequireApiKey("sdk") async decide(
    @Req() r: AuthedRequest,
    @Body() b: unknown,
  ) {
    return this.service.decide(await this.auth(r), b);
  }
  @Post("deliveries/:id/authorize") @RequireApiKey("sdk") async authorize(
    @Req() r: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.authorize(await this.auth(r), id);
  }
  @Get("deliveries/:id") @RequireApiKey("sdk") async status(
    @Req() r: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.status(await this.auth(r), id);
  }
  @Post("deliveries/:id/events") @RequireApiKey("sdk") async event(
    @Req() r: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: unknown,
  ) {
    return this.service.event(await this.auth(r), id, b);
  }
  @Post("revoke") @RequireApiKey("sdk") async revoke(@Req() r: AuthedRequest) {
    return this.service.revoke(await this.auth(r));
  }
}
