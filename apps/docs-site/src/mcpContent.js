const setup = `# API environment · replace both origins for your installation
MCP_ENABLED=true
MCP_PUBLIC_URL=https://api.example.com
MCP_CONSOLE_URL=https://console.example.com

# Remote MCP URL shown under Settings → AI connections (MCP)
https://api.example.com/mcp`;

const scopes = `mcp:read             # Viewer / Editor / Admin / Owner
mcp:drafts:write     # Editor / Admin / Owner
mcp:customers:read   # Current role + administrator approval + explicit consent`;

const funnel = `// query_funnel tool arguments
{
  "steps": ["sign_up", "product_viewed", "purchase_completed"],
  "window_days": 7,
  "time_basis": "client_ts"
}`;

const retention = `// query_retention tool arguments
{
  "cohort_event": "sign_up",
  "return_event": "login",
  "days": [1, 7, 30],
  "time_basis": "client_ts"
}`;

const metrics = `// query_event_metrics tool arguments
{
  "event_names": ["sign_up", "purchase_completed"],
  "interval": "day",
  "group_by": "event_name",
  "compare": true
}`;

const links = [
  { label: "MCP · API / OAuth / tool contracts", href: "https://github.com/NudgeOn/nudgeon-platform/blob/main/docs-public/MCP.md" },
  { label: "Connection & draft OpenAPI", href: "https://github.com/NudgeOn/nudgeon-platform/blob/main/packages/openapi/mcp.openapi.json" },
  { label: "Deployment", href: "https://github.com/NudgeOn/nudgeon-platform/blob/main/docs-public/DEPLOY.md" },
];

