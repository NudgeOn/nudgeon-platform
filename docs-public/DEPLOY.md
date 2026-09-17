# NudgeOn 배포 가이드

> NudgeOn는 동일한 versioned image 세트를 자체 서버와 관리형 클라우드에 배포하는 구조를 목표로 합니다 (PRD-08).
> 현재 Safe Boot Preview는 저장소 소스를 로컬에서 빌드하므로 이 release-image 목표를 달성했다는 증거는 아닙니다.

> **2026-09-17 검증 경계:** Safe Boot는 DB 비밀번호 설정·최초 관리자 계정·로그인·선택형 OTP 안내를 제공합니다. 현재 저장소 소스를 로컬에서 빌드하며, Test Inbox·versioned release image·clean-host 출시 증거는 아직 없습니다. 관리형 DB 실연결, 백업 복원·부하·롤백도 별도 출시 게이트입니다. [현재 출시 체크리스트](RELEASE-CHECKLIST.md)를 함께 확인하세요.

## 1. 빠른 시작 — Safe Boot Preview

NudgeOn는 Apache-2.0 Open Source의 소유권·검토 가능성을 유지하면서, 기본 셀프호스팅 시작을 한 명령으로 줄이는 방향입니다. 현재 Safe Boot Preview는 Docker Engine, Compose v2, OpenSSL, cURL이 준비된 로컬 환경에서 다음처럼 실행합니다.

```bash
git clone https://github.com/NudgeOn/nudgeon-platform.git
cd nudgeon-platform
./nudgeon up
```

명령은 호스트 전용 `.nudgeon/`에 설치 ID와 시크릿을 원자적으로 만들고, 전용 `deploy/compose.safe.yaml`을 사용해 setup shell과 gateway를 먼저 엽니다. 처음 설치할 때는 터미널의 링크를 열어 DB 비밀번호를 저장한 뒤 나머지 서비스를 빌드·기동합니다. 터미널을 닫지 말고 위자드를 진행하세요. 개발 seed는 넣지 않으며 PostgreSQL·ClickHouse·Redis·API·worker·console은 호스트 포트를 열지 않습니다. 기본 진입점은 gateway 하나인 <http://localhost:8080/setup>입니다.

### 위자드에서 처음부터 대시보드까지

1. **DB 비밀번호**: 추천 비밀번호(암호학적 난수 24바이트, 48자리)를 생성하거나 직접 입력합니다. 12~128자이며 공백·특수문자·한글을 허용하고 제어 문자는 허용하지 않습니다. **비밀번호 파일 다운로드**로 선택한 값과 DB 사용자/DB 이름을 JSON 파일에 저장할 수 있습니다. 파일에는 평문 비밀번호가 들어 있으니 안전한 곳에 보관하세요.
2. **서비스 준비**: **이 비밀번호로 설치 시작**을 누르면 CLI가 값을 받아 PostgreSQL의 첫 기동 전에 적용하고 나머지 서비스를 자동으로 시작합니다. 상태 API는 비밀번호를 반환하지 않습니다. 설치 후 비밀번호는 서버의 `.nudgeon/secrets/postgres_password`에 보관되며 기존 설치에는 이 단계를 다시 표시하지 않습니다.
3. **관리자 계정 만들기**: 링크의 설치 코드를 확인한 뒤 워크스페이스·첫 앱·관리자 이름·**로그인 이메일과 로그인 비밀번호**를 설정합니다. DB 비밀번호와 콘솔 로그인 비밀번호는 별개입니다.
4. **로그인**: 완료 화면의 **만든 계정으로 로그인하기**를 눌러 방금 만든 계정으로 접속합니다. SDK/Server Key는 완료 화면에서 한 번만 표시되므로 별도로 보관하세요.
5. **OTP(선택)**: 인증 앱에 키를 등록하고 6자리 코드로 활성화한 뒤 백업 코드를 보관하거나, **지금은 건너뛰고 대시보드로**를 선택합니다. 나중에도 앱 설정에서 켤 수 있습니다. 조직이 2FA를 강제하는 경우에는 기존 필수 등록 정책이 우선합니다.
6. **메인 대시보드**: 로그인한 대시보드에 도착합니다. 앱 연결은 대시보드의 시작 안내에서 이어갈 수 있고 온보딩에서도 건너뛰기가 가능합니다. 실제 푸시에는 SDK·FCM/APNs·테스트 기기 연결이 추가로 필요합니다.

