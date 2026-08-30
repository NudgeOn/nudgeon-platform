import { Module } from "@nestjs/common";
import { InfraModule } from "./infra/infra.module";
import { HealthController } from "./health/health.controller";
import { ApiKeyGuard } from "./auth/api-key.guard";
import { ApiKeyService } from "./auth/api-key.service";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { SessionService } from "./auth/session.service";
import { IngestionService } from "./ingestion/ingestion.service";
import { TrackController } from "./ingestion/track.controller";
import { CredentialsController } from "./credentials/credentials.controller";
import { TestPushController } from "./messaging/test-push.controller";
import { SessionGuard } from "./auth/session.guard";
import { AppsController } from "./apps/apps.controller";
import { SegmentsController } from "./segments/segments.controller";
import { JourneysController } from "./journeys/journeys.controller";
import { RateLimitGuard } from "./rate-limit/rate-limit.guard";
import { RateLimitService } from "./rate-limit/rate-limit.service";

@Module({
  imports: [InfraModule],
  controllers: [
    HealthController,
    AuthController,
    TrackController,
    CredentialsController,
    TestPushController,
    AppsController,
    SegmentsController,
    JourneysController,
  ],
  providers: [
    ApiKeyGuard,
    SessionGuard,
    RateLimitGuard,
    RateLimitService,
    ApiKeyService,
    AuthService,
    SessionService,
    IngestionService,
  ],
})
export class AppModule {}
