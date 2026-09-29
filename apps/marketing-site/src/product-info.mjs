// Shared by the visible homepage and the optional llms.txt reading guide.
// Release claims must match docs-public/RELEASE-CHECKLIST.md.
export const productInfo = {
  en: {
    category: 'Open-source customer engagement platform',
    title: 'What can you build with NudgeOn?',
    intro: 'Collect app events, segment customers, and connect push notifications, email and in-app campaigns in one self-hosted platform.',
    questions: [
      ['What is NudgeOn?', 'NudgeOn is an Apache-2.0 open-source customer engagement platform. Teams collect customer events, build audience segments, create event-triggered journeys, and check message delivery on their own infrastructure.'],
      ['Which messaging channels are available?', 'NudgeOn implements push notifications through FCM and APNs, email, and HTML-based in-app campaigns for native iOS and Android apps. Alimtalk currently has a connector contract and mock vendor; live Alimtalk delivery is not available.'],
      ['Can I show a full-screen ad when my app starts?', 'Yes. APP LAUNCH ADS displays a full-screen campaign after the launch screen, then automatically opens the main app after 3–5 seconds (4 seconds by default). Campaigns can include new and existing installations on the selected OS, subject to consent, schedule, frequency limits and app readiness.'],
      ['Do content changes require another app release?', 'An app developer first integrates the native SDK and presentation host. After that integration is released, your team can upload HTML and web assets to NudgeOn, test them, approve the review and publish content changes from the console without releasing the app again.'],
      ['How do I install NudgeOn on my own server?', 'Install Docker Engine, Compose v2, Git, OpenSSL and cURL. Clone the repository, run ./nudgeon up and open the setup link shown in the terminal. The wizard guides database password and first owner setup, login and optional OTP. The first run builds from source; a ready-to-run platform image is not yet the installation path.'],
      ['Can AI analyze our customer data?', 'Yes, when your installation includes MCP and your operator enables it. Connect an external AI with your own NudgeOn account and choose one app. It can read metric definitions and analyze event trends, message performance, funnels and D1/D7/D30 retention, then save segment and journey drafts for console review. MCP is disabled by default; external client compatibility still needs to be verified.'],
      ['Does everyone get the same AI permissions?', 'No. Viewer can read and analyze; Editor and higher can opt in to draft editing. Customer profile access requires administrator approval for the connection and the member’s explicit consent. Changes to roles or connections apply on the next request. AI cannot activate journeys, send messages or delete data through MCP.'],
      ['Which SDKs are published?', 'Native iOS and Android SDK 0.2.8 are published through Swift Package Manager and Maven Central. Android in-app campaigns also use io.nudgeon:nudgeon-inapp:0.2.8. React Native and Flutter public releases are pending, and their in-app launch-ad bridges are not available.'],
      ['Is NudgeOn ready for general production use?', 'NudgeOn is a partner beta candidate. Managed database recovery, target load and a 24-hour soak test, and external developer onboarding still need validation. Managed hosting is not available. Review the release checklist before planning a pilot.'],
    ],
    resourcesTitle: 'Choose your next step',
    resources: [
      ['For operators', 'Set up campaigns and read delivery results', '/guide/'],
      ['For app developers', 'Start with the SDK integration examples', 'https://developer.nudgeon.io/#sdk-quickstart'],
      ['For infrastructure teams', 'Install and operate your own instance', 'https://developer.nudgeon.io/#self-hosting'],
      ['For AI-assisted analysis', 'Connect your account and review AI-created drafts', '/guide/#mcp'],
      ['MCP integration', 'Configure OAuth, scopes and analysis queries', 'https://developer.nudgeon.io/#mcp'],
      ['Release status', 'Check verified features and remaining beta gates', 'https://github.com/NudgeOn/nudgeon-platform/blob/main/docs-public/RELEASE-CHECKLIST.md'],
    ],
  },
  ko: {
    category: '오픈소스 고객 인게이지먼트 플랫폼',
    title: 'NudgeOn으로 무엇을 할 수 있나요?',
    intro: '앱 이벤트 수집부터 고객 세분화, 푸시 알림·이메일·인앱 캠페인까지. 우리 서버에서 하나의 흐름으로 운영하세요.',
    questions: [
      ['NudgeOn은 어떤 서비스인가요?', 'NudgeOn은 Apache-2.0 라이선스의 오픈소스 고객 인게이지먼트 플랫폼입니다. 고객 이벤트를 수집하고, 세그먼트를 만들고, 행동에 따라 메시지를 보내는 저니와 발송 결과를 우리 인프라에서 직접 관리합니다.'],
      ['어떤 메시지 채널을 지원하나요?', 'FCM·APNs 푸시 알림, 이메일, 네이티브 iOS·Android 앱의 HTML 기반 인앱 캠페인을 구현했습니다. 알림톡은 현재 커넥터 계약과 모의 공급자 단계이며, 실제 알림톡 발송은 지원하지 않습니다.'],
      ['앱 실행 직후 전면 광고를 보여줄 수 있나요?', 'APP LAUNCH ADS는 런치 화면 다음에 전체 화면 광고·이벤트를 표시하고, 3~5초 뒤 자동으로 메인 화면으로 이동합니다. 기본값은 4초입니다. 선택한 OS의 신규·기존 설치 모두를 대상으로 할 수 있으며, 동의·일정·노출 빈도·앱 준비 조건을 적용합니다.'],
      ['광고 내용을 바꿀 때마다 앱을 다시 배포해야 하나요?', '개발자가 먼저 네이티브 SDK와 광고를 표시할 호스트를 앱에 연결해 배포해야 합니다. 이후에는 NudgeOn 콘솔에 HTML과 웹 에셋을 업로드하고 테스트·검수 승인한 뒤 게시하면, 앱 재배포 없이 콘텐츠를 변경할 수 있습니다.'],
      ['내 서버에는 어떻게 설치하나요?', 'Docker Engine, Compose v2, Git, OpenSSL, cURL을 준비합니다. 저장소를 내려받아 ./nudgeon up을 실행하고 터미널의 설치 링크를 여세요. 위자드에서 DB 비밀번호와 첫 관리자 설정, 로그인, 선택 사항인 OTP를 안내합니다. 첫 실행은 소스 빌드가 필요하며, 완성된 플랫폼 이미지를 내려받기만 하는 방식은 아직 제공하지 않습니다.'],
      ['AI로 고객 데이터를 분석할 수 있나요?', 'MCP가 포함된 버전을 설치하고 운영자가 기능을 활성화하면 가능합니다. 본인 NudgeOn 계정으로 외부 AI를 연결하고 앱 하나를 선택하세요. 지표 정의와 함께 이벤트 추이·메시지 성과·퍼널·D1·D7·D30 리텐션을 분석하고, 콘솔에서 검토할 세그먼트·저니 초안을 저장할 수 있습니다. MCP는 기본 비활성이며 외부 클라이언트별 연결 검증은 별도로 필요합니다.'],
      ['사람마다 AI에 허용되는 권한이 다른가요?', 'Viewer는 조회·분석, Editor 이상은 동의한 범위에서 초안 편집이 가능합니다. 고객 프로필 조회에는 연결별 관리자 승인과 본인 동의가 모두 필요합니다. 역할 변경·연결 해제는 다음 요청부터 반영됩니다. MCP에서는 AI가 저니를 활성화하거나 메시지를 보내거나 데이터를 삭제할 수 없습니다.'],
      ['현재 사용할 수 있는 SDK는 무엇인가요?', '네이티브 iOS·Android SDK 0.2.8가 Swift Package Manager와 Maven Central에 공개돼 있습니다. Android 인앱 캠페인에는 io.nudgeon:nudgeon-inapp:0.2.8도 사용합니다. React Native·Flutter는 공개 게시가 남아 있으며, 인앱·시작 광고 브리지는 아직 제공하지 않습니다.'],
      ['바로 정식 운영에 도입해도 되나요?', '현재는 파트너 베타 후보입니다. 관리형 DB 복구, 목표 부하와 24시간 연속 시험, 외부 개발자 온보딩 검증이 남아 있습니다. 관리형 호스팅은 제공하지 않습니다. 파일럿을 계획하기 전에 출시 체크리스트에서 검증 범위를 확인하세요.'],
    ],
    resourcesTitle: '담당 업무에 맞춰 시작하세요',
    resources: [
      ['서비스 운영자', '캠페인 설정부터 발송 결과 확인까지', '/ko/guide/'],
      ['앱 개발자', 'SDK 연결 예제로 시작하기', 'https://developer.nudgeon.io/#sdk-quickstart'],
      ['인프라 담당자', '우리 서버에 설치하고 운영하기', 'https://developer.nudgeon.io/#self-hosting'],
      ['AI로 분석하는 팀', '내 계정으로 연결하고 AI 초안 검토하기', '/ko/guide/#mcp'],
      ['MCP 연동 개발자', 'OAuth·권한·분석 도구 설정하기', 'https://developer.nudgeon.io/#mcp'],
      ['출시 상태 확인', '검증된 기능과 남은 베타 조건 보기', 'https://github.com/NudgeOn/nudgeon-platform/blob/main/docs-public/RELEASE-CHECKLIST.md'],
    ],
  },
};
