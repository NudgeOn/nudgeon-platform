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
# Next.js는 NEXT_PUBLIC_*를 빌드 시점에 클라이언트 번들에 인라인한다 — 런타임 env로는 안 바뀐다.
# 따라서 배포 대상 API 주소를 build-arg로 받아 build 전에 주입한다 (재검증 #3).
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm --filter @onda/console... build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Next standalone 산출물 (output: "standalone")
COPY --from=build /repo/apps/console/.next/standalone ./
COPY --from=build /repo/apps/console/.next/static ./apps/console/.next/static
COPY --from=build /repo/apps/console/public ./apps/console/public
COPY LICENSE NOTICE TRADEMARKS.md THIRD_PARTY_NOTICES.md /licenses/onda/
COPY docs-public/LICENSING.md /licenses/onda/LICENSING.md
EXPOSE 3000
USER node
CMD ["node", "apps/console/server.js"]
