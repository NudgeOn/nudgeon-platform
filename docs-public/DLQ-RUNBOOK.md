# DLQ 경보 대응 런북

`NudgeOnDLQEntries`는 PostgreSQL `send_dlq`에 **미해결 항목이 1건 이상** 있으면 발생한다.
최근 5분의 새 실패 수가 아니라 DB에 남은 항목을 기준으로 하므로, 첫 관측값이 1이거나
5분 동안 새 실패가 없어도 감지한다. 재처리 큐에 넣은 사실만으로 해결 처리하지 않는다.

## 0. 상태와 경보의 의미

| DB 상태 | 의미 | 미해결 경보에 포함 |
| --- | --- | --- |
| `resolved_at IS NULL`, `replayed_at IS NULL` | 확인·재처리가 필요한 항목 | 포함 |
| `resolved_at IS NULL`, `replayed_at IS NOT NULL` | 재처리 큐 발행 기록 있음, 최종 결과 미확인 | 포함 |
| `resolved_at IS NOT NULL` | 운영자가 결과 또는 승인된 폐기 근거를 확인하고 기록 | 제외 |

같은 키의 **새 실패 회차(`failure_id`)**에는 `created_at`이 갱신되고 재처리·해결 표시가 초기화된다.
같은 회차의 DB 저장 재시도는 갱신하지 않으므로, 응답 유실 후 재시도가 해결 기록을 되돌리지 않는다.
과거 `replayed_at`만 있는 행도 미해결로 남긴다. 결과를 확인하지 않은 자동 일괄 종료는 금지한다.

- `NudgeOnDLQCollectorFailure`: DB 조회 실패 또는 마지막 성공 후 15초 초과. 상태는 **미확인**이다.
  마지막 성공한 건수는 유지하고 성공 시각은 갱신하지 않는다. 첫 조회 전에는 건수 0을 내보내지 않는다.
- `NudgeOnDLQMonitorDown`: 전용 모니터를 scrape할 수 없다.
- `NudgeOnDLQMonitorMissing`: 모니터 target·신규 collector 메트릭·DB 식별 라벨 설정이 빠졌다.
- `NudgeOnWorkerBatchErrors`: 같은 워커 역할의 배치 오류가 지속된다. DLQ 건수와는 별도 경보다.

짧은 모니터 재시작 동안 `NudgeOnDLQEntries`를 유지하도록 `keep_firing_for: 1m`을 사용한다.
**1분을 넘는 관측 중단에서는 Entries의 resolved 알림이 올 수 있다.** 이 알림만으로 복구를 선언하지 말고
MonitorDown/CollectorFailure/Missing 해소와 새 DB 조회의 0건을 함께 확인한다.
Prometheus·Alertmanager 자체의 장애 및 원격 수신 실패는 별도 외부 감시가 필요하다.
규칙의 유지 시간은 [Prometheus alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)를 따른다.

이 경보는 **DB에 저장된** 미해결 항목을 관측한다. P0-2b에서는 push와 공통 SendLoop의 저장 오류를
전파하고, Redis `dlq_pending|...` 상태와 원본 queue pending을 유지하도록 수정했다.
재전달은 공급자 발송 없이 같은 `failure_id`의 DB 저장만 이어간다. DB 저장과 Redis 완료 상태가
확인된 뒤에만 종결 로그/ACK로 진행한다. 로그 저장 실패도 ACK를 막는다.

**아직 DB에 저장하지 못한 `dlq_pending`은 이 PG 건수 경보에 포함되지 않는다.**
`DLQ 저장/완료 실패 — pending 유지`, `DLQ 대기 상태 기록 실패 — pending 유지` 로그와
원본 큐의 미처리 상태를 별도 확인해야 한다. P0-4a의 별도 `ops-monitor`와
`NudgeOnDLQPendingStorage`가 Redis 저장/종결 대기를 관측한다.
[운영 감시 문서](OPERATIONS-MONITOR.md)의 소규모 순회 한도·stale/unknown 조건을 함께 확인한다.
DB 저장 후 Redis 종결만 실패한 항목도 포함되므로 PG 건수와 합산해 고유 실패 수로 보고하지 않는다.
Redis 상태 유실·eviction·미처리 stream trim까지 무손실을 보장하는 변경은 아니다.

## 1. 영향과 원인 확인

