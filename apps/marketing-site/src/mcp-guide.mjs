export const mcpGuide = {
  ko: {
    id: 'mcp', nav: 'AI 분석과 MCP', title: 'AI에서 분석하고 콘솔에서 검토합니다.',
    intro: 'MCP를 활성화한 설치에서는 외부 AI에 지표 정의와 집계를 제공해 성과·퍼널·리텐션을 분석하고 세그먼트와 저니 초안을 준비할 수 있습니다. 별도 NudgeOn 모델 API 키는 필요하지 않습니다.',
    where: '설정 → AI 연결(MCP) · 세그먼트 → 세그먼트 초안',
    steps: [
      ['본인 계정으로 연결하세요', '관리자가 MCP를 활성화한 뒤 설정의 서버 주소를 AI 클라이언트에 등록하세요. NudgeOn에 로그인하고 필요한 2단계 인증을 마친 뒤 앱 하나와 범위를 선택합니다. 앱 이름은 미검증 이름이므로 동의 화면의 콜백 주소와 클라이언트 ID를 확인하세요. Viewer는 조회, Editor 이상은 초안 작성을 허용할 수 있습니다. 고객 상세 조회는 관리자 승인과 사용자 추가 동의가 필요합니다. 기본 범위는 프로필 필드를 제외하지만 팀이 작성한 이름·조건·메시지 내용은 공유되므로 개인정보가 들어 있을 수 있습니다.'],
      ['질문에 기준과 분모를 함께 넣으세요', '“최근 30일의 회원가입 → 상품 조회 → 구입 퍼널을 7일 전환 기준으로 분석해줘”처럼 이벤트와 기간을 명시하세요. 지표 정의를 먼저 읽고 기준 시각·시간대·분모·수집 경고를 포함해 달라고 요청합니다. D1·D7·D30 리텐션에서 관측 기간이 끝나지 않은 코호트는 0이 아닙니다. 구매 금액은 통화별 수집 이벤트 합계로 정산 매출이나 캠페인 기여매출을 뜻하지 않습니다.'],
      ['초안을 열어 검토한 뒤 사용하세요', 'AI가 제공한 콘솔 링크에서 세그먼트 이름·조건·예상 인원을 확인합니다. 변경사항을 저장하고 ‘세그먼트로 만들기’를 누르면 운영 세그먼트가 생성됩니다. 초안은 발송에 사용되지 않으며 전환된 초안은 잠기고 복제로 다시 작성합니다. 저니는 발행 이력이 없는 초안만 AI에서 수정할 수 있습니다. 실제 활성화와 발송은 콘솔에서 진행하며, 다른 편집자의 변경과 충돌하면 최신 버전을 확인합니다.'],
    ],
    check: '연결한 앱과 권한이 맞고 분석의 기간·분모·품질 경고를 확인했습니다. AI가 작성한 초안은 콘솔에서 검토한 뒤 사용합니다.',
    note: 'MCP는 기본 비활성인 선택 기능입니다. 원격 MCP와 OAuth를 지원하는 클라이언트가 필요하며 ChatGPT·Claude·Cursor·Codex의 모든 버전 호환성이 검증된 상태는 아닙니다. 역할 변경·연결 해제는 다음 요청부터 반영됩니다. 분석 한도는 최대 90일(퍼널·리텐션 유입 30일)·500개 집계 행입니다. 수집·병합 반영 지연, 현재 프로필 기준의 국가·언어 분류, 통계적 유의성·인과관계 미판정에 유의하세요.',
    links: [['MCP 연결·분석 연동', 'mcp'], ['세그먼트', 'segments'], ['저니', 'journeys']],
  },
  en: {
    id: 'mcp', nav: 'AI analysis and MCP', title: 'Analyze with AI. Review in the console.',
    intro: 'Installations with MCP enabled can share metric definitions and aggregates with an external AI to analyze performance, funnels and retention, then prepare segment and journey drafts. No separate NudgeOn model API key is needed.',
    where: 'Settings → AI connections (MCP) · Segments → Segment drafts',
    steps: [
      ['Connect with your own account', 'After your operator enables MCP, register the server address shown in Settings with your AI client. Sign in to NudgeOn, complete required two-factor authentication, and choose one app and its scopes. Application names are unverified: check the callback address and client ID on the consent screen. Viewer can read; Editor and higher can allow draft writing. Customer details require administrator approval and additional user consent. The default scope excludes profile fields, but user-authored names, conditions and message content are shared and may contain personal data.'],
      ['Include the criteria and denominator in your question', 'Ask, for example: “Analyze signup → product view → purchase over the last 30 days with a 7-day conversion window.” Ask the AI to read metric definitions first and include timestamps, time zone, denominators and collection warnings. D1, D7 and D30 cohorts whose observation window has not ended are not zero. Purchase amounts sum collected events by currency; they are not settled or attributed revenue.'],
      ['Review drafts before using them', 'Follow the AI’s console link to review the segment name, conditions and estimated audience. Save edits, then choose Create segment to make it operational. Drafts are excluded from sending; converted drafts are locked and can be duplicated. AI can edit only journey drafts that have never been published. Activate and send from the console. If another editor changes a draft, review the latest revision before applying your edits.'],
    ],
    check: 'The connected app and permissions are correct, and you reviewed the analysis period, denominators and quality warnings. Review AI-created drafts in the console before using them.',
    note: 'MCP is optional and disabled by default. A client that supports remote MCP and OAuth is required; compatibility has not been verified for every ChatGPT, Claude, Cursor or Codex version. Role changes and revocations apply from the next request. Queries allow at most 90 days (30-day funnel or retention entry periods) and 500 aggregate rows. Account for delayed collection and merge mirroring, current-profile country and language grouping, and the absence of significance or causality judgments.',
    links: [['MCP connection and analysis integration', 'mcp'], ['Segments', 'segments'], ['Journeys', 'journeys']],
  },
};
