# 접수·분석 처리량 계측 — P0-4b

HTTP 요청 수, 새로 저장된 이벤트 수, 분석 반영 완료 수를 별도로 측정한다.
`/v1/track`의 기존 응답 `accepted`는 제출한 배치 크기다. 중복을 뺀 처리량으로 사용하지 않는다.

## 계측 경계

| 지표 | 증가하는 시점 | 포함하지 않는 것 |
| --- | --- | --- |
| `nudgeon_api_track_started_total` | POST track 요청이 JSON 파싱·인증·종료 gate 전에 도착 | 네트워크에 도착하지 못한 발생기 드롭 |
| `nudgeon_api_track_completed_total{status_class}` | 서버 응답 finish | 클라이언트가 실제 읽었다는 보장 |
| `nudgeon_api_track_aborted_total` | finish 전 소켓 close | DB transaction 취소 보장; 이후 commit될 수 있음 |
| `nudgeon_api_receipts_committed_total` | PG receipt/outbox COMMIT 성공 응답 후 새 고유 이벤트만 | 배치 내 중복, 기존 ID 재전송, rollback된 시도 |
| `nudgeon_api_receipt_duplicates_total` | 성공한 transaction의 제출 수 − 새 원장 수 | 실패한 transaction |
| `nudgeon_api_receipt_retries_total` | 재시도 가능한 DB/identity 오류 후 다음 transaction | 고유 실패 이벤트 수 |
| `nudgeon_ingest_receipts_projected_total` | 동기 CH 저장 후 PG projection marker/outbox COMMIT 성공 | CH 저장만 성공한 상태, 실패·삭제·이미 반영된 재전달 |
| `nudgeon_ingest_clickhouse_rows_acknowledged_total{table}` | 동기 CH insert 성공 | 고유 이벤트라는 보장; 재시도·미러 행을 따로 포함 |

`track_inflight`와 `track_duration_seconds{outcome}`는 finish/close 중 먼저 발생한 것을 한 번만 센다.
API의 `/metrics`, readiness, 임의 URL은 track RPS를 늘리지 않는다.
기존 `nudgeon_ingest_events_processed_total{tenant}`도 COMMIT 후로 옮겼다.
과거에는 저장 전 준비 단계에서 증가했으므로 **구버전·신버전 구간을 같은 의미로 비교하지 않는다.**
새 계측은 사용자·테넌트·URL·SQL·오류 문자열을 라벨로 넣지 않는다.

카운터는 프로세스 재시작 시 초기화된다. DB COMMIT은 됐으나 응답이 끊겼거나,
COMMIT 직후 프로세스가 죽으면 카운터는 과소 집계될 수 있다. 카운터를 원장으로 쓰지 않는다.
최종 판정에는 발생기의 ID/journal, PG receipt, CH 고유 ID와 **물리 행 수**, 실제 관리 API 조회를 대조한다.
CH 재시도 물리 중복을 `FINAL`, `OPTIMIZE FINAL`, `uniq`로 숨겨 통과시키지 않는다.

## 시간과 병목

- API `receipt_stage_seconds{stage,outcome}`: `pool_acquire`, `begin`, `advisory_lock`,
  `cursor_lock`, `profile_lock`, `sql`, `commit`, `rollback`. 실패 시도도 별도 outcome으로 기록한다.
- API `pg_pool_connections{state}`: `total`, `idle`, `waiting`을 pool 메모리에서 읽는다.
  이는 track 전용 pool이 아니라 API 전체 공유 pool이다. scrape가 DB 쿼리를 만들지 않는다.
- worker `projection_stage_seconds`: `transaction`, `pool_acquire`, `begin`, `cursor_lock`,
  `profile_lock`, `sql`, `commit`. transaction은 CH 저장까지 포함하므로 하위 stage와 합산하지 않는다.
- worker `clickhouse_insert_seconds{table,outcome}`: prepare → append → 동기 send 시간.
  `events`, `profiles_mirror`, `user_merges`, `attr_changes`, `ingestion_errors`, `other`만 사용한다.

lock이라는 stage도 **쿼리 전체 왕복 시간**이다. 네트워크·서버 실행을 뺀 순수 lock wait로 부르지 않는다.
worker의 SQL 계측은 projection transaction 범위이며 profile mirror 조회나 모든 worker SQL을 포괄하지 않는다.
고객 cursor → profile → CH → PG COMMIT 순서를 그대로 유지한다. 삭제 안전성을 위해 CH 저장 중
cursor lock을 해제하지 않았다. Postgres 성능 스킬의 짧은 lock 원칙보다 기존 데이터 보존 계약을 우선했다.

`receipt_to_projection_seconds`는 **PG의 COMMIT 전 received_at → worker의 COMMIT 후 관측 시각**이다.
원장 commit→projection commit의 정확한 지연이 아니다. 서로 다른 서버의 시계가 동기화되어야 하며,
음수는 histogram에 넣지 않고 `projection_clock_skew_total`로 기록한다. 양수 시계 오차까지 검출하지는 못한다.
따라서 이 지표만으로 설계의 commit→commit p99 SLO를 합격 처리하지 않는다.

