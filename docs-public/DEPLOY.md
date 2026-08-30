# Onda 배포 가이드

> Onda는 하나의 컨테이너 이미지 세트로 자체 서버부터 관리형 클라우드까지 배포합니다 (PRD-08).
> 배포 대상이 달라도 이미지는 같고, 차이는 오케스트레이션 매니페스트뿐입니다.

## 1. 빠른 시작 — 셀프호스팅 (Docker Compose)

```bash
git clone <repo> onda && cd onda
cp .env.example .env
# 필수: 마스터키 생성 (크리덴셜 봉투 암호화)
echo "ONDA_MASTER_KEY=$(openssl rand -base64 32)" >> .env

# 번들 DB + 앱 전체 기동 (PG16 · ClickHouse24 · Redis7 + api · console · worker)
docker compose -f deploy/compose.yaml --profile full --profile app up -d
```

- 콘솔: http://localhost:3000 · API: http://localhost:8080 · 워커 metrics: http://localhost:9090/metrics
- `migrator`가 스키마를 먼저 적용(멱등)한 뒤 api·worker가 기동합니다.
- 목표: `git clone` → `.env` → `up` → **15분 내 콘솔 온보딩** (M-7).

### 셀프호스팅 단일 테넌트 모드

`.env`에 `MODE=single_tenant`를 설정하면 가입 대신 **초기 관리자 셋업**으로 전환됩니다.
- `GET /v1/bootstrap/status` → `needs_setup` 확인
- `POST /v1/bootstrap/setup` (email·password·name) → 최초 1회 관리자 생성, 이후 잠금

## 2. 관리형 데이터 서비스 (RDS · ElastiCache · ClickHouse Cloud)

번들 DB 대신 외부 관리형 DB에 연결 — URL 교체만으로 지원됩니다 (12-Factor).

```bash
# .env
DATABASE_URL=postgres://user:pass@your-rds:5432/onda
REDIS_URL=redis://your-elasticache:6379
CLICKHOUSE_URL=http://user:pass@your-ch-cloud:8123/onda

# 앱만 기동 (DB는 외부)
docker compose -f deploy/compose.yaml --profile app up -d
```

- 지원 매트릭스: RDS/Aurora PostgreSQL 15+, ElastiCache(Redis 7 호환), ClickHouse(자체/Cloud/Altinity).
- 스키마 적용: `migrator` 서비스가 자동 실행. 수동은 `docker run onda-worker /onda-migrate /db`.

## 3. 스키마 마이그레이션

- **부트스트랩·재적용**: `onda-migrate`가 `db/postgres/schema.sql` + `db/clickhouse/*.sql`를
  멱등 적용(기존 객체 스킵). 관리형 DB 초기 셋업·컨테이너 재기동에 안전.
- **프로덕션 정식 마이그레이션**: PostgreSQL은 Atlas 선언적 스키마(`db/postgres/atlas.hcl`),
  expand-contract 규율로 앱 N ↔ 스키마 N-1 호환(롤링·롤백 안전).

## 4. 관찰성

- 구조화 JSON 로그(trace_id 전파). 워커 `:9090/metrics` Prometheus 지표(`onda_<comp>_<metric>`):
  `onda_ingest_events_processed_total`, `onda_scheduler_sends_published_total`,
  `onda_channel_sends_total{status}`, `onda_worker_batch_errors_total{role}`.
- 헬스: api `:8080/healthz`·`/readyz`, worker `:9090/healthz`.

## 5. 백업·복구

- **PostgreSQL**: WAL 아카이빙 또는 RDS 스냅샷.
- **ClickHouse**: `clickhouse-backup` → S3.
- **Redis**: AOF(everysec) 기본 구성 — 발송 멱등 키·dedup·frequency cap 카운터 보존.
  큐 자체는 재적재 가능하나 이 카운터들 때문에 완전 휘발은 중복 발송 0% 보장을 깨뜨림.
- **수집 최종 안전망**: `raw_ingestions`(CH, 30일) replay로 특정 구간 재처리.

## 5. 업그레이드

- 이미지 태그 교체 → `migrator`(expand) → 롤링 → (다음 릴리스에서 contract).
- N-1 스키마 호환 규율로 무중단 롤링·롤백. 마이너 버전 건너뛰기 금지.

## 6. 규모 가이드 (단일 노드)

- 유저 50만 · 토큰 100만 기준 권장: 8 vCPU / 32GB + NVMe (ClickHouse 볼륨 분리).
- 역할별 독립 스케일: `worker --role=channel`(발송 최다)을 별도 다수 기동.
- 성능 한계·스케일아웃 신호는 `docs/perf/`(부하 테스트 결과)를 기준선으로.
