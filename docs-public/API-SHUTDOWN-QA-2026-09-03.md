# API 정상 종료 수정·로컬 검증 — 2026-09-03

상태: **P0-3 로컬 회귀 통과 / 운영 미적용 / TPS 재측정 아님**

종료 신호를 받은 API가 새 요청을 거절하고, 기존 요청과 비동기 작업을 제한된 시간 동안
기다린 뒤 연결을 정리하도록 수정했다. 정상 종료는 exit 0, 시간 초과·정리 실패는 exit 1로
구분한다. **실패 종료가 15초 안에 끝났다는 이유만으로 정상 종료라고 표시하지 않는다.**

## 원인 재현

수정 전 빌드를 별도 Linux API 컨테이너의 PID 1로 실행했다.
`nudgeon-api-shutdown-d4e7d8e7`에서 실제 요청 후 `docker compose stop -t 20`을 실행했으며,
명령 소요 20.397초, **exit 137 / OOMKilled=false**를 재현했다.

진단 로그는 `http_close_end → infra_hook_end → self_signal_SIGTERM → still_alive`였다.
HTTP 종료와 Nest 훅은 이미 끝났고, 1초 뒤 TCP 소켓 4개와 타이머가 남아 있었다.
인프라 종료 훅이 비어 있어 `pg.end()` 호출도 없었다. 사용 중인 Nest는 훅 이후 자신에게
SIGTERM을 다시 보내는 경로를 사용했지만, 이 PID 1 컨테이너에서는 종료되지 않았다.
따라서 이번 재현의 원인은 HTTP close의 대기만으로 설명할 수 없으며, 남은 연결과
프로세스 종료 방식까지 함께 수정했다. 기존 서비스를 진단 대상으로 정지하지 않았다.

## 구현

- SIGTERM/SIGINT 수신 즉시 공유 admission gate를 닫는다. JSON parsing·인증 가드 전에
  새 요청을 503 `shutting_down`, `Retry-After: 1`, `Connection: close`로 거절한다.
  이미 시작한 readiness 검사도 종료 중에는 성공을 반환하지 않는다.
- 기존 HTTP 응답을 최대 **10초** 기다린 뒤 listener를 닫고 남은 연결을 정리한다.
  middleware에 도달하지 못한 미완성 HTTP header 연결도 종료 대상이다.
- `raw_ingestions`와 API key 마지막 사용 시각의 best-effort 작업을 추적한다.
  최대 **2초** 기다리고 남은 건수를 기록한다. 이 변경은 raw 적재를 필수 접수 조건으로 바꾸지 않는다.
- `app.close()`의 Nest lifecycle에서 PG `end()`, Redis `quit()`/`disconnect()`, CH `close()`를
  병렬·시간 제한으로 호출한다. 한 연결의 실패가 다른 연결 정리를 건너뛰지 않게 했다.
- 정상 정리가 끝나면 연결·타이머가 더 없는 상태에서 자연스럽게 exit 0한다.
  **14초 watchdog**은 정리 실패나 남은 자원이 있으면 exit 1한다. 반복 신호는 무시한다.
  Compose API 종료 유예는 **20초**로 명시했다. 기존 실행 컨테이너에는 적용하지 않았다.