1. 경보의 `nudgeon_cluster`, `stream`, `failure_class`와 해당하는 경우 `role`을 기록한다.
2. 워커 로그에서 같은 시간대의 `idempotency_key`, 공급자 응답, 재시도 횟수를 확인한다. 크리덴셜과 토큰 원문은 기록하거나 공유하지 않는다.
3. 공급자 장애, 잘못된 크리덴셜, 계약 불일치, 데이터베이스·Redis 연결 실패 중 어느 경계인지 분리한다.

```sql
SELECT id, tenant_id, app_id, failure_class, attempts, created_at,
       replayed_at, resolved_at, resolution_note
FROM send_dlq
WHERE resolved_at IS NULL
ORDER BY created_at DESC
LIMIT 100;
```

## 2. 복구와 재처리

- 공급자·크리덴셜·계약 원인을 먼저 고친다.
- DB 저장 장애는 먼저 DB 접속/쓰기 권한/스키마를 복구한다. 새 worker가 원본 pending을 다시 받으면
  공급자를 호출하지 않고 기록 저장을 이어간다. 이미 저장된 같은 회차는 다시 덮어쓰지 않는다.
- 저장 대기 중에 수동 replay하거나 Redis의 멱등/attempt/대기 키를 지우지 않는다.
  `dlq_pending`은 만료 없이 유지하며, 저장 성공 후에만 7일짜리 종결 상태로 바뀐다.
  Redis 지속성·`noeviction`·큐 보존과 메모리 예산이 필요하다.
- 대상 테넌트, 원본 envelope 종류, 정확한 항목과 중복 발송 위험을 확인한다.
  현재 `cmd/dlq replay`는 **push 스트림 전용**이며 단건 키 조회도 tenant 범위로 제한되지 않는다.
  `--all`은 건수 제한이 없다. message/email 또는 다중 테넌트에 안전한 일반 복구 도구로 사용하지 않는다.
  이번 변경은 replay 라우팅·멱등 삭제·재발행 원자성을 수정하거나 검증하지 않았다.
- `replayed_at`, `message_log`, 공급자 ID, 수명주기 이벤트가 서로 일치하는지 대사한다.
- 동일 항목을 수동으로 여러 번 replay하지 않는다. 발송 결과 불명 상태는 중복 가능성을 먼저 평가한다.

검증을 마친 **한 행**만 명시적으로 완료 처리한다. `DATABASE_URL`은 비밀 관리 경로로 제공하고
명령·장애 기록에는 비밀번호, 토큰, 개인정보를 넣지 않는다. 아래 값은 조회 결과로 바꿔야 한다.

```sh
dlq list --tenant '<tenant UUID>' --limit 100
dlq resolve --tenant '<tenant UUID>' --id '<DLQ row UUID>' \
  --created-at '<list에 표시된 created 값, RFC3339Nano>' \
  --note '<결과 검증 또는 승인된 폐기 근거의 incident 참조>' --verified
```

`resolve`는 Redis나 공급자를 호출하지 않고 `resolved_at`과 `resolution_note`만 기록한다.
테넌트·행 ID·조회한 실패 시각이 모두 일치할 때만 성공한다. 조회 후 새 실패가 발생했거나
이미 완료한 행이면 실패하므로, 다시 조회하고 판단한다. `--verified`는 운영자 확인 선언이며
프로그램이 공급자·단말 수신을 자동 증명했다는 뜻이 아니다. 해결 기록은 새 실패 시 초기화되므로
장기 감사 증거는 별도 incident 기록에 보관한다.

## 3. 종료 조건

- 새 DLQ 유입이 15분 이상 없고, 미해결 항목이 0이다. 승인된 폐기 역시 근거를 남겨 개별 처리한다.
- DB 미저장 대기 작업도 없어야 한다. DB 건수 0만으로 원본 큐가 비었다고 판단하지 않는다.
- 재처리된 각 항목의 최종 상태가 `message_log`와 분석 저장소에 반영된다.
- collector 성공=1, 마지막 성공 후 15초 이내, 모니터 up=1을 확인한다.
- `NudgeOnDLQEntries`는 성공한 0건 조회 후 유지 시간과 알림 묶음 대기만큼 늦게 해제될 수 있다.
- 원인·영향 건수·복구 시각·재발 방지 작업을 장애 기록에 남긴다.

## 4. 배포 순서와 DB 부하 제한

