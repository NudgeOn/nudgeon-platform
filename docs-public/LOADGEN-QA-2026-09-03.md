# 부하 발생기 P0-1 수정·QA

2026-09-03 · **발생기 구현/로컬 회귀 통과, 플랫폼 부하 재시험 아님**

## 수정 내용

- HTTP 응답 본문을 최대 64 KiB까지 읽고 닫아 연결을 재사용한다. 202라도 `accepted: 1`이
  아니거나 본문 읽기가 실패하면 성공으로 세지 않는다. 응답 읽기에도 timeout이 적용된다.
- 실패 합계는 `목표 - 성공`이다. 발생기 드롭·HTTP·네트워크·응답 계약 오류를 포함한다.
  timeout 후 DB에 저장된 요청은 여전히 성공 응답이 아니며, 원장 대사에서 별도로 확인한다.
- 처리량 게이트는 **측정 구간 안에서 완료한 성공**만 사용한다. 종료 후 성공까지 목표 기간으로
  나누던 계산을 수정했다. 모든 응답이 성공해도 늦게 도착하면 처리량 실패다.
- 지연 원시 배열을 고정 크기 histogram 3개로 교체했다. bucket 배열 합계 432 KiB,
  범위 초과 별도 집계·실패, p50/p99 보수적 근사, 최대 지연은 실제값이다.
- run ID와 sequence로 이벤트·사용자·기기 ID 및 payload를 재현할 수 있게 했다.
  시작/성공/실패/드롭을 고정 버퍼 binary journal로 기록하고 1초 누적 계측·최종 JSON을 남긴다.
- 키 파일/stdin 전달, 기존 증거 디렉터리 덮어쓰기 차단, SIGTERM 중단 증거를 추가했다.
  로컬 시험 스크립트도 키를 argv에 넣지 않고 JSON 결과를 읽도록 연결했다.

Go HTTP 동작 근거는 [공식 응답 본문 계약](https://pkg.go.dev/net/http#Response)이며,
사용법·파일 포맷은 [발생기 README](../apps/worker/cmd/loadgen/README.md)에 있다.
검증한 소스·실행 파일 SHA-256 및 요약 수치는 [QA 명세](capacity/loadgen-qa.json)에 기록했다.

## 실행 결과

환경: macOS arm64, Apple M4 Max, Go 1.26.1. 테스트 서버는 loopback만 사용했다.
샌드박스에서 포트 bind가 막혀 처음 실행은 실패했고, 로컬 포트 권한으로 다시 실행한 결과다.
불가능한 테스트를 skip/pass로 바꾸지 않았다.

| 검사 | 결과 |
| --- | --- |
| 기존 단위 테스트 수정 전 기준선 | 통과 |
| `go test -race ./apps/worker/cmd/loadgen -count=3` | 전체 회귀 3회 통과, race 검출 없음 |
| 실제 HTTP 연결 재사용 | 순차 요청 10개 / TCP 연결 1개 |
| 응답 계약 | 빈 JSON·잘못된 accepted·과대 응답·본문 지연·중간 끊김 실패 판정 |
| 드롭/지연 | 드롭이 실패 합계에 포함됨, 종료 후 성공은 처리량 합격에서 제외됨 |
| histogram 기록 | 1,000,000회 benchmark: 0 B/op, 0 allocs/op |
| histogram 정확도/경쟁 | 보수적 bucket 범위, 동시 기록 합계, 60초 초과 실패 통과 |
| 증거 파일 | ID 재현·순서·권한·비밀 비노출·쓰기 실패 취소·기존 경로 거부 통과 |
| `go vet`, 실행 파일 빌드 | 통과 |
| JS 구문 검사 | 로컬 runner 및 CLI smoke 통과 |
| 빌드 CLI smoke | 정상/늦은 응답/잘못된 응답/기존 경로/중단 5개 시나리오 통과 |

### 빌드 CLI의 실제 응답기 시험

명령: `node tests/ops/loadgen-smoke.mjs /tmp/nudgeon-loadgen-build.un2K5E/loadgen`

- 정상: 200 req/s · 1초, 예정 200 / 성공 200 / 구간 내 성공 200 / 실패 0.
  TCP 연결 2개 생성, 연결 재사용 198회. 기록에서 복원한 성공 ID 200개가 실제 요청과 일치했다.
- 늦은 응답: 예정 1 / 성공 1 / 구간 내 성공 0 / 실패 합계 0이지만 **처리량 FAIL·exit 1**.
- 잘못된 응답: `accepted: 0`인 응답 2개를 성공 처리하지 않고 실패 2개로 집계했다.
- 기존 경로: 이전 증거를 덮어쓰지 않고 요청 전 exit 1. 정상 결과는 보존됐다.
- 중단: 예정 300 / 시작·성공 1 / 나머지 드롭 299, **ABORTED·exit 1**.

이 응답기는 DB를 사용하지 않는다. 위 200 req/s를 API·DB·분석의 새 성능 결과로 인용하면 안 된다.

임시 원본 증거:
`/var/folders/j_/blpv946j115gq8l1z2sx975c0000gn/T/nudgeon-loadgen-smoke-aU1rxP/`.
전체 로그·manifest·journal·누적 계측·summary가 남아 있다. 임시 경로는 영구 보관을 보장하지 않는다.

## 남은 경계

- 이번에는 API/worker 서비스 코드·DB·Docker 자원·운영 설정을 바꾸지 않았다.
  기존 다른 변경도 보존했으며 커밋/푸시는 하지 않았다.
- all-new 사용자·단건 workload를 유지했다. 계획된 기존 사용자 M0/M1, 다중 고객사,
  10개 배치, 계측 시계 정합성, 자원 사전 점검과 장시간 외부 정렬 대사는 아직 별도 구현이다.
- binary journal은 메모리를 고정하는 대신 성공 이벤트당 34 bytes의 디스크를 사용한다.
  5,000 req/s·24시간은 journal만 약 13.68 GiB이며 샘플·DB 저장량은 추가다.
- 로컬 운영 runner는 PostgreSQL/ClickHouse 전체 ID를 아직 RAM에 모은다. 이번 수정만으로
  24시간 soak가 준비됐다고 판단하지 않는다.
- 실제 API 재부하, 첫 DLQ/미해결 backlog 경보(P0-2), API 정상 종료(P0-3)는 후속 작업이다.
  [기존 운영 QA](LOCAL-OPS-QA-2026-09-03.md)의 성능·복구 결과를 새 결과로 대체하지 않는다.
