# App launch ads — complete iOS / Android examples

[한국어](#한국어) · [English](#english)

## 한국어

**SDK 0.2.6 · 콘텐츠 검수와 시작 광고를 실행하는 앱.** 앱 진입점, SDK 생성·보관, 첫 프레임 전 덮개, 독립적인 3초 fallback, 동의·외부 진입 제외, 생명주기 정리가 모두 포함됩니다. 개발자센터의 전체 코드도 이 파일들을 직접 읽어 표시합니다.

- iOS 15 이상, Xcode + XcodeGen. SPM의 `NudgeOnInApp` **정확히 0.2.6**.
- Android 8(API 26) 이상, JDK 17, Android SDK 34. Gradle wrapper 8.13 포함, Maven Central core/in-app **0.2.6**. `mavenLocal`이나 형제 SDK 체크아웃을 사용하지 않습니다.
- 서버에 migration 0010~0012, `IN_APP_ENABLED`, `IN_APP_CAMPAIGNS_ENABLED`, 영속 자산 볼륨·별도 HTTPS 콘텐츠 호스트가 준비되어 있어야 합니다. [서버·콘솔 계약](../../../../docs-public/APP-LAUNCH-ADS.md).
- 푸시 토큰이나 FCM/APNs 인증서는 이 시작 광고 예제에 필요하지 않습니다.

### 1. 내려받고 설정

```sh
git clone https://github.com/NudgeOn/nudgeon-platform.git
cd nudgeon-platform/apps/docs-site/examples/app-launch
```

[iOS 전체 소스](ios/LaunchAdExample.swift)의 `apiURL`·`sdkKey`, [Android 전체 소스](android/app/src/main/kotlin/io/nudgeon/launchexample/MainActivity.kt)의 `API_URL`·`SDK_KEY`를 **통제된 테스트 앱**의 HTTPS API 기본 주소와 공개 SDK 키로 설정하세요. 콘텐츠 호스트 주소나 Admin API 키를 넣지 않습니다. 자리표시자가 남으면 광고 없이 메인으로 진입합니다. 로컬 설정값을 커밋하지 마세요.

### 2. iOS 실행

```sh
cd ios
xcodegen generate
xcodebuild -project LaunchAdExample.xcodeproj -scheme LaunchAdExample \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=YES build
open LaunchAdExample.xcodeproj
```

Xcode에서 시뮬레이터를 선택하고 실행합니다. 시뮬레이터 전용 `Simulator.entitlements`와 ad-hoc 서명은 Keychain 전송 저장소 접근에 필요합니다. 서명을 끄면 저장소 초기화가 실패할 수 있습니다. 이 설정은 실제 기기에는 적용되지 않습니다. 실제 iPhone은 본인 Team과 고유 Bundle ID를 설정하고 실행하세요. 단일 `UIWindow`/AppDelegate 예제이며 Scene 기반 앱은 동일한 덮개·취소 규칙을 해당 Scene 소유자에 연결합니다.

### 3. Android 실행

```sh
cd android # app-launch 폴더 기준
# JDK 17과 ANDROID_HOME을 로컬 설치 경로로 설정한 뒤:
./gradlew :app:assembleDebug
adb -s YOUR_TEST_DEVICE install -r app/build/outputs/apk/debug/app-debug.apk
adb -s YOUR_TEST_DEVICE shell am start -a android.intent.action.MAIN \
  -c android.intent.category.LAUNCHER -n io.nudgeon.launchexample/.MainActivity
```

### 4. 같은 앱에서 콘텐츠 검수

1. 작업실에서 소스를 저장·검증하고 **기기 연결** 코드를 만듭니다.
2. 예제의 **Workbench pairing code**에 코드를 붙여 넣고 **Connect for content review**를 누릅니다. 이 버튼이 테스트 모드의 명시적 동의이며, 시작 광고용 **Allow startup ads** 스위치와 별개입니다.
3. 앱의 **Confirmation number**와 콘솔의 숫자를 대조한 뒤 **같은 기기 확인**을 누릅니다. 앱을 전경에 둔 채 **내 기기에서 실행**합니다.
4. 광고의 **네이티브 Close 버튼**으로 종료합니다. 앱의 **기록 보관 → 서버 수신 확인 중 → 기록 전송 완료 · 대기 0건**으로 서버 수신을 확인합니다. 로컬 이벤트 메시지와 별개입니다.
5. 네이티브 닫기 후 앱의 기록 전송 상태를 확인하세요. 일시적인 연결 실패는 “기록 1건 보관 중 · 자동 재시도 예정”으로 안내하며, 앱이 실행 가능한 동안 자동 재시도합니다. 연결 복구 후 다시 전송(Retry transfer) 또는 앱 재실행으로 전송만 복구할 수도 있습니다. 서버가 인증·권한·만료 문제 등으로 거절하면 재전송 버튼 대신 “새 검수가 필요합니다”를 안내합니다. 새 검수 준비(Prepare new review)에서 기록 폐기를 확인하고 새 연결 코드로 다시 검수하세요. 폐기한 기록은 서버 수신이나 검수 통과로 처리되지 않습니다. 수신 완료 뒤 “다음: 콘솔에서 검수 승인”을 따라 같은 소스 버전·OS의 실행과 네이티브 닫기 완료를 확인하고 승인하세요. 중단된 검수는 다시 진행해야 합니다. End test session은 남은 기록을 전송한 뒤 연결을 끝냅니다. 테스트 자격(30분)·실행 유효기간(5분)이 지나면 복구가 거절될 수 있습니다.

연결 코드는 저장하지 않습니다. 전송에 필요한 단기 자격과 최대 200개 기록을 iOS Keychain·Android Keystore 보호 저장소에 보관합니다. 앱은 시작할 때 테스트 클라이언트를 생성하여 전송을 복구하지만 과거 광고·명령을 다시 실행하지 않습니다. 복구 또는 명시적 폐기 후 새 코드로 연결하세요. 자동 재시도는 앱이 실행 가능한 동안 1~30초 간격이며 백그라운드에서는 OS가 중단할 수 있습니다. 테스트 자격(30분)·실행 유효기간(5분) 이후 서버 거절은 실패로 남고 새 검수가 필요합니다. 저장 실패·명시적 폐기·앱 삭제까지 수신을 보장하지는 않습니다. 콘텐츠 검수 중에는 운영 광고 클라이언트를 중단합니다.

### 5. 게시 후 새 프로세스에서 시작 광고 테스트

처음 실행하면 메인이 보입니다. **Allow startup ads**를 켜고 프로세스를 종료한 뒤 다시 실행하세요. Android는 아래 명령을 사용합니다. iOS는 시뮬레이터 앱 종료 또는 Xcode Stop 후 다시 Run합니다. 홈으로 나갔다 돌아오기만 하면 새 시작 시도가 아닙니다.

```sh
adb -s YOUR_TEST_DEVICE shell am force-stop io.nudgeon.launchexample
adb -s YOUR_TEST_DEVICE shell am start -a android.intent.action.MAIN \
  -c android.intent.category.LAUNCHER -n io.nudgeon.launchexample/.MainActivity
```

| 확인할 상황 | 기대 결과 |
|---|---|
| 게시된 `launch` 캠페인과 서버 빈도 조건 충족 | 덮개 → 불투명 전면 광고 → 실제 표시부터 기본 4초 뒤 메인 |
| 첫 실행·동의 꺼짐·설정 미완료 | 광고 요청 없이 메인 |
| 캠페인 없음·빈도 소진 | 메인, `noCampaign` / `NO_CAMPAIGN` |
| 통신 실패·느린 응답·호스트 준비 지연 | 호스트 덮개 최대 3초, 늦은 응답으로 광고를 끼워 넣지 않음 |
| 준비/표시 중 백그라운드·동의 변경·외부 경로 | SDK 중단, 덮개 제거, 같은 프로세스에서 재시도 없음 |
| Android 회전·Activity 재생성 | 시작 기회 재사용 없음, 메인 진입 |

`shown`/`SHOWN`은 **표시 시작**입니다. 콜백에서는 광고 뒤 덮개만 제거하고 fallback을 취소합니다. 여기서 `disable()`을 부르면 광고까지 즉시 사라지므로 호출하지 않습니다. 실제 자동 종료는 운영 기록 `dismiss` + `auto_dismiss`로 확인합니다. 프로세스 재시작으로 서버의 일일 빈도·숨김 제한이 초기화되지는 않습니다. 한국 날짜 기준은 `Asia/Seoul`입니다.

### 두 테스트는 별개입니다

| | 1. 콘텐츠 검수 | 2. 실제 시작 광고 |
|---|---|---|
| 실행 위치 | 작업실 + 이 예제의 Connect for content review | 이 예제 + 통제된 테스트 앱에 게시한 캠페인 |
| 클라이언트 | `InAppTestClient` | `InAppCampaignClient` |
| 종료 | **네이티브 닫기**로 검수 종료 | 실제 표시부터 기본 4초 **자동 종료** |
| 완료 | 같은 소스 버전의 대상 OS별 마지막 테스트와 검수 통과 | 런치→광고→메인, 표시·노출·자동 종료 운영 이벤트 확인 |

두 플랫폼 모두 예제 안에 작업실 연결 화면이 있습니다. 콘텐츠 검수 완료 후 같은 버전을 검수·게시하고, 테스트 연결을 종료한 뒤 시작 광고를 확인하세요. [운영자 절차](https://nudgeon.io/ko/guide/#launch-ads).

운영 캠페인 예제는 **시작 광고만** 다루므로 앱이 비활성화되면 운영 클라이언트를 중단합니다. 일반 화면·이벤트·복귀 캠페인, 실제 딥링크 라우팅, 권한 요청 및 결제 화면은 서비스 앱의 생명주기에 맞춰 추가하세요. 시작 기회를 건너뛴 뒤 나중에 광고를 삽입하지 마세요. URL 허용 목록은 기본적으로 비어 있으며 예제는 광고 액션을 외부로 열지 않습니다.

### 검수 상세 정보

SDK 0.2.6 예제는 최근 실행 ID·소스 버전·OS와 마지막 전송 시도·수신 확인·연결/실행 유효기간을 표시합니다. 시각은 KST이며 수신 확인은 서버 시각이 아닌 기기가 응답을 확인한 시각입니다. 정보는 앱 재시작 후에도 유지됩니다. ‘실행 ID 복사’ 후 콘솔 → 인앱 캠페인 → 검수 → ‘실행 ID로 찾기’에 붙여 넣고 같은 소스 버전·OS를 대조하세요. 현재 앱의 최근 50개 실행만 검색하며, 오래된 실행이 없으면 새 검수를 진행합니다. 선택만으로 승인되지는 않습니다. 이전 SDK 기록의 없는 정보는 ‘아직 확인되지 않음’으로 표시하며, 자격증명은 복사하지 않습니다. 수신 건수는 연결 전체 누적이고 상세 정보는 최근 실행 기준입니다.

## English

These are complete **content-review and startup-ad** apps pinned to public SDK **0.2.6**: app entry point, retained client, startup cover before the first frame, independent three-second fallback, prior-consent/routing exclusions and lifecycle cleanup. The developer page imports the exact source files shown here.

Requirements: iOS 15+, Xcode and XcodeGen; or Android 8/API 26+, JDK 17 and Android SDK 34. The Gradle 8.13 wrapper is included. No local SDK checkouts, push tokens or FCM/APNs credentials are required. Prepare a launch-capable server with migrations 0010–0012, both in-app feature flags, persistent assets and a separate HTTPS content host.

1. Clone this repository using the command above. Edit `apiURL`/`sdkKey` in the Swift file or `API_URL`/`SDK_KEY` in Kotlin with a **controlled test app's** HTTPS API base URL and public SDK key. Do not use the content host or an admin key, or commit local credentials. Placeholders skip ads.
2. Run the iOS or Android build commands above. For physical iOS devices, select your signing Team and a unique Bundle ID. iOS uses one UIWindow/AppDelegate; adapt ownership for Scene-based apps.
3. For the published startup test, turn on **Allow startup ads**. Terminate the process and relaunch. Use Android `am force-stop` followed by the launcher intent above; on iOS use Xcode Stop/Run or terminate the simulator app. Returning from Home does not create another startup attempt.
4. Publish a reviewed `launch` campaign to the controlled test app. Verify cover → opaque ad → main after four seconds, plus presented/impression/dismiss(`auto_dismiss`) records. Preparation defaults to three seconds; visible duration defaults to four and supports 3–5 seconds. Server frequency/suppression survives restart. Use `Asia/Seoul` for Korean calendar-day limits.
5. Check opt-out/unconfigured startup (no request), no eligible campaign (main), slow/failing network (cover removed within three seconds), background/consent/route changes (cancel; no late insertion), and Android Activity recreation (no new launch opportunity).

`shown`/`SHOWN` reports presentation **start**. Remove the cover and cancel its fallback in the callback; do not disable the SDK there or the ad will close immediately.

**Content review is the separate first test, inside these same examples:**

1. Save/validate a source in the workbench and generate a pairing code. Paste it into **Workbench pairing code** and tap **Connect for content review**. This explicit test opt-in is independent of the **Allow startup ads** switch.
2. Compare the persistent **Confirmation number** with the console, confirm the same device, then run the saved revision while the app remains foregrounded.
3. Finish using the ad’s **native Close button**. After native Close, check delivery in the app. Temporary failures show retained records and scheduled automatic retry while the app can run. After connection recovery, use Retry transfer or relaunch to recover uploads only. Rejected credentials, permissions, expiry or other permanent errors disable Retry and explain that a new review is required. Choose Prepare new review, confirm discard, then use a new pairing code to repeat the review. Discard never counts as receipt or approval. After delivery, follow “Next: approve the review in the console”: check the same revision, OS and native-close completion, then approve. Interrupted reviews must be repeated. End test session sends remaining records before closing. Expired test credentials (30 minutes) or active runs (five minutes) can reject recovery.
4. Delivery complete means telemetry receipt, not approval. Approve the same revision for each target OS in the console and publish to the controlled test app. End the test connection, then use the startup steps above to verify automatic dismissal and production events.

The pairing code is not stored. The short-lived credential and up to 200 pending records are protected in iOS Keychain / Android Keystore storage. The examples initialize the test client at startup for delivery-only recovery: old ads and commands never resume. Finish recovery or explicitly discard before pairing again. Retries back off from 1 to 30 seconds while the process can run; background execution may be suspended. Expired test credentials (30 minutes) or active runs (five minutes) can reject delayed records and require a new review. No receipt guarantee covers failed storage writes, explicit discard or uninstall. The production client stops when content review starts. [Operator procedure](https://nudgeon.io/guide/#launch-ads).

The iOS project uses simulator-only `Simulator.entitlements` and ad-hoc signing for Keychain access. Keep signing enabled. Physical devices require your own Team and Bundle ID; the simulator entitlement is not applied to them.

The examples stop the client when inactive. Add ordinary screen/event/foreground campaigns, real routing, permission prompts and checkout exclusions according to your production host lifecycle. Never insert a skipped startup ad later. URL allowlists are empty and the examples do not open campaign actions externally.

### Review details

SDK 0.2.6 examples show the latest run ID, revision, OS, last delivery attempt, observed receipt, and session/run expiry in KST. Receipt time is observed on the device, not a server timestamp. Context survives restart. Use Copy run ID, then Console → In-app campaigns → Review → Find by run ID; match the revision and OS before approving. Search covers this app’s latest 50 runs; perform a new review if an older run is unavailable. Selection never approves automatically. Missing old-SDK fields show Not recorded, credentials are never copied, and receipt counts remain cumulative for the session while context describes the latest run.