자동화 환경은 최초 실행에 `./nudgeon up --defaults`를 사용합니다. DB 비밀번호는 자동 생성되어 서버 시크릿 파일에 저장됩니다. 이미 웹 설정을 시작한 설치는 `--defaults`로 덮어쓰지 않으며 `./nudgeon up`으로 재개합니다. 기존 DB의 비밀번호 변경/회전 기능은 아닙니다.

**설치 소유권 확인 → 관리자 로그인 계정.** `./nudgeon up` 실행 중 터미널에 **설치 코드가 붙은 URL**(`/setup#token=…`)이 표시됩니다. 그 링크로 들어가면 setup 화면이 코드를 URL에서 지우고 API와 교환해 15분짜리 Bootstrap 세션을 얻고, 워크스페이스·첫 앱·Owner를 한 트랜잭션으로 만든 뒤 초기 설정을 완료합니다(설치 코드 폐기, 이후 신규 bootstrap 요청은 410). SDK/Server Key는 그 화면에서 한 번만 보입니다. `MODE=single_tenant`에서는 설치 전후 모두 `/v1/auth/signup`이 404입니다.

- 코드를 다시 보려면 `./nudgeon setup-url --token`, 분실·유출 시 `./nudgeon setup-token rotate`(이전 코드와 진행 중 claim 즉시 폐기).
- 원격 서버에서는 평문 HTTP claim이 거부됩니다 — gateway가 `127.0.0.1`에만 바인딩된 상태에서 SSH 터널(`ssh -L 8080:localhost:8080`)로 접속하거나, TLS reverse proxy(`X-Forwarded-Proto: https`) 뒤에 두세요.
- 2026-09-10 실측: 깨끗한 clone → `./nudgeon up` → 코드 링크 → Owner 생성까지 약 3분. API E2E `tests/e2e/bootstrap-claim.mjs`(동시 claim 1 lease, rotate, 동시 setup 1 Owner + 멱등 replay, 잠금 410, signup 404) 27건 통과.

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
- Slice B(설치 claim·최초 Owner 원자 생성·Bootstrap 영구 잠금)는 구현됐습니다. recovery bundle export(`./nudgeon secrets backup`)와 master key fingerprint 안내도 제공합니다.
- NudgeOn Test Inbox와 재개 가능한 activation은 **Slice C·D**입니다. 초기 설정 후 로그인·선택형 OTP를 거쳐 대시보드로 이동합니다. 앱 연결은 콘솔 온보딩 위저드(4단계)에서 진행합니다.
- Docker Compose config·단위 테스트나 한 환경의 기동만으로 clean Linux/arm64 지원, production readiness, 백업·복구를 입증하지 않습니다.

전체 목표 계약과 Slice별 상태는 [P0 Docker Setup Wizard PRD](DOCKER-SETUP-WIZARD-PRD.md)에 정리되어 있습니다.

### Docker 설치 방식: 현재와 이미지 배포 계획

현재 `./nudgeon up`은 Docker Compose의 `up --build`로 NudgeOn 서비스를 소스에서 빌드합니다. PostgreSQL·ClickHouse·Redis·Nginx는 기존 배포 이미지를 내려받습니다. Docker로 실행되지만, NudgeOn의 배포된 이미지만 내려받는 설치 방식은 아직 아닙니다.

이미지 배포 방식의 목표는 **버전이 지정된 이미지 다운로드 → 컨테이너 시작 → DB 비밀번호·관리자 계정·선택형 OTP 설정 → 로그인한 대시보드**입니다. 사용자 서버에서 NudgeOn 소스를 컴파일하는 과정이 없어지고, 기존 설치 위자드는 그대로 사용합니다. Docker Engine과 Compose는 계속 필요합니다.

이미지 다운로드만으로 설치하려면 다음 작업이 남아 있습니다.

1. **릴리스 이미지 구성 완성:** API·콘솔·worker와 함께 설치 위자드용 `setup-status` 이미지를 배포합니다. 마이그레이터는 worker 이미지에 포함된 바이너리를 사용하고, 콘솔은 gateway 경로인 `/api`를 사용하도록 빌드합니다.
2. **설치 명령 전환:** 버전이 지정된 레지스트리 이미지를 받도록 Compose와 `./nudgeon up`을 연결하고, 서버에서 소스를 빌드하지 않는 설치 경로를 제공합니다.
3. **새 환경 검증:** 배포된 이미지 접근과 다운로드, 서비스 준비, 위자드, 로그인·대시보드 진입을 새 환경에서 확인합니다. 검증 후 홈페이지에 실행 가능한 이미지 설치 명령을 안내합니다.

2026-09-17 확인 기준으로 GitHub 릴리스와 `release.yml` 실행 이력은 각각 0건입니다. 현재 안내된 빠른 시작 명령은 위의 소스 빌드 방식을 사용합니다.

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

