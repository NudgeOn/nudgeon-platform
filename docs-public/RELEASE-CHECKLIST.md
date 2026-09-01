# Onda 출시까지 남은 작업

**2026-08-31 오후 로컬 작업 트리 재점검.** 플랫폼 HEAD `28bc113` 이후 미커밋 변경과 네 SDK 소스를 대조했다. 코드·단위 검증·저장소 통합·실기기 검증을 구분하며, 현재는 **Push MVP 알파 / 고객 발송·공개 운영 게이트 미통과**다. 아래 완료 조건을 확인하지 않고 실제 고객 발송, 전체 채널 지원, 네 SDK 배포 완료로 안내하지 않는다.

최근 **메시지 ID 생성/전달, 채널 리스/재시도, PG 이벤트 receipt/outbox, 그래프 v2 저니, TOTP·감사·조직 보안, 콘솔 API URL 빌드 설정**은 코드가 추가됐다. 이 기능들을 미구현으로 세지 않되, 아래 계약·복구·검증 잔여를 닫아야 한다.

## 1. 실제 고객 발송·관리자 공개 전에 완료할 항목

| ID | 항목 / 상태 | 남은 작업 | 완료 조건 |
|---|---|---|---|
| P0-01 | message_id / **부분 구현·wire 불일치** | worker는 literal `data["onda.message_id"]`, iOS/NSE는 nested `onda.message_id`, Android는 plain `message_id`를 읽음. 실제 provider payload/SDK 계약 통일, 저니 deep_link·NSE 유효 식별자 연결 | provider fixture를 두 코어와 RN/Flutter에서 동일하게 해석. 실수신/열기/로그의 ID 일치, 재시도 ID 보존. ID 없는 구형 큐 입력도 안정 처리 |
| P0-02 | 채널 유실·재시도·DLQ / **부분 구현** | 20초 리스·최대5회 시도 존재. 처리 중/완료/결과 불명 구분, Redis 오류, sent commit 후 로그 실패 복구, 지수 백오프·Retry-After·실제 DLQ 재처리 미완료 | 선점/전송/로그/ACK 경계 종료·429/5xx·응답 불명에서 조용한 유실 없음. 원래 결과 보존·복구 및 중복 가능성 추적. `*_exhausted` 로그만으로 DLQ 완료 처리하지 않음 |
| P0-03 | SDK 동의·로그아웃·토큰 소유권 / **부분 구현** | local reset/opt-in을 서버 구독·이전 계정 연결 해제와 동기화. identify/reset 직후 track 순서·오프라인 재시도 및 전송 직전 상태 재확인 | 거부·로그아웃·A→B 로그인·재시작 후 이전 사용자 대상 푸시가 새 계정 기기에 도착하지 않음. local external_id 삭제 테스트만으로 닫지 않음 |
| P0-04 | 수집→저니 복구 / **구현·통합 검증 대기** | track receipt+outbox, CH projection·normalized outbox, 미처리 재발행 존재. 최신 PG/CH/Redis 장애·다중 소비자·backlog/trim 및 published outbox 대사 필요 | 접수한 이벤트의 저장·순서·트리거 중복 억제·진입/발송 큐 복구 확인. track 외 endpoint와 raw replay 범위를 구분 |
| P0-05 | 수집 dedup / **부분 구현·집계 위험** | CH 성공→PG projection commit 전 재적재 가능. TS/Go 세그먼트 `count()`가 물리 merge 전 중복을 셀 수 있음. 기존 7일 Redis 정책과 현 receipt 보존 정책 대사 | 장애 재적재 전후 대상 집합·횟수 일치, canonical identity·insert_id 정책/보존 계약 테스트. receipt 통합 skip을 성공으로 집계하지 않음 |
| P0-06 | pause / **부분 구현** | claim와 실행 트랜잭션 부모 상태 재검사 구현. resume의 오래된 메시지·기존 outbox/발송 큐 취소 범위 확정 | pause/claim 경합·재개·장기 대기·이미 큐에 들어간 발송이 명세와 일치. 노드 정지를 provider 취소로 안내하지 않음 |
| P0-07 | 권한 / **부분 구현** | full scope·Viewer 테스트 발송 차단·일부 PermissionGuard 구현. 관리 경로 인라인 검사와 중앙 matrix 대사, 신규 경로 누락 탐지 | 역할 허용/거부·교차 tenant/app 실제 HTTP 전수 통과. 기존 고정15개 isolation probe만으로 전수 검증 선언하지 않음 |
| P0-08 | OS 권한·토큰 대사 / **부분 구현** | 서버 authorized/provisional/ephemeral/not_determined 정규화 존재. SDK autoRegisterPushToken 소비·자동 토큰 획득·사용자 응답·동일 토큰 권한/계정 변경 미완료 | 네 플랫폼 실제 API 토큰 등록 및 권한·사용자·동의 변경 서버 반영. OS 권한과 서비스 동의를 분리 |
| P0-09 | 2FA 안전성·강제 등록 / **부분 구현** | TOTP/개인 UI/조직 정책 존재. enrollment_required 로그인 분기, counter·실패횟수·백업코드 동시 소비, reset 기존세션 정책 보완 | 병렬 재사용/시도 제한·백업코드 일회성·reset 세션 차단 및 강제 등록→정상 복귀 HTTP/브라우저 검증 |

