# 인앱 웹 소스 작업실 — 사용 안내

2026-09-17 · SDK 0.2.0부터 지원하는 소스 테스트 기능. 운영 게시는 [캠페인 안내](IN-APP-CAMPAIGNS.md)를 확인하세요. [제품 기획](IN-APP-CAMPAIGNS-PRD.md)과 [전체 개발 설계](IN-APP-CAMPAIGNS-DESIGN.md) 중 소스 저장·미리보기·SDK 테스트 경로를 먼저 구현합니다.

시작 전면 광고의 운영·4초 자동 종료는 [앱 실행 직후 광고](APP-LAUNCH-ADS.md)를 확인하세요. 작업실 미리보기와 기기 테스트는 콘텐츠 검수 단계이며 시작 타이머를 적용하지 않습니다.

## 제공하는 흐름

1. 대시보드의 **인앱 이벤트**를 엽니다.
2. **예제로 시작**, **시작 전면 광고 예제** 또는 **웹 소스 업로드**에서 HTML/ZIP을 선택합니다.
3. HTML/CSS/JS를 편집하고 **저장·검증**을 누릅니다. 자산은 NudgeOn 서버 영속 볼륨에 저장됩니다.
4. 페이지 미리보기에서 버튼을 눌러 액션 로그를 확인합니다. 브라우저에서는 앱 이동을 모의 실행합니다.
5. **기기 연결**로 코드를 만들고, 앱에 적용한 SDK의 테스트 연결 화면에 붙여 넣습니다.
6. 앱과 콘솔의 확인 숫자를 대조한 뒤 **같은 기기 확인**을 누릅니다.
7. 앱을 열어 둔 상태로 **내 기기에서 실행**합니다. 같은 저장 버전의 해시를 SDK가 검증합니다.
8. 실패·만료·취소 이력을 확인하고 **다시 테스트**합니다. 이전 기록은 유지되며 새 실행이 생성됩니다.

테스트 기기 연결은 최초 코드 5분, 확인된 세션 30분입니다. 실행 대기는 2분, 표시를 포함한 실행 상한은 5분입니다. 푸시 토큰과 알림 허용이 필요하지 않습니다. 앱에 인앱 테스트 모듈을 처음 적용하는 업데이트는 필요합니다.

## 웹 소스

ZIP 루트에 `index.html`을 둡니다. 참조하는 CSS/일반 JavaScript/이미지/폰트를 함께 넣고 상대 경로로 연결합니다. 원본 React/TSX/npm 프로젝트는 로컬에서 정적 실행 결과물로 빌드한 뒤 업로드합니다. 서버에서 npm이나 업로드 코드를 실행하지 않습니다.

- ZIP 10 MiB, 파일 200개, 해제 총량 30 MiB, 파일당 8 MiB, HTML/CSS/JS/JSON 파일당 1 MiB.
- HTML, CSS, classic JS, JSON, PNG/JPEG/WebP/GIF, WOFF2 지원.
- ESM·동적 import·SVG·외부 CDN·외부 API 호출·중첩 iframe·서버 코드·파일 업로드 폼은 지원하지 않습니다.
- `nudgeon.json`을 포함하면 manifest를 읽습니다. 없으면 기본 설정을 만들고 콘솔에서 표시·액션을 편집합니다.
- 첫 구현은 번들 자산을 검증 후 하나의 자체 포함 HTML로 변환합니다. CSS/JS는 inline, 이미지/폰트는 data URI가 됩니다. 원본 파일도 NudgeOn에 보관합니다.
- 실행 문서의 CSP는 스크립트 해시와 네트워크 제한을 포함합니다. 문서를 서버에서 수정하면 SHA-256이 달라지고 SDK가 거절합니다.
- 모든 저장은 불변 버전을 생성합니다. 미저장 변경이 있으면 미리보기·기기 테스트 전에 저장해야 합니다.

```javascript
window.addEventListener('nudgeon:ready', () => {
  document.querySelector('#join').addEventListener('click', () => {
    window.nudgeonBridge.performAction('join_event').catch(() => {
      // 허용하지 않은 목적지 등의 실패를 사용자에게 안내합니다.
    });
  });
});
```

부트스트랩이 이미지·폰트와 DOM의 기본 준비를 확인합니다. 앱이 추가 준비를 해야 하면 `ready()`를 호출할 수도 있지만, 현재 테스트 버전은 자동 준비 신호를 사용하므로 수동 ready로 표시를 지연시키는 계약은 제공하지 않습니다. `dismiss('close_button')`으로 닫을 수 있으며 네이티브 닫기는 항상 별도로 제공됩니다.

