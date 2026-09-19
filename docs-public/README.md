# NudgeOn 공개 문서

설치·연동·운영에 필요한 가이드와 현재 설계·출시 조건을 정리합니다.
현재 상태는 [출시 체크리스트](RELEASE-CHECKLIST.md)를 기준으로 확인하세요.

## 1. 설치하고 첫 푸시 보내기

| 문서 | 언제 읽나 |
|---|---|
| [배포 가이드](DEPLOY.md) | `./nudgeon up` Safe Boot 설치, 설치 코드로 첫 Owner 만들기, 재시작·업그레이드·백업/복구 |
| [콘솔 화면 안내](CONSOLE-GUIDE.md) | 로그인부터 저니·리포트까지 실제 화면 캡처. 언어(ko/en) 전환 |
| [외부 개발자 온보딩 기록지](EXTERNAL-ONBOARDING-TEST.md) | B-3 외부 3명 검증의 실행 전 준비·시간·증거 기록 |
| [첫 실기기 푸시 런북](FIRST-REAL-PUSH.md) | FCM/APNs 크리덴셜 등록 → 발송 → 수신 → 열기 → 리포트 대사 |
| [Resend로 이메일 보내기](RESEND-SETUP.md) | Resend SMTP/API 등록과 웹훅 |

## 2. 연동하기 (앱·서버 개발자)

| 문서 | 내용 |
|---|---|
| [API 가이드](API.md) | Integration API(track/identify/디바이스)와 Management API 전체 경로 |
| [푸시 페이로드 계약](PUSH-CONTRACT.md) | worker와 4개 SDK가 공유하는 `message_id`·데이터 형태 |
| [앱 시작 전면 광고](APP-LAUNCH-ADS.md) | 네이티브 SDK 연결·검수·게시와 문제 해결 |
| [저니 그래프 v2](JOURNEY-GRAPH.md) | 조건·이벤트 대기·A/B 분기의 지원 범위와 제한 |
| [커넥터 계약 v0](CONNECTOR-CONTRACT.md) | 알림톡 등 새 채널을 엔진 수정 없이 붙이는 큐 스키마 |

## 3. 운영하기

| 문서 | 내용 |
|---|---|
| [실패 기록과 재발송](FAILURE-RECOVERY.md) | 테스트 푸시 기록·재시도와 DLQ replay의 현재 제한 |
| [관리형 저장소 검증](MANAGED-STORAGE-VALIDATION.md) | 실제 관리형 환경의 연결·복구·백업 검증 절차 |
| [DLQ 경보 대응 런북](DLQ-RUNBOOK.md) | `NudgeOnDLQEntries` 경보가 울렸을 때 |
| [Redis 유실 대응 런북](REDIS-RECOVERY-RUNBOOK.md) | Redis를 잃은 뒤 `cmd/reconcile`로 상태 확인 |
| [운영 대기량 감시](OPERATIONS-MONITOR.md) | 처리되지 않은 일이 쌓이는지 보는 지표와 경보 |
| [접수·분석 처리량 계측](INGESTION-METRICS.md) | 요청 수·저장 수·분석 반영 수를 구분하는 지표 |

## 4. 설계와 상태

| 문서 | 내용 |
|---|---|
| [출시 체크리스트](RELEASE-CHECKLIST.md) | 지금 어디까지 검증됐고 베타 전에 무엇이 남았는지 (단일 출처) |
| [아키텍처 결정 기록](ARCHITECTURE-DECISIONS.md) | 왜 PostgreSQL·ClickHouse·Redis Streams인가 |
| [처리량·장시간 안정성 설계](CAPACITY-PLAN.md) | 성능 목표·자원 예산·롤백과 남은 검증 |
| [Docker Setup Wizard PRD](DOCKER-SETUP-WIZARD-PRD.md) | 설치 위저드의 전체 목표(Slice A~F)와 구현 경계 |
| [인앱 캠페인 PRD](IN-APP-CAMPAIGNS-PRD.md) | 투명 WebView 팝업·이벤트 제작·노출 조건·SDK의 전체 계획 (전체 기획과 현재 구현 범위 구분) |
| [인앱 작업실 개발 버전](IN-APP-WORKBENCH.md) | 웹 소스 업로드·미리보기·SDK 테스트 연결과 현재 구현 범위 |
| [인앱 캠페인 게시·SDK 연결](IN-APP-CAMPAIGNS.md) | 기간·트리거·설치 기기별 제한·운영 결과 |
| [인앱 캠페인 개발 설계](IN-APP-CAMPAIGNS-DESIGN.md) | SDK·NudgeOn 웹 자산 저장·소스 업로드·페이지 미리보기·실기기 테스트의 개발 계약 (전체 설계와 후속 범위 포함) |
| [라이선싱 가이드](LICENSING.md) | Apache-2.0 범위, 상표, 제3자 고지 |
| [런타임 아키텍처 그림](architecture/runtime-architecture.svg) | 푸시 주경로와 신뢰 경계 ([인터랙티브](architecture/runtime-architecture.html)) |

## 5. 자산과 문서 관리

- [문서 자산](assets/README.md): 로고·콘솔·설치 화면 캡처와 아키텍처 그림.
- [성능 시험 계약](capacity/test-plan.json): 자원 사전 점검과 CI가 사용하는 기계 판독용 기준.
- 검증 재현 방법은 [`tests/ops/`](../tests/ops/)와 [`tests/e2e/`](../tests/e2e/)의 러너·안내를 따릅니다.

날짜별 QA 리포트·측정 결과 JSON·완료 작업의 진행 기록은 공개 문서에 추가하지 않습니다.
시험 산출물은 각 러너의 로컬 출력이나 CI 아티팩트로 보관하고, 현재 동작·제한·남은 조건을 관련 가이드에 반영합니다.
진행 중인 설계는 실제 제공 기능과 구분하며, 구현 후에는 사용 안내에 반영하고 완료 기록을 정리합니다.
개발 내부 원장은 저장소에 포함되지 않는 `docs/`를 사용합니다.