기존 수동 Compose에서 `.env`에 `MODE=single_tenant`를 설정하면 가입이 닫히고 설치 claim 경로만 남습니다. 설치 코드는 `NUDGEON_SETUP_TOKEN`(또는 `_FILE`)으로 API에 넘깁니다(예: `openssl rand -hex 32`). 콘솔이 아니라 setup 화면(Safe Boot의 gateway `/setup`)이 필요하므로, 수동 Compose에서는 API를 직접 호출합니다:
- `GET /v1/bootstrap/status` → `state`(`unclaimed`·`claimed`·`secured`), `setup_token_configured`
- `POST /v1/bootstrap/claim` `{token}` → Bootstrap cookie(15분)
- `POST /v1/bootstrap/setup` + `Idempotency-Key` + cookie → Owner·워크스페이스·앱 원자 생성, 잠금

## 2. 관리형 데이터 서비스 (RDS · ElastiCache · ClickHouse Cloud)

번들 DB 대신 외부 데이터 서비스를 지정하는 설정 경로가 있습니다. URL 외에 TLS·인증·네트워크·DB 권한·버전 호환성을 실제 환경에서 검증해야 합니다. 현재 app 단독 Compose config 통과는 실서비스 연결 증거가 아닙니다.

```bash
# deploy/.env (실제 인증 정보는 로컬 환경 파일에만 보관)
DATABASE_URL=postgres://user:pass@your-rds:5432/nudgeon?sslmode=verify-full
REDIS_URL=rediss://user:pass@your-elasticache:6379
CLICKHOUSE_URL=https://user:pass@your-ch-cloud:8443/nudgeon

# 앱만 기동 (DB는 외부)
docker compose -f deploy/compose.yaml --env-file deploy/.env --profile app up -d
```

- 검증 대상: RDS/Aurora PostgreSQL 15+, ElastiCache(Redis 7 호환), ClickHouse(자체/Cloud/Altinity). 현재 확정된 호환성 인증 목록은 아닙니다.
- 스키마 적용: `migrator` 서비스가 자동 실행. 수동은 `docker run nudgeon-worker /nudgeon-migrate /db`.
- 실제 제공자가 안내한 호스트·포트·인증서 체인을 사용합니다. 사설 CA는 해당 프로세스가 신뢰하도록 마운트·설정해야 하며 인증서 검증을 끄지 않습니다. PG의 `sslrootcert` 경로는 호스트 경로가 아니라 **컨테이너 안의 경로**입니다. API(Node)와 워커·migrator(Go) 모두에서 검증합니다.
- API의 `PG_CONNECT_TIMEOUT_MS` 기본값은 5,000ms입니다. 새 PG 연결과 풀 대기 시간을 제한하며 SQL 실행 시간 제한이나 트랜잭션 재시도 설정은 아닙니다. 유휴 연결이 끊어지면 `postgres_idle_connection_lost`를 기록하고 다음 요청에서 새 연결을 만듭니다. 진행 중이던 요청의 성공을 보장하지 않습니다.
- [로컬 TLS·재연결 회귀 시험](../tests/ops/postgres-recovery/README.md)은 기존 풀의 종료 문제와 수정 후 재연결, 잘못된 CA·호스트명·비밀번호 거부를 확인합니다. 실제 관리형 DB의 failover·DNS 전환·복구 검증을 대체하지 않습니다.

## 3. 스키마 마이그레이션

