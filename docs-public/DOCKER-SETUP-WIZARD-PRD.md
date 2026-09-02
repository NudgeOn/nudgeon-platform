# NudgeOn Docker Setup Wizard PRD (P0)

> 상태: **Slice A Safe Boot Preview 구현 — 전체 P0 위자드는 미완료**
> 작성 기준일: 2026-09-02
> 대상: NudgeOn 셀프호스팅 `MODE=single_tenant` 신규 설치
> 제품 목표: release bundle의 `./nudgeon up` 한 명령으로 Compose를 기동하고, 브라우저에서 안전하게 설치를 끝낸 뒤 공급자 크리덴셜 없이 첫 Sandbox 발송까지 완료한다.

이 문서는 현재의 수동 Compose 설치, 최초 관리자 Bootstrap API, 4단계 온보딩을 하나의 제품 경험으로 재구성하는 P0 요구사항이다. Slice A의 일부 항목은 Safe Boot Preview로 구현됐지만, 나머지 화면·API·상태는 목표 계약이며 현재 구현이나 검증 완료를 뜻하지 않는다.

| Slice | 현재 상태 | 지금 제공되는 범위 / 남은 경계 |
|---|---|---|
| A — Safe boot | **Preview 구현** | `./nudgeon up/status/setup-url/doctor/logs/down`, 자동 로컬 시크릿, dev seed 없는 전용 Compose, loopback gateway, same-origin API 경로, setup-status shell, API·worker readiness가 소스에 있다. 현재는 source build이며 versioned release image와 clean-host 출시 증거는 남아 있다. |
| B — Atomic Bootstrap | **미구현** | 설치 claim, Bootstrap cookie, 최초 Owner 원자 생성, setup 잠금, recovery CLI가 필요하다. |
| C — Resumable activation | **미구현** | 서버 저장형 onboarding 진행 상태와 재개·skip이 필요하다. |
| D — Test Inbox | **미구현** | 외부 provider 없이 lifecycle `received`까지 증명하는 sandbox connector가 필요하다. |
| E — One real channel | **미구현** | FCM/APNs guided credential 검증과 단일 대상 실제 테스트가 필요하다. |
| F — Release proof | **미완료** | clean Linux amd64·Docker Desktop arm64, 보안 경쟁 조건, 복구, 접근성, release image 증거가 필요하다. |

따라서 현재 공개 문구는 **“Open Source의 소유권과 투명성은 그대로, `./nudgeon up` 한 명령으로 Safe Boot를 시작”**까지 사용할 수 있다. “설치 완료”, “WordPress급 설치”, “production-ready”는 Slice B–F와 Definition of Done을 닫기 전에는 사용하지 않는다.

## 1. 제품 결정

NudgeOn의 설치 완료 기준은 컨테이너가 실행 중인 상태가 아니다.

1. **Secure installation:** 필수 서비스가 준비되고, 설치 소유자가 증명되며, 최초 Owner가 원자적으로 생성되고, 공개 Bootstrap 경로가 잠긴 상태
2. **Product activation:** 인증된 Owner가 NudgeOn Test Inbox로 첫 메시지 수명주기를 확인한 상태
3. **Real channel activation:** 실제 앱 이벤트, 실제 채널 크리덴셜, 공급자 접수, 가능할 때 실기기 도달까지 별도로 검증한 상태

세 상태는 화면에서는 하나의 위자드로 이어지지만 권한·완료 증거·운영 지표를 섞지 않는다.

```text
./nudgeon up
  → host CLI의 TTY에서 설치 URL·일회용 코드 1회 확인
  → 시스템 점검
  → 최초 Owner 생성·Bootstrap 잠금
  → NudgeOn Test Inbox 발송
  → 실제 SDK 이벤트 연결
  → 선택한 채널 하나 연결
  → 테스트 발송·NudgeOn Health
```

## 2. 현재 기준선과 해결할 문제

현재 저장소에는 다음 기반이 있다.

- `deploy/compose.yaml`: PostgreSQL·ClickHouse·Redis → migrator → API·worker·console 기동 순서
- `GET /v1/bootstrap/status`, `POST /v1/bootstrap/setup`: 단일 테넌트 최초 관리자 생성
- `/onboarding`: SDK Key → 채널 크리덴셜 → 첫 이벤트 → 테스트 푸시의 4단계 UI
- `/healthz`, `/readyz`, worker `/healthz`: 프로세스·일부 의존성 상태
- `test_run_id`, `message_id`, `message.lifecycle.v1`: 발송 상태를 연결할 기반

현재 경험은 WordPress 수준의 설치 경로로 보기 어렵다.

| 현재 상태 | 사용자 영향 | P0 결정 |
|---|---|---|
| `.env` 복사와 `NUDGEON_MASTER_KEY` 수동 생성이 선행 | Docker를 아는 사용자도 시작 전에 보안 설정을 직접 판단 | 기본 번들 설치는 host CLI가 시크릿을 자동 생성 |
| API 주소가 콘솔 빌드에 인라인 | 도메인 변경 시 콘솔 재빌드 필요 | same-origin gateway와 런타임 설정 사용 |
| 공개 Bootstrap 요청에 설치 소유권 증명 없음 | 먼저 요청한 사람이 Owner를 선점할 수 있음 | 일회용 설치 코드와 짧은 Bootstrap 세션 도입 |
| 멤버 수 조회로 최초 설치를 판정 | 동시 요청에서 중복 Owner·tenant 생성 가능 | DB singleton 상태와 트랜잭션 잠금 사용 |
| `single_tenant`에서도 첫 `/auth/signup`이 가능 | Bootstrap 경로를 우회해 Owner 선점 가능 | single-tenant signup은 항상 비활성화 |
| 빈 볼륨에 `seed.dev.sql` 적용 | 알려진 개발 키·데모 tenant가 셀프호스트 DB에 생김 | 개발 seed를 production/self-host Compose에서 분리 |
| 첫 단계에 FCM·APNs·이메일 설정을 한꺼번에 노출 | 첫 가치 전에 가장 어려운 외부 설정을 요구 | Test Inbox를 기본으로 하고 실제 채널은 하나만 선택 |
| 테스트 발송 완료가 브라우저 `pushSent` 상태와 queue 응답에 의존 | 새로고침 시 소실되고, 접수를 도달로 오해 | 서버에 진행 상태와 `test_run_id`를 저장하고 단계별 상태 표시 |
| `/readyz`가 일부 의존성만 보고 실패해도 `200` 가능 | 설치 화면이 준비되지 않은 시스템을 정상으로 표시 | 의존성·스키마를 모두 검사하고 실패 시 `503` |

## 3. 목표와 성공 지표

