# P0-4a 운영 감시 QA — 2026-09-03

결과: **로컬 대기량·DLQ 저장/종결 대기·관측 장애 경보 검증 통과**.
TPS/EPS 향상, 실제 공급자 발송, 운영 배포를 의미하지 않는다.

## 검증한 흐름

합성 PG 원장/outbox 및 Redis pending → 새 worker-only 이미지의 읽기 전용 ops-monitor →
실제 Prometheus → Alertmanager → 로컬 webhook. 재시작 후에는 readiness뿐 아니라
Prometheus가 새 성공 시각을 수집한 것까지 확인했다.

최종 프로젝트: `nudgeon-ops-qa-0bbd15a2`.
2026-09-03 **17:47:55–17:50:46 KST**. 실제 공급자/단말/ClickHouse는 이 시험에 없다.

| 검증 | 결과 |
| --- | --- |
| PG 분석 반영 대기 / 매칭 대기 / outbox 대기 | 2 / 3 / 2건과 실제 fixture 일치 |
| DB DLQ 0건, Redis push/message pending 각 1건 | 최초 로컬 webhook **12.536초**, 30초 제한 통과 |
| 읽기 권한 | PG SELECT-only, Redis SET 거부, 원본 marker/만료 없음 유지 |
| 재시작 | 이전부터 있던 pending 재발견, TTL/본문 변경 없음 |
| PG 잠금 장애 | 조회 **2.000747043초**에 중단, 캐시 2/3/2 유지, success=0·readyz=503 |
| PG 장애 중 Redis | 독립 관측 success=1 유지, 실제 실패/복구 webhook 수신 |
| PG 연결 | 정상 상태 1개, query timeout 후 측정 시 0개; 설정 상한 1개 |
| Redis 읽기 권한 제거 / 손상된 pending JSON | 관측 실패·기존 값 유지; 복구 후 readiness 정상 |
| Redis 80,000개 합성 키 | SCAN 호출 한도 초과를 unknown으로 판정; 기존 pending 1건을 0으로 덮어쓰지 않음 |
| observer 중단 | MonitorDown webhook 수신, 재시작 후 Prometheus 새 수집 확인 |
| 짧은 scrape 누락 | pending 경보 조기 resolved 없음, 1분 유지 |
| 합성 상태를 완료로 변경 | 새 PG/Redis 관측 0건, 유지 시간 후 실제 resolved 수신 |
| 종료/보존 | 시험 6컨테이너 exit 0, OOM 없음, 기존 실행 19개·이미지 태그 보존 |

PG EXPLAIN은 기존 부분 인덱스 3개를 사용했다. 작은 fixture에서 planning 0.463ms,
execution 0.119ms였다. 대규모 backlog 쿼리 비용·생산 처리량 수치로 일반화하지 않는다.

## 회귀·정적 검증

- ops/metrics/channel/message/worker 5패키지 race: **156 PASS 항목(상위 테스트·하위 사례 포함)**.
  실제 DB 환경이 없는 기본 실행에서는 `TestDLQStoragePostgresRedis`, `TestMessageDLQDatabaseErrors` 2개를 skip했다.
- 위 skip은 별도 프로젝트 `nudgeon-dlq-storage-842b129b`에서 실제 PG/Redis로 실행했다.
  **상위 테스트 4개, push/sendloop × INSERT 거부/commit 응답 유실 4사례 통과, skip 0**.
  provider/log sink는 모의 구현이다. 장애 후에도 추가 공급자 호출 없이 DB 저장·ACK 조건이 유지됐다.
  17:51:05–17:51:23 KST, 시험 3컨테이너 exit 0, 기존 19개 보존.
- Prometheus 규칙 **기존 9 + 신규 8 시나리오 통과**. 조기 해제 방지·stale·미구성·자원 경보 포함.
  모든 종류의 경보를 실제 webhook으로 시험한 것은 아니다. 실제 수신 범위는 위 표를 따른다.
- 전체 Go worker/libqueue 모듈 test, vet, build 통과. 환경 의존 통합 테스트가 기본 실행에서
  skip되는 기존 규칙은 그대로이며, 위 별도 시험 외 모든 통합 E2E가 실행됐다는 뜻은 아니다.