예시 PromQL (운영망에서 별도 scrape 설정 후):

```promql
sum(rate(nudgeon_api_receipts_committed_total[1m]))
sum(rate(nudgeon_ingest_receipts_projected_total[1m]))
histogram_quantile(0.99, sum by (le, stage) (rate(nudgeon_api_receipt_stage_seconds_bucket{outcome="success"}[5m])))
```

합산할 instance/cluster 범위를 명시하고 `up`·관측 누락·재시작도 함께 확인한다.
10초 기능 검증을 1분 rate로 환산하여 최대 처리량이라고 보고하지 않는다.
정확한 시험 구간은 발생기 입력 시간 안의 snapshot 차이와 별도 배수 시간으로 기록한다.
API/worker scrape는 원자적 동시 snapshot이 아니므로 두 scrape의 시간 폭도 남긴다.
히스토그램 p99는 bucket 기반 추정이며 정확한 개별 요청 p99나 commit-to-commit 시각이 아니다.
[Prometheus histogram 설명](https://prometheus.io/docs/practices/histograms/)을 따른다.

## 실행과 안전

### API 키 사용 시각 쓰기 예산 — P1-2a

`API_KEY_USAGE_COALESCE_ENABLED=true`는 **인증을 캐시하지 않는다**. 키 해시 조회,
폐기·회전 만료·scope 확인은 요청마다 수행한다. `last_used_at` 표시 정보만 DB 시각 기준
60초 이상 오래됐을 때 갱신하고, API 프로세스당 동시 작업 2개·같은 키 1개로 제한한다.
60초는 매번 지켜지는 기록 보장 시간이 아니다. 예산 초과·DB 실패 시 기록을 건너뛰며,
다음 유효 요청이 재시도한다. 감사·정확한 최근 접속 판단에는 사용하지 않는다.
다중 API의 동시 갱신도 DB UPDATE 조건으로 다시 검사한다. 해당 행 갱신 간의 대기와
조건 재평가는 [PostgreSQL READ COMMITTED 동작](https://www.postgresql.org/docs/16/transaction-iso.html)을 따른다.

기본값과 롤백은 `false`다. 이때 기존 요청별 비동기 갱신을 유지한다. 기존 실행 서비스에는
자동 적용하지 않으며, 별도 설정·재배포가 필요하다. 풀 크기는 여전히 10이다.

- `nudgeon_api_key_usage_total{outcome}`: `recent`, `coalesced`, `budget`는 쓰기 생략 결정,
  `scheduled`는 예약 수, `updated`, `noop`, `error`는 완료 결과다. 전체 outcome 합계는 요청 수가 아니다.
- `nudgeon_api_key_usage_pending`: 풀 대기를 포함한 미완료 작업 수. enabled일 때만 최대 2다.
- `nudgeon_api_key_usage_write_seconds{outcome}`: 풀 획득부터 UPDATE/autocommit 응답까지의 시간.
  인증 SELECT나 이벤트 원장 저장 시간을 포함하지 않는다. 키·고객·오류 문자열 라벨은 없다.

[격리 전후 비교 방법](../tests/ops/api-capacity/README.md).

### 계측 listener와 빌드 식별

API는 `METRICS_PORT`를 설정하지 않으면 계측 listener를 열지 않는다.
설정 시 기본 host는 `127.0.0.1`이다. 컨테이너 운영망에서만 `METRICS_HOST=0.0.0.0`과
별도 포트(예: 9091)를 사용하고, 외부 공개 ingress/host port에 연결하지 않는다.
주 API 포트의 `/metrics`는 제공하지 않는다. 별도 listener는 GET `/metrics`만 제공하며
연결 16개, HTTP 읽기/유휴 시간 5초 한도와 종료 시 모든 소켓 정리를 적용한다.

Node 계측은 고정 버전 `@prometheus-io/client@0.16.1`을 사용한다.
[Prometheus 공식 Node client](https://github.com/prometheus/client_js)의 Registry/Counter/Histogram을 이용한다.
특정 route 집계와 pool 상태만 export하며 기본 process metric 수집은 추가하지 않았다.

API와 worker 전체 Dockerfile에 `BUILD_REVISION`, `BUILD_SOURCE_SHA256`을 전달한다.
worker에는 `BUILD_DIRTY`도 전달한다. 빌드 라벨과 실제 metrics의 source SHA, 실행 image ID를 함께 확인한다.
HEAD만으로 dirty source를 증명하지 않는다. 로컬 RepoDigests가 있어도 registry 게시·cosign 서명은 아니다.

[격리 실행 방법](../tests/ops/projection/README.md). 전체 흐름 검증 스킬에 따라 readiness,
scrape 성공, 접수, 분석 저장, 인증된 사용자 활동 조회를 각각 확인한다.
공급자 발송·단말 수신, Journey 전체, 관리형 DB·백업·24시간 soak·최대 TPS는 범위 밖이다.