아래 수치는 출시 목표이며 현재 실적이 아니다. 기준 환경과 원본 측정 결과 없이 달성으로 표시하지 않는다.

| 지표 | P0 목표 | 측정 시작·종료 |
|---|---:|---|
| Clean install 성공률 | 90% 이상 | 빈 볼륨 `./nudgeon up` → Secure installation |
| `TTFReady` | p50 5분, p90 15분 이내 | `./nudgeon up` 시작 → API·worker 포함 전체 system ready |
| 최초 Owner 완료율 | 90% 이상 | setup 화면 진입 → Bootstrap 잠금 |
| `TTFSandboxSend` | p50 8분, p90 15분 이내 | setup claim → Test Inbox `received` |
| `TTFEventAccepted` | p50 3분, p90 7분 이내 | event challenge 발급 → 같은 challenge의 non-synthetic receipt 영속 접수 |
| `TTFEventVerified` | 별도 측정 | event challenge 발급 → 같은 receipt의 projection 확인 |
| `TTFProviderAccepted` | 별도 측정 | credential verified → 같은 test의 provider accepted |
| `TTFDeviceReceived` | 별도 측정 | provider accepted → 같은 `message_id`의 device receipt |
| 단계 복구율 | 100% | 새로고침·console 재시작 후 마지막 서버 상태 복원 |
| 설치 소유권 안전성 | 선점·중복 Owner 0건 | 동시 claim/setup 보안 테스트 |
| 발송 추적성 | 테스트 발송 100% | `test_run_id`에서 `message_id`와 lifecycle 조회 |

Self-hosted 제품 사용 분석은 로컬에 남기는 것이 기본이다. NudgeOn 프로젝트로 보내는 익명 설치 통계는 명시적 opt-in 전에는 비활성화한다. 위 지표는 CI, 설치 실험, 동의한 파일럿에서 집계한다.

## 4. 범위

### 4.1 P0에 포함

- 기본 번들 DB 설치의 무수동 시크릿 초기화
- `./nudgeon up` host CLI와 versioned release image 기반 Compose 기동
- same-origin gateway와 런타임 public URL 설정
- 진짜 readiness와 설치 진단 화면
- 일회용 설치 코드 claim, 최초 Owner 원자 생성, Bootstrap 영구 잠금
- 중단 후 복구 가능한 서버 저장형 onboarding 상태
- NudgeOn Test Inbox와 synthetic sample event
- iOS·Android·React Native·Flutter·cURL 앱·Server 백엔드 첫 이벤트 안내와 `pk_`/`sk_` 경계
- 선택한 실제 채널 하나의 guided credential setup
- 테스트 수명주기 타임라인과 NudgeOn Health 진입점
- 키보드·스크린리더·오류 복구 기준
- clean install, 재시작, 동시 claim, 실패 복구 E2E

### 4.2 P0에서 제외

- 관리형 SaaS 공개 가입·결제
- 외부 관리형 DB를 브라우저에서 프로비저닝하는 기능
- 자동 TLS 인증서 발급과 DNS 변경
- 공개 Connector Marketplace·외부 플러그인 설치
- 실제 APNs/FCM 실기기 수신을 10분 내 보장
- 백업 자동화·원클릭 복원·버전 롤백 완성
- 전체 콘솔 국제화
- AI 추천·자동 발송

외부 DB, 기존 reverse proxy, KMS/Vault는 고급 설치 경로로 계속 지원하되 기본 위자드와 완료율을 공유하지 않는다.

## 5. 사용자와 핵심 작업

### 5.1 Primary persona

- Docker Compose로 자체 서버에 NudgeOn를 설치하는 개발자 또는 기술 PM
- NudgeOn 내부 구성요소보다 “내 앱의 이벤트를 받고 첫 메시지를 보내는 것”이 목표
- APNs·FCM·이메일 자격증명은 일부 알고 있지만 NudgeOn의 queue, worker role, key 종류는 모를 수 있음

### 5.2 사용자 작업

1. release bundle 문서대로 `./nudgeon up` 한 명령으로 스택을 시작한다.
2. 출력된 설치 URL로 접속해 자신이 설치 소유자임을 증명한다.
3. Owner와 기본 workspace/app을 만든다.
4. 외부 공급자 없이 NudgeOn의 event → audience → send → lifecycle 흐름을 체험한다.
5. 자신의 앱 또는 서버에서 첫 이벤트를 보낸다.
6. 필요한 경우 실제 채널 하나를 연결하고 자신에게 테스트한다.
7. 운영 준비가 부족한 항목을 NudgeOn Health에서 확인한다.

## 6. 경험 원칙

1. **한 번에 하나:** 현재 단계에 필요한 입력만 보이고, 다른 채널 설정은 숨긴다.
2. **좋은 기본값:** Development app, Test Inbox, sample user, timezone 감지를 기본으로 준비한다.
3. **증거 기반 완료:** 버튼 클릭이 아니라 서버가 관측한 상태로 체크한다.
4. **솔직한 상태:** `queued`, `provider accepted`, `delivered`, `opened`를 각각 표시한다.
5. **안전한 탈출구:** 고급 설정은 문서·CLI로 제공하되 기본 경로를 방해하지 않는다.
6. **중단 가능:** Owner 생성 이후 각 activation 단계는 독립적으로 보류하고 나중에 이어갈 수 있다.
7. **되돌릴 수 있음:** sample data는 Production data와 구분하고 한 번에 삭제할 수 있다.

## 7. 전체 흐름과 화면 요구사항

### S0. Starting NudgeOn

**목적:** 서비스가 준비되는 동안 빈 화면이나 연결 오류 대신 진행 상황을 보여준다.

표시 항목:

- NudgeOn 버전과 설치 ID
- PostgreSQL, Redis, ClickHouse, migration, API, worker, console/gateway 상태
- 현재 단계: starting / waiting / ready / blocked
- blocking 오류와 권장 조치
- `다시 확인`, `진단 정보 복사` 동작

Acceptance criteria:

- [ ] gateway는 API가 준비되지 않아도 setup shell과 상태 화면을 제공한다.
- [ ] 필수 의존성이 준비되지 않으면 다음 버튼은 비활성화되고 원인을 텍스트로 설명한다.
- [ ] 5초 polling 또는 SSE 재연결이 실패해도 backoff 후 자동 복구한다.
- [ ] 진단 정보에는 비밀번호, DSN credential, master key, setup token, API key가 포함되지 않는다.
- [ ] migration 실패는 무한 spinner가 아니라 실패한 revision과 안전한 재시도 안내를 표시한다.

### S1. Claim installation

**목적:** 원격 서버에서 최초 접속자가 임의로 Owner가 되는 것을 막는다.

기본 경험:

