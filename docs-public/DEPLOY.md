# NudgeOn 배포 가이드

> NudgeOn는 동일한 versioned image 세트를 자체 서버와 관리형 클라우드에 배포하는 구조를 목표로 합니다 (PRD-08).
> 현재 Safe Boot Preview는 저장소 소스를 로컬에서 빌드하므로 이 release-image 목표를 달성했다는 증거는 아닙니다.

> **2026-09-02 검증 경계:** `./nudgeon up` Safe Boot Preview와 전용 Compose·gateway·설치 상태 화면은 구현되어 있습니다. 다만 현재 경로는 저장소 소스를 로컬에서 빌드하는 Slice A이며, 최초 Owner 위자드·Test Inbox·versioned release image·clean-host 출시 증거는 아직 없습니다. 관리형 DB 실연결, 백업 복원·부하·롤백도 별도 출시 게이트입니다. [현재 출시 체크리스트](RELEASE-CHECKLIST.md)를 함께 확인하세요.

## 1. 빠른 시작 — Safe Boot Preview

NudgeOn는 Apache-2.0 Open Source의 소유권·검토 가능성을 유지하면서, 기본 셀프호스팅 시작을 한 명령으로 줄이는 방향입니다. 현재 Safe Boot Preview는 Docker Engine, Compose v2, OpenSSL, cURL이 준비된 로컬 환경에서 다음처럼 실행합니다.

```bash
git clone <repo> nudgeon && cd nudgeon
./nudgeon up
```

명령은 호스트 전용 `.nudgeon/`에 설치 ID와 시크릿을 원자적으로 만들고, 전용 `deploy/compose.safe.yaml`을 사용해 setup shell과 gateway를 먼저 연 뒤 나머지 서비스를 빌드·기동합니다. 개발 seed는 넣지 않으며 PostgreSQL·ClickHouse·Redis·API·worker·console은 호스트 포트를 열지 않습니다. 기본 진입점은 gateway 하나인 <http://localhost:8080/setup>입니다.

```bash
./nudgeon status       # 컨테이너와 secret-redacted 준비 상태
./nudgeon setup-url    # 현재 로컬 setup URL
./nudgeon doctor       # Docker·Compose·포트·파일 권한·published port 검사
./nudgeon logs api     # 서비스별 최근 로그
./nudgeon down         # 데이터와 시크릿을 삭제하지 않고 중지
```

8080 포트가 사용 중이면 첫 실행 전에 포트를 지정합니다. 선택한 포트는 `.nudgeon/compose.env`에 보존됩니다.

```bash
NUDGEON_PORT=18080 ./nudgeon up
```

### Safe Boot Preview의 현재 경계

- 현재 gateway는 `127.0.0.1` 바인딩만 허용합니다. 인터넷이나 원격 사설망에 직접 공개하지 마세요.
- 현재 이미지는 registry의 versioned release image가 아니라 checkout 소스를 `development` 태그로 로컬 빌드합니다.
- setup shell은 런타임 readiness와 redacted 진단만 제공합니다. 설치 소유권 claim, 최초 Owner 원자 생성, Bootstrap 영구 잠금은 **Slice B**입니다.
- NudgeOn Test Inbox와 재개 가능한 activation은 **Slice C·D**입니다. 지금 setup shell에서 Owner 설정 CTA가 비활성화된 것은 정상입니다.
- Docker Compose config·단위 테스트나 한 환경의 기동만으로 clean Linux/arm64 지원, production readiness, 백업·복구를 입증하지 않습니다.

전체 목표 계약과 Slice별 상태는 [P0 Docker Setup Wizard PRD](DOCKER-SETUP-WIZARD-PRD.md)에 정리되어 있습니다.

### 기존 수동 Compose — 개발·고급 경로

기존 `deploy/compose.yaml`은 개발 또는 명시적인 고급 설정을 위해 남아 있습니다. 이 경로는 `.env`와 마스터키를 수동으로 준비하고 DB·API·console·worker metrics 포트를 호스트에 노출하므로 Safe Boot와 같은 설치 안전성을 제공하지 않습니다.

