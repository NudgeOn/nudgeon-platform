import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import express from "express";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false, // 본문 1MB 상한을 직접 설정 (PRD-01: 배치 100건·1MB)
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.enableCors({ origin: cfg.corsOrigin, credentials: true });
  app.enableShutdownHooks();
  await app.listen(cfg.port);
  // eslint-disable-next-line no-console
  console.log(`onda-api listening on :${cfg.port} (mode=${cfg.mode})`);
}

void bootstrap();