- init 과정은 256-bit setup token을 생성하고 hash만 DB에 저장한다.
- raw token은 root-only secret volume에 저장하고 container stdout/stderr에는 출력하지 않는다.
- `./nudgeon up`은 host-local helper를 통해 `.../setup#token=<raw>` URL을 시작한 TTY에 한 번만 표시한다. 재확인은 `./nudgeon setup-url`을 명시적으로 실행한 로컬 관리자에게만 허용한다.
- 브라우저는 fragment를 읽어 즉시 history에서 제거하고 claim API로 교환한다.
- claim 성공 시 15분 수명의 HttpOnly Bootstrap cookie를 발급한다.

Acceptance criteria:

- [ ] raw token은 HTTP request URL, access log, DB, analytics, Referer에 남지 않는다.
- [ ] token은 최소 256-bit entropy를 사용하고 rate limit을 적용한다.
- [ ] 동시에 두 브라우저가 claim해도 하나의 활성 claim lease만 존재한다.
- [ ] claim 브라우저가 종료되면 lease 만료 후 같은 설치 코드로 재claim할 수 있다.
- [ ] 비-loopback HTTP에서는 claim API 자체가 hard fail한다. 원격 설치는 사용자가 준비한 TLS reverse proxy 또는 loopback SSH tunnel만 허용한다.
- [ ] 코드 분실 시 host-local `./nudgeon setup-token rotate` 명령으로 rotate할 수 있고 이전 코드와 모든 claim lease는 즉시 폐기된다.
- [ ] Bootstrap session 만료 2분 전에 텍스트·live region 경고와 연장 CTA를 제공하고, 연장 실패 시 비밀을 제외한 입력 초안을 안전하게 복원한다.
- [ ] setup response와 page에는 `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`을 적용한다.
- [ ] setup 화면은 외부 analytics, third-party script, remote font를 로드하지 않는다.

### S2. Create Owner and workspace

**목적:** 최소 입력으로 보안 설치를 끝낸다.

입력:

- Workspace 이름
- 첫 App 이름
- Owner 이름·이메일·비밀번호
- timezone (자동 감지 후 확인)
- public base URL (자동 제안 후 검증)

동작:

- tenant, Owner, Development app, SDK key metadata를 하나의 트랜잭션으로 생성한다.
- Owner 생성 성공과 동시에 installation state를 `secured`로 전환한다.
- setup token과 mutation 권한을 영구 폐기한다. claim session은 응답 유실 복구를 위한 read-only result 조회에만 원래 TTL까지 남긴다.
- 일반 `nudgeon_session`을 발급하고 같은 wizard shell의 인증된 구간으로 이동한다.

Acceptance criteria:

- [ ] tenant·Owner·app 생성과 `secured` 전이는 같은 DB transaction에서 성공하거나 모두 rollback된다.
- [ ] `count(members)`는 설치 잠금의 권위가 아니며 singleton installation row를 `FOR UPDATE`한다.
- [ ] `MODE=single_tenant`에서 `/v1/auth/signup`은 설치 전후 모두 `404` 또는 `403`이다.
- [ ] 동시 setup 요청으로 tenant나 Owner가 두 개 생기지 않는다.
- [ ] setup 요청은 필수 `Idempotency-Key`와 request hash를 저장한다. commit 후 응답이 유실돼도 같은 claim session과 key로 동일 결과를 조회하고 일반 session을 다시 받을 수 있다.
- [ ] setup 성공 후 새로운 bootstrap mutation은 `410 Gone`을 반환한다. 같은 request의 idempotent replay와 read-only result 조회만 원래 Bootstrap TTL 안에서 허용한다.
- [ ] SDK/Server key 원문 응답이 유실돼도 Owner가 인증된 키 발급·회전 경로로 복구할 수 있다.
- [ ] public base URL은 허용 scheme/host를 검증하고 전달받은 Host header만으로 확정하지 않는다.
- [ ] 자동 생성 master key의 fingerprint와 recovery bundle export 절차를 안내한다. raw key는 브라우저에 표시하지 않는다.

> **Secure installation 완료점:** 여기까지 성공하면 activation을 건너뛰어도 다시 공개 Bootstrap 상태로 돌아가지 않는다.

Secure installation은 서비스 소유권 증명이지 운영 준비 완료가 아니다. `./nudgeon secrets backup`으로 암호화된 recovery bundle을 내보내고 별도 보관을 확인하기 전에는 NudgeOn Health가 **Critical — 복구 키 백업 미확인**을 유지하며 production readiness 표현을 금지한다.

### S3. First value — NudgeOn Test Inbox

**목적:** APNs·FCM·SMTP 크리덴셜 없이 NudgeOn의 가치를 먼저 경험한다.

기본 데이터:

- `Development` environment 전용 sample user
- `nudgeon_sample_signup` synthetic event
- 미리 채운 환영 메시지
- `nudgeon_test_inbox` internal connector

실행 경계:

- receipt/outbox, audience/targeting, send envelope, message lifecycle은 실제 제품 경로를 사용한다.
- 외부 provider transport만 Test Inbox가 대체한다.
- 모든 sample object에는 `synthetic=true`, `source=setup_wizard`를 저장한다.

Acceptance criteria:

- [ ] 사용자는 별도 credential 입력 없이 한 번의 CTA로 sample send를 시작한다.
- [ ] UI는 `실제 고객에게 발송되지 않는 테스트`임을 명확히 표시한다.
- [ ] 결과는 accepted → queued → connector → received 순서와 timestamp를 보여준다.
- [ ] `test_run_id`에서 모든 `message_id`를 조회할 수 있다.
- [ ] 새로고침·console 재시작 후 마지막 test run과 결과가 복원된다.
- [ ] sample data 전체 삭제가 가능하고 실제 app data를 삭제하지 않는다.
- [ ] Test Inbox 성공은 Real channel activation으로 집계하지 않는다.
- [ ] Test Inbox connector는 외부 provider·일반 outbound network를 호출하지 않고 sandbox lifecycle/KPI namespace만 사용한다.

> **Product activation 완료점:** 같은 Sandbox run의 `received` 증거가 저장되면 전체 온보딩은 완료로 표시할 수 있다. S4·S5·S6은 독립 권장 milestone이며 보류해도 이 증거를 취소하지 않는다.

### S4. Connect the first real event

**목적:** 사용자의 앱 또는 서버 데이터가 실제로 NudgeOn에 도착했음을 확인한다.

플랫폼 선택:

- iOS (Swift)
- Android (Kotlin)
- React Native
- Flutter
- cURL — 앱 연동 점검 (`pk_` SDK Key)
- Server — 고객 백엔드 연동 (`sk_` Server Key)

화면 요구사항:

