# I-6 백업·복구 리허설

```sh
scripts/backup.sh <dir>                       # 실행 중 스택 백업 (PG pg_dump -Fc, CH 테이블별 Native, Redis RDB)
scripts/restore.sh <dir>                      # 마이그레이션만 적용된 빈 스택에 복원 (대상 컨테이너는 환경변수로)
node tests/ops/backup-restore/run.mjs         # 리허설: 백업 → 빈 스택(별도 compose 프로젝트·볼륨·포트 25433/28123/26379/28080) → 복원 → 대조
```

## 무엇을 대조하는가

- PostgreSQL 28개 테이블 행 수, ClickHouse 원본 10개 테이블 행 수.
- 계측 MV 대상(`usage_sends_daily`·`usage_active_users_daily`)은 덤프하지 않는다 — 복원 시 원본 테이블 INSERT가 MV를 다시 태워 채운다. 복원 쪽 MV가 복원 `message_log`와 정확히 일치하는지 본다. 원본 쪽 불일치(원본에서 `message_log`가 지워진 뒤 남은 집계)는 드리프트로 기록한다.
- Redis 키 수. appendonly가 켜진 Redis 7은 AOF가 없으면 `dump.rdb`를 무시하므로, 임시 `appendonly no` 서버로 RDB를 올린 뒤 AOF로 다시 쓰고 원래 컨테이너를 띄운다.
- **원본에서 발급한 세션 쿠키로 복원 API 호출**(sessions·members·tenants가 함께 왔다는 증거)과 **복원 워커가 같은 `NUDGEON_MASTER_KEY`로 크리덴셜을 복호화·재검증**(verified 유지, 복호화 오류 0).

## 2026-09-10 실측 (로컬 docker, PG 78k행 · CH 19.7k행 · Redis 19.5k키)

| 단계 | 시간 |
|---|---|
| 백업 | 6s |
| 빈 스택 기동 + 마이그레이션 | 9s |
| 복원 (PG·CH·Redis) | 14s |
| api·worker 기동 → healthz | 3s |
| **RTO 합계** | **26s** |

RPO = 마지막 백업 시각(이 절차는 스냅샷이다). WAL 아카이빙·CH 증분 백업은 아직 없다.

## 경계

- 같은 호스트의 docker에서 한 리허설이다. 다른 서버·관리형 DB(RDS·ClickHouse Cloud)로의 복원은 미실행.
- 마스터키는 백업에 들어가지 않는다. 키 없이 복원하면 크리덴셜만 못 풀고 나머지는 동작한다.
- 백업 도중 들어온 쓰기는 PG(단일 pg_dump 스냅샷)·CH(테이블별 순차 덤프)·Redis(BGSAVE 시점) 사이에 시점이 다를 수 있다. 정지 시점 백업이 필요하면 api·worker를 먼저 멈춘다.
