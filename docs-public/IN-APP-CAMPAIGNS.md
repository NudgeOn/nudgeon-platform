# 인앱 캠페인 — SDK 0.2.2 사용 안내

2026-09-18. 웹 소스 작업실 다음 단계로 게시·기간·트리거·설치 기기별 제한과 iOS/Android 운영 클라이언트를 구현했습니다. 기본 UTC 캠페인은 SDK 0.2.0 이상과 호환되며, 캠페인 시간대와 정상 중단 사유는 SDK 0.2.2 이상에서 지원합니다. 운영 서버에는 해당 API·마이그레이션을 먼저 배포해야 합니다. 전체 기획의 세그먼트·사용자 개인화·저니 연동은 포함하지 않습니다.

## 콘솔에서 게시하기

1. [웹 소스 작업실](IN-APP-WORKBENCH.md)에서 소스를 저장하고 대상 OS마다 테스트합니다.
2. 레이아웃·이미지·각 버튼의 목적지를 확인합니다. 마지막 테스트는 노출된 팝업의 **네이티브 닫기**로 마칩니다.
3. 작업실의 **캠페인 관리**(`/in-app/campaigns`)에서 완료한 테스트를 선택하고 검수 항목을 확인해 **검수 통과**를 누릅니다. 시스템은 같은 소스 버전의 노출 및 네이티브 닫기 기록을 검사합니다. 버튼·시각 품질은 운영자가 직접 검수합니다.
4. 이름, 불변 소스 버전, 대상 OS, 표시 조건, 시작/종료 시각, 일일 제한·숨김 시간대와 빈도를 설정하고 **초안 저장**합니다.
5. 저장된 설정을 확인하고 **저장된 버전 게시**를 누릅니다. 시작 시각이 미래라면 그 시각부터 대상이 됩니다. 백그라운드 앱을 깨우거나 푸시를 보내지 않습니다.
6. **캠페인 중지**로 새 표시를 막습니다. 중지 후 내용을 수정하고 저장·재게시할 수 있습니다. 이전 소스 버전을 선택해 다시 게시하면 콘텐츠를 되돌릴 수 있으며 빈도 제한은 유지됩니다.

Viewer는 조회, Editor는 초안 작성·테스트, Admin/Owner는 검수·게시·중지를 할 수 있습니다. `in_app:publish` 권한을 기존 저니 활성화 권한과 분리했습니다. 변경은 감사 로그에 기록됩니다. 검수 불합격은 이미 게시된 캠페인을 자동 중지하지 않으므로 운영 중 문제를 발견하면 **중지**를 먼저 사용합니다.

## 대상과 표시 규칙

- 대상은 해당 앱에 인앱 모듈을 적용하고 표시를 허용한 **설치 기기**입니다. 사용자 로그인이나 세그먼트 자격을 인증하지 않습니다. 공개 이벤트·일반 공지에 사용하고 개인별 비밀·금전성 보상을 HTML에 넣지 않습니다.
- 시작 광고: SDK 0.2.3의 `enableAfterLaunch`와 `launch` 조건으로 연결합니다. [앱 실행 직후 광고](APP-LAUNCH-ADS.md)의 준비 시간·중복 방지 규칙을 따릅니다.
- 트리거: 앱 열기(`foreground`), 화면 이름 정확히 일치(`screen`), 이벤트 이름 정확히 일치(`track`). SDK 호스트가 이 신호를 명시적으로 연결합니다. `track`은 기존 분석 수집 API로 이벤트를 중복 전송하지 않습니다.
- 우선순위 높은 캠페인을 먼저 선택하고 동률은 생성 시각·ID 순서입니다. 기기당 한 실행만 예약·표시합니다. 기기당 모든 캠페인 사이 최소 30초, 캠페인당 세션 1회, 일일/누적 상한 및 최소 간격을 서버에서 검사합니다.
- 빈도는 **표시 직전 서버 승인된 시도** 기준입니다. 승인을 받은 직후 앱이 종료되어도 한 번 사용한 것으로 보수적으로 계산합니다. 실제 노출 수는 별도 `impression` 기록입니다.
- 날짜 입력은 브라우저 현재 시간대를 따릅니다. 일일 제한과 **오늘 하루 안 보기**는 캠페인의 IANA 시간대(`time_zone`) 기준입니다. `Asia/Seoul`이면 한국 시간 다음 자정까지 숨깁니다. 서버는 같은 순간을 UTC로 저장합니다. 신규 콘솔 초안은 브라우저 시간대를 제안하며, 기존 캠페인 또는 API에서 생략한 설정은 UTC를 유지합니다.
- 설정 수정과 재게시는 캠페인 ID를 유지하므로 빈도와 숨김 상태를 초기화하지 않습니다. 앱 재설치·명시적 설치 자격 삭제 후의 새 설치까지 동일 사람으로 식별하지 않습니다.
- 새 설치 자격 발급은 앱당 하루 10,000개, 캠페인 원장은 앱당 100개까지입니다. 대규모 운영·원장 보존/삭제 정책은 후속 단계입니다.

