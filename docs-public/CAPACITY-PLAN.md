# NudgeOn 처리량·장시간 안정성 설계

상태: **단계별 설계안 — P0-1·P0-2·P0-2b·P0-3 로컬 회귀 검증, 운영 성능 미검증** · 2026-09-03

P0-1 구현과 회귀 결과는 [발생기 QA](LOADGEN-QA-2026-09-03.md)를 참조한다.
P0-2의 첫 경보 13.633초·330초 미해결 유지·장애/종료 검증은 [DLQ QA](DLQ-QA-2026-09-03.md)를 참조한다.
P0-2b의 DB 저장 실패·응답 유실·안전한 ACK 회귀는 [저장 실패 QA](DLQ-STORAGE-QA-2026-09-03.md)를 참조한다.
P0-3의 실제 API 종료·시간 초과·PG 접수 보존 회귀는 [API 종료 QA](API-SHUTDOWN-QA-2026-09-03.md)를 참조한다.
이 문서의 단계별 목표와 후보 설정은 계속 설계값이며, 시험 실행 승인이나 성능 합격이 아니다.

## 먼저 알아야 할 결론

1. **100 TPS를 30분씩 두 번** 안정적으로 처리한다.
2. 그다음 **500 TPS를 1시간씩 두 번** 처리한다.
3. 1,000 → 2,000 → **5,000건/초**로 단계적으로 높인다.
4. 24시간 시험은 별도 단계다. **100 TPS로 하루를 통과해도 5,000 TPS로 하루를 통과한 것은 아니다.**

각 단계에서 오류·발생기 드롭이 없고, 응답·분석 반영이 제시간에 끝나며,
접수 원장과 실제 분석 결과가 같아야 한다. 부족한 자원을 숨기거나 이전 단계의
실패를 건너뛰어 다음 단계로 넘어가지 않는다. 500 TPS는 중간 검증 목표이며
원래의 5,000 ev/s 목표를 낮춰 대체하는 것이 아니다.

실제 고객의 최대 예상 트래픽은 아직 확인되지 않았다. 아래 수치와 트래픽 구성은
이번 프로젝트의 **제안된 검증 계약**이지 업계 공통 기준이나 고객 수용량 보장이 아니다.
현재 증거는 [로컬 QA 보고서](LOCAL-OPS-QA-2026-09-03.md)이며, 200 TPS/15초까지의 짧은 시험만 통과했다.
100 TPS/5분 시험은 실패했으므로 지속 처리량을 200 TPS라고 보장할 수 없다.

## 1. 무엇을 측정하는가

| 지표 | 정의 | 혼동하면 안 되는 것 |
| --- | --- | --- |
| HTTP RPS | 초당 시작/완료한 HTTP 요청. 두 값을 각각 기록 | DB SQL 실행 수와 다름 |
| 수집 EPS | 초당 성공 접수한 **고유 이벤트** 수 | 배치 크기나 재전송으로 부풀리지 않음 |
| 분석 반영 EPS | 원장 이벤트가 실제 분석 조회에 반영된 속도 | HTTP 202 응답만으로 증명하지 않음 |
| 발송 처리량 | 채널 작업 및 공급자 응답·단말 수신을 별도로 측정 | 수집 EPS를 FCM/APNs 발송 TPS로 표현하지 않음 |

이 문서의 기본 시험은 **배치 크기 1: 100 TPS = 100 RPS = 100 ev/s**다.
배치 크기 10의 500 RPS는 5,000 ev/s이지만 **5,000 HTTP TPS가 아니다**.
기본 시험과 배치 효율 시험의 결과를 따로 발표한다.
아래에서 고객사는 `tenant`, 사용자는 그 고객사의 앱 이용자 `user`를 뜻한다.
사용자별 이벤트 순서 보장을 고객사 전체의 전역 순서 보장과 혼동하지 않는다.

현재 `track()` 응답의 `accepted`는 입력 배치 길이이므로, 중복 재전송 때 이를 더해서
고유 접수 수로 사용하면 안 된다. `(tenant_id, app_id, insert_id)` 집합으로 센다.

## 2. 시험 단계와 합격 기준

실행 가능한 명령이 아닌 기계 판독용 설계 계약을
[test-plan.json](capacity/test-plan.json)에 함께 둔다. 현재 `run.mjs`는 이 파일을 읽지 않는다.

| 단계 | 측정 부하 · 기간 | 1회 이벤트 수 | 반복 / 선행 조건 |
| --- | --- | ---: | --- |
| G0 | 결함 회귀, 짧은 기능·용량 보정 | 고정 아님 | 아래 P0 작업 완료 |
| G1 | 100 RPS · 30분 | 180,000 | 연속 2회, G0 통과 |
| G2 | 500 RPS · 1시간 | 1,800,000 | 연속 2회, G1 통과 |
| G3a | 1,000 RPS · 10분 | 600,000 | 연속 2회, G2 통과 |
| G3b | 2,000 RPS · 10분 | 1,200,000 | 연속 2회, G3a 통과 |
| G3c | 5,000 RPS · 1시간 | 18,000,000 | 연속 2회, G3b 통과 |
| B5000 | 500 RPS × 10이벤트 · 1시간 | 18,000,000 | 배치 효율 별도 시험, G2 이후 |
| S100 | 100 RPS · 24시간 | 8,640,000 | 장시간 사전 점검, G2 이후, 별도 실행 승인 |
| S5000 | 5,000 RPS · 24시간 | 432,000,000 | 최종 지속 부하 목표, G3c·S100 및 자원 승인 후 |