- **새 PostgreSQL DB**: `nudgeon-migrate`가 enum·기본 테이블을 만드는 `db/postgres/schema.sql`을 먼저 적용한 뒤 `db/postgres/upgrades/*.sql`을 이름순으로 재적용합니다.
- **기존 PostgreSQL DB**: 추가 컬럼을 참조하는 schema index보다 upgrade가 먼저 필요하므로 upgrades → schema 순서를 유지합니다.
- **적용 기록과 직렬화 (PostgreSQL)**: migrator는 세션 advisory lock을 잡고 시작하므로 레플리카 여러 개가 동시에 기동해도 한 번에 하나만 스키마를 만집니다(뒤의 것은 "다른 migrator가 실행 중 — 완료를 기다린다"를 찍고 대기). 각 upgrade 파일은 `schema_migrations(filename, checksum, applied_at)`에 기록되며 같은 체크섬이면 다음 기동에서 건너뜁니다. upgrade 하나가 중간에 실패하면 기록이 남지 않고 다음 실행이 그 파일을 처음부터 다시 적용합니다 — upgrade 문은 여전히 재실행 가능해야 합니다.
- **적용된 upgrade는 수정하지 않습니다**: 파일 내용이 기록된 체크섬과 다르면 migrator는 파일명을 지목하며 실패합니다. 다른 설치본은 옛 내용을 적용했기 때문입니다. 고칠 것이 있으면 새 번호의 파일을 추가합니다. 개발 DB에서만 `MIGRATE_REAPPLY_DRIFTED=1`로 재적용을 허용합니다.
- **ClickHouse**: `db/clickhouse/*.sql`을 이름순으로 매번 재적용합니다. 적용 기록·락이 없으므로 재실행 가능한 DDL이어야 하며, 동시 migrator는 PG 락이 앞단에서 직렬화합니다(같은 프로세스가 PG 다음에 CH를 돌립니다).
- **프로덕션 준비 기준**: Atlas 선언적 스키마(`db/postgres/atlas.hcl`)와 추가형 upgrade 코드가 있습니다.
  앱 N ↔ 스키마 N-1 호환·혼합 버전·롤링/롤백 안전성은 실제 업그레이드 테스트로 확인해야 합니다.

## 4. 관찰성

- 구조화 JSON 로그(trace_id 전파). 워커 `:9090/metrics` Prometheus 지표(`nudgeon_<comp>_<metric>`):
  `nudgeon_ingest_events_processed_total`, `nudgeon_scheduler_sends_published_total`,
  `nudgeon_channel_sends_total{status}`, `nudgeon_worker_batch_errors_total{role}`.
- 헬스: api `:8080/healthz`·`/readyz`, worker `:9090/healthz`.
- 자동 복구: `compose.yaml`·`compose.safe.yaml` 모두 장기 실행 서비스(postgres·clickhouse·redis·api·worker·dlq-monitor·console)에 `restart: unless-stopped`가 걸려 있다. 워커는 DB 연결이 끊기면 스스로 종료하는데(예: PG `i/o timeout`), 이 정책이 없으면 그대로 멈춘 채 남는다 — 2026-09-08 로컬에서 36시간 방치된 사례. `migrator`만 일회성이라 `restart: "no"`.

## 5. 백업·복구

```sh
scripts/backup.sh /backups/$(date +%F)     # PG(pg_dump -Fc) + CH(테이블별 Native) + Redis(RDB) + manifest.json
PG_CONTAINER=… CH_CONTAINER=… REDIS_CONTAINER=… scripts/restore.sh /backups/2026-09-10   # 마이그레이션만 적용된 빈 스택에
```

- 복원 순서: 빈 스택을 `up -d postgres clickhouse redis migrator`로 띄워 스키마를 만든 뒤 `restore.sh`, 그 다음 **같은 `NUDGEON_MASTER_KEY`로** api·worker를 띄운다. 마스터키는 DB 백업에 들어가지 않는다.
- **복구 번들(Safe Boot)**: `NUDGEON_RECOVERY_PASSPHRASE=… ./nudgeon secrets backup [file]`이 `.nudgeon`(마스터키·시크릿·설치 ID)을 AES-256-CBC(PBKDF2 60만회)로 내보낸다. DB 백업과 **다른 곳**에 보관한다. 빈 호스트에서는 `./nudgeon secrets restore <file>` → `./nudgeon up` → `scripts/restore.sh`. `./nudgeon doctor`는 번들을 한 번도 내보내지 않았으면 `CRIT`를 낸다. setup 화면과 `GET /v1/bootstrap/status`의 `master_key_fingerprint`가 번들의 것과 같아야 한다.
- 계측 MV 대상(`usage_*`)은 덤프하지 않는다. 복원 시 원본 테이블 INSERT가 MV를 다시 채운다.
- Redis(appendonly)는 `restore.sh`가 임시 `appendonly no` 서버로 RDB를 올린 뒤 AOF로 다시 쓴다. 큐·멱등 키·빈도 제한 상태가 복원되지만, 백업 시점 이후의 큐 항목은 PG outbox 재발행으로 메꿔지고 중복 발송 0%를 보장하지는 않는다.
- **2026-09-10 리허설**(`tests/ops/backup-restore/run.mjs`, 로컬 docker, PG 78k행·CH 19.7k행·Redis 19.5k키): 백업 6초, 빈 스택+복원+기동 26초. PG 28·CH 10 테이블 행 수 일치, 원본 세션 쿠키로 복원 API 200, 크리덴셜 17건 복호화·재검증. 다른 서버·관리형 DB로의 복원과 WAL 아카이빙·증분 백업은 아직 없다.
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
