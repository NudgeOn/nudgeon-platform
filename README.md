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
docker compose -f deploy/compose.yaml --profile full up -d
pnpm install && pnpm build
pnpm --filter @onda/api dev        # Ingestion API :8080
go run ./apps/worker/cmd/worker --role=all   # 워커
```

## 라이선스

MIT
