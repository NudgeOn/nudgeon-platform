# NudgeOn 콘솔 화면 안내

2026-09-02 기준 실제 화면입니다. `docker compose --profile full --profile app up`으로 띄운 인스턴스에서 데모 테넌트를 만들어 캡처했습니다. 숫자와 이름은 데모 데이터입니다.

전체 화면 목록: [`assets/console/`](assets/console/)

---

## 1. 시작하기

### 가입 · 로그인

셀프호스팅 기본값은 `MODE=single_tenant`로, 가입 대신 최초 관리자 셋업 화면이 열립니다. `MODE=multi_tenant`이면 가입 시 테넌트·Owner·기본 앱·SDK Key·Server Key가 한 번에 만들어집니다.

| 로그인 | 가입 |
|---|---|
| ![로그인](assets/console/01-login.png) | ![가입](assets/console/02-signup.png) |

### 대시보드

오늘 발송·실패·생략, 활성 저니, DAU/MAU, 앱 삭제율, 30일 발송량을 한 화면에서 봅니다. 아래 바로가기로 각 화면에 들어갑니다.

![대시보드](assets/console/03-dashboard.png)

### 온보딩 위저드 — 4단계

SDK Key 확인 → 채널 크리덴셜 등록 → 첫 이벤트 수신 확인 → 테스트 발송. 3단계는 iOS·Android·React Native·Flutter 스니펫과 지금 바로 붙여넣을 수 있는 `curl`을 제공하고, 첫 이벤트가 들어올 때까지 5초마다 확인합니다.

> 이 화면은 현재 알파 구현이다. Docker 기동, 안전한 최초 Owner claim, Test Inbox, 서버 저장형 재개를 하나로 잇는 후속 목표는 [P0 Docker Setup Wizard PRD](DOCKER-SETUP-WIZARD-PRD.md)에 정의되어 있으며 아직 출시된 기능이 아니다.

![온보딩](assets/console/19-onboarding.png)

---

## 2. 고객 데이터

### 세그먼트

조건 그룹을 AND/OR로 묶어 대상을 정의하고, 저장 전에 예상 대상 수를 확인합니다. 조건은 속성·행동(이벤트)·푸시 수신 상태 세 종류입니다.

| 목록 | 편집 · 미리보기 |
|---|---|
| ![세그먼트 목록](assets/console/04-segments.png) | ![세그먼트 편집](assets/console/05-segment-detail.png) |

새로 만들 때도 같은 빌더를 씁니다.

![세그먼트 생성](assets/console/06-segment-new.png)

### 유저 검색 · 데이터

`external_id`로 고객을 찾아 프로필·디바이스·최근 이벤트를 봅니다. 데이터 화면에서는 수집된 속성 사전과 수집 오류를 확인합니다.

| 유저 검색 | 데이터 |
|---|---|
| ![유저](assets/console/10-users.png) | ![데이터](assets/console/11-data.png) |

---

## 3. 캠페인 · 저니

### 저니 편집기

이벤트 진입 → 시간 대기 → 메시지 → 이벤트 대기 → 분기로 흐름을 만듭니다. 메시지 단계는 푸시와 이메일 중 하나를 고르고, 이메일은 발송기(SMTP·SES·NHN·Resend)를 지정하거나 활성 발송기에 맡깁니다.

| 목록 | 편집기 |
|---|---|
| ![저니 목록](assets/console/07-journeys.png) | ![저니 캔버스](assets/console/08-journey-canvas.png) |

### 저니 리포트

실행 수·대기·완료·발송 접수와 단계별·경로별 결과를 봅니다. **도달·반응** 패널은 SDK 이벤트와 공급자 웹훅을 합산해 도달률·오픈률·클릭·반송을 보여줍니다.

![저니 리포트](assets/console/09-journey-report.png)

> 발송 접수는 전송 서비스가 받은 건수이고 실제 도달과 다릅니다. 도달·오픈은 SDK(`$push_delivered`/`$push_opened`)와 이메일 공급자 웹훅에서 옵니다.

---

## 4. 메시지 · 이메일

### 메시지 로그

발송 한 건씩의 시각·유저·채널·상태·실패 사유를 봅니다. 상태 탭으로 발송·실패·중복거부·도달불가를 걸러 봅니다.

![메시지 로그](assets/console/12-logs.png)

### 이메일 템플릿과 발송기

HTML 템플릿에 `{{변수}}` 개인화를 넣고 실시간 미리보기와 테스트 발송을 합니다. 왼쪽 카드에서 발송기를 등록합니다.

![이메일 템플릿](assets/console/13-email-templates.png)

발송기는 5가지 프리셋을 제공합니다. 앱마다 여러 개를 등록해 두고 저니 노드별로 골라 쓸 수 있습니다.

| 프리셋 | 저장되는 크리덴셜 | 특징 |
|---|---|---|
| 범용 SMTP | `email_smtp` | 자체 릴레이·MailHog 등 |
| AWS SES (SMTP) | `email_smtp` | 리전만 넣으면 호스트 자동 |
| Resend (SMTP) | `email_smtp` | API 키를 비밀번호로 |
| NHN Cloud (API) | `email_nhn` | 국내 사업자 |
| Resend (API) | `email_resend` | 웹훅으로 도달·오픈·클릭 수집 |

| AWS SES | Resend (SMTP) |
|---|---|
| ![SES](assets/console/14-provider-ses.png) | ![Resend SMTP](assets/console/15-provider-resend-smtp.png) |

| Resend (API) | NHN Cloud |
|---|---|
| ![Resend API](assets/console/16-provider-resend-api.png) | ![NHN](assets/console/17-provider-nhn.png) |

Resend는 설정 화면에서 Resend 대시보드로 바로 이동하는 링크를 제공합니다. 자세한 절차는 [Resend 설정 가이드](RESEND-SETUP.md)를 보세요.

![Resend 발송기 카드](assets/console/18-provider-resend-closeup.png)

---

## 5. 운영

### 팀 · 감사 로그

Owner/Admin/Editor/Viewer 역할로 권한을 나눕니다. 크리덴셜 등록, 2FA 변경, 키 회전 같은 민감한 행위는 감사 로그에 남습니다.

| 팀 | 감사 로그 |
|---|---|
| ![팀](assets/console/20-team.png) | ![감사 로그](assets/console/21-audit.png) |

### 앱 설정

조용 시간, 빈도 상한, 타임존, 2FA 강제, SDK/Server 키 회전을 관리합니다.

![설정](assets/console/22-settings.png)

---

## 캡처를 다시 만들려면

`tests/e2e/`와 같은 자리에서 도커 스택을 띄운 뒤 데모 테넌트를 만들고 Chrome으로 순회 캡처했습니다. 화면이 바뀌면 같은 순서로 다시 찍어 이 문서의 이미지를 교체하세요. 파일명 앞의 번호가 이 문서의 등장 순서입니다.
