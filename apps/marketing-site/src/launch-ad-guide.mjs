import { launchAdHelp } from './launch-ad-help.mjs';
import { launchAdTests } from './launch-ad-tests.mjs';

export const launchAdGuide = {
  ko: {
    help: launchAdHelp.ko,
    id: 'launch-ads', tests: launchAdTests.ko, nav: '앱 시작 전면 광고', title: '앱을 여는 순간, 전면 광고를 보여주세요.',
    intro: 'APP LAUNCH ADS · iOS & ANDROID. 신규·기존 사용자 전체가 대상입니다. 회원 로그인이나 테스트 기기 연결 없이, 선택한 OS의 SDK 연결 기기에서 동의·기간·빈도 조건에 따라 표시합니다. 런치 화면 다음에 이벤트·프로모션을 3~5초 보여주고 자동으로 메인으로 이동합니다. 기본 4초이며, 닫기 버튼을 누를 필요가 없습니다.',
    where: '인앱 이벤트 → 시작 전면 광고 예제 → 캠페인 관리',
    steps: [
      ['개발 담당자와 시작 화면을 연결하세요', 'iOS·Android SDK 0.2.4의 인앱 모듈과 앱 시작 흐름 연결이 필요합니다. 서버의 인앱 기능도 켜져 있어야 합니다. 먼저 테스트 앱과 기기를 준비하세요. 최초 동의·딥링크·권한 요청처럼 다른 화면이 우선이면 시작 광고를 건너뛰도록 개발 담당자와 정합니다.'],
      ['전면 광고 소스를 만드세요', '인앱 이벤트에서 시작 전면 광고 예제를 선택하거나 HTML/ZIP을 업로드하세요. HTML·CSS·JS와 이미지는 NudgeOn에서 관리합니다. 화면 전체를 채우는 문구와 디자인을 편집한 뒤 저장·검증을 누릅니다. 광고 표시 시간은 HTML 타이머가 아닌 SDK 설정입니다.'],
      ['연결한 기기에서 콘텐츠를 검수하세요', '미리보기로 모양을 확인하고, 기기 연결 코드를 앱의 테스트 연결 화면에 입력합니다. 확인 숫자를 대조한 뒤 같은 기기 확인 → 내 기기에서 실행 순서로 진행하세요. 대상 iOS·Android에서 각각 확인하고 마지막 테스트는 네이티브 닫기로 마칩니다. 작업실 테스트는 콘텐츠 검수이므로 이 단계에서 4초 자동 종료를 기대하지 않습니다.'],
      ['검수한 버전으로 캠페인을 게시하세요', '캠페인 관리에서 같은 소스 버전의 OS별 테스트와 검수 항목을 확인한 뒤 검수 통과를 누릅니다. 표시 조건은 앱 실행 직후로 선택합니다. 대상 OS, 시작·종료 시각, 빈도와 시간대를 설정하고 초안 저장 → 저장된 버전 게시 순서로 진행합니다. 한국 날짜 기준 하루 1회라면 시간대를 Asia/Seoul로 지정하세요. 검수·게시·중지는 Admin/Owner가 진행합니다.'],
      ['앱을 다시 실행해 실제 시작 흐름을 확인하세요', '먼저 통제된 테스트 앱에 게시하고 앱 프로세스를 종료한 뒤 다시 실행하세요. 런치 화면 → 전면 광고 → 약 4초 후 메인 진입을 확인합니다. 운영 기록에서 표시·노출·자동 종료를 확인하세요. 홈 버튼으로 나갔다 돌아오는 것만으로는 새 시작 기회가 생기지 않으며, 재실행해도 일일 제한과 숨김 상태는 유지됩니다.'],
      ['소식을 바꾸거나 노출을 멈추세요', '게시 중인 캠페인은 먼저 중지하세요. 콘텐츠를 바꾸면 새 소스 버전을 저장하고 OS별 검수를 다시 진행합니다. 수정한 캠페인을 저장·재게시하세요. SDK와 앱 시작 흐름을 이미 연결한 앱은 콘텐츠 변경 때마다 앱 업데이트를 할 필요가 없습니다.'],
    ],
    check: '대상 OS별 콘텐츠 검수와 게시한 테스트 캠페인의 실제 시작 흐름을 모두 확인했습니다. 일반 팝업과 달리 시작 광고에는 네이티브 닫기·오늘 하루 안 보기 버튼이 표시되지 않습니다.',
    note: '광고가 없거나 기본 3초 준비 기한을 넘기면 메인으로 진입합니다. 표시되지 않으면 게시 상태·기간·대상 OS·앱 실행 직후 조건·빈도·시간대를 확인하세요. 웹 미리보기와 기기 테스트 이력은 운영 노출 기록과 별도입니다. 일반 인앱 팝업의 닫기·숨김 기능은 유지됩니다.',
    links: [['iOS·Android 시작 광고 연결', 'launch-ads']],
    flow: ['런치 화면', '전면 광고 · 기본 4초', '자동 종료 → 메인'],
  },
  en: {
    help: launchAdHelp.en,
    id: 'launch-ads', tests: launchAdTests.en, nav: 'App launch ads', title: 'Show a full-screen ad as your app opens.',
    intro: 'APP LAUNCH ADS · iOS & ANDROID. Target all new and existing users. No login or test pairing is required; SDK integration, consent, schedule and frequency apply on selected platforms. Display an event or promotion after the launch screen for 3–5 seconds, then move automatically to the main screen. The default is 4 seconds. No close tap is needed.',
    where: 'In-app events → Full-screen startup ad example → Campaign management',
    steps: [
      ['Connect the startup flow with your developer', 'Install the iOS or Android in-app SDK 0.2.4 and integrate the host startup flow. Enable the server in-app features and prepare a controlled test app and device. Agree on when to skip startup ads, including initial consent, deep links and permission prompts.'],
      ['Create your full-screen content', 'Select the full-screen startup ad example or upload HTML/ZIP in the in-app workbench. NudgeOn manages HTML, CSS, JavaScript and images. Edit the full-screen design and copy, then save and validate. Display duration is an SDK setting, not an HTML timer.'],
      ['Review content on connected devices', 'Check the preview, generate a pairing code and enter it in the app test connection screen. Compare confirmation numbers, approve the device, then run on your device. Check every target OS and finish the last test with the native close button. Workbench testing reviews content; do not expect four-second automatic dismissal at this stage.'],
      ['Publish the reviewed revision', 'In campaign management, review the same revision’s OS-specific tests and approve the review checklist. Choose the app-launch trigger. Set target platforms, start/end dates, frequency and time zone, then save the draft and publish the saved version. For one display per Korean calendar day, use Asia/Seoul. Admins/Owners approve, publish and stop campaigns.'],
      ['Relaunch the app to verify the actual flow', 'Publish to a controlled test app first. Terminate its process and open it again: launch screen → full-screen ad → main after about 4 seconds. Check presented, impression and automatic dismissal in production records. Returning from the background does not create another launch opportunity. Restarting the process does not reset daily or suppression limits.'],
      ['Update your story or stop showing it', 'Stop an active campaign before editing it. Content edits create a new revision that needs a new review for each OS. Save and republish the campaign. Once the SDK and host startup flow are integrated, content changes do not require another app update.'],
    ],
    check: 'You have verified content on every target OS and the actual startup flow of a published test campaign. Startup ads have no native close or hide-today buttons.',
    note: 'If no ad is available or the default 3-second preparation deadline expires, the app proceeds to main. Check publication, dates, target OS, app-launch trigger, frequency and time zone if nothing appears. Preview/device-test history is separate from production records. Ordinary in-app close and hide behavior remains available.',
    links: [['Integrate iOS and Android startup ads', 'launch-ads']],
    flow: ['Launch screen', 'Full-screen ad · 4s default', 'Auto-dismiss → main'],
  },
};