- 선택한 플랫폼 하나의 설치·초기화·track 코드만 표시한다.
- 모바일·브라우저·cURL 앱 예제에는 실제 runtime API base URL과 해당 app의 `pk_` SDK Key를 삽입한다.
- Server 예제에만 `sk_` Server Key를 제공하고 모바일·브라우저 번들에 포함하면 안 된다는 blocking warning을 표시한다.
- key 원문이 더 이상 없으면 안전한 회전/발급 flow를 제공한다.
- 단계 진입 시 `event_challenge_id`와 예상 `insert_id` 계약을 발급한다.
- 같은 challenge의 첫 non-synthetic event에 대해 name, accepted time, projected time, request/receipt identifier, identity 결과를 표시한다.

Acceptance criteria:

- [ ] placeholder `pk_YOUR_SDK_KEY`를 복사하게 하지 않는다.
- [ ] first event accepted는 해당 app·challenge·`insert_id`가 일치하는 non-synthetic receipt로만 판정한다. 과거 event나 다른 app event는 완료시키지 않는다.
- [ ] `/v1/track`의 `202`는 receipt/outbox 영속 접수로 표현하고 저니 실행·발송·도달로 표현하지 않는다.
- [ ] first event verified는 같은 receipt가 projection store에 반영된 뒤에만 판정하고 accepted와 별도 timestamp를 저장한다.
- [ ] `sk_`는 Server 선택에서 인증 후 한 번만 복사할 수 있으며 클라이언트 플랫폼 코드·브라우저 storage·telemetry에 절대 포함되지 않는다.
- [ ] 잘못된 key, CORS/network, schema validation, clock skew를 서로 다른 해결 안내로 표시한다.
- [ ] polling은 서버 상태를 기준으로 재개되고 브라우저 메모리에만 의존하지 않는다.
- [ ] 사용자는 이 단계를 건너뛰고 Dashboard에서 다시 시작할 수 있다.

### S5. Connect one real channel

**목적:** 사용자가 지금 필요한 채널 하나만 안전하게 연결한다.

P0 선택지:

- FCM
- APNs
- `나중에 연결`

P0 출시 계약은 **FCM과 APNs를 모두 guided connector로 제공하고, 사용자는 둘 중 하나만 골라도 진행 가능**하다는 뜻이다. 이메일과 이후 알림톡·WeChat·LINE은 기존 콘솔 또는 후속 connector milestone이며 이 위자드의 출시 약속이 아니다.

채널별 증거는 다음처럼 독립 저장한다.

| 증거 | FCM/APNs 최소 조건 | 의미 |
|---|---|---|
| `credential_verified` | 공급자 인증·환경 dry-run 성공 | 연결 정보가 유효함 |
| `provider_accepted` | 공급자 성공 응답과 `provider_message_id` 저장 | 공급자가 메시지를 접수함 |
| `device_received` | 동일 `message_id`의 실기기 SDK receipt | 선택한 기기가 수신함 |
| `opened` | 동일 `message_id`의 open event | 사용자가 열었음 |

Real channel activation은 `credential_verified`에서 시작한다. `real_test_completed`는 최소 `provider_accepted`가 있어야 하며 `device_received`와 `opened`는 connector가 실제 증거를 보고한 경우에만 별도 승격한다.

Acceptance criteria:

- [ ] 채널 선택 전에는 모든 provider form을 동시에 렌더링하지 않는다.
- [ ] FCM은 JSON 파일 업로드와 필수 필드 미리검사를 지원한다.
- [ ] APNs는 `.p8` 파일, Key ID, Team ID, Bundle ID, sandbox/production을 분리한다.
- [ ] 비밀 원문은 브라우저 analytics·console log·server log에 남지 않는다.
- [ ] credential 상태는 saving / verifying / verified / error / expired를 구분한다.
- [ ] 검증 오류는 필드·권한·환경 불일치 중 가능한 원인을 구체적으로 설명한다.
- [ ] 실제 provider 연결을 건너뛰어도 Secure installation과 Sandbox activation은 유지된다.
- [ ] Push 테스트 대상 단계는 앱 설치 → 알림 권한 `granted` → active token → identify → 단일 device 선택을 각각 검증한다.
- [ ] 위자드 발송은 사용자가 명시적으로 고른 단일 endpoint만 허용하며 segment·production audience 선택과 다중 발송을 차단한다.

### S6. Send to me and finish

**목적:** 선택한 실제 채널의 가능한 가장 강한 증거를 보여주고 다음 작업 하나를 제안한다.

타임라인 상태:

- API accepted
- queued
- connector attempted
- provider accepted 또는 failed
- delivered / opened (해당 connector가 보고할 때만)

Acceptance criteria:

- [ ] `queued`만으로 성공 체크를 켜지 않는다.
- [ ] connector manifest가 보고하지 않는 lifecycle은 `미지원`으로 표시하고 0건과 구분한다.
- [ ] 실기기·provider 조건이 없으면 Sandbox 완료와 실제 채널 미완료를 동시에 보여준다.
- [ ] 재시도는 같은 `message_id` 계약과 idempotency 정보를 유지한다.
- [ ] 실패 후 credential 수정 또는 테스트 대상 변경으로 돌아갈 수 있다.
- [ ] 대상 준비가 끝나지 않으면 send CTA를 비활성화하고 누락된 권한·token·identity·environment를 각각 안내한다.
- [ ] 단일 선택 endpoint와 channel environment를 확인하는 마지막 confirmation을 거친다.
- [ ] 완료 화면의 primary CTA는 `첫 저니 만들기` 하나이며 secondary CTA는 `NudgeOn Health 보기`다.

## 8. 설치·온보딩 상태 모델

### 8.1 Installation state

서버에는 설치당 하나의 권위 있는 행만 존재한다.

```text
unclaimed
  → claimed (lease_expires_at)
  → secured (Owner session issued, bootstrap revoked)
existing invariant mismatch
  → recovery_required (host-local recovery only)
```

- `unclaimed`: setup token hash 존재, 공개 mutation은 claim만 가능
- `claimed`: 유효한 Bootstrap cookie 하나가 Owner 생성 가능
- `secured`: bootstrap token hash 제거, 새 bootstrap mutation 영구 차단; 원래 claim TTL 안의 동일 setup-result 복구만 허용
- `recovery_required`: 기존 member/tenant/app 또는 secret 상태가 singleton과 모순돼 자동 진행을 금지

권장 필드:

