# onda-console (Next.js standalone)
# 빌드 컨텍스트: 저장소 루트
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/console/package.json ./apps/console/
COPY packages/openapi/package.json ./packages/openapi/
COPY packages/segment-dsl/package.json ./packages/segment-dsl/
COPY packages/journey-model/package.json ./packages/journey-model/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @onda/console... build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Next standalone 산출물 (output: "standalone")
COPY --from=build /repo/apps/console/.next/standalone ./
COPY --from=build /repo/apps/console/.next/static ./apps/console/.next/static
COPY --from=build /repo/apps/console/public ./apps/console/public
EXPOSE 3000
USER node
CMD ["node", "apps/console/server.js"]
