import { launchAdGuide } from "../src/launch-ad-guide.mjs";
const siteUrl = 'https://nudgeon.io';
const docsUrl = 'https://developer.nudgeon.io';
const repoUrl = 'https://github.com/NudgeOn/nudgeon-platform';
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Grounded in the current console onboarding, users, SegmentBuilder, JourneyEditor,
// settings and logs screens, plus docs-public/CONSOLE-GUIDE.md and JOURNEY-GRAPH.md.
const copy = {
  en: {
    title: 'NudgeOn user guide | From your first customer to your first push',
    description: 'A practical guide for NudgeOn operators: prepare your app, understand customers, build audiences, set up push journeys and full-screen startup ads, and check results.',
    home: 'NudgeOn home', product: 'Product', deployment: 'Deployment', guide: 'User guide', developer: 'Developer center', language: 'Language', navigation: 'Main navigation', skip: 'Skip to the guide',
    heading: 'A clear path to\nyour first message.',
    intro: 'Start with one test customer. Check the audience, shape the message, and follow the result before opening the journey to more people.',
    scope: 'For operators working with a team that has installed NudgeOn and connected its app. NudgeOn is a partner beta candidate; native iOS and Android SDK 0.2.4 are published.',
    toc: 'In this guide', start: 'Start with your app', sectionLabel: 'Step', where: 'In the console', checkpoint: 'Before you continue', technical: 'Developer reference',
    sections: [
      {
        id: 'prepare', nav: 'Prepare your app', title: 'Begin with a connected app.',
        intro: 'Your team’s console and the customer’s app work together. Confirm the connection with your developer before preparing a campaign.',
        where: 'Start setup · App settings',
        steps: [
          ['Confirm your workspace', 'Open the console address provided by your administrator. In Start setup, check the app name so your team is working in the intended environment. Ask the administrator for access if you cannot reach it.'],
          ['Complete the app connection together', 'The setup flow covers SDK keys, channel credentials, the first event, and a test send. Your developer handles the SDK and FCM or APNs connection; you agree on the event names and the test customer to use.'],
          ['Set the sending rules', 'Review the app’s time zone, quiet hours, and frequency limit in App settings. Use a test device with notifications allowed, a registered push token, and the correct customer identity.'],
        ],
        check: 'The intended app is selected, its first event is visible, and your developer has confirmed the push channel connection.',
        note: 'Keep provider credentials and server keys with the person responsible for the integration. Screenshots and support requests should contain only the information needed to identify the issue.',
        links: [['SDK setup', 'sdk-quickstart'], ['Push permissions', 'push-permissions'], ['Self-hosting', 'self-hosting']],
      },
      {
        id: 'audience', nav: 'Find your audience', title: 'Know who should receive it.',
        intro: 'A customer is a profile. A segment is a set of conditions that selects profiles. Start with a customer you can identify before defining a wider audience.',
        where: 'User search · Data · Segments',
        steps: [
          ['Find your test customer', 'In User search, enter the exact customer identifier or email address. Open the profile and inspect its devices and recent events. The identifier is the value your app uses to recognize the customer.'],
          ['Check the data you will use', 'Use the Data screen for collected attributes and collection errors, and the customer profile for recent event names. Match names and values with your developer. A rule based on an event that has not arrived cannot describe the intended audience yet.'],
          ['Create and preview a segment', 'Choose New segment and give it a name your team will recognize. Add attribute or event conditions, then use AND when every condition must match or OR when any may match. Review the estimated audience before saving.'],
        ],
        check: 'You can explain each condition in one sentence and the preview fits the audience you intended.',
        note: 'The preview is an estimate at the time of the query. Device state, permission, consent, and sending rules are checked separately. Before sending, ask your integration owner to confirm that opt-outs and logout changes also reach the server; automatic SDK synchronization of these changes is not yet complete.',
        links: [['Segments', 'segments'], ['Customer and event concepts', 'concepts']],
      },
      {
        id: 'message', nav: 'Build your message', title: 'Test first, then send your message.',
        intro: 'A test push checks one customer’s connection. A journey decides when customers enter and which message or wait step comes next.',
        where: 'Start setup · Test send · Journeys',
        steps: [
          ['Receive a test push first', 'In the setup flow, send a test to the customer identity used on your test device. Watch the device and open the notification. A queued confirmation means the request entered the queue; check the actual notification as well.'],
          ['Create a focused journey', 'Choose New journey and name it. Segment entry uses a saved segment; event entry uses the exact event name collected by the app. Event entry has no segment filter, so test it in a separate test app with a test-only event. Add a push message, write its title and body, and add a wait step if needed.'],
          ['Save, validate, and activate deliberately', 'Save the draft, then choose Validate and activate. Resolve the highlighted issues and review the activation summary. Activation can send real messages. Use a controlled test segment for segment entry, or the separate test app and test-only event for event entry.'],
        ],
        check: 'The test device received and opened the message, and the journey’s audience, entry condition, copy, and sending rules have been reviewed.',
        note: 'To edit an active journey, use Pause and edit. Waiting deadlines continue while paused; customers already in a journey keep the version they entered. Review the effect on those customers before resuming.',
        links: [['Create a push', 'push-create'], ['Journeys', 'journeys']],
      },
      launchAdGuide.en,
      {
        id: 'results', nav: 'Read the results', title: 'Follow the message all the way through.',
        intro: 'Sending, device delivery, and opening are separate events. Use the report and the individual message log together to understand what happened.',
        where: 'Dashboard · Journey report · Message logs',
        steps: [
          ['Read the journey’s progress', 'Open the journey report to inspect entered, waiting, and completed runs and the results of individual steps. Use the dashboard for an overview, then narrow the review to the journey you changed.'],
          ['Inspect individual messages', 'Use Message logs to review the customer, channel, time, status, and failure reason for a send. A provider accepting a message is different from the device displaying it. Delivery and open reports depend on the corresponding SDK events.'],
          ['Record what you can verify', 'Compare a controlled test with the device: notification received, notification opened, and the corresponding result recorded. If the report is incomplete, give your developer the time, customer identifier, journey, and visible error, with private values removed.'],
        ],
        check: 'You can distinguish a request that was queued, a provider send, an observed device receipt, and an open event.',
        note: 'Use evidence from your own connected app before expanding the audience. A preview on this website is a demonstration; it does not send a message or establish delivery.',
        links: [['Troubleshooting', 'debugging'], ['Operations', 'operations']],
      },
    ],
    exampleTitle: 'One simple journey', exampleLabel: 'Illustrative flow using supported journey steps', example: ['An app event arrives', 'Wait for a set time', 'Send a push message'], exampleNote: 'An example of the sequence, not an active campaign. Choose the event, audience, delay, and content that fit your app.',
    screenshotAlt: 'NudgeOn journey editor with a step canvas and a push message settings panel', screenshotCaption: 'The current console editor, shown in Korean with example data.', screenshotOpen: 'View the full console image',
    troubleshootTitle: 'When the result is different',
    troubleshooting: [
      ['No customer or event appears', 'Check the customer identifier and the app environment first. Ask your developer to confirm the SDK connection and event collection.'],
      ['The audience estimate is unexpected', 'Review AND/OR groups, attribute values, event names, and time windows. Check a known customer profile against the conditions before broadening the audience.'],
      ['A test is queued but no notification arrives', 'Check the device notification permission, registered token, customer identity, and channel credentials with your developer. Then inspect the message log for its actual status.'],
      ['The journey cannot be activated', 'Read the highlighted validation issues. Confirm the entry event, required message fields, and connections between steps, then save and validate again.'],
      ['A push arrives but the report is missing an open', 'Open the notification on the test device. Ask your developer to check delivery and open event reporting; do not treat a missing event as proof that the user did not see the message.'],
    ],
    nextTitle: 'Keep your team on the same page.', nextBody: 'Use this guide for the operating steps. Share the developer center with the person connecting your app and managing the infrastructure.',
    nextLink: 'Open the developer center', sources: 'Guide references', sourceConsole: 'Current console guide', sourceJourney: 'Journey behavior', contact: 'Contact', footer: 'Customer engagement, on your terms.', top: 'Back to top',
  },
  ko: {
    title: 'NudgeOn 사용자 가이드 | 첫 고객부터 첫 푸시까지',
    description: '앱 준비, 고객과 세그먼트 확인, 푸시·저니와 시작 전면 광고 설정, 결과 확인까지. NudgeOn 운영자를 위한 사용 순서를 안내합니다.',
    home: 'NudgeOn 홈', product: '제품', deployment: '도입 방식', guide: '유저가이드', developer: '개발자센터', language: '언어 선택', navigation: '메인 메뉴', skip: '가이드 본문으로 이동',
    heading: '첫 메시지까지,\n순서대로 시작하세요.',
    intro: '테스트 고객 한 명으로 시작하세요. 대상을 확인하고 메시지를 만든 뒤, 실제 결과를 살펴보며 저니의 범위를 넓혀가세요.',
    scope: 'NudgeOn을 설치하고 앱을 연결한 팀의 운영자를 위한 가이드입니다. 현재 파트너 베타 후보이며 iOS·Android SDK 0.2.4가 공개되어 있습니다.',
    toc: '가이드 순서', start: '앱 준비부터 보기', sectionLabel: '단계', where: '콘솔에서 찾기', checkpoint: '다음 단계로 가기 전', technical: '개발자 참고 문서',
    sections: [
      {
        id: 'prepare', nav: '앱 준비', title: '연결된 앱에서 시작합니다.',
        intro: '팀이 사용하는 콘솔과 고객의 앱이 함께 동작합니다. 캠페인을 만들기 전에 개발 담당자와 연결 상태를 확인하세요.',
        where: '시작하기 · 앱 설정',
        steps: [
          ['작업할 앱을 확인하세요', '관리자가 안내한 콘솔 주소로 접속하세요. 시작하기 화면의 앱 이름을 보고 팀이 작업하려는 환경이 맞는지 확인합니다. 접속할 수 없다면 관리자에게 권한을 요청하세요.'],
          ['개발 담당자와 앱 연결을 마치세요', '시작하기는 SDK Key 준비, 채널 크리덴셜 등록, 첫 이벤트 수신, 테스트 발송 순서로 구성됩니다. SDK와 FCM·APNs 연결은 개발 담당자가 진행하고, 운영자는 사용할 이벤트 이름과 테스트 고객을 함께 정합니다.'],
          ['발송 기준을 정하세요', '앱 설정에서 타임존, 조용 시간, 발송 빈도 제한을 확인하세요. 테스트 기기는 알림 권한을 허용하고 푸시 토큰과 고객 식별 정보가 등록된 상태여야 합니다.'],
        ],
        check: '작업할 앱이 맞고 첫 이벤트가 표시되며, 개발 담당자가 푸시 채널 연결을 확인했습니다.',
        note: '공급자 인증 정보와 서버 키는 연동 담당자가 관리하세요. 화면을 공유하거나 문의할 때는 문제를 확인하는 데 필요한 정보만 남깁니다.',
        links: [['SDK 연동', 'sdk-quickstart'], ['푸시 권한', 'push-permissions'], ['직접 설치·운영', 'self-hosting']],
      },
      {
        id: 'audience', nav: '고객과 세그먼트', title: '누구에게 보낼지 확인합니다.',
        intro: '고객은 프로필 하나를, 세그먼트는 조건에 맞는 고객의 집합을 뜻합니다. 확인할 수 있는 고객부터 찾아보고 대상 조건을 만드세요.',
        where: '유저 검색 · 데이터 · 세그먼트',
        steps: [
          ['테스트 고객을 찾으세요', '유저 검색에서 고객 식별자 또는 이메일을 정확히 입력하세요. 프로필을 열어 기기와 최근 이벤트를 확인합니다. 고객 식별자는 앱에서 해당 고객을 구분할 때 사용하는 값입니다.'],
          ['사용할 데이터가 있는지 보세요', '데이터 화면에서는 수집된 속성과 수집 오류를, 고객 프로필에서는 최근 이벤트 이름을 확인하세요. 개발 담당자와 이름·값을 맞춥니다. 아직 수집되지 않은 이벤트로는 원하는 대상을 제대로 확인하기 어렵습니다.'],
          ['세그먼트를 만들고 미리 보세요', '새 세그먼트를 선택하고 팀이 알아볼 수 있는 이름을 적으세요. 속성이나 이벤트 조건을 추가합니다. 조건을 모두 만족해야 하면 AND, 하나라도 만족하면 OR로 묶고 예상 대상 수를 확인한 뒤 저장하세요.'],
        ],
        check: '각 조건을 한 문장으로 설명할 수 있고, 미리보기 결과가 의도한 대상과 맞습니다.',
        note: '예상 대상 수는 조회 시점의 추정치입니다. 실제 푸시 수신 가능 여부는 기기 상태, 알림 권한, 수신 동의와 발송 정책에 따라 따로 결정됩니다. 발송 전에 연동 담당자와 수신거부·로그아웃 상태가 서버에도 반영되는지 확인하세요. 해당 변경을 자동으로 동기화하는 SDK 구현은 아직 완료되지 않았습니다.',
        links: [['세그먼트', 'segments'], ['고객과 이벤트 개념', 'concepts']],
      },
      {
        id: 'message', nav: '푸시와 저니', title: '먼저 테스트하고, 메시지를 발송해 보세요.',
        intro: '테스트 푸시는 한 고객의 연결을 확인합니다. 저니는 고객이 언제 진입하고 어떤 메시지와 대기를 거칠지 정합니다.',
        where: '시작하기 · 테스트 발송 · 저니',
        steps: [
          ['테스트 푸시를 직접 받아보세요', '시작하기의 테스트 발송에서 테스트 기기에 등록한 고객 식별자를 사용하세요. 기기에 알림이 도착하는지 보고 알림을 눌러 앱을 엽니다. 큐 적재 안내는 요청 접수 상태이므로 실제 알림도 함께 확인합니다.'],
          ['간단한 저니를 만드세요', '새 저니를 선택하고 이름을 적으세요. 세그먼트 일괄 진입은 저장된 세그먼트를, 이벤트 발생 진입은 앱이 수집하는 정확한 이벤트 이름을 사용합니다. 이벤트 진입에는 세그먼트 필터가 없으므로 별도의 테스트 앱과 테스트 전용 이벤트로 확인하세요. 푸시 제목·본문을 작성하고 필요하면 시간 대기를 넣습니다.'],
          ['저장하고 검증한 뒤 활성화하세요', '임시 저장 후 검증 후 활성화를 선택하세요. 표시된 문제를 해결하고 활성화 확인 화면을 읽습니다. 활성화하면 실제 메시지가 발송될 수 있습니다. 세그먼트 진입은 확인 가능한 테스트 세그먼트로, 이벤트 진입은 별도 테스트 앱과 테스트 전용 이벤트로 시작하세요.'],
        ],
        check: '테스트 기기에서 수신과 열기를 확인했고, 저니의 대상·진입 조건·문구·발송 정책을 검토했습니다.',
        note: '활성 저니를 수정할 때는 일시정지하고 편집을 사용합니다. 일시정지 중에도 대기 제한시간은 흐르며, 이미 진입한 고객은 진입 당시 버전을 유지합니다. 재개 전에 기존 고객에게 미치는 영향을 확인하세요.',
        links: [['푸시 만들기', 'push-create'], ['저니', 'journeys']],
      },
      launchAdGuide.ko,
      {
        id: 'results', nav: '결과와 문제 해결', title: '메시지의 마지막 단계까지 봅니다.',
        intro: '발송, 기기 도달, 알림 열기는 서로 다른 단계입니다. 리포트와 개별 메시지 로그를 함께 확인하면 결과를 더 정확히 읽을 수 있습니다.',
        where: '대시보드 · 저니 리포트 · 메시지 로그',
        steps: [
          ['저니 진행 상황을 확인하세요', '저니 리포트에서 진입·대기·완료와 단계별 결과를 살펴보세요. 대시보드로 전체 흐름을 본 뒤, 변경한 저니를 중심으로 범위를 좁혀 확인합니다.'],
          ['개별 메시지를 확인하세요', '메시지 로그에서 발송 대상, 채널, 시각, 상태와 실패 사유를 확인하세요. 발송 공급자가 요청을 받은 것과 기기에 알림이 표시된 것은 다릅니다. 도달·열기 리포트는 해당 SDK 이벤트가 수집되어야 확인할 수 있습니다.'],
          ['확인한 결과를 남기세요', '테스트 기기에서 수신, 알림 열기, 대응하는 결과 기록을 비교하세요. 기록이 충분하지 않다면 시각, 고객 식별자, 저니와 화면의 오류를 정리해 개발 담당자에게 전달합니다. 개인 정보와 비밀 값은 가려주세요.'],
        ],
        check: '큐 접수, 공급자 발송, 실제 기기 수신과 알림 열기를 구분해 설명할 수 있습니다.',
        note: '대상을 넓히기 전에는 연결한 앱에서 얻은 결과를 확인하세요. 이 웹사이트의 미리보기는 동작을 설명하는 데모이며, 실제 메시지를 보내거나 도달을 확인하지 않습니다.',
        links: [['문제 해결', 'debugging'], ['운영 가이드', 'operations']],
      },
    ],
    exampleTitle: '간단한 저니의 흐름', exampleLabel: '지원하는 저니 단계로 구성한 예시', example: ['앱 이벤트 수신', '설정한 시간 대기', '푸시 메시지 발송'], exampleNote: '진행 순서를 설명하는 예시입니다. 실제 운영할 이벤트, 대상, 대기 시간과 문구는 앱에 맞게 정하세요.',
    screenshotAlt: '저니 단계 캔버스와 푸시 메시지 설정 패널이 있는 NudgeOn 저니 편집기', screenshotCaption: '현재 콘솔의 실제 편집 화면입니다. 저니와 데이터는 예시입니다.', screenshotOpen: '콘솔 화면 크게 보기',
    troubleshootTitle: '기대한 결과와 다를 때',
    troubleshooting: [
      ['고객이나 이벤트가 보이지 않아요', '먼저 고객 식별자와 앱 환경을 확인하세요. 개발 담당자에게 SDK 연결과 이벤트 수집 상태를 확인해 달라고 요청합니다.'],
      ['예상 대상 수가 생각과 달라요', 'AND/OR 그룹, 속성 값, 이벤트 이름과 조회 기간을 확인하세요. 범위를 넓히기 전에 알고 있는 고객 프로필이 조건에 맞는지 비교합니다.'],
      ['테스트가 큐에 들어갔는데 알림이 오지 않아요', '개발 담당자와 함께 기기의 알림 권한, 푸시 토큰, 고객 식별 정보와 채널 인증 상태를 확인하세요. 메시지 로그에서 실제 상태도 살펴봅니다.'],
      ['저니를 활성화할 수 없어요', '검증 결과에서 표시한 문제를 읽으세요. 진입 이벤트, 메시지 필수 입력과 단계 사이 연결을 확인하고 저장한 뒤 다시 검증합니다.'],
      ['알림은 도착했는데 열기 기록이 없어요', '테스트 기기에서 알림을 직접 눌러보세요. 개발 담당자에게 도달·열기 이벤트 수집을 확인해 달라고 요청합니다. 기록이 없다는 이유만으로 고객이 메시지를 보지 않았다고 판단하지 않습니다.'],
    ],
    nextTitle: '팀이 같은 순서로 시작할 수 있도록.', nextBody: '운영 순서는 이 가이드에서 확인하세요. 앱 연결과 인프라를 관리하는 담당자에게는 개발자센터를 공유해 주세요.',
    nextLink: '개발자센터로 이동', sources: '가이드 참고 문서', sourceConsole: '실제 콘솔 화면 안내', sourceJourney: '저니 동작 안내', contact: '문의하기', footer: '고객과의 연결을, 우리 방식으로.', top: '맨 위로',
  },
};