## SDK 연결

작업실의 `InAppTestClient`와 운영의 `InAppCampaignClient`는 별도 객체·API·자격을 사용합니다. 서버가 임의 설치 ID를 받아 기존 자격을 재발급하지 않습니다. 신규 설치에 무작위 자격을 발급하고 서버에는 해시만 저장합니다. iOS는 [기기에 한정된 Keychain 항목](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly), Android는 [Android Keystore](https://developer.android.com/privacy-and-security/keystore)의 AES-GCM과 백업 제외 파일에 저장합니다. 업로드 HTML에는 전달하지 않습니다.

```swift
import NudgeOnInApp
// 앱이 보관하고, 표시할 UIViewController가 준비된 시점에 enable합니다.
let campaigns = try InAppCampaignClient(
    configuration: .init(apiURL: apiURL, sdkKey: sdkKey,
                         allowedURLSchemes: ["godspell"], allowedWebHosts: ["example.com"]),
    host: { currentViewController },
    isAllowed: { appAllowsInApp && !checkoutIsVisible },
    onAction: { action in appRouter.handle(action) }
)
campaigns.enable()
campaigns.screen("home")
campaigns.track("level_completed")
campaigns.contextChanged() // 계정·동의·현재 화면 맥락이 바뀔 때 기존 표시 폐기
campaigns.disable()        // 이후 표시 중단
// 사용자가 설치 자격 삭제/수신 종료를 명시적으로 요청한 경우:
await campaigns.forgetInstallation()
```

```kotlin
val campaigns = InAppCampaignClient(
    application, InAppTestClient.Configuration(apiUrl, sdkKey,
        allowedSchemes = setOf("godspell"), allowedWebHosts = setOf("example.com")),
    host = { currentActivity }, isAllowed = { appAllowsInApp && !checkoutIsVisible },
    onAction = { appRouter.handle(it) }
)
// 주 스레드, 활성 Activity가 포커스를 가진 시점에 시작합니다.
campaigns.enable()
campaigns.foreground() // 호스트의 실제 앱 foreground 경계에 연결
campaigns.screen("home")
campaigns.track("level_completed")
campaigns.contextChanged()
campaigns.disable()
campaigns.destroy()    // 소유자가 객체를 폐기할 때
```

iOS는 enable 이후 UIApplication의 재활성화 신호를 받습니다. Android는 Activity 전환을 앱 세션으로 오인하지 않도록 호스트의 앱 foreground 경계에서 `foreground()`를 호출합니다. 각 호출은 새 세션을 시작하므로 화면마다 호출하지 않습니다. 화면 변화에는 `screen()`을 사용합니다. 테스트 모드를 시작할 때 운영 클라이언트를 `disable()`하고 종료 후 명시적으로 재개합니다. 객체를 앱/Scene 소유자가 강하게 보관하고 동시에 여러 운영 클라이언트를 생성하지 않습니다.

`isAllowed`는 대상 선정 전과 표시 직전에 확인합니다. 동의 철회·로그아웃 시 `contextChanged`/`disable`을 즉시 호출해 열린 팝업까지 닫으세요. 서버의 사용자 계정이나 기존 푸시 동의를 인앱 모듈이 자동으로 변경하지 않습니다. 허용된 앱 이동은 팝업이 닫힌 뒤 호스트 라우터 콜백으로 전달됩니다.

## 서버 설정과 표시 수명

`0010_in_app_workbench.sql` 다음 신규 migration **`0011_in_app_campaigns.sql`**을 기존 migrator로 적용합니다. 기존 migration 체크섬을 변경하지 않습니다. 자산 볼륨·콘텐츠 호스트 설정에 이어 다음을 API에 설정합니다.

```dotenv
IN_APP_ENABLED=true
IN_APP_CAMPAIGNS_ENABLED=true
```

두 기능은 기본 비활성입니다. Compose 기본·Safe Boot 환경에 변수를 전달하며, 설치 위자드의 인앱 설정은 아래 운영 준비 절차를 따릅니다.

운영 API는 `/v1/in-app/live`이며 설치 자격은 `X-NudgeOn-Installation` 헤더에, 앱 SDK Key는 기존 Authorization 헤더에 보냅니다. [OpenAPI](../packages/openapi/in-app-campaigns.openapi.json)에 계약이 있습니다.

1. 트리거에 대해 원자적으로 30초짜리 예약을 만듭니다. 후보가 없으면 `delivery: null`입니다.
2. SDK가 해시를 검증하고 웹뷰를 화면 밖에서 준비합니다.
3. 표시 직전 다시 서버에 승인 요청합니다. 게시 상태·버전·기간·예약 만료·설치 자격을 재검사합니다. 승인 응답을 잃으면 표시하지 않습니다.
4. 표시 후 3초 간격으로 중지 여부와 실행 상태를 확인합니다. 중지와 표시가 경쟁하면 이미 화면이 떴을 수 있으며 다음 성공한 조회에서 닫습니다. 오프라인 즉시 회수는 보장하지 않고 최대 약 5분 로컬 제한으로 종료합니다. 캠페인 종료 시각이 더 빠르면 그 시각을 사용합니다.
5. 표시·노출·액션·닫힘·실패는 event ID로 중복을 제거합니다. 준비/종료 후의 잘못된 이벤트로 실행 상태를 되살리지 않습니다. 실패한 운영 표시를 자동으로 다시 발송하지 않습니다.

상세 이벤트는 SDK 0.2.0의 로컬 영속 큐(최대 1,000건/7일)에 저장하고 재실행 후 재전송합니다. 저장 실패·용량 초과·보존 기간 만료 시 유실 가능하며 표시 빈도 원장은 서버에 남습니다. 네이티브 watchdog은 최대 실행 시간을 제한합니다. 자격 오류 401에서는 자동으로 새 설치를 만들어 제한을 초기화하지 않고 표시를 중단합니다.

결과 화면의 노출·참여·닫힘은 운영 실행별 집계이며 테스트 로그와 분리됩니다. ClickHouse 리포트·사용자별 전환 귀속·세그먼트·저니·RN/Flutter 어댑터는 후속 작업입니다. SPM/Maven 0.2.2 배포와 Godspell 소스 반영은 완료했습니다. 빌드·시뮬레이터 검증을 앱스토어 배포나 다양한 실기기의 실제 공급자 푸시 검증으로 대체하지 않습니다.

## SDK 0.2.2 / 운영 준비

- iOS SPM의 `NudgeOnInApp` product, Android Maven Central의 `io.nudgeon:nudgeon-inapp:0.2.2`을 앱에 추가합니다. 코어 SDK도 0.2.2를 사용합니다.
- 운영 노출·클릭 기록은 설치별 로컬 파일에 최대 1,000건/7일 저장합니다. 재실행 후 같은 event ID로 순서대로 재전송하며 일시 오류는 최대 60초+지터까지 재시도 간격을 늘립니다. 서버는 발생 시각을 검증하고 늦게 수신해도 중지·만료 상태를 다시 열지 않습니다. 400/404/409는 해당 이벤트를 버리고, 401은 클라이언트를 중지합니다. 테스트 페어링은 메모리 방식이라 재실행 시 다시 연결합니다.
- 서버 migration `0012_in_app_event_replay.sql`까지 적용해야 새 SDK의 기록을 수신할 수 있습니다.
- 신규 `./nudgeon up` 설치 위자드의 DB 설정 단계에서 인앱 기능과 콘텐츠 주소·포트를 함께 설정할 수 있습니다. 기본 로컬 주소는 콘솔(`localhost`)과 다른 호스트인 `127.0.0.1:8082`입니다. 외부 운영은 별도 HTTPS 콘텐츠 호스트를 만들고 해당 loopback 포트로 프록시합니다. DNS/TLS는 자동 발급하지 않습니다.
- 설정은 `.nudgeon` 설치 상태의 `in-app.env`에 보존하며, 재실행 시 Compose overlay와 영속 자산 볼륨을 자동 연결합니다. 기존 설치는 같은 파일에 `IN_APP_ENABLED`, `IN_APP_CAMPAIGNS_ENABLED`, `CONTENT_PUBLIC_ORIGIN`, `CONTENT_PORT`를 설정하고 `./nudgeon up`으로 적용합니다.
- `scripts/backup.sh`는 `API_CONTAINER`의 `/var/lib/nudgeon/assets` 볼륨 또는 명시한 `IN_APP_ASSETS_VOLUME`을 `in-app-assets.tar.gz`로 함께 내보냅니다. Safe Boot는 `API_CONTAINER=nudgeon-safe-api-1`을 지정하세요. manifest의 `in_app_assets.included=true`를 확인하세요. 복원 전 API·worker를 멈추고 빈 자산 볼륨을 지정합니다. 마스터키 복구 번들은 별도 보관합니다.

## 0.2.2 시간대·중단 사유 전환

1. 시간대와 `cancelled` 이벤트를 지원하는 API·콘솔을 먼저 반영합니다. 기존 0010–0012 이후 추가 DB migration은 없습니다.
2. iOS SPM 및 Android Maven의 코어·인앱 SDK를 0.2.2로 업데이트합니다. 새 SDK가 `X-NudgeOn-In-App-Capabilities: campaign-time-zone`을 보내야 UTC 외 캠페인이 노출됩니다. SDK 0.2.0/0.2.1은 기존 UTC 캠페인을 계속 받습니다.
3. KST로 운영할 캠페인은 중지 → `Asia/Seoul`로 저장 → 재게시합니다. 이미 발생한 숨김은 해당 실행의 불변 게시 버전 시간대로 계산하므로 뒤늦은 이벤트도 새 설정에 의해 다음 날까지 연장되지 않습니다. 여름시간과 30/45분 오프셋도 다음 현지 자정으로 계산합니다.
4. 새 예제는 낮은 화면 높이에서 아트·여백을 줄이고 카드 내부 스크롤을 지원합니다. 기존 저장 소스는 불변이므로 **예제로 시작 → 저장·검증 → 양쪽 OS 검수 → 새 버전 게시**가 필요합니다. 새 브리지의 읽기 전용 `window.nudgeonBridge.timeZone`으로 실제 캠페인 시간대를 표시할 수 있습니다. 미리보기·테스트 연결의 기본값은 UTC입니다.

실제 렌더링·통신 실패는 `failed`에 남기고, 정상 종료는 `cancelled`와 사유를 기록합니다. 콘솔의 **정상 중단 · 이전 SDK 상황 변경**에서 백그라운드, 화면/세션/표시 조건 변경, 비활성화, 캠페인 중지/버전 변경/기간 종료, 최대 표시 시간 종료를 구분합니다. 이전 SDK의 `CONTEXT_CHANGED`는 세부 원인 미확인으로 표시하며 최근 실패 목록에서 분리합니다. 원시 `events`/`deliveries` 집계는 과거 기록을 다시 쓰지 않습니다.

구 서버가 `lifecycle_events`를 제공하지 않으면 새 SDK는 이미 표시한 정상 종료를 `dismiss`, 표시 전 중단을 `failed(HOST_BLOCKED)`로 보내 구 서버와 호환됩니다. 정상 중단의 세부 구분은 라이브 캠페인에 적용되며 테스트 연결 로그는 별도입니다.

[실기기·콘솔 검증 기록](IN-APP-DEVICE-QA-2026-09-17.md)의 0.2.2 재검증 결과를 참조하세요.
