export const content = {
  en: {
    title: 'NudgeOn | Open-source customer engagement & app launch ads',
    description: 'Self-host customer journeys, push notifications and iOS/Android app launch ads with NudgeOn. Open source, Apache-2.0. Partner beta candidate.',
    product: 'Product', deployment: 'Deployment', developer: 'Developer center', contact: 'Contact', home: 'NudgeOn home', skip: 'Skip to content',
    headline: ['Give them a reason', 'to come back.'],
    intro: 'Open-source customer engagement, from the first event to the next push.',
    explore: 'Explore NudgeOn', alpha: 'Apache-2.0 · Partner beta candidate · Self-hosted',
    demoHeadline: ['Your next journey,', 'in one view.'],
    demoIntro: ['Start with an event. Connect the steps. Shape your message.', 'Explore the current NudgeOn journey editor.'],
    consoleAlt: 'NudgeOn journey editor with step tools on the left, an event-to-push journey in the center, and push message settings and a phone preview on the right.',
    consoleNote: 'Current console interface · Sample data · Shown in Korean',
    consoleExpand: 'View full screen',
    consoleTitle: 'Inside the journey editor',
    consoleFeatures: [
      ['Start with a customer action', 'Choose the event that starts a journey.'],
      ['Build the flow', 'Connect messages, waits and branching steps.'],
      ['Refine the message', 'Edit push copy and check its preview in the settings panel.']
    ],
    guideLink: 'Explore the user guide',
    deploymentHeadline: 'Run it your way.',
    selfIntro: 'Your infrastructure. Your customer data.',
    cloudIntro: 'Managed hosting is in preparation.',
    setup: 'Read the setup guide', status: 'Release status',
    releaseNote: 'NudgeOn is a partner beta candidate. Native SDK 0.2.8 is published; RN/Flutter publication and operational beta gates remain open.',
    footer: 'Open-source customer engagement.',
    close: 'Close',
    roadmapTitle: 'What needs to be ready.',
    roadmapIntro: 'NudgeOn Cloud is not open for signup or billing. Plans, pricing and availability have not been announced.',
    roadmap: [
      ['Reliable delivery', 'Recover failed sends, handle provider throttling, and make retries and dead-letter handling observable.'],
      ['Connected SDKs', 'Carry the same message ID through delivery and opens. Sync consent, logout and token ownership with the server.'],
      ['Operational checks', 'Verify isolation, restore backups, exercise upgrades and load, and complete the SDK integration tests.']
    ],
    roadmapEnd: 'The source includes recent fixes that still need integrated verification. An implemented feature is not the same as a completed release check.'
  },
  ko: {
    title: 'NudgeOn | 오픈소스 고객 인게이지먼트·푸시·앱 시작 광고',
    description: '고객 이벤트 수집, 세그먼트, 푸시 알림과 iOS·Android 앱 시작 전면 광고를 우리 서버에서 운영하세요. Apache-2.0 오픈소스 NudgeOn. 현재 파트너 베타 후보입니다.',
    product: '제품', deployment: '도입 방식', developer: '개발자센터', contact: '문의하기', home: 'NudgeOn 홈', skip: '본문으로 건너뛰기',
    headline: ['다시 찾아올', '이유를 보내세요.'],
    intro: '고객의 행동을 다음 푸시로 연결하는 오픈소스 고객 인게이지먼트 플랫폼.',
    explore: 'NudgeOn 살펴보기', alpha: 'Apache-2.0 · 파트너 베타 후보 · 직접 설치·운영',
    demoHeadline: ['다음 고객 여정을,', '한 화면에서.'],
    demoIntro: ['이벤트로 시작하고, 흐름을 연결하고, 메시지를 다듬으세요.', 'NudgeOn의 실제 저니 편집 화면을 살펴보세요.'],
    consoleAlt: '왼쪽 단계 도구, 중앙 이벤트에서 푸시로 이어지는 저니, 오른쪽 메시지 설정과 휴대폰 미리보기가 있는 NudgeOn 저니 편집기.',
    consoleNote: '현재 콘솔 화면 · 예시 데이터',
    consoleExpand: '화면 크게 보기',
    consoleTitle: '저니 편집기 살펴보기',
    consoleFeatures: [
      ['고객 행동에서 시작', '저니를 시작할 이벤트와 진입 조건을 정합니다.'],
      ['단계로 연결하는 흐름', '메시지, 대기, 분기를 연결해 여정을 구성합니다.'],
      ['메시지를 보며 작성', '설정 패널에서 푸시 문구를 다듬고 미리 확인합니다.']
    ],
    guideLink: '유저가이드 살펴보기',
    deploymentHeadline: '운영 방식은 우리 팀에 맞게.',
    selfIntro: '우리 인프라에서, 고객 데이터도 직접 관리.',
    cloudIntro: '운영을 맡길 수 있는 관리형 서비스를 준비하고 있습니다.',
    setup: '설치 안내', status: '출시 준비 현황',
    releaseNote: 'NudgeOn은 파트너 베타 후보입니다. 네이티브 SDK 0.2.8는 공개 배포됐으며 RN·Flutter 게시와 운영 베타 검증이 남아 있습니다.',
    footer: '오픈소스 고객 인게이지먼트 플랫폼.',
    close: '닫기',
    roadmapTitle: '출시 전에 확인할 것들.',
    roadmapIntro: 'NudgeOn Cloud는 아직 가입·결제를 받지 않습니다. 요금과 제공 범위, 출시 일정은 확정 후 안내합니다.',
    roadmap: [
      ['발송 안정성', '실패한 발송의 복구, 공급자 속도 제한 대응, 재시도와 실패 메시지 보관·재처리.'],
      ['SDK 연결', '발송부터 도달·열기까지 같은 메시지 ID 사용. 수신 동의, 로그아웃, 토큰 소유권을 서버와 동기화.'],
      ['운영 검증', '테넌트 격리, 백업 복구, 업그레이드, 부하와 SDK 전체 연동 검증.']
    ],
    roadmapEnd: '최근 수정이 반영된 항목도 통합 검증이 남아 있습니다. 코드가 작성된 것과 출시 검증이 끝난 것은 구분합니다.'
  }
};
