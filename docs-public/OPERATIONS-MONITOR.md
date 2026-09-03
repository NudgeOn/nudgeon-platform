# 운영 대기량 감시 — P0-4a

이 감시는 **처리되지 않은 일이 쌓이는지, DLQ 저장/종결이 막혔는지** 확인한다.
TPS/EPS, 분석 조회 가능 시각, 발송·단말 수신을 측정하는 도구는 아니다.
별도 `--role=ops-monitor` 프로세스이며 `all`에 포함되지 않는다.
기존 `--role=dlq-monitor`의 PG-only 계약은 변경하지 않았다.

## 무엇을 구분하는가

| 접두사 `nudgeon_ops_` 뒤 지표 | 의미 | 주의 |
| --- | --- | --- |
| `postgres_projection_pending_count` | `projected_at IS NULL` 원장 수 | 분석 API 조회 결과 자체가 아님 |
| `postgres_matching_pending_count` | `matched_at IS NULL` 원장 수 | 저니/공급자 완료가 아님 |
| `postgres_outbox_pending_count` | `published_at IS NULL` 전체 outbox 수 | 여러 스트림이 포함되며 원장과 합산하지 않음 |
| `postgres_*_oldest_*_timestamp_seconds` | 각 대기의 가장 이른 DB 기록 시각 | `received_at`은 COMMIT 이전이므로 commit 지연으로 부르지 않음 |
| `pending_{push,message}_pending_observed_count` | 완주한 Redis 순회에서 관측한 고유 `dlq_pending` 키 수 | 단일 시점의 정확한 snapshot이 아님 |
| `pending_{push,message}_oldest_observed_timestamp_seconds` | 위 관측의 가장 이른 실패 시각 | 시계 오차를 고려해야 함 |
| `redis_used_memory_bytes`, `redis_maxmemory_bytes` | Redis 내부 메모리/설정 한도 | 컨테이너 RSS가 아니며 maxmemory 0은 무제한 |
| `redis_noeviction`, `redis_aof_enabled`, `redis_aof_last_write_ok` | 보존 정책·AOF 설정·마지막 쓰기 상태 | 백업·복원이나 유실 없음의 증거가 아님 |
| `redis_evicted_keys_count` | 서버 시작 후 eviction 누적값 snapshot | gauge이며 서버 재시작 시 초기화될 수 있음 |

`dlq_pending`에는 **DB 저장은 됐지만 Redis 종결이 확인되지 않은** 경우도 포함된다.
따라서 PG DLQ 수와 Redis pending 수를 합쳐 고유 실패 수라고 보고하면 안 된다.
이 관측은 기존 push 및 공통 SendLoop의 message 네임스페이스만 지원한다. 별도 email worker,
Redis Stream consumer group pending/trim/retention 전체, Redis Cluster는 지원 범위가 아니다.

실제 channel worker에는 `nudgeon_channel_dlq_operation_errors_total{stage}`가 추가된다.
고정 stage는 `marker`, `state`, `store`, `finalize`이고 **오류 시도 수**다.
같은 항목의 DB 저장이 3번 실패하면 store=3이다. 성공/재전달을 고유 실패 3건으로 세지 않는다.
카운터는 재시작 시 초기화되며 첫 scrape 이전 실패를 모두 증명하지 못하므로 보조 신호로 쓴다.

## 실행·권한·비용

1. 새 worker 이미지와 운영망에서 `--role=ops-monitor`를 별도 실행한다. API·CH·공급자 키는 불필요하다.
2. 전용 PG 계정에 DB CONNECT, schema USAGE, `event_receipts`/`journey_outbox` SELECT만 부여한다.
   `DATABASE_URL` 또는 `DATABASE_URL_FILE`로 전달한다. 이 프로세스의 pool은 최대 1개,
   `default_transaction_read_only=on`, `statement_timeout=2000`이다.
3. 독립 Redis DB의 읽기 전용 사용자 URL을 `REDIS_URL` 또는 `REDIS_URL_FILE`로 전달한다.
   명령 권한은 `PING`, `HELLO`, `AUTH`, `SELECT`, `INFO`, `SCAN`, `GETRANGE`와 클라이언트
   초기화용 `CLIENT SETNAME/SETINFO`다. 키 읽기는 `send:idem:*`, `send:message:idem:*`에 제한한다.
   SCAN은 키 이름을 열거하므로 관리용 계정/운영망으로 보호한다. 연결 상한 2개, 재시도 없음,
   연결/읽기/쓰기/pool/context timeout 2초다. 배포별 Redis 버전/ACL을 다시 시험한다.
4. `/metrics`, `/readyz`는 운영망에서만 접근하게 한다. 외부에 포트를 공개하지 않는다.
   [Prometheus 예시](../deploy/observability/prometheus.example.yml)와
   [ops 규칙](../deploy/observability/ops-alerts.yml)을 함께 로드한다.
   `ops_monitor="true"`, 설치별 고유 `nudgeon_cluster` 라벨이 필요하다.
5. PG DLQ 감시는 기존 `dlq-monitor`로 계속 운영한다. 실제 channel worker도 scrape해야 오류 카운터가 보인다.

