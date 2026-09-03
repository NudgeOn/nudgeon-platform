# DLQ 저장 실패 복구·로컬 검증 — 2026-09-03

상태: **P0-2b 구현·로컬 회귀 통과 / 운영 미적용 / TPS 재측정 아님**

DB에 실패 기록을 저장하지 못했는데 원본 큐를 완료 처리하는 경로를 수정했다.
저장에 실패하면 원본 작업을 pending으로 남기고, 복구 후에는 **공급자 재발송 없이 저장만 재시도**한다.
DB 저장과 Redis 종결 상태 기록을 확인하고 로그 저장까지 성공해야 ACK한다.

## 최종 실행 결과

- 최종 실행: 2026-09-03 **15:29:18~15:29:39 KST**, `nudgeon-dlq-storage-239dac33`.
- 실제 PostgreSQL 16·Redis 7, 합성 tenant/app, 시험용 공급자와 메모리 로그 sink를 사용했다.
- 소스: `0f4f28141af0e7d3544c548a69bf3b784e5cfc0b` 위의 dirty 작업본. 커밋·푸시하지 않았다.
- 새 격리 프로젝트에서 총 3회 통과했다. 앞선 두 회차는 수정 중간 snapshot이며 아래 최종 회차가 기준이다.
- 메타데이터, 소스 21개·빌드·원본 로그 해시: [dlq-storage-qa.json](capacity/dlq-storage-qa.json).

각 경우 이전 실패 4회를 카운터에 준비하고 마지막 재시도 실패를 실행했다.
실제 발송을 5회 반복한 시험이 아니라, **마지막 실패 이후 저장 복구 경계**를 검증한 것이다.

| 경로 | 주입 장애 | 복구 전 | 복구 후 | 저장 재시도 중 추가 공급자 호출 |
| --- | --- | --- | --- | ---: |
| Push worker | PG INSERT 권한 회수 | DB 0건, 원본 pending 유지 | DLQ 1건, ACK | 0회 |
| Push worker | PG commit 후 응답 유실 모사 | DB 1건, 원본 pending 유지 | DLQ 1건 유지, ACK | 0회 |
| 공통 SendLoop | PG INSERT 권한 회수 | DB 0건, 원본 pending 유지 | DLQ 1건, ACK | 0회 |
| 공통 SendLoop | PG commit 후 응답 유실 모사 | DB 1건, 원본 pending 유지 | DLQ 1건 유지, ACK | 0회 |

각 시나리오의 시험용 공급자 호출은 전체 **1회**다. 실제 `libqueue`의 publish/fetch/reclaim/ACK,
Redis Lua 상태 변경, PG 쓰기와 권한 회수·복구를 실행했다. worker의 실제 Run 루프와 같은
`processSendBatch` 완료 처리 경로를 사용했다. 실제 message worker의 `DLQ()`에서도
PG 권한 오류 `42501`이 호출자에게 반환되고 복구 후 같은 회차가 1행만 남는 것을 별도 확인했다.

## 구현 내용

1. Push와 공통 SendLoop가 DLQ 저장 오류를 반환받는다. DB 미설정·카운터 읽기 실패도
   성공으로 넘기지 않는다. active/legacy/알 수 없는 멱등 상태를 종결 중복으로 ACK하지 않는다.
2. 마지막 발송 실패 시 Redis의 본인 processing lease를 `dlq_pending|...`으로 조건부 변경한다.
   실패 회차 UUID·원본 메시지 ID·실패 시각·분류·횟수를 유지하며, 저장 대기에는 TTL을 두지 않는다.
3. 재전달은 저장 대기를 먼저 처리한다. DB 오류나 Redis 종결 기록 오류가 있으면 원본 큐를 유지한다.
   본인 상태가 여전히 일치할 때만 종결 상태로 바꾸고 재시도 키를 정리한다.
4. `send_dlq.failure_id`와 additive migration `0006_dlq_failure_id.sql`을 추가했다.
   같은 실패 회차 재저장은 no-op이므로 `created_at`·재처리·운영자 해결 기록을 되돌리지 않는다.
   새 실패 회차에는 기존 행을 다시 미해결로 전환한다.
5. PostgreSQL 성능 스킬의 원자적 upsert·짧은 쿼리 원칙을 적용했다. 쓰기는 단일 조건부 SQL,
   5초 timeout이며 DB 락을 잡은 채 Redis·공급자를 호출하지 않는다.

## 회귀 및 빌드

- 관련 7개 패키지의 `go test -race` 통과: channel, message, dlq, metrics, cmd/worker, cmd/dlq, cmd/migrate.
  일반 패키지 명령은 fixture가 없으면 실제 DB 시험을 skip한다. 별도 최종 runner는 실제 PG/Redis를
  연결하고 필수 테스트 4개 모두 **PASS, SKIP 없음**을 확인했다.