function languageLinks(lang, label) {
  return `<nav class="languages" aria-label="${label}"><a href="/guide/" lang="en" hreflang="en"${lang === 'en' ? ' aria-current="page"' : ''}>EN</a><span aria-hidden="true">/</span><a href="/ko/guide/" lang="ko" hreflang="ko"${lang === 'ko' ? ' aria-current="page"' : ''}>KO</a></nav>`;
}

export function renderGuide(lang) {
  if (!Object.hasOwn(copy, lang)) throw new RangeError(`Unsupported guide language: ${lang}`);
  const t = copy[lang];
  const home = lang === 'ko' ? '/ko/' : '/';
  const pageUrl = `${siteUrl}${lang === 'ko' ? '/ko/guide/' : '/guide/'}`;
  const socialImage = `${siteUrl}/assets/nudgeon-lockup.png`;
  const schema = { '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${pageUrl}#webpage`, url: pageUrl, name: t.title, description: t.description, inLanguage: lang, image: socialImage, about: { '@id': `${siteUrl}/#software` }, publisher: { '@type': 'Organization', '@id': `${siteUrl}/#organization`, name: 'NudgeOn' } };
  const flow = `<figure class="guide-flow"><figcaption>${t.exampleTitle}</figcaption><ol aria-label="${t.exampleLabel}">${t.example.map(item => `<li>${escape(item)}</li>`).join('')}</ol><p>${t.exampleNote}</p></figure>`;
  const screenshot = `<figure class="guide-screen"><a href="/assets/console-journey.png" aria-label="${t.screenshotOpen}"><img src="/assets/console-journey.png" alt="${t.screenshotAlt}" width="1600" height="1000" loading="lazy"></a><figcaption>${t.screenshotCaption} <a href="/assets/console-journey.png">${t.screenshotOpen} ↗</a></figcaption></figure>`;
  return `<!doctype html>
<html lang="${lang}"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light"><meta name="theme-color" content="#f5f4ef">
  <title>${escape(t.title)}</title><meta name="description" content="${escape(t.description)}">
  <link rel="canonical" href="${pageUrl}"><link rel="alternate" hreflang="en" href="${siteUrl}/guide/"><link rel="alternate" hreflang="ko" href="${siteUrl}/ko/guide/"><link rel="alternate" hreflang="x-default" href="${siteUrl}/guide/">
  <meta property="og:type" content="website"><meta property="og:site_name" content="NudgeOn"><meta property="og:title" content="${escape(t.title)}"><meta property="og:description" content="${escape(t.description)}"><meta property="og:url" content="${pageUrl}"><meta property="og:locale" content="${lang === 'ko' ? 'ko_KR' : 'en_US'}">
  <meta property="og:image" content="${socialImage}"><meta property="og:image:width" content="1600"><meta property="og:image:height" content="528"><meta property="og:image:alt" content="NudgeOn — N monogram and wordmark">
  <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escape(t.title)}"><meta name="twitter:description" content="${escape(t.description)}"><meta name="twitter:image" content="${socialImage}"><meta name="twitter:image:alt" content="NudgeOn — N monogram and wordmark">
  <script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>
  <link rel="icon" type="image/svg+xml" href="/assets/nudgeon-mark.svg"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/guide.css">
</head><body class="guide-page" id="top">
  <a class="skip" href="#main">${t.skip}</a>
  <header class="header shell guide-header"><a class="brand" href="${home}" aria-label="${t.home}"><img src="/assets/nudgeon-mark.svg" alt="" width="40" height="40"><span>NudgeOn</span></a><nav class="main-nav" aria-label="${t.navigation}"><a href="${home}#product">${t.product}</a><a href="${home}#deployment">${t.deployment}</a><a href="${lang === 'ko' ? '/ko/guide/' : '/guide/'}" aria-current="page">${t.guide}</a><a class="developer-link" href="${docsUrl}/">${lang === 'en' ? 'Developers' : t.developer}<span aria-hidden="true">↗</span></a></nav><div class="header-actions"><a class="github-link" href="${repoUrl}" aria-label="${lang === 'ko' ? 'GitHub에서 NudgeOn 소스 보기' : 'View NudgeOn on GitHub'}" title="GitHub"><img src="/assets/github-mark.svg" width="24" height="24" alt=""></a>${languageLinks(lang, t.language)}</div></header>
  <main id="main">
    <section class="guide-hero section-shell"><h1>${t.heading.split('\n').map(escape).join('<br>')}</h1><p class="guide-intro">${t.intro}</p><a class="guide-start" href="#prepare">${t.start}<span aria-hidden="true">↘</span></a><p class="guide-scope">${t.scope}</p></section>
    <div class="guide-layout section-shell"><aside class="guide-toc"><nav aria-label="${t.toc}"><p>${t.toc}</p><ol>${t.sections.map((s, i) => `<li><a href="#${s.id}"><span aria-hidden="true">0${i + 1}</span>${s.nav}</a></li>`).join('')}</ol></nav></aside>
      <div class="guide-articles">${t.sections.map((s, i) => `<section class="guide-section" id="${s.id}" aria-labelledby="title-${s.id}"><header class="guide-section-header"><span class="guide-number" aria-label="${t.sectionLabel} ${i + 1}">0${i + 1}</span><h2 id="title-${s.id}">${s.title}</h2><p class="guide-section-intro">${s.intro}</p></header><p class="guide-location"><strong>${t.where}</strong><span>${s.where}</span></p>${s.tests ? `<section class="launch-tests" aria-label="${escape(s.tests.title)}"><h3>${escape(s.tests.title)}</h3><div class="launch-test-grid">${s.tests.phases.map(phase => `<article><h4>${escape(phase.title)}</h4><p class="launch-test-mode">${escape(phase.mode)}</p><ol>${phase.steps.map(step => `<li>${escape(step)}</li>`).join('')}</ol><p class="launch-test-success"><strong>${escape(s.tests.done)}</strong> ${escape(phase.success)}</p></article>`).join('')}</div></section>` : ''}<ol class="guide-procedure">${s.steps.map(([title, body]) => `<li><h3>${escape(title)}</h3><p>${escape(body)}</p></li>`).join('')}</ol>${s.id === 'message' ? screenshot + flow : ''}${s.flow ? `<figure class="guide-flow"><figcaption>APP LAUNCH ADS · iOS &amp; ANDROID</figcaption><ol>${s.flow.map(item => `<li>${escape(item)}</li>`).join('')}</ol></figure>` : ''}<div class="guide-checkpoint"><h3>${t.checkpoint}</h3><p>${s.check}</p></div><p class="guide-note">${s.note}</p><nav class="guide-references" aria-label="${s.nav} · ${t.technical}">${s.links.map(([label, hash]) => `<a href="${docsUrl}/#${hash}">${label}<span aria-hidden="true">↗</span></a>`).join('')}</nav>${s.id === 'results' ? `<div class="guide-troubleshooting"><h3>${t.troubleshootTitle}</h3>${t.troubleshooting.map(([question, answer]) => `<details><summary>${escape(question)}</summary><p>${escape(answer)}</p></details>`).join('')}</div>` : ''}</section>`).join('')}
      <section class="guide-next"><h2>${t.nextTitle}</h2><p>${t.nextBody}</p><a href="${docsUrl}/">${t.nextLink}<span aria-hidden="true">↗</span></a></section><nav class="guide-sources" aria-label="${t.sources}"><span>${t.sources}</span><a href="${repoUrl}/blob/main/docs-public/CONSOLE-GUIDE.md">${t.sourceConsole}</a><a href="${repoUrl}/blob/main/docs-public/JOURNEY-GRAPH.md">${t.sourceJourney}</a><a href="#top">${t.top} ↑</a></nav>
      </div></div>
  </main>
  <footer class="footer shell"><div class="footer-identity"><a class="footer-brand" href="${home}">NudgeOn</a><p>${t.footer}</p></div><nav class="footer-links" aria-label="${t.navigation}"><a href="${docsUrl}/">${t.developer}</a><a href="mailto:hello@nudgeon.io">${t.contact}</a></nav>${languageLinks(lang, t.language)}</footer>
</body></html>`;
}