- 저장소 규칙·tenant scan·공백·runner 구문·CI YAML 검사 통과. CI 규칙 테스트 단계는 추가했지만
  원격 GitHub Actions 실행은 하지 않았다.

## 실행 이미지 증거

| 항목 | 값 |
| --- | --- |
| Git HEAD / 작업트리 | `0f4f28141af0e7d3544c548a69bf3b784e5cfc0b` / dirty |
| Go source manifest | 147파일, `b3c3ead8fbb83b134843662a889909a6a27b51cefc355c452f7ef812a1d407a9` |
| Linux arm64 worker 바이너리 SHA-256 | `aa9156337684301b5001321ff97691cf6cbadf0f0aeaa2200ff5b4060670a900` |
| 새 로컬 이미지 | `nudgeon-ops-qa-0bbd15a2:local` |
| 로컬 image ID | `sha256:5e8951cc7415f1326d1dfa967315667fe1fdc9efc3e67cdf70eb0c7d9298a3ec` |
| 실제 실행 | 컨테이너 image ID, image label, `/metrics`의 source SHA 일치 |
| 빌드 도구 | Go 1.26.1 darwin/arm64에서 Linux arm64 cross-compile |

로컬 RepoDigests에도 같은 SHA가 기록됐다. 이는 원격 registry push·cosign·SBOM 증거가 아니다.
현재 Go 파일 manifest가 최종 시험 소스와 같은 것도 재확인했다. API 이미지와 배포용 다중 CLI
worker image는 이 단계에서 재빌드하지 않았다.

## 중간 실패와 수정

- `d44fc760`: 시험 Redis ACL 파일에 허용되지 않는 주석을 넣어 Redis 기동 실패. 주석을 YAML/README로 이동.
- `113cfbef`: 초기 관측/장애 시험은 통과했으나, 이후 최종 회귀에서 짧은 중단의 조기 해제 문제를 보완했다.
- `7e68cf02`: Docker 자동 주소 풀 고갈로 환경 생성 실패. 기존 서비스 네트워크는 건드리지 않고
  이번 작업의 빈 시험 네트워크만 해제했다. 새 runner도 자기 네트워크만 검사 후 해제한다.
- `bf0392bb`: 관측/오류 검증은 통과했으나 마지막 pending resolved 대사 timeout.
  짧은 scrape 누락에도 경보를 1분 유지하고, 재시작 후 새 Prometheus 수집을 기다리도록 보완했다.
  `0bbd15a2`에서 유지·실제 해제까지 재검증했다. 실패 실행도 증거에서 지우지 않았다.

시험 컨테이너는 정지했고 빈 시험 네트워크만 제거했다. DB 볼륨·로컬 이미지·증거는 보존했다.
커밋·푸시·운영 배포는 하지 않았다.

## 남은 범위

**P0-4b**: 기간별 HTTP 시작/완료·고유 접수 EPS·실제 projection EPS, pool/lock/SQL/COMMIT 및
ClickHouse 지연, 분석 API canary 대사, API/worker 전체 실행 이미지 증거.
대규모 Redis 관측은 원자적 인덱스/기존 marker 이관을 별도 검증해야 한다. 현재 bounded SCAN을
5,000 EPS용 감시로 간주하지 않는다. 관리형 DB·백업/복원·24시간 soak·실제 외부 경보 수신도 남는다.

Postgres 성능 스킬은 전용 읽기 pool·2초 예산·부분 인덱스 실행 계획 확인에,
전체 흐름 검증 스킬은 worker readiness와 Prometheus 수집·webhook 수신을 구분하는 대사에 반영했다.

## 증거 위치

- [기계 판독 요약·21개 증거/입력 파일 SHA](capacity/ops-monitor-qa.json)
- 최종 원본: `.nudgeon/nudgeon-ops-qa-0bbd15a2/`의 result, source-manifest, go-tests JSONL,
  초기/장애/한도/복구 `.prom`, notifications JSON, EXPLAIN, container log.
- 저장 회귀 원본: `.nudgeon/nudgeon-dlq-storage-842b129b/`.
- [운영·한도 설명](OPERATIONS-MONITOR.md), [재현 절차](../tests/ops/capacity/README.md),
  [전체 용량 계획](CAPACITY-PLAN.md).