| 필드 | 설명 |
|---|---|
| `installation_id` | 로그·진단용 비밀이 아닌 UUID |
| `state` | `unclaimed`, `claimed`, `secured`, `recovery_required` |
| `setup_token_hash` | raw token 저장 금지 |
| `setup_token_version`, `setup_token_expires_at` | rotate·만료와 stale token 거부 |
| `claim_session_hash`, `claim_nonce` | lease를 실제 Bootstrap cookie holder에 결박 |
| `claim_expires_at` | browser crash 복구용 lease |
| `claimed_at` | claim 감사 시각 |
| `secured_at` | Owner 생성·잠금 시각 |
| `tenant_id`, `owner_id`, `app_id` | secured 결과와 singleton invariant |
| `setup_idempotency_key_hash`, `setup_request_hash` | commit 후 응답 유실의 exact replay |
| `record_version` | compare-and-swap와 감사 가능한 상태 전이 |
| `master_key_fingerprint`, `master_key_backup_confirmed_at` | raw key 없이 recovery readiness 추적 |
| `installed_version` | 설치 당시 NudgeOn 버전 |
| `schema_version` | 설치 상태 스키마 버전 |

DB는 installation singleton 제약, 유효 state별 필수·금지 필드 CHECK, tenant/Owner/app의 unique invariant를 강제한다. claim·rotate·setup 전이는 row lock 또는 동등한 compare-and-swap으로 한 번만 성공한다.

### 8.2 Activation state

tenant/app 단위로 저장하되 정상 경로를 하나의 선형 enum으로 압축하지 않는다. Sandbox, 실제 이벤트, 실제 채널은 독립 milestone이다.

| milestone | 필수 증거 | Product 의미 |
|---|---|---|
| `sandbox_verified` | Test Inbox의 동일 `test_run_id`·`message_id`가 `received` | **Product activation 완료** |
| `event_accepted` | challenge와 일치하는 non-synthetic receipt/outbox commit | 실제 데이터 접수 |
| `event_verified` | 같은 receipt의 projection 확인 | 실제 이벤트 연결 검증 |
| `channel_credential_verified` | 선택 connector dry-run | Real channel activation 시작 |
| `channel_provider_accepted` | 같은 `message_id`의 provider success와 provider ID | 실제 test 최소 완료 |
| `channel_device_received` | 같은 `message_id`의 SDK receipt | 실기기 도달 증거 |
| `channel_opened` | 같은 `message_id`의 open event | 열기 증거 |

`onboarding_completed` predicate는 `installation.state=secured AND sandbox_verified_at IS NOT NULL`이다. 실제 이벤트와 채널은 독립 권장 milestone이며 `completed` 뒤에도 `pending`, `skipped`, `verified` 상태로 이어갈 수 있다. 그러므로 화면의 전체 완료와 real-channel readiness를 같은 체크로 표시하지 않는다.

권장 필드:

- `tenant_id`, `app_id`, `environment`, `record_version`, `updated_by`
- 각 step의 `status` (`not_started`, `in_progress`, `verified`, `skipped`, `blocked`), `evidence_ref`, `started_at`, `verified_at`, `skipped_at`, `skipped_reason`
- `resume_target`, `selected_platform`, `selected_channel`
- `sandbox_test_run_id`, `sandbox_verified_at`
- `event_challenge_id`, `first_real_event_receipt_id`, `event_accepted_at`, `event_verified_at`
- `credential_id`, `credential_verified_at`
- `real_test_run_id`, `provider_accepted_at`, `device_received_at`, `opened_at`
- `onboarding_completed_at`, `updated_at`

브라우저 상태는 선택 중인 탭·비밀이 아닌 입력 초안에만 사용한다. 완료 체크는 서버 상태에서 파생한다.

## 9. API 계약 초안

정확한 OpenAPI shape은 구현 단계에서 고정하되 역할 경계는 다음을 따른다.

### 9.1 공개·Bootstrap session

| Method | Path | 인증 | 역할 |
|---|---|---|---|
| `GET` | `/v1/bootstrap/status` | 없음 | mode, installation state, version의 최소 정보 |
| `POST` | `/v1/bootstrap/claim` | setup token | 짧은 Bootstrap cookie 발급 |
| `POST` | `/v1/bootstrap/setup` | Bootstrap cookie | Owner·workspace·app 원자 생성 |
| `GET` | `/v1/bootstrap/setup-result` | Bootstrap cookie + Idempotency-Key | 응답 유실 시 같은 setup 결과의 read-only 복구 |

token rotate는 HTTP API가 아니라 host-local `./nudgeon setup-token rotate` 관리 명령만 사용한다. `/v1/bootstrap/setup` 성공 응답은 일반 Owner session을 설정한다. 그 시점부터 activation API는 일반 Session·Owner 권한을 사용한다.

### 9.2 인증된 activation

| Method | Path | 역할 |
|---|---|---|
| `GET` | `/v1/apps/{appId}/onboarding` | 서버 진행 상태 조회 |
| `POST` | `/v1/apps/{appId}/onboarding/sandbox-runs` | sample data와 Test Inbox run 생성 |
| `GET` | `/v1/apps/{appId}/onboarding/runs/{testRunId}` | lifecycle 타임라인 조회 |
| `POST` | `/v1/apps/{appId}/onboarding/platform` | 선택 플랫폼 저장 |
| `POST` | `/v1/apps/{appId}/onboarding/event-challenges` | 특정 app·run에 결박된 첫 이벤트 challenge 생성 |
| `POST` | `/v1/apps/{appId}/onboarding/steps/{step}/skip` | 이유를 포함한 step-scoped idempotent 보류 |
| `POST` | `/v1/apps/{appId}/onboarding/steps/{step}/resume` | 저장 상태에서 해당 step 재개 |
| `POST` | `/v1/apps/{appId}/onboarding/complete` | 완료 증거 검증 후 상태 전환 |

기존 credential, ingest status, test push API를 재사용할 수 있다. 단, onboarding 완료 여부는 각 응답의 일회성 UI 상태가 아니라 저장된 receipt·credential·test run을 조합해 서버가 계산한다.

위 표는 API service의 canonical path다. 브라우저는 항상 same-origin `/api/v1/...`를 호출하고 gateway는 `/api/v1/*`에서 `/api` prefix만 제거해 API `/v1/*`로 전달한다.

## 10. Compose와 런타임 요구사항

### 10.1 기본 기동 계약

```bash
./nudgeon up
./nudgeon status
```

기본 설치는 다음을 만족해야 한다.

- 사용자가 `.env`를 복사하거나 master key를 직접 생성하지 않는다.
- `./nudgeon up`은 host CLI로 Compose를 기동하고 설치 URL을 호출한 TTY에만 표시한다. secret을 container log에서 찾도록 안내하지 않는다.
- release artifact는 source build가 아닌 versioned image를 기본으로 사용한다.
- init/migrator는 명시적 성공 후 다음 서비스가 시작된다.
- gateway 한 곳만 public port를 열고 DB·Redis·worker metrics는 내부 network에 둔다.
- 개발 포트와 `seed.dev.sql`은 별도 dev override에서만 사용한다.
- master key, setup token, DB credential은 root-only secret volume 또는 지원되는 secret store에 저장한다.
- API와 worker는 `*_FILE` 방식 또는 동등한 file secret 경로를 지원한다.