**오늘 하루 안 보기 예제 (SDK 0.2.1 이상):** **예제로 시작**에는 `오늘 하루 안 보기`와 `닫기` 버튼이 포함됩니다. `window.nudgeonBridge.hideToday()`는 표시 중인 라이브 캠페인을 캠페인 시간대의 다음 자정까지 숨기고 닫습니다. 시간대 설정은 서버와 SDK 0.2.2 이상에서 지원하며, `Asia/Seoul`이면 한국 시간 자정, 기존 UTC 설정이면 한국 시간 오전 9시입니다. 새 예제는 `window.nudgeonBridge.timeZone`으로 적용 시간대를 표시하고 폴드 가로 화면처럼 낮은 높이에도 대응합니다. 기존 저장 소스는 자동 변경되지 않으므로 새 버전으로 저장·검수·게시하세요. 브라우저 미리보기는 모의 실행 안내를 표시하며 실제 숨김을 저장하지 않습니다. 기기 테스트 연결에서는 `LIVE_CAMPAIGN_REQUIRED`를 반환합니다. 재노출 차단은 검토 후 게시한 캠페인으로 확인하세요. SDK 0.2.0에서는 HTML 버튼 호출을 지원하지 않습니다.

액션 종류는 `dismiss`, `copy`, `open_url`(HTTPS), `deep_link`입니다. 실제 SDK에서는 호스트 앱이 등록한 scheme/host도 통과해야 합니다. 공개 코드 복사는 가능하며 개인별 쿠폰 지급·보상 완료 처리는 포함하지 않습니다.

## 서버 설정

기능은 기본으로 꺼져 있습니다. 신규 migration `0010_in_app_workbench.sql`을 기존 migrator로 적용한 뒤 API에 다음을 설정합니다.

```dotenv
IN_APP_ENABLED=true
CONTENT_PUBLIC_ORIGIN=https://content.example.com
IN_APP_ASSET_DIR=/var/lib/nudgeon/assets
CONTENT_PORT=8082
```

콘텐츠 origin은 **콘솔과 호스트 이름이 달라야** 합니다. 같은 NudgeOn 서버에 연결하면 되며 별도 웹 호스팅 서비스는 필요 없습니다. 포트만 다른 동일 호스트는 쿠키 격리를 보장하지 않으므로 허용하지 않습니다. 로컬 개발은 콘솔 `http://localhost:3300`, 콘텐츠 `http://127.0.0.1:18082`처럼 구성할 수 있습니다.

초기 구현의 콘텐츠 리스너는 API 프로세스의 별도 포트에 있습니다. 업로드 실행 코드의 파싱은 CPU/메모리/시간 제한을 둔 worker thread에서 처리하며 업로드된 JS를 서버에서 실행하지 않습니다. 미리보기는 단기 읽기 URL로 해당 버전만 제공합니다. URL을 외부에 공유하거나 access log에 기록하지 마세요.

- 일반 `deploy/compose.yaml`: `in-app-assets` 볼륨과 loopback 콘텐츠 포트를 포함합니다. 별도 HTTPS 콘텐츠 호스트를 이 포트로 reverse proxy합니다.
- Safe Boot: `deploy/compose.safe.yaml`에 `deploy/compose.in-app.yaml`을 추가하면 gateway의 콘텐츠 포트를 loopback에 공개합니다. 같은 설치 state/env 및 Compose project를 사용해야 합니다. `./nudgeon up` 설치 위자드에서 인앱 기능을 선택하면 이 overlay를 자동 적용합니다.
- 콘텐츠 호스트는 콘솔/API 전체를 프록시하지 않고 콘텐츠 listener만 연결합니다. 업로드된 HTML을 콘솔 호스트 경로에서 직접 서비스하지 않습니다.
- PG와 `in-app-assets` 볼륨을 함께 백업합니다. DB만 복원하면 원본·실행 파일은 복원되지 않습니다.
- 개발 버전에는 자산 삭제/14일 자동 이력 정리가 아직 없습니다. 테넌트당 원본 합계 1 GiB 제한이 있으며 불변 버전이 누적됩니다.

## iOS 적용

별도 저장소 `nudgeon-ios-sdk`에 추가한 Swift Package product **NudgeOnInApp**을 앱에 연결합니다. iOS 15 이상입니다. 공개 태그 0.2.0부터 제공됩니다.