P0-01/03/08은 플랫폼과 SDK를 함께 수정해야 한다. P0-02에서는 공급자 응답이 불명확한 경우까지 “정확히 한 번 전달”을 보장하지 않는다. 단위 `sent→duplicate` 테스트는 실제 발송·로그·크래시 관통 검증이 아니다.

## 2. 공개 설치와 운영 준비

| ID | 현재 상태 | 남은 완료 조건 |
|---|---|---|
| P1-01 콘솔 API 주소 | **구현·새 이미지 검증 대기** — Docker ARG/ENV + Compose build.args 존재 | 비기본 호스트/포트 새 빌드에서 실제 브라우저 요청·세션/CORS 확인. runtime env 변경만으로 번들이 바뀌지는 않음 |
| P1-02 설치·관리형 DB | **부분 검증** — full/app config 통과, 과거 신규 스택 기동 이력·upgrade fixture 존재 | 새 서버 안내 그대로 15분 설치/최초 관리자, 실제 외부 DB TLS·인증·재연결·migration 경합, v1→v2 업그레이드·지원되는 롤백 |
| P1-03 SDK 빌드·배포 | **부분 구현** | Android plugin/Gradle 수정, 코어 podspec/Maven 의존·RN build/pack·Flutter publish_to 정책, 실행 가능한 앱4종·네 플랫폼 신규 설치/시작/실수신 |
| P1-04 CI·콘솔 회귀 | **부분 검증** — 이번 전체 typecheck·규칙 검사·콘솔 모델 테스트 통과, tenant scan 추가 | 실제 PR CI, 저장소 통합/SDK/브라우저 잡과 필수 skip 차단, 목표 커버리지·flaky 계측, tenant scan의 실제 WHERE/동적SQL/신규테이블 검출 보완·device key 규칙 강제. lint placeholder 교체 |
| P1-05 팀·감사 | **부분 구현** — 감사 기록/조회·조직 보안 API 및 개인2FA UI 존재 | 초대/역할/탈퇴·최소1 Owner·세션 정책, 감사 누락/실패 복구, 팀/감사/조직 보안 UI·권한 메뉴. 2FA 안전성은 P0-09 |
| P1-06 스펙·클라이언트 | **부분 구현** — 저니 스펙 보강, 공유 클라이언트는 수기 | 전체 관리 API/OpenAPI·큐·SDK wire 대사, 생성 클라이언트/drift CI, Go JSON Schema 전체 검증, 버전/호환 정책 |
| P1-07 복원·관찰성·부하 | **출시 게이트** — metrics·seed/loadgen·설계 안내 존재 | 백업 도구·빈 서버 복원·RPO/RTO·정합, queue/pending/retry/DLQ 경보·Grafana, 5k ev/s·100만 token·공정성·24h soak 및 원본 결과 |
| P1-08 공개 저장소·패키지 | **미완료** — 플랫폼 LICENSE·release workflow 존재 | SDK별 LICENSE·기여/보안 안내, 설치 URL/버전/새 앱 설치, secret·취약점·서명/멀티아치 검사. 이번 외부 registry/원격 CI는 조회하지 않음 |
| P1-09 관리형 서비스 | **미완료** | 파일럿3종·전체 격리·운영 리허설, 제공 범위·리전·보존/삭제·지원/장애 대응·가입/해지·사용량/청구. 수동 청구 파일럿과 셀프서비스 SaaS 구분 |
| P1-10 글로벌 제공 | **미완료** — 현재 콘솔 ko 고정 | 영문 콘솔/문서/SDK 예제, 시간대·날짜, 지원 언어·리전·데이터 처리 조건. 영문 홍보 페이지를 제품 국제화 완료로 보지 않음 |

## 3. 영역별 추가 잔여 — 기능과 검증 구분