API 시작 전 상태는 최소 `setup-status` sidecar가 담당한다. init·migrator·필수 서비스는 secret 없는 versioned JSON snapshot을 전용 read-only status volume에 atomic write하고, sidecar가 이를 `/setup-status/v1/state`로 제공한다. sidecar는 Docker socket, DB credential, master key를 mount하지 않는다.

- gateway `/livez`: gateway process 응답
- gateway `/setup-readyz`: setup shell asset과 setup-status sidecar 접근 가능
- `/setup-status/v1/state`: component별 `starting`, `waiting`, `ready`, `blocked`, revision, redacted error code
- `/api/v1/readyz`: 전체 API system readiness; 준비 전에는 `503`

Docker/LB의 gateway healthcheck는 `/setup-readyz`를 사용해 API migration 중에도 shell을 유지한다. 제품의 “NudgeOn ready” 판정은 `/api/v1/readyz`와 worker readiness를 함께 사용한다.

### 10.2 Same-origin gateway

- `/` → console
- `/api/v1/*` → `/api` prefix를 제거해 API `/v1/*`로 전달
- `/setup-status/v1/*` → API 준비 전에도 sidecar가 제공하는 최소 상태

console의 browser base는 `/api`, SSR/internal base는 Compose service URL로 고정하고 둘을 섞지 않는다. `NEXT_PUBLIC_API_URL` 변경을 위해 이미지를 다시 빌드하지 않는다. SSE·streaming 경로도 `/api/v1/*`에서 buffering 없이 같은 rewrite를 사용한다.

session cookie는 Domain을 생략하고 Path=`/`, HttpOnly, SameSite=Lax를 기본으로 한다. Bootstrap cookie는 Domain 생략, Path=`/`, HttpOnly, SameSite=Strict이며 loopback을 제외한 HTTPS에서 항상 Secure다. gateway는 allowlist된 proxy hop의 Forwarded 정보만 신뢰하고 state-changing session API는 canonical Origin과 CSRF token을 함께 검증한다.

`PUBLIC_BASE_URL`은 webhook·딥링크·표시용 canonical URL로 저장한다. reverse proxy를 쓸 때는 신뢰할 proxy CIDR을 설정하고 임의의 `X-Forwarded-*`를 신뢰하지 않는다.

### 10.3 Secret initialization

- 첫 빈 volume에서만 cryptographically secure secret을 생성한다.
- 기존 secret이 있으면 덮어쓰지 않는다.
- 부분 생성 뒤 crash해도 atomic rename 또는 동등한 방식으로 복구한다.
- secret 내용을 container stdout/stderr에 출력하지 않는다. setup URL의 token은 host-local CLI가 호출한 TTY에만 표시한다.
- 백업·복구 문서에는 어떤 secret이 데이터 복호화에 필요한지 명시한다.
- PostgreSQL과 ClickHouse migration은 각각 하나의 권위 있는 경로, version/checksum ledger, 동시 실행 lock을 사용한다. DB image entrypoint init mount와 migrator의 이중 적용을 금지한다.
- 두 DB 모두 migration 중단 후 재실행은 완료 revision을 건너뛰고 불일치 checksum·부분 statement를 `recovery_required`로 차단한다. readiness는 두 ledger의 요구 revision을 확인한다.
- 기존 설치 upgrade는 tenant/member/app invariant가 맞을 때만 `secured`로 이관하며 모순 시 `recovery_required`가 된다.

### 10.4 기존 설치 복구

`recovery_required`는 영구 막힘 상태가 아니다. P0 release bundle은 browser가 아닌 host-local `./nudgeon recover` 경로를 제공한다.

- `./nudgeon recover inspect`는 legacy dev tenant/app/known key 후보, 실제 Owner 연결, migration 상태를 read-only로 출력하고 secret은 redaction한다.
- legacy seed 정리는 고정 ID만으로 판단하지 않고 알려진 seed fingerprint와 참조 관계를 함께 검사한다. 사용자가 만든 데이터나 수정된 object는 자동 삭제하지 않는다.
- 변경 전 `./nudgeon backup`으로 생성한 backup ID를 요구하고 dry-run diff, 실제 Owner 선택, 명시적 apply를 분리한다.
- apply는 비활성화/격리를 우선하며 삭제가 필요하면 별도 확인과 감사 로그를 남긴다.
- 성공 후 singleton의 tenant/Owner/app invariant와 PG·CH revision을 다시 검증해야만 `secured`로 전환한다.

## 11. Readiness와 NudgeOn Health

### 11.1 Endpoint 의미

| Endpoint | 성공 조건 | 실패 응답 |
|---|---|---|
| API `/livez` | 프로세스 이벤트 루프 응답 | `503` |
| API `/readyz` | PG·Redis·ClickHouse 연결, schema revision, master-key self-test | `503` + 비밀 없는 component status |
| Worker `/livez` | 프로세스 응답 | `503` |
| Worker `/readyz` | required stores, consumer groups, connector registry 초기화 | `503` |
| Gateway `/livez` | gateway process 응답 | `503` |
| Gateway `/setup-readyz` | static setup shell과 setup-status sidecar routing 가능 | `503` |

외부 APNs·FCM·SMTP credential 오류는 시스템 readiness를 내리지 않는다. 이는 channel health와 activation 화면에서 분리한다.

### 11.2 설치 진단 severity

- **Blocking:** DB 연결, migration, schema mismatch, master key, worker 미기동
- **Critical operational readiness:** master-key recovery bundle 백업 미확인, backup/restore proof 없음
- **Warning:** loopback 개발 설치의 HTTPS 없음, scheduled data backup 미설정, 실제 채널 없음, outbound provider 미검증
- **Passed:** 각 검사의 timestamp와 version

진단 bundle은 사용자가 미리 보고 복사할 수 있어야 하며 secret·PII redaction test를 통과해야 한다.

## 12. 오류·중단·복구

