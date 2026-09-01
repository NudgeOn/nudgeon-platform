# Onda 배포 가이드

> Onda는 하나의 컨테이너 이미지 세트로 자체 서버부터 관리형 클라우드까지 배포합니다 (PRD-08).
> 배포 대상이 달라도 이미지는 같고, 차이는 오케스트레이션 매니페스트뿐입니다.

> **2026-08-31 검증 경계:** Compose 설정과 배포 코드는 존재하지만 최신 이미지의 전체 기동, 관리형 DB 실연결, 백업 복원·부하·롤백은 별도 출시 게이트입니다. 아래 운영 절차·사양은 준비 기준을 포함하며 실측 완료를 뜻하지 않습니다. [현재 출시 체크리스트](RELEASE-CHECKLIST.md)를 함께 확인하세요.

## 1. 빠른 시작 — 셀프호스팅 (Docker Compose)

```bash
git clone <repo> onda && cd onda
# Compose 전용 예제 — 컨테이너 내부 서비스명(postgres/redis/clickhouse) 주소.
# (루트 .env.example은 호스트 로컬 실행용이라 컨테이너에 주입하면 연결 대상이 어긋납니다.)
cp deploy/.env.example deploy/.env
# 필수: 마스터키 생성 (크리덴셜 봉투 암호화)
echo "ONDA_MASTER_KEY=$(openssl rand -base64 32)" >> deploy/.env

# 번들 DB + 앱 전체 기동 (PG16 · ClickHouse24 · Redis7 + api · console · worker)
docker compose -f deploy/compose.yaml --env-file deploy/.env --profile full --profile app up -d
```

- 콘솔: http://localhost:3000 · API: http://localhost:8080 · 워커 metrics: http://localhost:9090/metrics
- **비-localhost 배포(커스텀 도메인)**: `NEXT_PUBLIC_API_URL`은 Next.js가 **빌드 시점에 콘솔 번들에 인라인**한다(런타임 변경 불가). `deploy/.env`에 실제 API 주소를 넣고 반드시 **다시 빌드**하라: `docker compose -f deploy/compose.yaml --env-file deploy/.env --profile full --profile app up -d --build`.
- `migrator`가 스키마를 먼저 적용(멱등)한 뒤 api·worker가 기동합니다.
- 목표: `git clone` → `.env` → `up` → **15분 내 콘솔 온보딩** (M-7).

### 셀프호스팅 단일 테넌트 모드

`.env`에 `MODE=single_tenant`를 설정하면 가입 대신 **초기 관리자 셋업**으로 전환됩니다.
- `GET /v1/bootstrap/status` → `needs_setup` 확인
- `POST /v1/bootstrap/setup` (email·password·name) → 최초 1회 관리자 생성, 이후 잠금

## 2. 관리형 데이터 서비스 (RDS · ElastiCache · ClickHouse Cloud)

번들 DB 대신 외부 데이터 서비스를 지정하는 설정 경로가 있습니다. URL 외에 TLS·인증·네트워크·DB 권한·버전 호환성을 실제 환경에서 검증해야 합니다. 현재 app 단독 Compose config 통과는 실서비스 연결 증거가 아닙니다.

```bash
# deploy/.env (실제 인증 정보는 로컬 환경 파일에만 보관)
DATABASE_URL=postgres://user:pass@your-rds:5432/onda
REDIS_URL=redis://your-elasticache:6379
CLICKHOUSE_URL=http://user:pass@your-ch-cloud:8123/onda

# 앱만 기동 (DB는 외부)
docker compose -f deploy/compose.yaml --env-file deploy/.env --profile app up -d
```

- 검증 대상: RDS/Aurora PostgreSQL 15+, ElastiCache(Redis 7 호환), ClickHouse(자체/Cloud/Altinity). 현재 확정된 호환성 인증 목록은 아닙니다.
- 스키마 적용: `migrator` 서비스가 자동 실행. 수동은 `docker run onda-worker /onda-migrate /db`.

## 3. 스키마 마이그레이션

