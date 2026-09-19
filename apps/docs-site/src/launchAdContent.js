import { launchAdQuickstart } from './launchAdQuickstart.js';
import { launchAdHelp } from './launchAdHelp.js';
import swift from '../examples/app-launch/ios/LaunchAdExample.swift?raw';
import kotlin from '../examples/app-launch/android/app/src/main/kotlin/io/nudgeon/launchexample/MainActivity.kt?raw';
import { launchAdTests } from './launchAdTests.js';

const links = {
  ko: [
    { label: '전체 예제 · 설정·빌드·테스트 안내', href: 'https://github.com/NudgeOn/nudgeon-platform/tree/main/apps/docs-site/examples/app-launch' },
    { label: 'iOS 실행 프로젝트', href: 'https://github.com/NudgeOn/nudgeon-platform/tree/main/apps/docs-site/examples/app-launch/ios' },
    { label: 'Android 실행 프로젝트', href: 'https://github.com/NudgeOn/nudgeon-platform/tree/main/apps/docs-site/examples/app-launch/android' },
    { label: '운영자 가이드', href: 'https://nudgeon.io/ko/guide/#launch-ads' },
    { label: '시작 광고 전체 계약', href: 'https://github.com/NudgeOn/nudgeon-platform/blob/main/docs-public/APP-LAUNCH-ADS.md' },
  ],
  en: [
    { label: 'Complete examples · setup, build and test', href: 'https://github.com/NudgeOn/nudgeon-platform/tree/main/apps/docs-site/examples/app-launch' },
    { label: 'Runnable iOS project', href: 'https://github.com/NudgeOn/nudgeon-platform/tree/main/apps/docs-site/examples/app-launch/ios' },
    { label: 'Runnable Android project', href: 'https://github.com/NudgeOn/nudgeon-platform/tree/main/apps/docs-site/examples/app-launch/android' },
    { label: 'Operator guide', href: 'https://nudgeon.io/guide/#launch-ads' },
    { label: 'Full startup-ad contract', href: 'https://github.com/NudgeOn/nudgeon-platform/blob/main/docs-public/APP-LAUNCH-ADS.md' },
  ],
};
export const launchAdContent = {
  ko: {
    help: launchAdHelp.ko, quickstart: launchAdQuickstart.ko,
    id: 'launch-ads', tests: launchAdTests.ko, eyebrow: 'APP LAUNCH ADS · iOS & ANDROID',
    title: '런치 화면 다음, 전면 광고를 자동으로 보여주세요',
    intro: 'APP-AD는 해당 앱의 신규·기존 사용자 전체가 대상입니다. 로그인·세그먼트·테스트 기기 연결 없이 선택한 OS의 SDK 연결 기기에서 동의·기간·빈도 조건에 따라 표시합니다. OS 런치 화면 → 앱의 시작 화면 덮개 → 불투명 전면 광고 → 메인 화면. SDK 0.2.5는 실제 표시부터 기본 4초 뒤 광고를 자동 종료합니다. 표시 시간은 3~5초로 설정하며 시작 광고에는 네이티브 닫기·오늘 하루 안 보기 버튼이 없습니다.',
    endpoint: 'enableAfterLaunch(timeoutSeconds: 3, displaySeconds: 4) · trigger: launch',
    steps: [
      { title: '서버와 네이티브 SDK를 준비합니다', body: 'launch 트리거를 지원하는 서버·콘솔과 migration 0010~0012를 먼저 반영합니다. IN_APP_ENABLED와 IN_APP_CAMPAIGNS_ENABLED를 켜고 영속 자산 볼륨·별도 HTTPS 콘텐츠 호스트를 설정합니다. SPM NudgeOnInApp과 Maven nudgeon-inapp/core 0.2.5를 사용합니다. RN·Flutter의 인앱 연결은 아직 제공하지 않습니다.' },
      { title: '호스트 시작 화면과 표시 조건을 연결합니다', body: 'InAppCampaignClient를 앱 소유자가 보관하고 첫 메인 프레임 전에 시작 화면 덮개를 추가합니다. 동의·라우팅이 끝나고 표시 가능한 호스트가 준비되면 enable() 대신 enableAfterLaunch를 한 번 호출합니다. 최초 동의·딥링크·권한 요청·결제 중에는 호스트가 시작 기회를 건너뛰고 나중에 끼워 넣지 않습니다.' },
      { title: '준비 시간과 표시 시간을 구분합니다', body: 'timeoutSeconds는 준비 기한(기본 3초, 1~10초), displaySeconds는 실제 광고 표시 시간(기본 4초, 3~5초)입니다. 광고가 없거나 실패·시간 초과면 덮개를 제거합니다. shown/SHOWN도 덮개를 제거하되 전면 광고가 그 위를 가립니다. 콜백은 표시 시작을 알리며 종료 콜백이 아닙니다. 호스트에도 독립적인 3초 fallback과 생명주기 정리를 둡니다.' },
      { title: '콘텐츠 검수 후 시작 캠페인을 게시합니다', body: '인앱 이벤트 작업실에서 시작 전면 광고 예제를 선택하거나 HTML/ZIP을 업로드하고 저장·검증합니다. 대상 OS별로 연결한 기기에서 테스트하고 네이티브 닫기로 검수를 마칩니다. 캠페인 관리에서 같은 버전의 OS별 검수 통과 후 앱 실행 직후 조건, 기간, 빈도와 시간대를 저장하고 게시합니다. 작업실 테스트는 콘텐츠 검수이며 4초 자동 종료 검증은 아닙니다.' },
      { title: '새 프로세스에서 흐름과 이벤트를 확인합니다', body: '통제된 테스트 앱의 게시 캠페인으로 프로세스를 종료하고 다시 실행합니다. 표시·노출·dismiss(auto_dismiss)와 메인 복귀를 확인하세요. API 주소/SDK 키마다 프로세스당 한 번만 시도합니다. 객체 재생성·disable/enable로 재시도하지 않으며 재실행해도 서버 빈도·숨김 제한은 유지됩니다. KST 기준 일일 제한은 Asia/Seoul을 선택합니다.' },
      { title: '표시되지 않는 이유를 구분합니다', body: 'noCampaign/NO_CAMPAIGN은 선택 가능한 광고 없음, timedOut/TIMED_OUT은 준비 시간 초과, blocked/BLOCKED는 호스트 조건 불충족입니다. cancelled/CANCELLED는 상태 변경, failed/FAILED는 통신·검증 실패, alreadyHandled/ALREADY_HANDLED는 활성화 또는 시작 기회 사용을 뜻합니다. 준비 중 screen/contextChanged/disable 및 백그라운드 전환은 취소합니다. 결과 Bool은 새 시도 여부이며 노출 성공 여부가 아닙니다.' },
    ],
    examples: [
      { label: 'iOS · SPM 0.2.5 + NudgeOnInApp product', code: '.package(url: "https://github.com/NudgeOn/nudgeon-ios-sdk.git", exact: "0.2.5")\n// Add .product(name: "NudgeOnInApp", package: "nudgeon-ios-sdk") to your target.' },
      { label: 'iOS · 전체 실행 소스 펼치기 / 복사', code: swift, complete: true },
      { label: 'Android · Maven Central 의존성', code: 'implementation("io.nudgeon:nudgeon-sdk:0.2.5")\nimplementation("io.nudgeon:nudgeon-inapp:0.2.5")\nimplementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")' },
      { label: 'Android · 전체 실행 소스 펼치기 / 복사', code: kotlin, complete: true },
    ],
    note: '전체 예제 프로젝트와 실행 안내는 아래 링크에서 받습니다. 두 예제에서 Connect for content review로 연결 코드를 입력하고 확인 숫자를 대조할 수 있습니다. 앱에서 전송 상태와 서버 확인(대기 0)을 확인하고 End test session으로 종료하세요. 일시적 실패는 기록을 보관하고 자동 재시도합니다. 재전송할 수 없는 오류는 새 검수 준비를 안내합니다. 수신 완료 뒤 “다음: 콘솔에서 검수 승인”을 따라 진행하세요. 서버 수신은 검수 통과가 아닙니다. 검수와 운영 광고는 동시에 실행하지 않으며 백그라운드 전환 때 중단합니다. 첫 실행에서 동의한 후 프로세스를 종료·재실행하세요. 추가 화면·이벤트·복귀 캠페인은 앱 생명주기에 맞춰 별도로 연결합니다. InAppTestClient와 운영 InAppCampaignClient는 별도입니다. 앱스토어 업데이트 없이 콘텐츠를 바꾸려면 먼저 앱에 SDK·호스트 연결을 배포해야 합니다. 일반 인앱 팝업의 닫기·숨김 동작은 유지됩니다.',
    source: 'APP-LAUNCH-ADS · IN-APP-CAMPAIGNS · iOS/Android SDK 0.2.5', links: links.ko,
  },
  en: {
    help: launchAdHelp.en, quickstart: launchAdQuickstart.en,
    id: 'launch-ads', tests: launchAdTests.en, eyebrow: 'APP LAUNCH ADS · iOS & ANDROID',
    title: 'Show a timed full-screen ad after the launch screen',
    intro: 'APP-AD targets all new and existing users of this app. No login, segment membership or test pairing is required; SDK integration, consent, schedule and frequency still apply on selected platforms. OS launch screen → host startup cover → opaque full-screen ad → main screen. SDK 0.2.5 automatically dismisses the ad 4 seconds after presentation by default. Configure 3–5 seconds; startup ads have no native close or hide-today buttons.',
    endpoint: 'enableAfterLaunch(timeoutSeconds: 3, displaySeconds: 4) · trigger: launch',
    steps: [
      { title: 'Prepare the server and native SDKs', body: 'Deploy the launch-capable server/console and migrations 0010–0012 first. Enable IN_APP_ENABLED and IN_APP_CAMPAIGNS_ENABLED, persistent asset storage and a separate HTTPS content host. Use SPM NudgeOnInApp and Maven in-app/core 0.2.5. React Native and Flutter in-app integration is not yet available.' },
      { title: 'Connect the host startup flow', body: 'Retain InAppCampaignClient in the app owner and place a startup cover above the first main frame. Once consent, routing and the presentation host are ready, call enableAfterLaunch once instead of enable(). Skip the launch opportunity for initial consent, deep links, permission prompts or checkout; do not insert it later in navigation.' },
      { title: 'Separate preparation time from display time', body: 'timeoutSeconds bounds preparation (3 seconds by default, range 1–10); displaySeconds controls visible time (4 seconds by default, range 3–5). Remove the cover on every result, including shown/SHOWN, when the opaque ad covers the main UI. This callback reports presentation start, not dismissal. Add an independent 3-second host fallback and lifecycle cleanup.' },
      { title: 'Review content, then publish a launch campaign', body: 'Choose the full-screen startup ad example or upload HTML/ZIP in the in-app workbench and save/validate. Test on each target OS and finish with the native close button. Approve the same revision for each OS in campaign management, select the app-launch trigger, save dates, frequency and time zone, then publish. Workbench testing reviews content; it does not verify the four-second launch timer.' },
      { title: 'Verify a new process and its events', body: 'Use a published campaign in a controlled test app. Terminate and relaunch the process; check presented, impression, dismiss(auto_dismiss), and return to main. Only one launch attempt per API URL/SDK key is available in a process. Recreating the owner or disabling/enabling does not reset it; server frequency and suppression limits survive a process restart. Choose Asia/Seoul for KST daily limits.' },
      { title: 'Distinguish no ad from a failure', body: 'noCampaign/NO_CAMPAIGN means no eligible ad; timedOut/TIMED_OUT means preparation expired; blocked/BLOCKED means host conditions failed. cancelled/CANCELLED means context changed, failed/FAILED indicates communication/validation failure, and alreadyHandled/ALREADY_HANDLED means already enabled or consumed. screen/contextChanged/disable or backgrounding cancel preparation. The returned Boolean reports a new attempt, not a successful impression.' },
    ],
    examples: [
      { label: 'iOS · SPM 0.2.5 + NudgeOnInApp product', code: '.package(url: "https://github.com/NudgeOn/nudgeon-ios-sdk.git", exact: "0.2.5")\n// Add .product(name: "NudgeOnInApp", package: "nudgeon-ios-sdk") to your target.' },
      { label: 'iOS · expand / copy complete app source', code: swift, complete: true },
      { label: 'Android · Maven Central dependencies', code: 'implementation("io.nudgeon:nudgeon-sdk:0.2.5")\nimplementation("io.nudgeon:nudgeon-inapp:0.2.5")\nimplementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")' },
      { label: 'Android · expand / copy complete app source', code: kotlin, complete: true },
    ],
    note: 'Get the complete projects and run instructions from the links below. Both examples include Connect for content review and a persistent confirmation number. Check Delivery complete (Pending 0) in the app before End test session. Temporary failures retain records and retry automatically. Permanent errors guide you to Prepare new review. After delivery, follow Next: approve the review in the console. Receipt does not approve the review. Review and production clients never run together, and stop when inactive. Grant consent on first run, then terminate and relaunch. Integrate other screen/event/foreground campaigns with your own app lifecycle separately. InAppTestClient and the production InAppCampaignClient are separate. Deploy the SDK and host integration in your app before changing content without app updates. Ordinary in-app close/hide behavior is retained.',
    source: 'APP-LAUNCH-ADS · IN-APP-CAMPAIGNS · iOS/Android SDK 0.2.5', links: links.en,
  },
};