| 상황 | 요구 동작 |
|---|---|
| 브라우저 새로고침 | 서버 상태로 동일 단계 복원 |
| console container 재시작 | Owner session이 유효하면 activation 복원 |
| API 재시작 | installation·activation 상태 보존 |
| claim 후 브라우저 종료 | lease 만료 후 재claim 가능 |
| Owner transaction 실패 | tenant/member/app/secured 상태 모두 rollback |
| Owner commit 후 HTTP 응답 유실 | 같은 claim session·Idempotency-Key로 결과 조회와 session 재발급; 중복 생성 없음 |
| migration 실패 | 설치 차단, 실패 revision 표시, 데이터 파괴 없는 재시도 |
| Test Inbox worker 지연 | run을 유지하고 polling/backoff; 새 중복 run 자동 생성 금지 |
| credential 검증 실패 | secret 재노출 없이 교체·재검증 가능 |
| 실제 test send 결과 불명 | `unknown` 또는 `provider accepted`로 유지; delivered로 승격 금지 |
| setup 완료 후 `/setup` 접근 | 로그인 사용자는 onboarding 또는 dashboard, 비로그인은 login으로 이동 |
| 기존 설치 invariant 불일치 | `recovery_required`와 host-local inspect/dry-run/backup/apply 절차 표시 |
| 비-loopback HTTP claim | token 교환 전에 hard fail하고 TLS proxy 또는 SSH tunnel 안내 |

## 13. 보안 요구사항

- **SEC-001:** setup token은 256-bit 이상, hash at rest, constant-time comparison을 사용한다.
- **SEC-002:** Bootstrap cookie는 HttpOnly, SameSite=Strict, 짧은 TTL이며 remote setup은 HTTPS가 아니면 claim 전에 hard fail한다.
- **SEC-003:** claim/setup에는 rate limit, Origin/CSRF 검증, 구조화 감사 로그를 적용한다.
- **SEC-004:** 최초 Owner·tenant·app·installation lock은 한 transaction과 DB lock으로 처리한다.
- **SEC-005:** single-tenant signup 우회 경로가 없어야 한다.
- **SEC-006:** setup 완료 후 token material을 폐기하고 새 공개 mutation은 `410`을 반환한다. 원래 claim TTL의 동일 setup-result 복구만 예외다.
- **SEC-007:** dev seed·고정 API key는 self-hosted release compose에 포함되지 않는다.
- **SEC-008:** secret은 logs, browser storage, analytics, support bundle, error response에 포함되지 않는다.
- **SEC-009:** container image는 고정 version 또는 digest를 사용하고 release 서명·SBOM 검증 경로를 제공한다.
- **SEC-010:** DB·Redis·ClickHouse·worker metrics는 기본 host port로 노출하지 않는다.
- **SEC-011:** setup page는 no-store/no-referrer/CSP를 적용하고 third-party code를 실행하지 않는다.
- **SEC-012:** 기존 설치 자동 이관은 데이터 invariant를 검증하며 모순을 임의 수정하지 않는다.
- **SEC-013:** setup commit은 Idempotency-Key, request hash, read-only result recovery로 응답 유실에도 exactly-once다.
- **SEC-014:** master-key recovery bundle은 host-local로만 export하고 fingerprint·backup 확인은 감사 가능하게 저장한다.

## 14. 접근성·반응형·문구

- 목표 적합성은 WCAG 2.2 AA로 검증하며 소스·스크린샷만으로 준수 판정을 내리지 않는다.
- 모든 단계는 키보드만으로 완료할 수 있다.
- 단계 indicator는 색상 외에 번호·상태 텍스트·아이콘 대체명을 제공한다.
- progress 변화는 `aria-live=polite`, blocking error는 적절한 alert semantics로 알린다.
- 파일 업로드는 drag-and-drop 외에 표준 file input을 제공한다.
- focus는 단계 이동 시 제목으로 이동하고 뒤로 가면 이전 control에 복원한다.
- 오류는 입력값을 지우지 않고 필드와 summary 양쪽에 연결한다.
- 320px 폭에서 가로 스크롤 없이 핵심 설치·오류 복구를 완료할 수 있다.
- 주요 touch target은 최소 44×44 CSS px, 본문 대비는 4.5:1, UI·focus indicator는 3:1 이상이다.
- 200% 확대, reduced motion, KO/EN 30% 문자열 확장 fixture에서 핵심 동작이 유지된다.
- copy는 `설치됨`, `접수됨`, `공급자 접수`, `도달`, `열림`을 구분한다.
- Bootstrap TTL 만료 2분 전에 focus를 빼앗지 않는 live-region 경고를 제공하고 키보드로 연장할 수 있다. 만료 후 비밀을 제외한 입력값과 오류 연결을 복원한다.
- secret field는 붙여넣기 가능하고 기본 masking한다. reveal은 현재 상태와 접근성 이름을 명확히 제공하는 토글 버튼이며 자동 재마스킹 전 경고를 제공한다.
- 출시 접근성 E2E는 최소 VoiceOver/Safari와 NVDA/Chrome에서 claim → Owner → Test Inbox 흐름, focus order, modal focus trap, live-region announcement를 assertion한다.

## 15. 로컬 분석 이벤트와 개인정보

최소 로컬 이벤트:

- `setup_viewed`
- `setup_claim_succeeded`, `setup_claim_failed(reason_class)`
- `setup_system_check_completed(result)`
- `setup_owner_created`
- `onboarding_sandbox_started`, `onboarding_sandbox_received`
- `onboarding_platform_selected`
- `onboarding_real_event_accepted`, `onboarding_real_event_verified`
- `onboarding_channel_selected`, `onboarding_credential_verified`
- `onboarding_real_test_result(evidence)`
- `onboarding_completed`, `onboarding_skipped(step)`

금지 필드:

- email, name, external_id, push token
- raw credential, API key, setup token
- event payload와 message body
- full URL query/fragment

Self-hosted 외부 telemetry는 opt-in이며, 전송 전 payload를 사용자가 확인할 수 있어야 한다.

## 16. 구현 순서

### Slice A — Safe boot

- [x] `./nudgeon up`, status, setup-url, doctor, logs, down host CLI
- [x] dev seed·내부 서비스 host port를 분리한 전용 Safe Boot Compose
- [x] host-private state directory의 원자적 secret initialization과 `*_FILE` 전달
- [x] setup-status sidecar, API·worker readiness, loopback gateway setup shell
- [ ] source build 대신 versioned release image를 기본으로 사용하는 release bundle
- [ ] 지원 clean host·architecture와 실패 복구를 관통하는 Slice A 출시 증거

### Slice B — Atomic Bootstrap

- `installation_state` migration
- claim token·Bootstrap cookie
- Owner transaction·idempotent response recovery·single-tenant signup 차단
- setup 완료 잠금·보안 테스트
- legacy install inspect/recovery CLI

### Slice C — Resumable activation

- `onboarding_progress` migration/API
- wizard shell·resume/skip
- runtime API URL·real key snippets

### Slice D — Test Inbox

- internal connector·sample objects
- lifecycle timeline·sample cleanup
- test run E2E

### Slice E — One real channel

- FCM/APNs guided upload
- credential validation states
- actual test run evidence and failure recovery

### Slice F — Release proof

- clean Linux amd64 and Docker Desktop arm64 installs
- concurrent takeover, restart, migration failure, secret redaction tests
- browser keyboard/accessibility pass
- docs and support bundle