세 collector(`postgres`, `pending`, `redis`)는 독립적으로 5초마다 읽는다.
한쪽 장애가 다른 쪽의 새 관측을 막지 않는다. `/metrics`와 `/readyz`는 캐시만 읽는다.
DB의 3개 집계는 하나의 SQL statement snapshot을 사용한다. 기존 부분 인덱스의 조건을 이용하되,
대기 건수 자체가 커지면 집계 비용도 늘어난다. timeout을 제거하지 말고 EXPLAIN과 실행 시간을 확인한다.
전용 pool·짧은 조회 예산은 Postgres 성능 스킬을 적용한 부분이다.
[PostgreSQL timeout 문서](https://www.postgresql.org/docs/16/runtime-config-client.html)는 이 제한의 기준이다.

Redis 순회는 호출 256회, COUNT 힌트 256, 수신 페이지 최대 1,024키, pending 키 최대 10,000개,
키 길이 1,024바이트, 값 읽기 최대 8,193바이트와 전체 2초 제한을 둔다.
중복 키는 중복 집계하지 않고, 빈 페이지라도 cursor가 남으면 계속한다.
순회가 완료되기 전에 어떤 제한/권한 오류/손상된 pending JSON을 만나도 전체 관측은 실패한다.
**이 방식은 소규모 호환 감시다. 큰 keyspace에서 한도를 늘려 5,000 EPS 감시로 사용하지 않는다.**
고부하 단계에서는 상태 전이와 원자적으로 갱신되는 인덱스 및 기존 marker 마이그레이션을 별도 설계·검증해야 한다.
SCAN은 원자적 snapshot이 아니며 COUNT는 엄격한 응답 크기 상한이 아니다.
[Redis SCAN](https://redis.io/docs/latest/commands/scan/)과
[GETRANGE](https://redis.io/docs/latest/commands/getrange/)의 의미를 따른다.

## 실패·경보·복구 판정

- 첫 조회 성공 전: 건수 자체를 내보내지 않고 `collector_success=0`이다. **0건이 아니다.**
- 조회 오류/손상/예산 초과: 마지막 성공 데이터를 유지하고 success=0, errors 증가, 성공 시각은 유지한다.
- 성공했어도 마지막 성공 시각이 15초보다 오래되면 readiness=503이다. 별도 stale 경보도 필요하다.
- `NudgeOnDLQPendingStorage`: PG DLQ가 0건이어도 Redis 저장/종결 대기 관측이 있으면 경보한다.
  `keep_firing_for: 1m`으로 짧은 scrape 누락/재시작 중 해제를 막는다. 완주 0건 후에도 최소 1분 지연될 수 있다.
- `NudgeOnDLQOperationErrors`: worker의 오류 시도 증가를 경보한다.
- `NudgeOnOpsCollectorFailure/MonitorDown/MonitorMissing`: 읽기 실패·관측 중단·불완전 설정을 경보한다.
- `NudgeOnPipelineBacklogAge`: 10초 초과 대기가 1분 지속되면 조사한다. 처리량 합격 기준을 대신하지 않는다.
- `NudgeOnRedisDurabilityRisk`: eviction 이력, noeviction/AOF 설정·쓰기 실패를 확인한다.
- `NudgeOnRedisMemoryPressure/MemoryUnbounded`: 80% 초과 2분 지속 또는 한도 미설정을 알린다.

카운트 경보의 resolved만으로 복구를 선언하지 않는다. 관측 프로세스·세 collector가 정상/신선한지,
1분이 넘는 관측 중단으로 경보가 해제된 것은 아닌지,
연속된 완주 관측과 PG 조회가 정상인지, 원본 큐·실제 처리 결과까지 맞는지 확인한다.
순회 중 생기거나 사라진 키는 일관된 단일 시점 집계가 아니므로 한 번의 0으로 전체 배수를 증명하지 않는다.
Redis 키 삭제·TTL 변경·수동 재발송은 이 observer의 기능이 아니며 자동 복구로 실행하지 않는다.

## 실행 이미지 증거와 남은 계측

`nudgeon_worker_build_info`는 revision, source_sha256, dirty, go_version을 노출한다.
빌드 인수를 넣지 않으면 `unknown`을 정직하게 표시한다. Git HEAD만으로 dirty 소스를 식별하지 않는다.
시험 runner는 source manifest, 바이너리 SHA-256, 새 로컬 image ID, 실행 컨테이너 image ID,
실제 `/metrics`의 소스 SHA를 대조한다. 로컬 image ID/RepoDigests 항목이 있어도 원격 레지스트리
게시·서명 증거가 되는 것은 아니다.

P0-4b의 HTTP 시작/완료·고유 접수/반영 EPS, SQL/pool/lock/COMMIT 및 CH 지연,
활동 조회 canary와 전체 API/worker 이미지 소스 검증은 [별도 계측](INGESTION-METRICS.md)에 구현했다.
[실대사 QA](PROJECTION-QA-2026-09-03.md)는 계측·ID 대사 통과, 부하 지연 게이트 실패로 구분한다.
이 작업만으로 G0/G1 또는 운영 TPS가 통과하지 않는다.

[로컬 재현](../tests/ops/capacity/README.md) / [QA 결과](OPS-MONITOR-QA-2026-09-03.md)