| 항목 | 현재 상태 | 필요한 작업 |
|---|---|---|
| 디바이스 상세 조건·미지원 연산자 | device는 명시적 거부. first/last_performed·token_platform_in 미지원 | metadata 적재/미러·TS/Go 비교·경계/결측값 검증 및 미지원 UI 정리 |
| 세그먼트 정기 평가·미러 대사 | segment worker stub. 단발 audience 생성·소비는 존재 | 정기 평가/대사·통계 갱신·실패 복구. 기존 생성 경로까지 미구현으로 세지 않음 |
| 병합·참조 무효화 | receipt identity/병합 처리 존재 | 과거 이벤트의 canonical 사용자 세그먼트 귀속, 속성 삭제 참조 탐색·broken 표시·활성화 차단 연결 |
| 삭제 | PG 익명화·receipt 정리/CH mutation 및 tenant7일 유예/restore/파기 코드 존재 | tenant 파기의 receipt/cursor 누락 FK 위험, restore/파기 경합 수정. PG 파기 후 CH 실패 재시도·완료 추적, 전체 인벤토리·30일 삭제 검증. 별도 동시 작업 E2E 주장을 이번 검증으로 승계하지 않음 |
| 저니 그래프 v2 | **구현됨:** 조건/이벤트/A-B 분기·합류·편집·revision 활성화·버전별 리포트·통합 fixture | 전용 PG/CH/Redis에서 skip 없는 통합 실행, 브라우저 저장/활성화/리포트, 50노드 성능·v1/v2 배포. [지원 범위/제한](JOURNEY-GRAPH.md) 준수 |
| 렌더·피드백·skip | scheduler 디바이스 fan-out·정책·치환·skip 경로 존재 | 누락 변수 fallback/오류 처리, 디바이스0건·로그장애 skip 보존, InvalidTarget→미러→차회제외, 폐기 credential→화면 관통 |
| 도달·열기·사용량 | 발송 상태·노드/경로·MAU 집계 존재 | P0-01 이후 delivered/opened ID 조인·롤업·중복제거·분모·원장 대사. provider 접수를 도달/고객수로 표시하지 않음 |
| SDK 품질 | 네 코어/브리지·iOS 계약 러너 존재 | init 전 버퍼, identify/reset 순서, 큐/세션/동기파일쓰기, RN scalar/구독/옵션·Flutter EventChannel/Activity, NSE appGroup, 4개 공통 러너·실기기/성능 |
| 추가 채널 | 실제 채널은 FCM/APNs Push | mock-alimtalk 인터페이스 검증은 기존 게이트. 실제 알림톡/SMS/이메일·순환/동시 분기 등은 별도 확장. 그래프 분기 전체를 이후 계획으로 쓰지 않음 |

## 4. 권장 작업 순서

1. message_id·동의/토큰 소유권·결과 보존 계약과 TOTP/권한 차단 항목을 먼저 맞춘다.
2. 전용 PG/CH/Redis·가짜 발송 플러그인으로 receipt→저니→채널 장애·재처리·pause/merge/삭제를 검증한다.
3. iOS/Android 이후 RN/Flutter에서 identify→동의/토큰→저니→수신/열기→리포트→reset/계정전환을 검증한다.
4. 새 서버 설치·복원·부하·격리·보안·CI 게이트를 닫은 뒤 제한된 파일럿을 진행한다.
5. 실제 지원 범위·운영 책임·요금/청구/지원 체계를 정한 뒤 관리형 가입/결제를 연다.

## 5. 근거와 검증 경계

- [발송 워커](../apps/worker/internal/channel/worker.go), [APNs payload](../apps/worker/internal/channel/apns.go), [저니 발송 생성](../apps/worker/internal/journey/tick.go), [테스트 발송](../apps/api/src/messaging/test-push.controller.ts)
- [API receipt](../apps/api/src/ingestion/event-receipts.ts), [CH projection](../apps/worker/internal/ingest/receipts.go), [재발행](../apps/worker/internal/ingest/receipt_maintenance.go), [저니 event 처리](../apps/worker/internal/journey/events.go)
- [TS 세그먼트](../packages/segment-dsl/src/index.ts), [Go 세그먼트](../apps/worker/internal/segment/compiler.go), [TOTP](../apps/api/src/auth/totp.service.ts), [로그인 UI](../apps/console/src/app/login/page.tsx)
- [콘솔 Dockerfile](../apps/console/Dockerfile), [Compose](../deploy/compose.yaml), [CI](../.github/workflows/ci.yml), [배포 안내](DEPLOY.md)

SDK 근거는 형제 저장소 `onda-ios-sdk`의 PushPayload/OndaCore/PushManager/OndaDelivery와 `onda-android-sdk`의 PushPayload/OndaCore/PushManager, RN/Flutter 브리지에 있다.

이번에 typecheck·규칙·Compose config·TS/Go 단위 일부와 iOS payload parser를 직접 실행했다. API receipt/Go 저장소 통합에는 skip이 있으며, 최신 이미지 full-stack·실기기·실공급자·관리형 DB·부하/복원은 이번 실행하지 않았다. 단위 수·문서의 구현률·과거 다른 이미지의 성공을 출시 승인으로 쓰지 않는다. 항목 종료 시 검사 커밋/diff·환경·명령·원본 로그·pass/fail/skip·제외 범위를 함께 기록한다.
