# Onda

**한국 시장 네이티브 오픈소스 고객 인게이지먼트 플랫폼.**
Push부터 알림톡까지, 하나의 세그먼트·저니 엔진 위에서 — 셀프호스팅 가능한 한국형 Braze.

> ⚠️ 초기 개발 단계 (MVP S1). API·스키마는 예고 없이 변경됩니다.

## 구조

```
apps/
  api/        NestJS — 관리 API + Ingestion API
  console/    Next.js — 어드민 콘솔
  worker/     Go — 실행 엔진 (--role: ingest-consumer|scheduler|trigger-matcher|segment|channel)
packages/
  openapi/         OpenAPI 3.1 스펙 + 생성 클라이언트
  queue-schemas/   큐 메시지 JSON Schema (단일 출처)
  libqueue-ts/     Redis Streams 래퍼 (TS, 생산)
  libqueue-go/     Redis Streams 래퍼 (Go, 생산·소비)
  segment-dsl/     세그먼트 DSL 스키마 + 골든 테스트
db/
  postgres/        Atlas 선언적 스키마
  clickhouse/      순번 SQL 마이그레이션
deploy/            Docker Compose
```

## 빠른 시작 (개발)

```bash
# 데이터 서비스만 (앱은 로컬 실행)
docker compose -f deploy/compose.yaml --profile full up -d
export ONDA_MASTER_KEY=$(openssl rand -base64 32)
go run ./apps/worker/cmd/migrate db        # 스키마 적용 (멱등)
pnpm install && pnpm build
pnpm --filter @onda/api dev                # 관리·Ingestion API :8080
go run ./apps/worker/cmd/worker --role=all # 워커 (전 역할)
pnpm --filter @onda/console dev            # 콘솔 :3000
```

## 셀프호스팅 (원-커맨드)

```bash
cp .env.example .env
echo "ONDA_MASTER_KEY=$(openssl rand -base64 32)" >> .env
docker compose -f deploy/compose.yaml --profile full --profile app up -d
# → 콘솔 :3000 · API :8080 · 워커 metrics :9090
```

자세한 배포·관리형 DB·백업·업그레이드는 [docs-public/DEPLOY.md](docs-public/DEPLOY.md).

## 운영 도구

```bash
go run ./apps/worker/cmd/seed --tenant <uuid> --app <uuid> --users 500000   # 합성 데이터
go run ./apps/worker/cmd/loadgen --key pk_... --rate 5000 --dur 30s          # 수집 부하
node tests/isolation/run.mjs                                                  # 테넌트 격리 검증
```

## 라이선스

MIT
