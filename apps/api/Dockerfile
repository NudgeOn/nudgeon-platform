# nudgeon-api (NestJS) — pnpm workspace 빌드
# 빌드 컨텍스트: 저장소 루트
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/queue-schemas/package.json ./packages/queue-schemas/
COPY packages/libqueue-ts/package.json ./packages/libqueue-ts/
COPY packages/openapi/package.json ./packages/openapi/
COPY packages/segment-dsl/package.json ./packages/segment-dsl/
COPY packages/journey-model/package.json ./packages/journey-model/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @nudgeon/api... build \
 && pnpm --filter @nudgeon/api --prod deploy --legacy /app

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
COPY LICENSE NOTICE TRADEMARKS.md THIRD_PARTY_NOTICES.md /licenses/nudgeon/
COPY docs-public/LICENSING.md /licenses/nudgeon/LICENSING.md
EXPOSE 8080
USER node
CMD ["node", "dist/main.js"]