1. 새 이미지·스키마를 준비하고 백업 및 락 영향을 검토한다. 기존 DB에는
   `db/postgres/upgrades/0005_dlq_resolution.sql`, `0006_dlq_failure_id.sql`의 additive 컬럼부터 적용한 후
   `schema.sql`의 `send_dlq_unresolved_idx`를 적용한다. 기존 bootstrap migrator는 이 순서를 따른다.
   큰 운영 테이블에서 기본 `CREATE INDEX`를 바로 실행하지 말고 별도 동시 인덱스 생성·락 예산을 검토한다.
2. push/message 소비자를 일시 중지하고 진행 중 호출이 끝난 뒤, 큐와 Redis 상태를 보존한 채
   **모든 해당 writer를 호환 버전으로 함께 교체**한다. 구버전과 신버전의 혼합 소비를 허용하지 않는다.
   구버전은 새 `dlq_pending` 상태를 종결 중복으로 오인해 ACK할 수 있다. 저장 대기가 남은 동안
   구버전으로 롤백하지 않는다. 새 상태로 복구·배수한 뒤 별도 롤백 계획을 검토한다.
   구버전 writer가 남은 동안 수동 resolve도 금지한다.
3. worker 바이너리를 **별도 `--role=dlq-monitor` 프로세스**로 실행한다. `all` 역할에 포함되지 않는다.
   이 역할은 PG만 사용하고 Redis·CH·공급자 키·발송 consumer를 시작하지 않는다.
4. 전용 DB 계정에 연결·schema 사용·`send_dlq` SELECT만 부여하고 monitor의 DATABASE_URL에 연결한다.
   Compose는 `DLQ_DATABASE_URL`로 모니터의 계정을 별도 지정할 수 있다. 미지정 시 기존 DB URL을
   공유하므로 운영에서는 전용 읽기 계정으로 분리한다.
5. [Prometheus 설정 예시](../deploy/observability/prometheus.example.yml)와
   [규칙](../deploy/observability/alerts.yml)을 로드하고 실제 수신 채널을 설정·시험한다.
   `dlq_monitor="true"`, `nudgeon_cluster="해당 DB의 고유 ID"` 라벨이 필요하다.

관측자는 연결 최대 **1개**, 읽기 전용 세션, 5초 간격, 쿼리/연결 timeout 2초를 사용한다.
`/metrics`에서는 DB를 조회하지 않는다. 미해결 부분 인덱스는 완료 이력을 제외하지만,
미해결 건수 집계 자체는 backlog 크기에 따라 비용이 증가한다. collector duration/error와
DB 쿼리 계획을 검토하며 timeout을 없애거나 연결만 늘려 문제를 숨기지 않는다.

같은 DB의 복제 관측자는 경보에서 `max by (nudgeon_cluster, stream, failure_class)`로 합산 중복을 막는다.
서로 다른 DB에 같은 cluster 라벨을 쓰면 안 된다. stream 4종×실패 분류 6종으로 라벨 수를 제한하고
알 수 없는 값은 `unknown`으로 합친다. 사용자·기기·tenant ID·오류 원문은 메트릭 라벨에 넣지 않는다.
누적 `nudgeon_channel_dlq_entries_total`은 추세용이며 미해결 건수 대신 사용하지 않는다.
Gauge·초기값·bounded label 원칙은 [Prometheus instrumentation](https://prometheus.io/docs/practices/instrumentation/)을 참조한다.

## 5. 로컬 재현

[격리 DLQ 경보 시험](../tests/ops/dlq/README.md)은 새로 컴파일한 모니터/CLI, 실제 PostgreSQL,
Prometheus, Alertmanager, 로컬 webhook으로 검증한다. 공급자 발송 및 운영 알림 수신 증거는 아니다.
기존 로컬 부하 시험 결과를 갱신하거나 지속 TPS가 향상됐다고 판단하지 않는다.

[저장 실패 회귀](../tests/ops/dlq-storage/README.md)는 실제 PG/Redis와 같은 worker batch/ACK 경로를
실행한다. 시험용 공급자와 로그 sink를 사용하므로 실제 발송·ClickHouse·자연 reclaim 주기 검증은 아니다.
결과는 [P0-2b QA](DLQ-STORAGE-QA-2026-09-03.md)를 참조한다.

[운영 관측 시험](../tests/ops/capacity/README.md)은 PG 원장/outbox 대기, Redis 저장/종결 대기,
관측 실패·한도 초과·프로세스 중단을 실제 로컬 webhook까지 검증한다.
이는 [P0-4a QA](OPS-MONITOR-QA-2026-09-03.md)이며 기간별 EPS/SQL/CH 계측은 P0-4b에 남는다.