```swift
import NudgeOnInApp

// 앱이 강한 참조로 보관합니다. host는 현재 활성 Scene의 UIViewController입니다.
let inApp = try InAppTestClient(
    configuration: .init(
        apiURL: URL(string: "https://api.example.com")!,
        sdkKey: "pk_...",
        allowedURLSchemes: ["godspell"],
        allowedWebHosts: ["example.com"]
    ),
    host: { currentViewController },
    isAllowed: { appAllowsInApp && !checkoutIsVisible },
    onAction: { action in
        // 이미 검증되고 팝업이 닫힌 뒤 전달됩니다. 기존 앱 라우터에 연결하세요.
        if let value = action.url, let url = URL(string: value) { appRouter.open(url) }
    }
)
// 사용자가 앱 설정/개발 메뉴에서 테스트 연결을 누른 시점에만 호출합니다.
inApp.presentConnection(from: currentViewController)
// 로그인 계정/동의/화면 맥락이 바뀌면 기존 팝업을 폐기합니다.
inApp.contextChanged()
// 테스트 종료:
await inApp.end()
```

호스트·동의·라우터 변수는 고객 앱이 제공할 값이며 위 코드는 연결 예시입니다. 테스트 자격은 메모리에만 유지하고 앱을 재시작하면 다시 연결합니다. SDK 본체와 푸시 모듈의 사용자 식별·세션 정책을 자동 변경하지 않습니다.

## Android 적용

별도 저장소 `nudgeon-android-sdk`의 신규 **nudgeon-inapp** 모듈입니다. Maven Central의 `io.nudgeon:nudgeon-inapp:0.2.2`으로 연결합니다. SDK 저장소 샘플 앱의 **In-app event test** 버튼으로 연결 화면을 열 수 있습니다. Android 8/API 26 이상이며 WebView의 `WEB_MESSAGE_LISTENER` 지원이 필요합니다.

```kotlin
val inApp = InAppTestClient(
    application = application,
    configuration = InAppTestClient.Configuration(
        apiUrl = "https://api.example.com",
        sdkKey = "pk_...",
        allowedSchemes = setOf("godspell"),
        allowedWebHosts = setOf("example.com")
    ),
    host = { currentActivity },
    isAllowed = { appAllowsInApp && !checkoutIsVisible },
    onAction = { action -> action.url?.let(appRouter::open) }
)
// 메인 스레드, 앱 설정/개발 메뉴의 사용자 액션에서 호출:
inApp.showConnection(currentActivity)
inApp.contextChanged() // 계정·동의·화면 변경
inApp.end()            // 연결 종료
inApp.destroy()        // 호스트 소유자가 SDK 인스턴스를 폐기할 때
```

허용 목록은 필요한 목적지만 등록합니다. 미지원 WebView에 `addJavascriptInterface`를 대신 열지 않습니다. 테스트 토큰·관리 세션·SDK Key를 업로드 HTML에 넣지 않습니다.

## 전체 설계와 이번 구현의 차이

| 항목 | 이번 테스트 버전 |
|---|---|
| 업로드 전송 | 제한된 JSON/base64, 15 MiB 요청 상한. multipart/비동기 검증 job은 후속 |
| 저장 | NudgeOn 파일 볼륨 + PG 메타데이터. 자체 포함 HTML 아티팩트 |
| 연결 | 코드 붙여넣기 + 양쪽 확인 숫자. QR·일반 SDK installation credential은 후속 |
| 실행 명령 | 1회 원자 claim, 3초 polling, 고정 5분 상한. 응답 유실 시 취소/만료 후 새 run 생성 |
| 테스트 기록 | 실패 목록·재실행·취소·중복 방지. 실기기 화면 스트리밍은 없음 |
| 일반 사용자 캠페인 | 설치 기기 대상 게시·기간·트리거·빈도·오늘 그만 보기 구현. [운영 사용 안내](IN-APP-CAMPAIGNS.md). 사용자 세그먼트·저니는 후속 |
| SDK·파일럿 | SDK 0.2.2 대상. Godspell 실기기의 정상 중단·KST 숨김·폴드 레이아웃 [검증 기록](IN-APP-DEVICE-QA-2026-09-17.md). 운영 서버·스토어 빌드는 별도 |
| 설치 위자드 | 인앱 기능·콘텐츠 주소·포트 설정과 Compose 볼륨/overlay 제공. DNS/TLS 발급은 수동, CLI 자산 백업 절차는 [캠페인 안내](IN-APP-CAMPAIGNS.md) 참고 |

브라우저와 모의 SDK 요청 검증은 실제 iOS/Android 기기 검증을 대체하지 않습니다. 검증 결과는 구현 완료 보고에서 구분합니다.
