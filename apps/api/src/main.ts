import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { RawBodyRequest } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { IncomingMessage } from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";
import { ShutdownState } from "./infra/shutdown-state";
import { installShutdown } from "./infra/shutdown";
import { CapacityMetrics } from "./infra/capacity-metrics";

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false, // 본문 1MB 상한을 직접 설정 (PRD-01: 배치 100건·1MB)
  });
  const shutdown = app.get(ShutdownState);
  app.use(app.get(CapacityMetrics).middleware);
  app.use(shutdown.middleware);
  app.use(
    express.json({
      limit: "1mb",
      // 공급자 웹훅(/v1/webhooks/*)은 원문 바이트로 서명을 검증한다 — 해당 경로만 rawBody 보존 (1MB 상한 동일)
      verify: (req: IncomingMessage, _res, buf) => {
        if (req.url?.startsWith("/v1/webhooks/")) (req as RawBodyRequest<IncomingMessage>).rawBody = buf;
      },
    }),
  );
  app.use(cookieParser());
  app.enableCors({ origin: cfg.corsOrigin, credentials: true });
  installShutdown(app, shutdown);
  await app.listen(cfg.port);
  // eslint-disable-next-line no-console
  console.log(`nudgeon-api listening on :${cfg.port} (mode=${cfg.mode})`);
}

void bootstrap();