종료 순서는 [Nest lifecycle](https://docs.nestjs.com/fundamentals/lifecycle-events),
HTTP 연결 정리는 [Node HTTP server](https://nodejs.org/download/release/latest-jod/docs/api/http.html#serverclosecallback),
PG pool 정리는 [node-postgres pool.end](https://node-postgres.com/apis/pool#poolend)를 참조했다.
verification 스킬에 따라 프로세스 종료뿐 아니라 성공 응답→실제 저장소 보존→재시도까지 대사했다.

## 최종 실행

- 프로젝트: `nudgeon-api-shutdown-4156b3c0`.
- 실행: 2026-09-03 **15:59:57~16:00:52 KST**.
- 소스: `0f4f28141af0e7d3544c548a69bf3b784e5cfc0b` 위 dirty 작업본. 커밋·푸시하지 않았다.
- 새로 컴파일한 API `dist/`를 복제해 cached runtime image에 read-only mount했다.
  소스 70개·빌드 파일 165개의 fingerprint와 버전은 [기계 판독 증거](capacity/api-shutdown-qa.json)에 기록했다.
  새 운영 이미지를 빌드·배포한 시험은 아니다.
- 런타임: Node 22.23.2, Nest 11.2.3, pg 8.23.0, ioredis 5.11.1, CH client 1.23.1.

| 시험 | 실제 프로세스 종료 | 종료 코드 | 결과 |
| --- | ---: | ---: | --- |
| 40건 입력 후 PG 잠금 대기 중 요청에 SIGTERM, 잠금 해제 | **0.550초** | 0 | 기존 요청 202 완료, 새 요청·readyz 503, 세 연결 정상 정리 |
| PG 잠금을 10초 넘게 유지, 중복 SIGINT | **14.030초** | 1 | 정상 종료로 오인하지 않음, 해당 요청에 202 없음 |
| 시험 CH pause로 raw 작업 대기 | **14.111초** | 1 | 남은 raw 작업 보고, 먼저 202한 PG 접수는 보존 |
| keep-alive·미완성 HTTP header 연결 중 SIGINT | **0.029초** | 0 | 연결이 남아 프로세스를 붙잡지 않음 |

시간은 호스트의 signal 명령 시작부터 Docker `FinishedAt`까지다. VM/호스트 시계가
실행 전 조회 구간 안에서 일치하는지 확인했고 Docker 조회 왕복 시간은 별도로 남겼다.
예를 들어 raw 장애의 실제 종료는 14.111초지만 조회까지 돌아온 시간은 15.919초였다.
이는 최대 TPS나 지속 부하 지연 지표가 아니다. 입력 40건은 명목 20 req/s·2초의 작은 종료 회귀다.
SIGTERM을 보낼 때는 이 입력을 마친 뒤 별도로 잡아 둔 요청 1건이 실제 PG에서 대기 중이었다.

## 데이터 및 추가 회귀

- 성공 HTTP 응답 **84회**, 고유 `insert_id` **43개**. 재시도 성공 응답을 새 이벤트로 더하지 않았다.
- 고유 이벤트 43개 모두 PG receipt와 ingest outbox가 일치했다. 재시작 후 같은 ID를 재전송해도
  최초 receipt 시각·순번을 유지했고, 논리 작업이 중복 생성되지 않았다.
- 새 요청 503에는 receipt가 없었다. 시간 초과 요청도 해당 시험에서 receipt 0건을 확인하고,
  DB 잠금 해제·API 재시작 후 같은 ID로 재시도해 1건 저장을 확인했다.
- 강제 종료 직후에는 PG 잠금 대기 세션 **1개가 남았고**, 잠금 해제 후 0개가 됐다.
  연결의 클라이언트 쪽 종료를 DB 쿼리의 즉각 취소와 동일시하지 않는다.
- API 기본 시험 **147건 통과**. 기본 명령의 DB 의존 시험 14건은 skip이며, 그중 receipt 회귀
  **7건은 실제 격리 PG를 연결해 별도 PASS / skip 0**을 확인했다. Journey 통합 7건은 이번에 실행하지 않았다.
- 타입 검사, API 및 workspace dependency build, Node 문법 검사, 프로젝트 절대 규칙·tenant SQL 검사,
  공백 검사 통과. readiness 종료 경쟁, 반복 신호, Redis QUIT 정지, 늦은 promise 거부도 단위 회귀에 포함했다.

## 시험 중 보완한 판정

중간 실패 기록도 삭제하지 않았다. 최종 합격과 혼동하지 않는다.

| 중간 실행 | 시험이 멈춘 이유 | 조치 |
| --- | --- | --- |
| `c3225567` | 강제 종료 직후에도 PG 세션이 남아 “즉시 0개” 가정 실패 | 정상·강제 종료를 분리, 잠금 해제 후 정리·재시도까지 확인 |
| `46e4c99b` | Docker wait/inspect 지연까지 15초 기준에 포함 | 실제 컨테이너 종료 시각과 제어 명령 왕복 시간을 각각 기록 |
| `4298c644` | CH unpause 직후 cached health가 아직 unhealthy라 API 재시작 거부 | 실제 dependency healthy 복구를 확인한 후 재시작 |

최종 실행에서는 위 네 종료 시나리오, 데이터 대사, 실제 PG 회귀와 cleanup까지 모두 통과했다.

## 환경 보존·적용 범위

기존 실행 컨테이너 **19개 집합 동일**. 기존 서비스·DB는 변경하지 않았다.
최종 시험의 API·PG·Redis·CH·gateway는 **5/5 exit 0**으로 정리됐고 볼륨·증거는 보존했다.
시나리오 중의 예상 exit 1 두 번은 위 표와 로그에 별도로 남아 있다.
재현 명령·격리 방식은 [시험 README](../tests/ops/api-shutdown/README.md)를 따른다.

운영 반영 전 API 이미지를 새로 빌드하고 종료 유예 20초 이상 및 readiness 라우팅을 확인해야 한다.
강제 종료에는 미확정 요청이 있을 수 있으므로 SDK/클라이언트는 **같은 insert_id**로 재시도한다.
실제 DB의 lock·statement timeout과 연결 예산도 필요하다. 임의의 쿼리를 즉시 취소하거나
event loop/OS가 멈춘 상황까지 14초 종료를 보장하는 설계는 아니다.

raw 작업 완료는 CH 영구 반영을 뜻하지 않는다. `wait_for_async_insert=0`은 유지했다.
대사는 **PG receipt/outbox**이며 worker projection·Journey·분석 화면·공급자·단말 대사가 아니다.
전체 G0/G1·최대 TPS·관리형 DB·백업 복원·24시간 soak·정식 배포를 완료하지 않았다.
다음 단계는 [처리량 설계](CAPACITY-PLAN.md)의 **P0-4 계측·실행 이미지 증거**다.