각 Slice는 독립 배포 가능한 additive change로 만든다. 새 wizard가 완성되기 전까지 기존 `/onboarding`은 feature flag 뒤 fallback으로 유지한다.

## 17. E2E acceptance matrix

| ID | 시나리오 | 통과 조건 |
|---|---|---|
| E2E-01 | 빈 Linux host 기본 설치 | 수동 `.env` 없이 secured, Test Inbox received |
| E2E-02 | Apple Silicon Docker Desktop | 지원 image로 동일 결과; 미지원이면 출시 blocker |
| E2E-03 | 100개 병렬 claim/setup | 정확히 tenant 1, Owner 1, app 1 |
| E2E-04 | claim 후 20분 중단 | lease 만료 후 안전하게 resume, 중복 Owner 없음 |
| E2E-05 | Owner transaction 중 DB 오류 | 부분 tenant/member/app 없음, 재시도 가능 |
| E2E-06 | API·console 재시작 | secured와 activation 단계 복원 |
| E2E-07 | ClickHouse unavailable | `/readyz` 503, wizard blocking, 복구 후 자동 진행 |
| E2E-08 | wrong master key on existing data | readiness blocking, credential overwrite/재생성 금지 |
| E2E-09 | sample send | test_run → message_id → received 전체 추적 |
| E2E-10 | first real `/v1/track` | exact challenge receipt의 accepted와 projection verified를 분리 표시 |
| E2E-11 | FCM/APNs invalid credential | field/permission/environment 오류, secret leak 없음 |
| E2E-12 | provider accepted but no receipt | delivered 미표시, evidence 그대로 유지 |
| E2E-13 | setup 완료 후 public mutation | 새 mutation `410`; 같은 idempotent result만 TTL 내 복구 |
| E2E-14 | diagnostics export | fixture secret·PII 전부 redacted |
| E2E-15 | keyboard/screen reader | VoiceOver/Safari·NVDA/Chrome에서 focus·timeout·live region assertion 통과 |
| E2E-16 | forged Host·Forwarded·Origin·CSRF | public base URL·cookie·Owner 생성에 영향 없이 거부 |
| E2E-17 | PG migrator kill·동시 실행·checksum mismatch | 부분 ready 없음, 안전한 resume 또는 recovery_required |
| E2E-18 | CH migrator statement 중단·동시 실행·checksum mismatch | 이중 적용 없음, 안전한 resume 또는 recovery_required |
| E2E-19 | 기존 single-tenant clean upgrade | invariant가 맞으면 secured 이관 |
| E2E-20 | legacy dev seed와 실제 Owner 공존 | inspect/dry-run/backup/apply 후 데이터 보존·secured 또는 안전한 차단 |
| E2E-21 | Owner commit 직후 response drop | 같은 key로 결과·session 복구, tenant/Owner/app 각 1개 |
| E2E-22 | 비-loopback HTTP claim | token 교환·cookie 발급 전 hard fail |
| E2E-23 | API down 또는 migration 중 | gateway setup shell과 redacted component status 유지 |
| E2E-24 | Push 단일 대상 test | 선택 endpoint 하나만 발송, segment·다중 audience 차단 |

모든 E2E 결과는 image digest, host, architecture, Docker/Compose version, 시작 시각, 종료 시각, pass/fail/skip과 원본 로그 위치를 남긴다.

## 18. Definition of Done

P0 Docker Setup Wizard는 다음을 모두 만족해야 완료다.

- [ ] 지원되는 clean host에서 문서 그대로 재현되는 `./nudgeon up`
- [ ] 수동 master key·API URL build·dev seed 없음
- [ ] installation claim과 최초 Owner 생성의 동시성·선점 방지 증거
- [ ] true readiness와 secret-redacted diagnostics
- [ ] setup token이 container log·DB·browser history에 없고 remote HTTP claim이 hard fail
- [ ] Owner 생성 뒤 공개 Bootstrap 영구 잠금
- [ ] commit 응답 유실의 idempotent 복구와 legacy install recovery proof
- [ ] refresh/restart 가능한 server-backed activation
- [ ] provider credential 없는 Test Inbox `received` 증거
- [ ] 실제 event와 synthetic event의 명확한 분리
- [ ] 실제 채널 하나의 guided verification과 상태별 타임라인
- [ ] master-key recovery bundle export와 NudgeOn Health backup 확인 상태
- [ ] queued/provider accepted/delivered/opened 의미 분리
- [ ] amd64·arm64 clean-install evidence
- [ ] 접근성·보안·복구 E2E 통과
- [ ] DEPLOY, API, CONSOLE-GUIDE, RELEASE-CHECKLIST가 구현 상태와 일치

코드·단위 테스트·Compose config 검사는 필요조건일 뿐이다. 빈 서버 설치, 브라우저, 실제 worker lifecycle, 실패 복구와 보안 경쟁 조건을 통과하기 전에는 WordPress급 설치 경험이나 production-ready로 안내하지 않는다.

## 19. 예상 변경 영역

| 영역 | 예상 변경 |
|---|---|
| release bundle `./nudgeon` | up/status/setup-url/token rotate/backup/recovery host CLI |
| `deploy/` | release compose, dev override, init secrets, gateway, health dependency |
| `db/postgres/` | `installation_state`, `onboarding_progress`, dev seed 분리 |
| `apps/api/src/auth/` | claim, atomic setup, signup 차단, bootstrap lock |
| `apps/api/src/health/` | true readiness와 503 semantics |
| `apps/api/src/apps/` | onboarding state·test run 조회 |
| `apps/console/src/app/setup/` | anonymous claimed setup shell |
| `apps/console/src/app/onboarding/` | authenticated resumable activation |
| `apps/worker/` | worker readiness, Test Inbox connector/lifecycle |
| `packages/openapi/` | setup·onboarding generated contract |
| `tests/` | clean install·takeover·restart·redaction·a11y E2E |
| `docs-public/` | 배포, API, 콘솔, 출시 증거 동기화 |

## 20. 참고 원칙

- WordPress의 공식 설치 안내는 5분 설치와 호스트의 자동 설치를 기본 기대치로 둔다: <https://wordpress.org/documentation/article/faq-installation/>
- WordPress 플러그인은 관리자 화면 안에서 검색·설치·활성화·업데이트한다: <https://wordpress.org/documentation/article/manage-plugins/>
- WordPress Site Health는 Critical, Recommended, Passed 상태와 상세 진단을 제공한다: <https://wordpress.org/documentation/article/site-health-screen/>
- NudgeOn의 현재 배포 경계는 [배포 가이드](DEPLOY.md)와 [출시 체크리스트](RELEASE-CHECKLIST.md)를 따른다.