각 회차는 60초 준비 구간을 별도 run ID로 실행·대사한다. 준비 구간과 종료 후 배수 시간은
측정 기간에 넣지 않는다. 반복 사이에 프로그램·DB를 초기화해 메모리 증가를 숨기지 않는다.
대표 혼합 부하 M1도 G1/G2/G3c의 동일 속도·기간으로 각각 1회 통과해야 그 단계의 자격을 얻는다.

### 정상 부하의 필수 게이트

- **발생기 드롭 0**, HTTP 오류·429·네트워크 오류·시간초과 **0**.
- 고유 이벤트의 예정 시각부터 응답 본문 확인까지 **p99 ≤ 500ms**.
  네트워크 서비스 시간과 발생기 큐 대기 시간을 분리해 함께 기록한다.
- 고정 측정 구간 `[T0,T1)` 안에서 완료한 성공 접수 속도 ≥ 목표의 **99%**.
  `최종 성공 수 / 예정 기간`으로 종료 후 성공까지 끌어와 부풀리지 않는다.
- 정상 측정 구간의 완료 이벤트는 원장 commit → projection commit **p99 ≤ 5초**.
  독립 분석 조회 canary의 가시성은 **10초 이내**. 서로 다른 지표다.
  기존 `received_at`은 COMMIT 이전 시각이므로 commit 시각으로 표기하지 않는다.
  새 계측은 시작·종료 지점과 서버 간 시계 오차를 기록하고, 다른 지연 정의는 별도 이름으로 보고한다.
- 가장 오래 대기한 미반영 receipt와 미발행 outbox의 나이 **10초 이하**.
  마지막 5분 대기량 p95가 최초 안정 5분보다 `2 × 목표 EPS` 이상 커지면 조사 후 재시험한다.
- 입력 종료 후 **120초 이내** 이번 run의 원장·분석·후속 매칭 대사를 완료한다.
  정상 부하는 모든 예정 이벤트가 성공 접수되어야 한다.
- OOM, 비정상 재시작, CH 메모리 초과, 미해결 DLQ **0**.
  측정 중 각 컨테이너 RSS ≤ 메모리 제한의 **80%**, 전체 VM 여유 ≥ **20%**.
- 준비 후 RSS·큐·연결 수가 계속 증가하는 현상은 통과 처리하지 않는다.
  캐시의 정상 증가와 누수를 구분하는 추세 검토를 별도 증거로 남긴다.
- 24시간 시험은 전체 p99뿐 아니라 **각 5분 구간**의 동일 오류·지연 기준도 통과한다.

부하 발생기 자체가 속도를 만들지 못했거나 기록 파일 쓰기에 실패하면 `INVALID_GENERATOR`,
보호를 위해 중단하면 `ABORTED_RESOURCE`, 앱 기준을 어기면 `FAIL_SUT`로 구분한다.
어느 경우도 PASS가 아니며, FAIL_SUT 판정도 제품의 절대 최대 TPS를 의미하지 않는다.

## 3. 트래픽 구성

| 프로필 | 설계 | 용도 |
| --- | --- | --- |
| M0 기준 | 고객사별 기존 사용자·기기 10,000쌍, 모두 재사용, 이벤트만 매번 새 ID | 동일 조건의 성능 비교 |
| M1 혼합 | 요청의 99% 기존 사용자, 1% 신규 사용자·기기. 배치 1 | 신규 등록 비용 포함. 실제 비율은 추후 보정 |
| M2 신규 폭증 | 전부 신규, 100 RPS · 30초, 최대 3,000쌍 | 이전 시험과 비교, 장시간 주 시나리오로 사용하지 않음 |
| M3 재전송 | 동일 insert_id·동일 payload 재전송, 응답 소실·처리기 장애 주입 | 성능 시험과 분리한 정확성·복구 시험 |
| M4 배치 | 같은 기기의 이벤트 10개/요청, 요청 500 RPS | B5000 전용, 단건 결과와 분리 |

합성 이벤트 properties는 기본 1 KiB, 이벤트 이름은 고정 10종, 의미 없는 동적 필드는 만들지 않는다.
2~8 KiB payload는 별도 스트레스 시험으로 추가한다. 계정·앱·키·기기 ID는 고객사별로 분리한다.
M0 결과만 보고 실제 고객 트래픽을 대표한다고 표현하지 않는다.
기본 용량 시험은 격리된 시험 앱에 활성 Journey 0개를 기준으로 한다. ingest·정규화·trigger-matcher는
실제로 실행해 `matched_at`까지 확인하지만, Journey 분기나 채널 발송 성능을 증명하지는 않는다.
Journey 통합 부하는 별도 프로필에서 정의 수·매칭률·분기·채널 증폭을 고정하고 로컬 mock으로 검증한다.
실제 FCM/APNs·SMS·알림톡 발송이나 단말 수신을 이 기준 시험에 섞지 않는다.

- G1: 고객사 1개. G2: 고객사 5개에 균등 배분. G3: 고객사 20개에 균등 배분.
- 코드 기본 제한은 고객사당 1,000 RPS / 키당 500 RPS / 기기당 20 RPS다. 실제 적용값도 실행 전에 기록한다.
  기본 G3c는 고객사·키별 250 RPS여서 제한을 끄지 않고 합계 5,000 RPS를 시험한다.