export const mcpContent = {
  ko: {
    id: "mcp", eyebrow: "AI 연동 · 선택 기능", title: "MCP로 분석하고 초안을 준비하기",
    intro: "외부 AI에 지표 정의와 집계 데이터를 제공하고, 분석을 세그먼트·저니 초안으로 연결합니다. 사람마다 현재 콘솔 역할을 적용하며, 실제 발송은 콘솔에서 검토 후 진행합니다. 이 기능은 설치 운영자가 활성화해야 합니다.",
    endpoint: "OAuth + Streamable HTTP · /mcp",
    steps: [
      { title: "설치에서 MCP를 활성화합니다", body: "추가 DB 마이그레이션과 새 API·콘솔을 배포한 뒤 MCP_ENABLED를 활성화하세요. 기본값은 false입니다. MCP_PUBLIC_URL에는 외부에서 접근할 API origin을, MCP_CONSOLE_URL에는 콘솔 origin을 입력합니다. 운영에서는 HTTPS를 사용하고 loopback HTTP는 로컬 개발에만 사용하세요. 스트리밍 HTTP와 OAuth 경로가 프록시를 통과하도록 설정합니다. 별도 모델 API 키나 내장 AI는 필요하지 않습니다." },
      { title: "본인 계정으로 한 앱에 연결합니다", body: "설정 → AI 연결(MCP)에서 서버 주소를 복사해 AI 클라이언트의 원격 MCP 서버에 입력하세요. OAuth 로그인과 필요한 2단계 인증을 마친 뒤 앱 하나와 허용 범위를 선택합니다. pk_·sk_ SDK 키를 AI 인증에 사용하지 않습니다. ChatGPT·Claude·Cursor·Codex는 연결 검증 대상이며 모든 클라이언트·버전의 실제 호환성을 보장하는 목록은 아닙니다. 클라이언트가 원격 MCP와 이 서버의 OAuth 흐름을 지원하는지 먼저 확인하세요." },
      { title: "역할과 고객 정보 범위를 확인합니다", body: "Viewer는 조회, Editor 이상은 동의한 범위에서 초안 작성을 할 수 있습니다. 기본 범위는 고객 프로필 필드를 제외하지만 팀이 작성한 이름·세그먼트 조건·저니 메시지 내용도 공유하므로 개인정보가 들어 있을 수 있습니다. 고객 상세는 Admin·Owner의 해당 연결 승인과 사용자의 추가 동의가 모두 필요합니다. 관리자는 자신의 연결에 명시적으로 동의하며 승인할 수 있습니다. OAuth 앱 이름은 앱이 직접 등록한 미검증 이름이므로 동의 화면의 콜백 origin과 클라이언트 ID를 확인하세요. 권한 축소·탈퇴·연결 해제는 다음 요청에 반영됩니다. Admin·Owner는 조직 연결을, 각 사용자는 자신의 연결을 관리합니다." },
      { title: "지표 정의를 읽고 분석을 요청합니다", body: "get_app_context와 get_metric_catalog를 먼저 조회하게 하세요. query_event_metrics·query_message_metrics는 추이와 이전 기간 비교, query_funnel은 2–5개의 서로 다른 이벤트 단계, query_retention은 D1·D7·D30 재방문을 제공합니다. get_journey_report로 계측 가능한 노드 결과를 확인할 수 있습니다. Resources에는 이벤트·속성 카탈로그와 DSL·저니 스키마가 있고, Prompts에는 성과 분석·퍼널 진단·초안 작성 안내가 있습니다." },
      { title: "비교 기준과 품질을 함께 읽습니다", body: "기본 기간은 앱 시간대의 종료된 최근 30일입니다. 날짜 지정 시 start_date 포함, end_date 제외이며 최대 90일, 퍼널·리텐션 유입 기간은 최대 30일입니다. 행동 시각은 기본 client_ts이며 server_ts 선택이 가능합니다. 메시지는 최초 발송 시각의 코호트입니다. 퍼널은 첫 시작 후 기본 7일 안의 순서를 따르며 같은 시각의 이벤트 순서는 모호함으로 표시합니다. 비율은 1이 100%이고 분모가 0이면 null, 미성숙 리텐션은 not_matured입니다. 기준 시각·분모·품질 경고를 AI 답변에도 포함하게 하세요." },
      { title: "콘솔에서 초안을 검토하고 전환합니다", body: "AI가 반환한 콘솔 링크를 열어 세그먼트 초안의 조건과 예상 고객 수를 확인합니다. 변경사항을 저장한 뒤 ‘세그먼트로 만들기’를 누르면 새 운영 세그먼트가 생깁니다. 초안 자체는 발송에 사용되지 않으며 전환 뒤에는 잠기고 복제로 재작성합니다. 저니는 발행 이력이 없는 초안만 AI가 수정할 수 있습니다. 저장 revision이 달라지면 덮어쓰지 않고 충돌을 반환합니다. 활성·일시정지·보관 저니는 읽어서 새 초안으로 복제하세요. 활성화·테스트 발송·삭제 도구는 제공하지 않습니다." },
    ],
    examples: [
      { label: "운영자 설정 · 기본 비활성", code: setup },
      { label: "OAuth 허용 범위", code: scopes },
      { label: "이벤트 추이와 이전 기간 비교", code: metrics },
      { label: "가입 → 상품 조회 → 구입 퍼널", code: funnel },
      { label: "가입 코호트의 정확한 N일차 로그인", code: retention },
    ],
    note: "최대 500개 집계 행·30초 실행 제한이 있습니다. 수집·프로필·고객 병합 반영은 비동기이며 완전성을 보장하지 않습니다. 국가·언어 분류는 현재 프로필 기준입니다. 구매 금액은 통화별 수집 이벤트 합계로 정산·환불·광고 기여매출이 아닙니다. 가입 코호트는 조회 기간 내 첫 기준 이벤트이며 평생 최초 가입을 뜻하지 않습니다. 관측 도달과 공급자 접수, 저니 완료와 구매 전환을 구분하세요. A/B 승자·인과관계·통계적 유의성을 자동 판정하지 않습니다. 임의 SQL과 원본 이벤트 일괄 추출은 지원하지 않습니다.",
    source: "MCP / OAuth · 공용 분석 서비스 · 초안 API", links,
  },
  en: {
    id: "mcp", eyebrow: "AI integration · Optional feature", title: "Analyze data and prepare drafts with MCP",
    intro: "Give an external AI metric definitions and structured aggregates, then turn analysis into segment and journey drafts. Each person keeps their current console permissions. Review and send from the console. Your installation operator must enable this feature first.",
    endpoint: "OAuth + Streamable HTTP · /mcp",
    steps: [
      { title: "Enable MCP for your installation", body: "Deploy the additive database migration, API and console, then enable MCP_ENABLED. It defaults to false. Set MCP_PUBLIC_URL to the externally reachable API origin and MCP_CONSOLE_URL to the console origin. Use HTTPS in production; loopback HTTP is for local development. Ensure your proxy supports streaming HTTP and the OAuth routes. No separate model API key or built-in AI model is required." },
      { title: "Connect one app with your own account", body: "Copy the server address from Settings → AI connections (MCP) into your AI client's remote MCP server configuration. Complete OAuth sign-in and required two-factor authentication, then select one app and your scopes. Do not use pk_ or sk_ SDK keys for AI authentication. ChatGPT, Claude, Cursor and Codex are connection validation targets, not a claim that every client and version has passed compatibility testing. Check that the client supports remote MCP and this server's OAuth flow." },
      { title: "Check role and customer access", body: "Viewer can read; Editor and higher can write drafts within the scopes they consented to. The default scope excludes customer profile fields, but also shares user-authored names, segment conditions and journey messages, which may contain personal data. Customer details require both Admin or Owner approval for that connection and the user's additional consent. Administrators can explicitly approve and consent for their own connection. OAuth application names are self-registered and unverified: check the callback origin and client ID on the consent screen. Role reductions, deactivation and revocation apply from the next request. Admin and Owner manage organization connections; each member manages their own." },
      { title: "Read definitions before requesting analysis", body: "Start with get_app_context and get_metric_catalog. query_event_metrics and query_message_metrics return trends and comparisons with the preceding period; query_funnel supports 2–5 distinct event steps; query_retention returns exact D1, D7 and D30 returns. get_journey_report shows instrumented node outcomes. Resources contain event and attribute catalogs, the Segment DSL and journey schemas. Prompts guide performance analysis, funnel diagnosis and draft creation." },
      { title: "Read comparison criteria and data quality together", body: "The default is the last 30 completed days in the app's time zone. Explicit dates include start_date and exclude end_date: at most 90 days, or a 30-day entry period for funnels and retention. Behavior defaults to client_ts with optional server_ts; messages use a first-send cohort. Funnels require ordered steps within 7 days of the first start by default, and flag ambiguous same-time ordering. Rates use 1 = 100%; zero denominators are null and immature retention is not_matured. Ask the AI to include timestamps, denominators and quality warnings in its answer." },
      { title: "Review and convert drafts in the console", body: "Open the returned console link to review segment conditions and audience estimates. Save edits, then choose Create segment to create a new operational segment. Drafts cannot be used for sending and become locked after conversion; duplicate them for further changes. AI can modify only journey drafts that have never been published. A changed revision returns a conflict instead of overwriting edits. Read active, paused or archived journeys and copy them to new drafts. Activation, test sending and deletion tools are not provided." },
    ],
    examples: [
      { label: "Operator configuration · disabled by default", code: setup },
      { label: "OAuth scopes", code: scopes },
      { label: "Event trends and preceding-period comparison", code: metrics },
      { label: "Signup → product view → purchase funnel", code: funnel },
      { label: "Exact Nth-day login returns for signup cohorts", code: retention },
    ],
    note: "Queries allow at most 500 aggregate rows and 30 seconds of execution. Collection, profile updates and customer merge mirroring are asynchronous, so completeness is not guaranteed. Country and language use current profiles. Purchase amounts sum collected events by currency, without settlement, refunds or marketing attribution. Cohorts use the first event inside the requested entry period, not lifetime-first signup. Distinguish observed delivery from provider acceptance and journey completion from purchase conversion. This is not an A/B winner, causality or statistical-significance engine. Arbitrary SQL and bulk raw-event export are not supported.",
    source: "MCP / OAuth · shared analysis service · draft API", links,
  },
};