- 실제 PG 시험: migration 0006을 과거 형태의 임시 테이블에 2회 적용, 같은 회차의 반복 저장,
  해결 기록 보존, 새 회차 재개 및 기존 DLQ 상태·해결 규칙 통과. 임시 테이블 transaction은 rollback했다.
- 단위 회귀: DB 없음, 손상된 대기 상태, 이미 소진된 카운터, Redis 종결 기록 실패,
  오래된 lease 거부, 두 동시 저장 완료 시도, 원본 실패 시각 보존, 로그 저장 실패 시 ACK 차단 통과.
- 만료 없는 대기 상태는 **시간을 8일 전진시킨 모의 시험**으로 확인했다. 8일 soak가 아니다.
- `go vet`, 프로젝트 절대 규칙·tenant SQL 범위 검사, Node 구문 검사, `git diff --check` 통과.
- 규칙 검사에서 이전 DLQ 관측자의 직접 `time.Now()` 사용을 발견해 주입된 clock으로 바꿨다.
  freshness·duration 단위 회귀와 빌드는 통과했다. 이 변경 후 과거 330초 Alertmanager 시험을
  다시 실행하지는 않았으므로 [이전 경보 QA](DLQ-QA-2026-09-03.md)는 당시 소스의 기록으로 유지한다.
- 최종 worker와 DLQ CLI의 Linux arm64/CGO=0 빌드 통과. 바이너리 해시는 JSON에 기록했다.
  위 통합 시험은 native Go race test 실행이며, Linux worker daemon 바이너리 실행 시험은 아니다.

## 환경 보존과 재현

- 기존 실행 컨테이너 **19개 집합 동일**. 기존 서비스 재시작·DB migration·외부 공급자 발송 없음.
- 최종 시험 컨테이너 **3/3 exit 0**. 앞선 시험도 종료됐으며 증거·볼륨은 보존했다.
- 시험 컨테이너 메모리 제한 합계 416 MiB. 전체 Docker VM 제한이나 운영 권장 사양은 아니다.
- 원본 결과·로그는 무시 경로 `.nudgeon/nudgeon-dlq-storage-239dac33/`에 남아 있다.
- 재현 명령은 [격리 시험 README](../tests/ops/dlq-storage/README.md)를 따른다.

## 적용 전 필수 조건과 남은 검증

운영 적용 시 migration 0006을 writer보다 먼저 적용해야 한다. push/message의 구버전 소비자를
중지·배수하고 큐·Redis를 보존한 채 호환 버전으로 함께 교체한다. **구버전·신버전 혼합 소비 금지**다.
구버전은 새 대기 상태를 종결 중복으로 오인해 ACK할 수 있다. 저장 대기가 남아 있는 동안
구버전 롤백·수동 replay·관련 Redis 키 삭제도 금지한다. 상세 순서는 [런북](DLQ-RUNBOOK.md)을 따른다.

이번 검증에는 다음 한계가 있다.

- 복구 시험은 worker 객체와 consumer를 새로 만드는 방식이다. OS 강제 종료·daemon 재시작 검증이 아니다.
  reclaim의 min-idle은 0이며 운영의 자연 재획득 주기를 검증한 것이 아니다.
- 응답 유실은 실제 PG commit 후 클라이언트 오류를 주입했다. 네트워크 패킷 단절 시험이 아니다.
- 공급자는 시험용이고 로그 sink는 ClickHouse가 아니다. 실제 FCM/APNs·SMS·알림톡·단말·분석 대사가 아니다.
- Redis 지속성·`noeviction`·메모리 여유·미처리 stream 보존이 전제다. Redis 유실·eviction·trim이나
  동시 수동 replay까지 무손실·중복 없는 발송을 보장하지 않는다. email 파이프라인 전체에 일반화하지 않는다.
- **DB 미저장 대기는 PG DLQ 건수 경보에 보이지 않는다.** 별도 pending·저장 오류 관측은 P0-4에 남았다.
  기존 replay CLI의 push 전용 라우팅·단건 tenant 범위·`--all` 무제한도 미해결이다.

다음 단계는 [처리량 설계](CAPACITY-PLAN.md)의 **P0-3 API 정상 종료**, 이후 P0-4 계측이다.
후속 P0-3 구현·검증 결과는 [API 종료 QA](API-SHUTDOWN-QA-2026-09-03.md)에 별도 기록했다.
전체 G0/G1 합격, 관리형 DB·백업 복원, 실제 운영 적용, 지속 TPS 또는 24시간 soak를 완료한 것은 아니다.