- 한 고객사가 5,000 RPS를 보내는 요구는 **별도 상품·쿼터 계약**이다.
  전체 합계 시험 통과로 이를 보장하지 않는다.
- 쿼터 거부는 정상 부하에서 실패다. 폭주 보호 시험에서는 예상 429, `Retry-After`,
  다른 고객사의 정상 처리를 별도 기준으로 확인한다.

## 4. 유지할 보장과 변경할 구조

| 구간 | 현재 | 설계 결정 |
| --- | --- | --- |
| 접수 | API가 PostgreSQL receipt와 outbox를 같은 transaction으로 commit 후 202 | 유지. Redis에 넣기만 하고 202로 바꾸지 않음 |
| 전달 | scheduler의 relay가 500ms마다 최대 500행을 조회, XADD·PG UPDATE를 행별 실행 | 별도 역할·원자 선점·묶음 발행으로 변경 |
| 정규화 | ingest가 Redis를 읽어 사용자·기기 처리, CH 저장 및 PG 확정 | 건수·바이트·시간 제한 microbatch와 제한된 병렬성 |
| 후속 작업 | projection marker와 normalized outbox를 PG에 함께 확정 | 유지. Journey의 순서·재전송·삭제 계약 보존 |
| 장애 복구 | 미반영/미매칭 receipt를 원장에서 다시 발행 | 유지하되 전용 유지보수 역할로 분리·페이지 처리 |
| 관찰 | API의 raw_ingestions는 비동기 best effort | track 원장은 receipt. raw 로그를 무손실 백업이라고 부르지 않음 |

이벤트 1개는 일반적으로 `event.ingest`와 `event.normalized`라는 outbox 행을 최소 2개 만든다.
현재 relay는 주기만 고려해도 약 **1,000 outbox행/초 수준의 명목 예산**이다.
실제로는 행별 Redis·PG 왕복이 추가된다. 단일 relay가 곧 1,000 이벤트/초를 뜻하지 않는다.
5,000 ev/s에는 최소 10,000 outbox행/초와 Journey·발송·재시도분의 여유가 필요하다.
이는 코드에서 계산한 병목 후보이며 실측 최대 성능은 아니다.

### 4.1 수집 API와 PostgreSQL

- JSON body를 읽기 전 전역 in-flight 상한을 적용하고 1 MiB body 제한을 유지한다.
  인증·기존 요청 쿼터 후, 검증된 배치의 이벤트 수·바이트를 기준으로 추가 입장 제한을 둔다.
- 큐가 가득 차면 무한히 기다리지 않고 429/503 및 재시도 지침을 반환한다.
  정상 성능 시험에서는 이 거부도 실패로 센다.
- 초기 보정값: API당 in-flight 128, PG pool 8, pool 획득 대기 100ms,
  앱 요청 예산 2초, 시험 클라이언트 timeout 3초. **새 설정의 설계값이며 현재 flag가 아니다.**
- pool 획득, advisory lock, cursor lock, SQL, COMMIT, 응답 시간을 따로 측정한다.
  단순히 pool만 늘리거나 DB에 연결 대기를 밀어 넣지 않는다.
- `persistTrackReceipts()`의 이벤트별 왕복 SQL을 묶되,
  첫 receipt 유지, 사용자별 `receipt_seq`, 같은 batch의 원자성, merge·delete와의
  동일한 잠금 순서를 회귀 시험으로 보호한다.
- 전체 연결 예산: `Σ(인스턴스 수 × pool.max) + 유지보수 연결 ≤ DB 허용 연결의 80%`.
  DB 메모리와 쿼리별 메모리도 별도로 제한한다. `work_mem × 연결 수`만으로 최대 RAM을
  계산하지 않는다. 한 쿼리의 여러 연산·병렬 worker가 각각 메모리를 쓸 수 있다.
- 예시 G2 예산: API 2×8, ingest 2×4, relay 2×2, scheduler 4, matcher 4,
  channel 4, maintenance 2, 관리 2 = **44개**. DB 상한이 최소 55개여야 이 예산이 성립하며,
  연결 상한 자체는 CPU·메모리·실측에 맞춰 정한다.
- `EXPLAIN (ANALYZE, BUFFERS)`는 실행을 수반하므로 합성 데이터 DB에서만 사용한다.
  인덱스·파티셔닝은 100k/1M/10M 규모의 읽기·쓰기 비용을 비교한 뒤 채택한다.

