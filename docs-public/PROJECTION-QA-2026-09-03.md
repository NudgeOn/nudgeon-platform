# 접수·분석 계측 QA — 2026-09-03

**계측·이벤트 ID 대사 회귀는 통과했다. 부하 성능 게이트는 실패했다.**
최종 실행은 100 req/s·10초에 1,000건을 접수했지만 종단 p99 **548.863ms**로
기준 500ms를 넘었다. 따라서 안정적인 100 TPS, G1 또는 5,000 EPS 통과로 발표하지 않는다.

## 최종 실행

- 프로젝트: `nudgeon-projection-qa-42d33634`
- 시간: **2026-09-03 18:27:01–18:28:44 KST**
- 결과: `accountingPass=true`, `pass=false`, runner exit **1**. 지연 실패를 성공으로 바꾸지 않았다.
- 격리 PG/Redis/CH/API/ingest/scheduler/gateway 7개. 실제 공급자·채널 worker는 사용하지 않았다.
- 단일 합성 고객사, 요청당 새 익명 사용자·기기·이벤트 1개, 동시 요청자 20, 입력 10초.
- 1,000 요청 모두 구간 내 202, 발생기 드롭/HTTP·네트워크·응답 오류 **0**.
- 서비스 p99 489.983ms, 발생기 큐 p99 350.463ms, 종단 p99 **548.863ms**.
  서로 다른 요청의 분위수이므로 큐 p99와 서비스 p99를 더하지 않는다.

| 대사 대상 | 결과 |
| --- | --- |
| 발생기 승인 journal의 고유 ID | 1,000 |
| PG 원장 / projected marker | 1,000 / 1,000 |
| CH 고유 ID / 물리 행 | 1,000 / 1,000 |
| 발생기 ID ↔ PG ↔ CH | 전체 집합 일치 |
| 별도 기능 fixture까지 포함한 API / worker counter | 1,004 / 1,004 |

`FINAL`/`OPTIMIZE` 없이 ID별 물리 행 수가 각각 1인지 확인했다.
입력 안의 참고 관측 구간 9.687초에서 접수 975건(100.65 EPS), 반영 934건(96.42 EPS)을 관측했다.
API/worker scrape는 비동시이며 최대 scrape 폭 106ms다. 이 짧은 수치를 지속 처리량으로 쓰지 않는다.
이후 배수 확인 루프에 507ms가 추가로 걸렸다. 이는 루프 시작부터의 시간이며 정확한 입력 종료→배수
완료 지연으로 이름 붙이지 않는다. 최종 상태는 1,000건 전부 반영이다.

## 수정과 실제 장애 검증

1. **저장 전 처리량 증가 수정**: 기존 `IngestProcessed`는 CH 저장 전 증가했다.
   동기 CH 저장과 PG projection COMMIT 성공 후로 이동하고 고유 접수/반영 카운터를 분리했다.
2. **중복 집계 방지**: 배치 중복·동시 재전송 포함 제출 6건 → 원장 2건, 반영 2건,
   중복 4건. 기존 응답의 `accepted=batch.length` 계약은 유지했다.
3. **실제 PG 오류**: 시험 원장 table lock으로 statement timeout/HTTP 503을 발생시켰다.
   접수/반영 수는 2에서 증가하지 않았다. 같은 ID 재시도로 1건만 추가됐다.
4. **실제 CH 중단**: 시험 CH pause 중 HTTP 202는 성공했으나 접수 4·반영 3·대기 1이었다.
   CH insert 실패 histogram을 확인하고 재개·회수 후 반영 4, 재전송 후에도 4를 확인했다.
5. **독립 실제 조회**: 합성 owner 세션으로 사용자 활동 API HTTP 200, 이벤트 4건을 확인했다.
   마지막 조회 254ms는 단일 관측이지 canary p99가 아니다. readiness/metrics 성공과 별도로 검사했다.
6. **시험기 보정**: PG와 CH의 native UUID 정렬 순서를 동일하다고 가정하지 않도록
   문자열 ID 집합을 비교한다. journal 승인 ID를 기준으로 대사하고, 발생기 드롭은 성능 실패로 남긴다.
   시험 Compose의 API/worker → Redis 의존성을 명시해 종료 중 Redis가 먼저 꺼지지 않게 했다.

전체 흐름 검증 스킬에 따라 첫 실패 경계를 기록하고 대사 자체의 오류를 먼저 수정했다.
Postgres 성능 스킬을 적용하되 삭제 보호를 위한 cursor/profile lock 순서는 변경하지 않았다.
SQL/lock stage는 쿼리 왕복 시간이며 순수 lock wait가 아니다. 상세 정의는 [계측 문서](INGESTION-METRICS.md).

## 반복 실행의 불안정성도 보존