- **부트스트랩·재적용**: `onda-migrate`가 `db/postgres/upgrades/*.sql`을 이름순으로 먼저 실행한 뒤
  `db/postgres/schema.sql` + `db/clickhouse/*.sql`를 멱등 적용합니다. 기존 테이블의 신규 컬럼을
  먼저 추가하므로 해당 컬럼을 사용하는 인덱스도 업그레이드할 수 있습니다.
- **프로덕션 준비 기준**: Atlas 선언적 스키마(`db/postgres/atlas.hcl`)와 추가형 upgrade 코드가 있습니다.
  앱 N ↔ 스키마 N-1 호환·혼합 버전·롤링/롤백 안전성은 실제 업그레이드 테스트로 확인해야 합니다.

## 4. 관찰성

- 구조화 JSON 로그(trace_id 전파). 워커 `:9090/metrics` Prometheus 지표(`onda_<comp>_<metric>`):
  `onda_ingest_events_processed_total`, `onda_scheduler_sends_published_total`,
  `onda_channel_sends_total{status}`, `onda_worker_batch_errors_total{role}`.
- 헬스: api `:8080/healthz`·`/readyz`, worker `:9090/healthz`.

## 5. 백업·복구

아래는 설계 방향입니다. 자동화 도구·빈 서버 복원·데이터 정합·복구 시간은 아직 검증되지 않았습니다.

- **PostgreSQL**: WAL 아카이빙 또는 RDS 스냅샷.
- **ClickHouse**: `clickhouse-backup` → S3.
- **Redis**: AOF(everysec) 기본 구성. 큐·발송 멱등 키·frequency cap 상태의 유실과 재적재를 함께 검증해야 합니다.
  PG outbox가 있어도 모든 스트림의 trim/소비 전 유실 복구가 완료된 것은 아니며 중복 발송 0%를 보장하지 않습니다.
- **수집 복구**: `/track`은 PG receipt/outbox로 영속 접수하고 미완료 항목 재발행 코드를 사용합니다.
  `raw_ingestions`는 비동기 적재이므로 단독 안전망으로 보장할 수 없습니다. 특정 구간 raw replay 도구와 대량 복구는 잔여 작업입니다.

## 6. 업그레이드

- 이미지 태그 교체 → `migrator`(expand) → 롤링 → (다음 릴리스에서 contract).
- N-1 스키마 호환과 무중단 롤링·롤백은 검증 목표입니다. 버전별 호환성/복원 시험 없이 안전하다고 가정하지 마세요.

### 저니 그래프 v2 공개 순서

1. 추가형 DB 변경을 적용합니다. 기존 `journey_versions`·진행 상태·발송 outbox는 보존합니다.
2. `JOURNEY_GRAPH_V2_ENABLED=false`를 유지하고 v1/v2·durable event를 모두 처리하는 워커를 **전체** 교체합니다.
3. 호환 API를 적용한 뒤 `JOURNEY_GRAPH_V2_ENABLED=true`로 새 그래프 활성화를 허용합니다.
4. 새 콘솔을 공개합니다. 콘솔은 서버 capability가 없거나 비활성화되면 그래프 생성을 막고 기존 저니를 읽기 전용으로 표시합니다.

v2 실행이 생긴 뒤에는 구형 워커로 되돌리지 마세요. flag를 내려 신규 활성화를 막아도 진행 중인 v2 고객은
호환 워커가 끝까지 처리해야 합니다. [동작 규칙과 검증 방법](./JOURNEY-GRAPH.md)을 함께 확인하세요.

## 7. 규모 가이드 (단일 노드·실측 대기)

- 유저 50만 · 토큰 100만의 초기 검증 후보: 8 vCPU / 32GB + NVMe (ClickHouse 볼륨 분리). 처리량 보장이나 실측된 권장 사양은 아닙니다.
- 역할별 독립 스케일: `worker --role=channel`(발송 최다)을 별도 다수 기동.
- 성능 한계·스케일아웃 기준은 후속 부하 테스트의 원본 결과로 확정합니다. 현재 `docs/perf/` 결과가 확보됐다는 의미는 아닙니다.
