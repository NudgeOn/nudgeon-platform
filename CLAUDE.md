# NudgeOn 플랫폼 모노레포

이벤트 수집, 고객 세그먼트, 저니, 메시지 전송을 연결하는 오픈소스(Apache-2.0) 고객 인게이지먼트 플랫폼.
기획 문서는 `docs/prd/`, `docs/dev/` (git 미추적 — 로컬 참조 전용). 스프린트·Go/No-Go 원장은 `docs/dev/DEV-MAIN-개발기획서.md`.

## 스택 (ADR 확정 — DEV-MAIN §2 · 저장소 선택 근거는 `docs-public/ARCHITECTURE-DECISIONS.md`)

- **apps/api**: NestJS 11 — 관리 API + Ingestion API. OpenAPI 3.1 spec-first(`packages/openapi`).
- **apps/console**: Next.js 15 App Router + shadcn/ui + TanStack Query + next-intl(en/ko).
- **apps/worker**: Go 1.25 단일 바이너리, `--role=ingest-consumer|scheduler|trigger-matcher|segment|channel|dlq-monitor|ops-monitor|outbox-relay|all`. chi(헬스 엔드포인트) + pgx. **sqlc는 쓰지 않는다** — 쿼리는 수기 SQL이다.
- **저장**: PostgreSQL = 현재 상태(테넌트/프로필/디바이스/저니 상태), ClickHouse = append-only 수집·로그·분석.
- **큐**: Redis Streams + Consumer Group. 메시지는 JSON. 계약의 단일 출처는 `packages/queue-schemas`의 JSON Schema이며 **TS 쪽만 런타임 검증**한다. Go는 구조체를 수기로 대응시키고 필수 필드만 검사한다(`libqueue-go` `Envelope.Validate`, `TODO(S2)`). 큐 상한은 `MAXLEN ~ 1,000,000`이며 배압이 아니라 **오래된 엔트리 트림**이다 — `nudgeon_queue_*` 지표로 유실을 관측한다.
- **마이그레이션**: PG는 `apps/worker/cmd/migrate`가 `db/postgres/schema.sql` + `upgrades/000N.sql`을 순번 적용한다(자체 제작, **버전 테이블·advisory lock 없음**). `db/postgres/atlas.hcl`은 있으나 어디서도 호출되지 않는다. CH는 순번 SQL(`db/clickhouse`).
- **인증**: DB 세션(`sessions` 테이블) + httpOnly 쿠키. JWT 비채택. Redis 세션 캐시는 **미구현**(`session.service.ts` `TODO(S2)`) — 폐기가 즉시 반영되는 건 매 요청이 PG를 조회하기 때문이다.

## 절대 규칙 (CI가 기계 강제 — 위반 시 빌드 실패)

1. **파일 1,000라인 제한** (생성 코드 제외).
2. **Redis Streams 직접 호출 금지** — 큐 접근은 반드시 `packages/libqueue-ts` / `packages/libqueue-go` 경유. (Kafka 이관 시 교체 지점 단일화)
3. **Go에서 `time.Now()` 직접 호출 금지** — 주입된 `Clock` 인터페이스 사용 (시간 가속 테스트 하네스 전제).
4. **콘솔에서 수기 fetch 금지** — `packages/openapi` 생성 클라이언트만 사용.
5. **테넌트 격리**: 모든 PG 쿼리에 `tenant_id` 필터, 모든 CH 쿼리에 tenant 필터 강제 주입. 강제 수단은 `scripts/tenant-scan.py`(SQL 리터럴 정규식 스캔)이며 예외는 `scripts/tenant-scan-allowlist.txt`에 쿼리 해시와 사유를 함께 등록한다. 정규식 스캔이라 동적 SQL·런타임 주입 필터는 잡지 못한다 — 그런 경우도 allowlist에 사유를 적는다.
6. **발송 멱등 키**: `(journey_id, version, user_id, node_index, device_id)` — device_id 누락 금지 (다중 디바이스 미발송 버그).

## 명령어

```bash
pnpm install && pnpm build        # TS 전체 빌드
pnpm test                         # TS 단위 테스트
# Go — go.work 멀티모듈이라 루트 ./... 는 실패한다. 반드시 모듈 경로를 명시한다 (CI와 동일).
go build ./apps/worker/... ./packages/libqueue-go/... && go test ./apps/worker/... ./packages/libqueue-go/...
./scripts/lint-rules.sh           # 절대 규칙 검사 (CI가 같은 스크립트를 돌린다)
docker compose -f deploy/compose.yaml --profile full up -d   # 로컬 dev 환경 (PG+CH+Redis)
```

## 네이밍

- 제품명 **NudgeOn** 확정. 패키지: `@nudgeon/*`(npm), `github.com/nudgeon/nudgeon-platform/*`(Go), `io.nudgeon`(모바일).
- **이 repo는 `nudgeon-platform`** (api·console·worker·db). SDK는 형제 repo로 분리:
  `../nudgeon-ios-sdk`, `../nudgeon-android-sdk`, `../nudgeon-rn-sdk`, `../nudgeon-flutter-sdk`.
  SDK 인터페이스 명세는 `docs/prd/PRD-01A` (제품명 NudgeOn로 읽음).
- Prometheus 지표: `nudgeon_<component>_<metric>`.
- 문서의 `engage-*` 표기는 `nudgeon-*`로 읽는다 (PRD-00 Q1).
