# NudgeOn 공개 문서

용도별로 골라 읽으세요. 각 문서의 첫 줄에 기준일과 검증 범위가 적혀 있습니다.

## 1. 설치하고 첫 푸시 보내기

| 문서 | 언제 읽나 |
|---|---|
| [배포 가이드](DEPLOY.md) | `./nudgeon up` Safe Boot 설치, 설치 코드로 첫 Owner 만들기, 재시작·업그레이드·백업/복구 |
| [콘솔 화면 안내](CONSOLE-GUIDE.md) | 로그인부터 저니·리포트까지 실제 화면 캡처. 언어(ko/en) 전환 |
| [첫 실기기 푸시 런북](FIRST-REAL-PUSH.md) | FCM/APNs 크리덴셜 등록 → 발송 → 수신 → 열기 → 리포트 대사 |
| [Resend로 이메일 보내기](RESEND-SETUP.md) | Resend SMTP/API 등록과 웹훅 |

## 2. 연동하기 (앱·서버 개발자)

| 문서 | 내용 |
|---|---|
| [API 가이드](API.md) | Integration API(track/identify/디바이스)와 Management API 전체 경로 |
| [푸시 페이로드 계약](PUSH-CONTRACT.md) | worker와 4개 SDK가 공유하는 `message_id`·데이터 형태 |
| [저니 그래프 v2](JOURNEY-GRAPH.md) | 조건·이벤트 대기·A/B 분기의 지원 범위와 제한 |
| [커넥터 계약 v0](CONNECTOR-CONTRACT.md) | 알림톡 등 새 채널을 엔진 수정 없이 붙이는 큐 스키마 |

## 3. 운영하기

| 문서 | 내용 |
|---|---|
| [DLQ 경보 대응 런북](DLQ-RUNBOOK.md) | `NudgeOnDLQEntries` 경보가 울렸을 때 |
| [Redis 유실 대응 런북](REDIS-RECOVERY-RUNBOOK.md) | Redis를 잃은 뒤 `cmd/reconcile`로 상태 확인 |
| [운영 대기량 감시](OPERATIONS-MONITOR.md) | 처리되지 않은 일이 쌓이는지 보는 지표와 경보 |
| [접수·분석 처리량 계측](INGESTION-METRICS.md) | 요청 수·저장 수·분석 반영 수를 구분하는 지표 |

## 4. 설계와 상태

| 문서 | 내용 |
|---|---|
| [출시 체크리스트](RELEASE-CHECKLIST.md) | 지금 어디까지 검증됐고 베타 전에 무엇이 남았는지 (단일 출처) |
| [아키텍처 결정 기록](ARCHITECTURE-DECISIONS.md) | 왜 PostgreSQL·ClickHouse·Redis Streams인가 |
| [처리량·장시간 안정성 설계](CAPACITY-PLAN.md) | P0/P1 성능 프로그램의 설계안과 단계별 결과 |
| [Docker Setup Wizard PRD](DOCKER-SETUP-WIZARD-PRD.md) | 설치 위저드의 전체 목표(Slice A~F)와 구현 경계 |
| [라이선싱 가이드](LICENSING.md) | Apache-2.0 범위, 상표, 제3자 고지 |
| [런타임 아키텍처 그림](architecture/runtime-architecture.svg) | 푸시 주경로와 신뢰 경계 ([인터랙티브](architecture/runtime-architecture.html)) |

## 5. 검증 기록

- [`qa/`](qa/README.md) — 날짜가 붙은 QA 리포트. 각 리포트는 그 시점의 기록이며 현재 상태는 출시 체크리스트를 따릅니다.
- [`capacity/`](capacity/) — QA 리포트의 원본 수치(JSON)와 성능 시험 계획.
- [`assets/`](assets/README.md) — 로고·콘솔 캡처·설치 화면 캡처.

개발 내부 원장(PRD·Go/No-Go 판정)은 저장소에 포함되지 않는 `docs/`에 있습니다.
