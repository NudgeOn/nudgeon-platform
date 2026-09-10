# NudgeOn 출시 체크리스트 — 베타까지 남은 것

**2026-09-10 기준 (`main` PR #20까지).** 현재 상태는 **파트너 베타 후보**다. 실제 단말로 푸시 1건이 왕복했고(수신·열기·리포트 대사), 발송·저니·설치·격리·백업의 핵심 게이트를 자동화된 시험으로 닫았다. 아래 §2의 항목은 사람·자격증명·실환경이 필요해 코드만으로는 닫을 수 없다. 이 문서가 상태의 단일 출처이며, 날짜별 상세는 [`qa/`](qa/README.md)와 각 시험 러너의 README에 있다.

> **허용하는 공개 표현:** "오픈소스, `./nudgeon up` 한 명령으로 설치, 설치 코드로 첫 Owner 생성, 실기기 푸시 검증됨(파트너 베타)."
>
> **아직 금지하는 표현:** "production-ready", "정확히 한 번 전달", "관리형 SaaS 제공", "4개 SDK 정식 배포 완료".

## 1. 닫힌 게이트 (실행 증거 있음)

| 게이트 | 결과 | 증거 |
|---|---|---|
| 푸시 페이로드 계약 (R-01) | 문서·worker·4 SDK 재대조로 어긋남 5건 정정(journey_id 미방출, image_url 폐기, silent 미문서화, Android 표시 책임, 브리지 Maven 좌표). 골든 테스트 3케이스, Android 표시 에뮬레이터 확인 | PR #22; SDK 0.1.2; [계약](PUSH-CONTRACT.md) |
| 실기기 첫 푸시 (M-1) | Android(FCM)·iOS(APNs sandbox) 각 1건 수신→탭. 외부 앱(worshiplog) 서버 track → 이벤트 트리거 저니 → 2단말 발송 | `docs/dev` 원장 M-1, [첫 실기기 런북](FIRST-REAL-PUSH.md) |
| message_id 계보 (IT-3) | payload → message_log → 푸시 data 3곳 일치. push·email·message 세 채널이 한 SendLoop 상태기계(리스·재시도·DLQ) | PR #5, #8; `tests/ops/dlq-storage` |
| 도달·열기 리포트 대사 (IT-8) | 발송 원장 → 실제 `/v1/track` → CH → 독립 재집계 == 리포트 API. 대사 중 리포트 결함(Android 도달 0) 발견·수정 | PR #9; `tests/e2e/delivery-report-reconcile.mjs` |
| 선형 저니 E2E (M-3) | 실 PG + 시간 가속 4일. 기상 시각·이탈·발송 귀속·리포트 원천 정합. CI에서 실 PG로 실행 | PR #10, #11; `linear_journey_m3_test.go` |
| 중복 발송 카오스 (M-4) | 워커 SIGKILL ×10, 3,000명: message_log 고유 3,000. 공급자 실수신 3,001 → **중복 1** (공급자 응답 직후·커밋 전 kill = at-least-once 창). SDK는 `message_id`로 중복 표시를 억제 | PR #10, #12; `tests/ops/send-chaos` |
| 크래시 회수 지연 | 5~10분 → 1분 (리퍼 60s·하트비트·PG idle-in-transaction 30s·SKIP LOCKED) | PR #12 |
| 스케줄러 정확도 (O-3) | 1만 동시 기상 p99 31.7s → 2.5s (틱 내 병렬 16) | PR #15; `tests/ops/scheduler-accuracy` |
| 교차 테넌트 격리 (M-6) | 컨트롤러 소스에서 뽑은 85 라우트 중 앱/멤버 범위 55 + 웹훅 1을 B의 실제 id로 대입 → 위반 0. 첫 실행에서 접근 검사 순서 결함 4건 수정 | PR #14; `tests/isolation` |
| 셀프호스팅 재현 (M-7) | 깨끗한 clone → `./nudgeon up` 1분 37초 → status 6/6 → setup 화면 | `docs/dev` 원장 M-7 |
| 설치 소유권 (Slice B) | 설치 코드 claim(15분 lease, 동시 1) → Owner 원자 생성(Idempotency-Key replay) → 영구 잠금, signup 404, 코드 rotate, 복구 번들 `secrets backup/restore`, 마스터키 fingerprint | PR #16, #18; `tests/e2e/bootstrap-claim.mjs` 31건 |
| 백업·복구 (I-6) | 별도 compose 프로젝트에 복원: PG 28·CH 10 테이블 행 수 일치, 세션 쿠키 유효, 크리덴셜 복호화. RTO 26초 | PR #13; `tests/ops/backup-restore` |
| 워커 자동 복구 | `restart: unless-stopped`, 컨테이너 SIGTERM 뒤 재기동 확인 | PR #9 |
| 마이그레이션 직렬화 | advisory lock + `schema_migrations` 체크섬. CI Go 잡에 실 PG 서비스 (그 전까지 실 PG 테스트가 CI에서 실행된 적 없음) | PR #7 |
| 콘솔 i18n (U-12) | 전 화면 ko/en, 카탈로그 키 동치 테스트, 17화면 순회 MISSING 0 | PR #17, #19, #20; [콘솔 안내](CONSOLE-GUIDE.md) |
| 온보딩 드라이런 (M-2 일부) | 깨끗한 인스턴스에서 문서만으로 가입 → FCM 등록 → 첫 이벤트까지 6분. 결함 4건 수정 | PR #9 |

## 2. 베타 전에 남은 것 — 사람·자격증명·실환경 필요

| # | 항목 | 필요한 것 | 완료 조건 |
|---|---|---|---|
| B-1 | SDK 0.1.2 배포 (0.1.1은 미게시라 건너뜀) | Android: 태그 0.1.2의 bundle 워크플로 산출물을 Central Portal에 업로드. RN: npm, Flutter: pub.dev 첫 배포 자격증명 | 4 SDK 공개 좌표로 신규 앱 설치·시작·실수신 |
| B-2 | 실단말 재검증 | Fold3·iPhone 연결 | 0.1.2 SDK로 M-1 재현 + 중복 표시 억제 + Android SDK 알림 표시(3상태) 확인 |
| B-3 | 외부인 온보딩 (M-2) | 외부 개발자 3명 | 문서만으로 30분 내 4단계 완주 |
| B-4 | 관리형 DB (M-9) | RDS·ElastiCache·외부 CH 접근 | TLS·인증·재연결·migration 경합 E2E 통과 |
| B-5 | 부하 (PT-1~8, M-5) | 프로덕션 유사 환경 (로컬 Docker VM은 09-04 사전 점검에서 NO_GO) | 5,000 ev/s·100만 토큰·24h soak 원본 수치 |
| B-6 | 4플랫폼 계약 테스트 (M-8) | B-1 이후 | contract-tests 전 항목 통과 |
| B-7 | 파일럿 리허설 (M-10) | 파일럿 고객 시나리오 | 거래성 카테고리 포함 스테이징 재현 |

## 3. 베타 이후 (범위 밖으로 명시)

- **정확히 한 번 전달**: 공급자 응답 뒤 커밋 전 크래시 창은 at-least-once다. SDK가 `message_id`로 화면 중복을 막고, 리포트는 `uniqExact(message_id)`로 센다.
- **설치 위저드 Slice C~F**: Test Inbox, versioned release image, 공개 base URL 검증, Health 화면의 "복구 키 백업 미확인" 표시 — [PRD](DOCKER-SETUP-WIZARD-PRD.md).
- **관리형 서비스**: 가입/청구/리전/지원 체계 미정.
- **추가 채널**: 실제 채널은 FCM/APNs 푸시·이메일(SMTP/SES/NHN/Resend). 알림톡은 커넥터 계약과 Mock 벤더까지.
- **세그먼트 정기 평가·병합 귀속·삭제 FK 잔여**: `docs/dev` sub-01/02/07 원장.

## 4. 판정 규칙

Go는 실행 증거(러너·로그·PR)가 있을 때만 적는다. 단위 테스트 수·코드 존재·과거 이미지의 성공을 승인으로 쓰지 않는다. 항목을 닫을 때 검사 커밋·환경·명령·원본 로그·제외 범위를 함께 남긴다.