```bash
cp deploy/.env.example deploy/.env
echo "NUDGEON_MASTER_KEY=$(openssl rand -base64 32)" >> deploy/.env
docker compose -f deploy/compose.yaml --env-file deploy/.env --profile full --profile app up -d
```

- 콘솔: http://localhost:3000 · API: http://localhost:8080 · 워커 metrics: http://localhost:9090/metrics
- **비-localhost 배포(커스텀 도메인)**: 기존 Compose의 `NEXT_PUBLIC_API_URL`은 Next.js가 **빌드 시점에 콘솔 번들에 인라인**한다(런타임 변경 불가). `deploy/.env`에 실제 API 주소를 넣고 반드시 **다시 빌드**합니다.
- 최초 관리자 API에는 설치 소유권 claim이 없습니다. 외부에 공개된 호스트에서 Bootstrap을 열지 말고 localhost 또는 통제된 사설망에서만 다루세요.

### 셀프호스팅 단일 테넌트 모드

기존 수동 Compose에서 `.env`에 `MODE=single_tenant`를 설정하면 가입 대신 **초기 관리자 셋업**으로 전환됩니다. 이는 Slice B의 안전한 claim 위자드가 아닙니다.
- `GET /v1/bootstrap/status` → `needs_setup` 확인
- `POST /v1/bootstrap/setup` (email·password·name) → 최초 1회 관리자 생성, 이후 잠금

## 2. 관리형 데이터 서비스 (RDS · ElastiCache · ClickHouse Cloud)

번들 DB 대신 외부 데이터 서비스를 지정하는 설정 경로가 있습니다. URL 외에 TLS·인증·네트워크·DB 권한·버전 호환성을 실제 환경에서 검증해야 합니다. 현재 app 단독 Compose config 통과는 실서비스 연결 증거가 아닙니다.

```bash
# deploy/.env (실제 인증 정보는 로컬 환경 파일에만 보관)
DATABASE_URL=postgres://user:pass@your-rds:5432/nudgeon
REDIS_URL=redis://your-elasticache:6379
CLICKHOUSE_URL=http://user:pass@your-ch-cloud:8123/nudgeon

# 앱만 기동 (DB는 외부)
docker compose -f deploy/compose.yaml --env-file deploy/.env --profile app up -d
```

- 검증 대상: RDS/Aurora PostgreSQL 15+, ElastiCache(Redis 7 호환), ClickHouse(자체/Cloud/Altinity). 현재 확정된 호환성 인증 목록은 아닙니다.
- 스키마 적용: `migrator` 서비스가 자동 실행. 수동은 `docker run nudgeon-worker /nudgeon-migrate /db`.

## 3. 스키마 마이그레이션

- **새 PostgreSQL DB**: `nudgeon-migrate`가 enum·기본 테이블을 만드는 `db/postgres/schema.sql`을 먼저 적용한 뒤 `db/postgres/upgrades/*.sql`을 이름순으로 재적용합니다.
- **기존 PostgreSQL DB**: 추가 컬럼을 참조하는 schema index보다 upgrade가 먼저 필요하므로 upgrades → schema 순서를 유지합니다.
- **ClickHouse**: `db/clickhouse/*.sql`을 이름순으로 적용합니다. 각 경로는 재실행 가능한 DDL을 전제로 하지만, 중단·부분 적용·동시 migrator는 별도 실패 복구 검증이 필요합니다.
- **프로덕션 준비 기준**: Atlas 선언적 스키마(`db/postgres/atlas.hcl`)와 추가형 upgrade 코드가 있습니다.
  앱 N ↔ 스키마 N-1 호환·혼합 버전·롤링/롤백 안전성은 실제 업그레이드 테스트로 확인해야 합니다.

## 4. 관찰성

- 구조화 JSON 로그(trace_id 전파). 워커 `:9090/metrics` Prometheus 지표(`nudgeon_<comp>_<metric>`):
  `nudgeon_ingest_events_processed_total`, `nudgeon_scheduler_sends_published_total`,
  `nudgeon_channel_sends_total{status}`, `nudgeon_worker_batch_errors_total{role}`.
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
