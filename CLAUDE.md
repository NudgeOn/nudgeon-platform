# Onda 플랫폼 모노레포

한국 시장 네이티브 오픈소스(Apache-2.0) 고객 인게이지먼트 플랫폼. "셀프호스팅 가능한 한국형 Braze".
기획 문서는 `docs/prd/`, `docs/dev/` (git 미추적 — 로컬 참조 전용). 스프린트·Go/No-Go 원장은 `docs/dev/DEV-MAIN-개발기획서.md`.

## 스택 (ADR 확정 — DEV-MAIN §2)

- **apps/api**: NestJS 11 — 관리 API + Ingestion API. OpenAPI 3.1 spec-first(`packages/openapi`).
- **apps/console**: Next.js 15 App Router + shadcn/ui + TanStack Query + next-intl(en/ko).
- **apps/worker**: Go 1.23+ 단일 바이너리, `--role=ingest-consumer|scheduler|trigger-matcher|segment|channel|all`. chi + pgx + sqlc.
- **저장**: PostgreSQL = 현재 상태(테넌트/프로필/디바이스/저니 상태), ClickHouse = append-only 수집·로그·분석.
- **큐**: Redis Streams + Consumer Group. 메시지는 JSON + JSON Schema(`packages/queue-schemas`가 단일 출처).
- **마이그레이션**: PG는 Atlas 선언적 스키마(`db/postgres`), CH는 순번 SQL(`db/clickhouse`).
- **인증**: DB 세션 + Redis 캐시 + httpOnly 쿠키. JWT 비채택.

## 절대 규칙 (CI가 기계 강제 — 위반 시 빌드 실패)

1. **파일 1,000라인 제한** (생성 코드 제외).
2. **Redis Streams 직접 호출 금지** — 큐 접근은 반드시 `packages/libqueue-ts` / `packages/libqueue-go` 경유. (Kafka 이관 시 교체 지점 단일화)
3. **Go에서 `time.Now()` 직접 호출 금지** — 주입된 `Clock` 인터페이스 사용 (시간 가속 테스트 하네스 전제).
4. **콘솔에서 수기 fetch 금지** — `packages/openapi` 생성 클라이언트만 사용.
5. **테넌트 격리**: 모든 PG 쿼리에 `tenant_id` 필터 (sqlc 정적 스캔), 모든 CH 쿼리에 tenant 필터 강제 주입. 예외는 allowlist 파일에 사유와 함께 등록.
6. **발송 멱등 키**: `(journey_id, version, user_id, node_index, device_id)` — device_id 누락 금지 (다중 디바이스 미발송 버그).

## 명령어

```bash
pnpm install && pnpm build        # TS 전체 빌드
pnpm test                         # TS 단위 테스트
go build ./... && go test ./...   # Go (go.work 기반, 저장소 루트에서)
docker compose -f deploy/compose.yaml --profile full up -d   # 로컬 dev 환경 (PG+CH+Redis)
```

## 네이밍

- 제품명 **Onda** 확정. 패키지: `@onda/*`(npm), `github.com/ondahq/onda/*`(Go), `io.onda`(모바일).
- **이 repo는 `onda-platform`** (api·console·worker·db). SDK는 형제 repo로 분리:
  `../onda-ios-sdk`, `../onda-android-sdk`, `../onda-rn-sdk`, `../onda-flutter-sdk`.
  SDK 인터페이스 명세는 `docs/prd/PRD-01A` (제품명 Onda로 읽음).
- Prometheus 지표: `onda_<component>_<metric>`.
- 문서의 `engage-*` 표기는 `onda-*`로 읽는다 (PRD-00 Q1).
