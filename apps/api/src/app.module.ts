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

@Module({
  imports: [InfraModule],
  controllers: [
    HealthController,
    AuthController,
    TrackController,
    CredentialsController,
    TestPushController,
  ],
  providers: [
    ApiKeyGuard,
    SessionGuard,
    ApiKeyService,
    AuthService,
    SessionService,
    IngestionService,
  ],
})
export class AppModule {}