인스턴스 전체의 pool 합계를 고려하는 원칙은 [node-postgres 지침](https://node-postgres.com/guides/pool-sizing)을 따른다.

### 4.2 전용 outbox relay

`outbox-relay` 역할을 새로 추가하고 scheduler와 분리한다. 먼저 기존 단일 relay와
동일한 계약을 검증한 뒤 2개 이상으로 확장한다.

1. 추가 컬럼 제안: `claim_token`, `claimed_until`, `attempt_count`, `next_attempt_at`.
2. 짧은 PG transaction에서 발행 가능한 행을 `FOR UPDATE SKIP LOCKED`로 선점하고
   claim token과 만료 시각을 기록한 뒤 commit한다.
3. PG row lock을 해제한 상태에서 제한된 Redis pipeline으로 XADD한다.
   각 명령의 결과를 확인한다. pipeline 전체 성공을 추정하지 않는다.
4. 성공한 행만 현재 token 조건으로 `published_at`을 묶어서 확정한다.
   실패·결과 불명 행은 임대 만료 후 같은 논리 idempotency key로 다시 처리한다.
5. 오래된 worker는 token 불일치로 상태를 갱신하지 못한다. 단, 외부 발행 자체의
   중복을 없애는 보장은 아니므로 소비자의 멱등 처리는 계속 필요하다.

초기값: claim 최대 500행/2 MiB, 임대 30초, 외부 작업 timeout 5초,
pipeline 동시 실행 2개, 빈 큐에서만 최대 250ms backoff.
이 값들은 측정 결과로 보정한다. 전역 FIFO를 보장한다고 쓰지 않으며 사용자 순서는 원장의
`receipt_seq`와 현재 Journey 규칙이 책임진다.

순서 역전·중복 relay·선점 직후 종료·XADD 성공 후 PG 확정 전 종료·부분 pipeline 실패를
모두 시험한다. 고객사별 제한된 선점량과 순환 스케줄링으로 한 고객사의 실패가 전체 고객사를
막지 않게 한다. 장애용 재시도 분량은 정상 전달과 분리된 예산을 사용한다.
[PostgreSQL의 SKIP LOCKED](https://www.postgresql.org/docs/16/sql-select.html#SQL-FOR-UPDATE-SHARE)는 큐 소비에 쓰되, 일반 조회의 일관성 보장을 대체하지 않는다.

### 4.3 ingest와 ClickHouse

- `XREADGROUP COUNT=200`은 최대 조회 수이지 200개를 모을 때까지 기다리는 기능이 아니다.
  명시적인 reader → bounded buffer → flusher를 둔다.
- G1 초기 후보: 최대 500이벤트 / 직렬화 기준 2 MiB / 최대 대기 1초 중 먼저 도달하면 flush.
  대기 batch 2개, flusher 1개부터 시작한다. reader·대기·처리 중 buffer를 모두 RAM 예산에 포함한다.
- CH 저장은 성공 여부를 확인한 뒤에만 PG projection/normalized outbox commit과 XACK로 진행한다.
  성능을 위해 `wait_for_async_insert=0`로 접수 보장을 낮추지 않는다.
- 기본 경로는 동기 확인 batch다. 서버 측 async insert를 검토한다면
  `wait_for_async_insert=1` 및 고정된 flush 예산을 별도 시험한다.
- 저부하에서는 시간 상한 때문에 작은 batch가 생길 수 있다. 행 수만 키우지 말고
  초당 insert, 활성 part, merge backlog, CH 메모리, API lock 대기를 함께 비교한다.
  [ClickHouse 문서](https://clickhouse.com/docs/concepts/best-practices/selecting-an-insert-strategy)는 batch와 저장 확인 방식이 자원·신뢰성에 영향을 준다고 설명한다.
- 현재 `flushAndProject()`는 CH 작업 동안 사용자 cursor lock을 잡아 삭제 후 데이터 부활을 막는다.
  **이 lock을 무조건 해제하는 최적화는 하지 않는다.** 일괄 SQL·작은 lock 집합·CH timeout으로
  먼저 개선한다. 이를 넘어서는 G3 변경은 삭제 generation/fencing 및 사후 정리 프로토콜을
  별도 설계·검증하기 전에는 활성화하지 않는다.
- 사용자 mirror 및 다른 CH 테이블 쓰기도 실제 프로필에 포함한다. events 테이블만 남겨
  수치를 높인 시험은 별도 결과로 표시한다.
- ReplacingMergeTree의 물리 행과 논리 이벤트를 구분한다. 실제 분석 API의 집계가 맞는지
  확인하며, 대사에만 `FINAL`을 붙이거나 `OPTIMIZE FINAL`을 강제해 중복 문제를 숨기지 않는다.

### 4.4 Redis·재시도·보존

- Redis는 전달 계층이지 track의 유일한 원장이 아니다. `noeviction`과 명시적 메모리 상한을 유지한다.
- 현재 MAXLEN 약 1,000,000은 stream당 5,000항목/초에서 약 **200초 분량**일 뿐이다.
  XACK는 행 삭제가 아니며, Redis 7에서 trim이 미처리 항목을 안전하게 보호한다고 가정하지 않는다.
- 모든 소비 그룹의 pending·oldest age·처리 watermark를 보고 보존 정책을 정한다.
  trim으로 잃은 track 전달 작업은 원장에서 재생하며, 복구 처리 속도와 장애 중 새 부하를 함께 시험한다.
- `XAUTOCLAIM` 반환 cursor를 순회·보존한다. 매번 `0-0`부터 시작해 뒤쪽 pending을 굶기지 않게 한다.
  실제 사용 버전 Redis 7의 동작으로 검증한다. 최신 Redis 전용 옵션을 바로 도입하지 않는다.
  [XAUTOCLAIM 문서](https://redis.io/docs/latest/commands/xautoclaim/)를 참조한다.
- receipt 본문은 현재 완료 조건에 따라 30일 후 정리되고, 중복 방지 tombstone은 사용자 삭제 전까지 남는다.
  수치를 맞추기 위해 이 계약을 줄이지 않는다. 별도 maintenance 역할과 keyset pagination,
  작업량 제한으로 정리·복구가 실시간 ingest를 독점하지 않게 한다.
- identify/token 등 다른 endpoint는 현재 track과 다른 접수 계약이다.
  이 설계의 track 무손실 판정을 그대로 확장하지 않는다.

## 5. 부하 발생기와 데이터 대사

### 발생기 v2 설계

- 고정 도착률의 open-loop를 유지한다. 응답이 느려졌다고 목표 전송량을 자동으로 줄이지 않는다.
  [k6 open model 설명](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/)과 같은 측정 원칙이다.
- 정상 단건 lane의 `failed_total = scheduled_requests - acknowledged_requests`로 정의한다.
  발생기 드롭과 전송 후 실패를 모두 포함하되 원인별 수치는 중복 없이 나눈다.
  timeout 뒤 실제 저장된 요청도 성공 응답 수에는 넣지 않고 아래 집합 대사에서 따로 설명한다.
- HTTP 응답을 제한된 크기까지 읽고 닫아 연결을 재사용한다. 비정상적으로 큰 응답은 실패로 센다.
  실제 TCP 연결 수, 재사용률, 오류 유형을 기록한다. [Go HTTP 계약](https://pkg.go.dev/net/http#Response) 참고.
- 원시 latency 배열 대신 상한이 있는 histogram 3개(예정→시작 / 서비스 / 예정→응답)를 둔다.
  범위 1µs~60초, 유효 숫자 3자리, overflow는 별도 counter이며 clipping한 채 p99 합격 처리하지 않는다.
- 이벤트 ID는 `(run_id, sequence)`로 재구성 가능하게 생성한다. 동일 이벤트의 재시도는 ID와 payload를 유지한다.
  정상 부하 lane은 자동 재시도를 끄고, 재시도 lane은 논리 이벤트 수와 물리 요청 수를 따로 센다.
- 1초 단위 counter/histogram, 전송·성공 ID bitmap과 오류 기록을 제한된 buffer로 디스크에 보존한다.
  기록 실패는 즉시 INVALID_GENERATOR다. 장시간 대사는 keyset paging·외부 정렬로 수행해
  전체 ID/JSON 집합을 RAM에 올리지 않는다.
- 예고 없는 자격증명 출력, 키가 포함된 명령·URL·로그를 금지한다.
  key-file/FD 등 비밀 전달 방식은 새 runner 인터페이스로 명시적으로 구현한다.
- 예상 부하의 1.5배를 단순 로컬 응답기에 보내 generator 자체의 CPU·연결·기록 여유를 먼저 검증한다.
  이 결과는 앱 성능이 아니다. 앱 시험과 동시에 돌리지 않는다.

### 반드시 만족할 집합 관계

`E=예정`, `D=발생기 드롭`, `S=실제 전송한 고유 ID`, `A=성공 응답 ID`,
`P=PG receipt`, `C=분석에서 조회되는 고유 ID`로 정의한다.

- `E = D ∪ S`, `D ∩ S = ∅`.
- 일반 장애 대사: `A ⊆ P ⊆ S`, 배수 완료 후 `C = P`.
- 정상 부하 합격: `D = ∅`, `A = P = C = E`.
- `P − A`는 응답이 불명확해도 실제로 commit된 이벤트다. “유실”로 오인하거나 성공 응답으로 둔갑시키지 않는다.
- ID뿐 아니라 첫 payload hash, 고객사 귀속, 사용자별 receipt sequence, 실제 분석 API 집계를 비교한다.
- 동일 시각의 수를 단순 비교하지 않는다. phase/run ID로 닫힌 집합을 만들고, 조회 가시성이 수렴한 뒤 판정한다.

## 6. 자원과 디스크: 실행 전 필수 확인

아래는 **시작 후보 예산**이며 TPS 달성을 보장하는 사양이 아니다. 현재 Docker 설정을 바꾸지 않는다.

| 제한 합계 후보 | G1 로컬 개선 시험 | G2 전용 시험 |
| --- | ---: | ---: |
| API | 512 MiB | 2 × 512 MiB |
| PostgreSQL | 1 GiB | 2 GiB |
| ClickHouse 컨테이너 | 2 GiB | 4 GiB |
| Redis | 256 MiB | 1 GiB |
| worker 역할 합계 | 768 MiB | 1.5 GiB |
| 관측 + gateway | 384 MiB | 640 MiB |
| 시험 컨테이너 제한 합계 | 4.875 GiB | 10.125 GiB |

CH 내부 메모리 상한은 컨테이너 제한보다 낮게 잡고 캐시·merge·쿼리의 여유를 분리한다.
서버 전체 한도를 올리기 전에 insert 방식과 part 증가를 확인한다.

VM 메모리의 80% 안에 기존 프로젝트의 예약·실측 사용량과 새 시험 예산이 들어와야 한다.
로컬 QA 당시 약 8 GiB Docker에서 여러 프로젝트가 실행 중이었으므로 위 프로필이 자동으로 실행 가능하다고
가정하지 않는다. Docker 메모리 증설·다른 서비스 정지·다른 머신/클라우드 사용은 별도 승인 사항이다.
G2는 전용 16 GiB 시험 환경을 시작 후보로 검토하되 여유 20% 계산을 먼저 만족시킨다.
10.125 GiB의 예약 한도만으로도 VM은 최소 12.657 GiB가 필요하며 OS·발생기 등 추가 사용량은 별도다.
G3 자원은 G2 결과와 실제 증폭 계수로 산정한다. 고정된 CPU/RAM 숫자로 5,000 EPS를 약속하지 않는다.

디스크 예산은 보정 시험에서 측정한 **전체 물리 증가량/고유 이벤트**를 사용한다.
receipt·outbox·인덱스·WAL·CH 전체 테이블·Redis AOF·로그·발생기 기록·복사/merge 여유를 포함한다.
압축된 `pg_dump` 크기를 운영 저장 비용으로 사용하지 않는다.

`필요 여유 = 20 GiB 안전 여유 + 1.5 × 예상 신규 물리 증가 + 임시 정렬/백업/복원 추가 공간`.

5,000 EPS × 24시간은 4억 3,200만 이벤트다. 이벤트당 **전체 비용이 1 KiB뿐이라고 가정해도
약 412 GiB**이며, 실제 비용은 보정해야 한다. 최근 QA 종료 시 여유 디스크는 약 54 GiB였다.
실행 전에 다시 측정하며, 그 정도의 여유 공간에서 5,000 EPS 하루 시험을
바로 실행하지 않는다. 예상 여유가 부족하거나 측정 불가능하면 NO-GO다.

## 7. 경보·종료·장애 시험

### 경보

- 알려진 CounterVec 라벨은 worker 시작 시 0으로 초기화한다. 단, 시작 전후 scrape 사이에
  발생한 첫 실패를 이것만으로 완전히 보장하지 않는다.
- PG의 미해결 DLQ를 읽는 전용 collector에서 `unresolved_count`와 `oldest_created_timestamp_seconds`,
  수집 성공 시각을 노출한다. 같은 DB의 관측자는 고유 `nudgeon_cluster` 라벨과 `max`로 중복 합계를 막는다.
- `unresolved_count > 0` 경보로 첫 실패와 재시작 후 backlog를 감지한다.
  exporter/collector 장애는 별도 경보이며 DB 읽기 실패를 0건으로 출력하지 않는다.
- collector 5초, scrape/evaluate 5초, group_wait 5초를 시작값으로 두고
  **첫 DLQ 발생→로컬 webhook 30초 이내**를 실측한다. 외부 채널 수신은 별도 gate다.
- “새 DLQ가 5분간 없어서 resolved”와 “미해결 DLQ가 없어져 resolved”를 구분한다.
  재처리 실패 항목이 빠지지 않도록 queued/replaying/resolved 상태 정의를 먼저 정한다.
- 메트릭 라벨에 user_id, device_id, insert_id를 넣지 않는다. 고객사 상세는 제한된 로그·조회로 확인한다.
  초기값과 라벨 사용 원칙은 [Prometheus 지침](https://prometheus.io/docs/practices/instrumentation/)을 따른다.
- DB 미저장 `dlq_pending`은 PG gauge에 포함되지 않는다. P0-4a에서 별도 `ops-monitor`의
  pending/저장 오류 경보와 Redis 메모리·보존 관측을 추가했다([설명](OPERATIONS-MONITOR.md)).
  이 Redis 관측은 소규모 bounded SCAN이며 원자적 snapshot·G2/G3 규모 감시가 아니다.
  DB 건수 0만으로 발송 장애가 없다고 판정하지 않는다. PG와 Redis pending은 중복될 수 있어 합산하지 않는다.

### 정상 종료

API는 SIGTERM 시 readiness를 먼저 내리고 새 요청을 막는다. 진행 중 요청을 최대 10초 배수하고
best-effort raw 작업의 남은 상태를 기록한 뒤 PG·Redis·CH 연결을 명시적으로 닫는다.
목표 종료 15초 이하, 컨테이너 종료 유예 20초. 정상이면 SIGKILL/137이 없어야 한다.
P0-3에서 HTTP/Nest 훅 완료 후에도 PID 1 프로세스와 연결이 남는 현상을 재현했다.
신호 gate·10초 HTTP 배수·2초 background 배수·명시적 연결 정리를 구현했다.
14초 watchdog은 미완료 시 exit 1, 정상 정리 시 자연 exit 0으로 구분하며 종료 시간만으로 합격시키지 않는다.
강제 종료 시 PG 세션은 DB가 끊김을 인지할 때까지 남을 수 있어 DB lock/statement 예산도 필요하다.
로컬 검증 결과일 뿐 운영 반영·새 이미지 배포는 하지 않았다.
worker도 신규 claim을 멈추고 완료된 작업만 ack하며, 미완료 작업은 재전달되게 한다.

### G0 및 단계별 장애 회귀

| 주입 지점 | 합격 조건 |
| --- | --- |
| 첫 DLQ / worker 재시작 / collector 중단 | 첫 실패 감지, backlog 유지, collector 장애를 정상 0건으로 오인하지 않음 |
| worker 30초 중단 후 재시작 | 정상 부하와 분리해 배수 120초 내 일치, 허위 202 없음 |
| XADD 성공·outbox 확정 전 종료 | 중복 발행 허용, 논리 중복/유실/사용자 순서 위반 없음 |
| CH 저장 직후 PG 확정 전 종료 | 동일 receipt로 재처리, 실제 분석 API 결과 일치 |
| 분석 지연 중 사용자 삭제·병합 | 데이터 부활 없음, 기존 순서·귀속 회귀 통과 |
| 정상 부하 중 API SIGTERM | 종료 유예 내 정지, 성공 응답한 데이터 보존, 미확정 응답은 같은 ID로 재시도 |
| 고객사 하나의 과부하 | 해당 고객사 거부가 다른 고객사의 접수·지연 기준을 깨지 않음 |
| PG·CH·Redis 백업 복원 | 빈 별도 저장소 복원, 내용·인덱스·sequence·분석·새 접수 검증 |

장애 lane에서 의도한 오류는 성능 lane의 오류율에 섞지 않는다. 이전 로컬 복원 결과는 정지 상태의
복원만 증명한다. 관리형 DB failover/PITR, 운영 RPO/RTO 및 원격 알림은 계속 별도 작업이다.

## 8. 구현 순서와 롤백

| 우선순위 | 작업 | 주 변경 위치 | 완료 증거 |
| --- | --- | --- | --- |
| P0-1 | loadgen 연결 재사용·bounded histogram·고유 ID 기록 | `apps/worker/cmd/loadgen/`, `tests/ops/local/` | 10요청 1연결, 메모리 상한, 드롭/timeout 오판 방지 |
| P0-2 | 첫 DLQ·backlog·collector 장애 경보 | `internal/dlq/`, `internal/metrics/`, `deploy/observability/` | 첫 실패 webhook 30초 내, 재시작·5분 초과 backlog 유지 |
| P0-2b | DLQ 저장 실패 시 종결/ACK 방지 — 로컬 회귀 통과 | `internal/channel/`, DLQ writer, migration 0006 | INSERT 실패·응답 유실 시 pending 유지, 복구 후 DLQ 1건·추가 시험 공급자 호출 없음 |
| P0-3 | API 정상 종료·연결 종료 — 로컬 회귀 통과 | `apps/api/src/main.ts`, `infra/` | 처리 중 요청 완료 후 0.550초·exit 0, timeout 약 14초·exit 1, PG 고유 접수 43건 보존 |
| P0-4 | 기간별 EPS·대기 시간·SQL/CH 계측 및 새 이미지 빌드 | API·worker·시험 metadata | 실행 이미지의 빌드 소스 확인·digest 기록 |
| P0-4a | 대기량·Redis DLQ 대기·관측 실패/자원 경보 — 로컬 회귀 통과 | 읽기 전용 ops-monitor, metrics, alert rules | PG DLQ 0이어도 pending 경보, 2초 timeout, 한도 초과 unknown, 새 worker-only 시험 image 실행 |
| P0-4b | 계측·정확한 ID 대사 회귀 완료, **성능 게이트 실패** | API·ingest·load runner·전체 이미지 | 100 req/s 10초, 원장/CH 1,000건 일치. p99 549ms > 500ms. 상세는 [QA](PROJECTION-QA-2026-09-03.md) |
| P1-1 | 전용 relay·선점 임대·부분 성공 pipeline | `internal/journey/relay.go`, worker 역할, PG migration | 동시 relay·crash 회귀, 처리 여유 확인 |
| P1-2 | API SQL 왕복·in-flight·pool 예산 | `ingestion/event-receipts.ts`, rate-limit, infra | 동일 접수 계약과 사용자 순서, G1 정상화 |
| P1-2a | API 키 사용 시각 쓰기 합치기·예산 — 정확성 검증, **성능 실패 유지** | `auth/api-key-usage.ts`, opt-in flag, SQL/lock 시험 | 같은 키 대기 접속 10→1, 갱신 행 1,000→1. 수정 후 100 req/s 2회 중 1회 드롭 154; [QA](API-KEY-USAGE-QA-2026-09-03.md) |
| P1-3 | 명시적 microbatch·CH 및 유지보수 예산 | `internal/ingest/`, CH 시험 설정 | part/메모리/lock 안정, G2 통과 |
| P2 | 역할별 증설·G3·백업·장시간 시험 | 별도 capacity Compose/runner | 모든 phase 증거와 자원 승인 |

기존 `--role=all`은 로컬 기능 시험용으로 유지한다. 전용 relay를 켤 때는 기존 scheduler의
relay를 명시적으로 꺼서 두 구현이 섞이지 않게 한다. 새 동작은 검증 가능한 feature flag로
배포하고 schema 변경은 additive하게 한다. migration은 commit·락/timeout 회귀를 검증한 뒤 적용한다.

문제가 생기면 새 writer/claim을 중단하고 배수한 뒤 이전 단일 역할로 돌아간다.
살아 있는 lease를 무조건 지우거나 새 컬럼·데이터를 즉시 삭제하는 롤백은 하지 않는다.
호환되지 않는 Journey 진행 상태가 있으면 이전 worker로 되돌리지 않고 승인된 복구 경로를 따른다.
기존 더티 작업은 보존한다. 최초 설계 작성 시 제품 코드를 변경하지 않았으며,
후속 P0-1 구현에서 부하 발생기와 로컬 시험 스크립트만 변경했다.
P0-2는 worker·additive DB 스키마·관측 설정 소스까지 변경하며 격리된 로컬 DB에서 검증한다.
기존 실행 서비스·DB에는 적용하지 않았다. 모니터의 새 연결 1개도 실제 배포 연결 예산에 추가해야 한다.

## 9. 결과 발표 형식과 설계 산출물 상태

최종 결과는 `환경/이미지 digest + workload + batch 크기 + 요청 RPS + 고유 EPS + 기간 +
API p99 + 분석 지연 + 드롭/오류 + 대사 + 자원 여유`를 한 묶음으로 제시한다.
예: **“합계 20고객사, 단건 5,000 RPS/5,000 EPS, 1시간×2 통과. 24시간 미검증.”**
실제 합격 전에는 예시 숫자를 성능 결과로 게시하지 않는다.

- 이 문서와 `capacity/test-plan.json`: 구현을 위한 설계안. 프로그램이 이를 실행하도록 아직 구현하지 않았다.
- 설계 정합성 검사: JSON 3개 파싱, 8개 phase의 속도·기간·이벤트 수·선행 조건,
  기본 쿼터 배분, 메모리 합계, 연결 예산 44개, 로컬 링크 2개 및 신규 파일 4개의 공백 검사를 통과했다.
  이는 문서의 정적 검사이며 실제 부하나 성능 합격 결과가 아니다.
- `capacity/architecture.draft.json`: Archify 구조 초안. 기하 검사 9개는 통과했으나
  최종 구성 검사에서 본문 글자 가독성 오류 1개가 남아 보정 중단 규칙에 따라 멈췄다.
  검증된 HTML이나 브라우저 검증 결과는 없다. 설계의 권위 있는 설명은 이 문서다.
- PostgreSQL 성능 스킬은 전체 pool 예산, 짧은 relay 선점 transaction, 일관된 lock 순서에 반영했다.
  일반적인 “락을 짧게” 원칙 때문에 현재의 삭제 보호 lock을 제거하지는 않았다.
- **P0-1**: 연결 재사용·고정 크기 histogram·재현 가능한 ID·증거 기록 및 CLI 회귀 구현 완료.
  설계의 RAM bitmap 대신 고정 버퍼의 append-only journal을 사용하므로 디스크 예산에 그 증가량을 포함한다.
  이 완료는 M0/M1·다중 고객사·장시간 자원 사전 점검이나 분석 대사 자동화까지 완료했다는 뜻이 아니다.
- **P0-2**: DB 기반 미해결/재처리/해결 상태, 전용 읽기 모니터, 조회·관측 장애 경보,
  명시적 resolve 및 로컬 실제 webhook 회귀 통과. 운영 수신 채널·실제 공급자 발송 증거는 아니다.
- **P0-2b**: 저장 오류 전파, 만료 없는 저장 대기 상태, 같은 실패 회차의 idempotent upsert,
  저장/Redis 종결 확인 후 로그·ACK 처리 및 실제 PG/Redis 장애 회귀 통과. 수동 replay 동시 실행,
  구버전 혼합 소비, Redis 유실/trim까지 안전해졌다는 뜻은 아니다.
- **P0-3**: 실제 종료 4시나리오, PG receipt/outbox 대사, 실제 PG 회귀 7건 통과.
  새 빌드의 API 실행을 검증했으며 운영 이미지 배포·TPS 재측정은 아니다.
- **P0-4a**: [운영 감시 QA](OPS-MONITOR-QA-2026-09-03.md)까지 완료. source SHA·실행 image ID를 대조한
  새 worker-only 시험 이미지이며 API/다중 CLI 배포 이미지·레지스트리 digest·서명 증거는 아니다.
- **P0-4b**: [계측 정의](INGESTION-METRICS.md)와 [실대사 QA](PROJECTION-QA-2026-09-03.md)를 추가했다.
  전체 API/worker 이미지의 동일 소스 SHA·실행 image ID를 확인했고, 실제 1,000개 승인 ID가
  PG receipt와 CH 물리 행에 일치했다. **계측 회귀 통과와 성능 통과는 별개다.** 마지막 실행은
  100 req/s를 채웠지만 p99 548.863ms로 500ms 기준 실패이며, 다른 실행에서는 드롭 433건도 발생했다.
  기존 processed 지표의 저장 전 증가와 시험기의 UUID 정렬 비교·종료 의존 순서를 수정했다.
  정확한 commit→commit 지연·서버 시계 오차 검증과 다중 고객/긴 측정 구간은 남아 있다.
- **P1-2a**: 키 인증은 매번 조회하면서 사용 시각 쓰기만 묶는 opt-in 변경을 추가했다.
  실제 키 행 잠금 중 접속 대기 10→1, 완료 3/20→20/20. 사용 시각 변경 행 1,000→1을 확인했다.
  실제 PG 인증/접수 회귀 11/11 및 승인 ID/CH 물리 행 대사는 통과했지만 수정 후 두 번째
  짧은 부하에서 발생기 드롭 154건·p99 1,547ms가 발생했다. 정상 부하 지연 개선이나 G1 통과가 아니다.
  기본 설정은 false이며 기존 서비스에는 적용하지 않았다. 상세는 [키 갱신 QA](API-KEY-USAGE-QA-2026-09-03.md).
- 다음 구현 우선순위는 **COMMIT의 WAL 쓰기/동기화·호스트 자원 경합 분리와 SQL 왕복(P1-2), relay 병목(P1-1)**다.
  한 실행의 양호한 TPS만 선택해 합격 처리하거나 pool을 무조건 늘리지 않는다.
  대규모 Redis 관측용 원자적 인덱스/이관도 남는다.
  G0 전체·G1 이후 성능 단계가 통과된 것은 아니다. 자원 변경·장시간 실행·클라우드 비용·커밋/푸시는 별도 승인 범위다.