모든 실행이 100 req/s·10초 목표였다. 아래 실패를 최종 양호한 건수로 덮어쓰지 않았다.

| 실행 suffix | 구간 내 202 | 발생기 드롭 | 종단 p99 | 판정/중단 경계 |
| --- | ---: | ---: | ---: | --- |
| `4ea2b508` | 1,000 | 0 | 36.031ms | HTTP gate 통과, 시험기 UUID 정렬 비교 실패 |
| `39c6c63f` | 967 | 0 | 1,149.951ms | 처리율·지연 gate 실패; 종료 후 33건 완료 |
| `d825c794` | 507 | 433 | 9,543.679ms | 발생기 백프레셔 실패. 총 567건 승인; 종료 Redis 순서 문제도 발견 |
| `42d33634` | 1,000 | 0 | 548.863ms | 정확한 대사·회귀 통과, 지연 gate 실패 |

세 번째 실행의 계측에는 API receipt pool 획득 누적 62.10초/574회, COMMIT 누적 30.03초/573회가
기록됐다. 두 stage의 p99가 속한 bucket 상한은 5초였다. 병렬 요청의 누적 시간을 실경과 시간으로
해석하지 않는다. 이 값만으로 스토리지, 호스트 스케줄링, connection 예산 중 단일 원인을 확정하지 않는다.
이 컴퓨터에서 기존 서비스 19개가 함께 실행됐고 결과 변동이 컸으므로, 다음은 API pool/COMMIT의
실행 중 대기 원인·자원 압력 분리 측정과 SQL 왕복/relay 예산 최적화다. pool을 무조건 늘리지 않는다.

## 빌드와 회귀 증거

- 기준 HEAD: `0f4f28141af0e7d3544c548a69bf3b784e5cfc0b`, dirty checkout 보존.
- API/worker/packages/DB 등 **296개 파일** manifest SHA-256:
  `c1c3d08ea99db60ea1f90eab17dbc9f22bdf5c740fd102270c570571916b3959`
- 실제 API 전체 이미지: `nudgeon-projection-qa-42d33634-api:local`
  ID `sha256:06a6a17c775ba6852836db668ba94736fc70d240feb3dde473538e519bd15dfd`
- 실제 worker 전체 이미지: `nudgeon-projection-qa-42d33634-worker:local`
  ID `sha256:d647831a9823235a5ab12088443c66c685b980184febedb4a100b431fe7e21fc`
  migrate/seed/DLQ CLI도 원래 Dockerfile로 빌드했다. CLI 운영 동작 전체를 검증했다는 뜻은 아니다.
- image label, 실행 container image ID, live `build_info`의 source SHA를 대조했다.
  container worker Go 1.25.14, 호스트 Go 회귀 1.26.1이다. 동일 컴파일러 빌드라는 주장은 하지 않는다.
- API 기본 회귀 **154 통과**, 환경 의존 통합 **14 기본 스킵**.
  그중 receipt suite는 실제 PG에서 별도 **7 통과·스킵 0**.
- Go ingest suite: 실제 PG/CH 환경에서 **15 통과·스킵 0**, race 검사 포함.
  일반 단위 테스트도 포함된 suite 수다. CH 성공 후 PG COMMIT 전 취소, 재전달, 병합/삭제 회귀 포함.
- worker 전체 모듈 테스트·go vet·저장소 규칙·공백 검사 통과. 기본 모듈 실행은 환경 의존 통합을 스킵한다.
- 대사 검증기 단위 **3 통과**, 실제 API/worker exposition은 Prometheus `promtool check metrics` 통과.
- 마지막 시험 7개 컨테이너 모두 **exit 0·OOM 없음**. 기존 실행 19개 보존, 시험 DB 볼륨·이미지·증거 보존.
  시험용 빈 네트워크만 해제했다. 세 번째 실패 실행의 API exit 1도 원본 증거에 남아 있다.

요약 및 23개 증거 해시: [projection-qa.json](capacity/projection-qa.json).
원본: `.nudgeon/nudgeon-projection-qa-42d33634/`의 `result.json`, `load/`, `final-*.prom`,
`load-ledger.json`, `load-clickhouse.json`, `source-manifest.json`, 빌드·회귀·종료 로그.
[재현 runner](../tests/ops/projection/README.md).

## 아직 완료하지 않은 것

정확한 commit→commit p99와 시계 오차, 다중 고객사/재방문 사용자 부하, G0 전체·G1 이후 장시간 시험,
최대 TPS, 운영 Prometheus 배포·대시보드, 실제 provider/단말, 관리형 DB·백업·복원·24시간 soak는 남았다.
새 listener는 기본 비활성화이며 운영 서비스에는 적용하지 않았다. 로컬 이미지 ID/RepoDigests는
registry 게시·SBOM·서명·release 완료 증거가 아니다. 커밋·푸시·배포는 하지 않았다.
