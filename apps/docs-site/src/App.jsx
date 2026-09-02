import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconActivityHeartbeat,
  IconAlertTriangle,
  IconBell,
  IconBook2,
  IconBrandGithub,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCode,
  IconCopy,
  IconDeviceMobile,
  IconGitBranch,
  IconHelpCircle,
  IconKey,
  IconMenu2,
  IconMoon,
  IconRocket,
  IconRoute,
  IconSearch,
  IconServer2,
  IconShieldLock,
  IconSun,
  IconTerminal2,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { documentContentByLanguage } from "./documentContent.js";

const checklistSteps = [
  {
    id: "ready",
    label: "준비 상태",
    summary: "API와 저장소가 요청을 받을 준비가 됐는지 확인합니다.",
    title: "준비 상태 확인",
    description: "PostgreSQL과 Redis 연결까지 정상인지 확인한 뒤 연동을 시작하세요.",
    requestLabel: "요청",
    request: "GET <API_BASE_URL>/readyz",
    responseLabel: "응답",
    response: `HTTP/1.1 200 OK
content-type: application/json
cache-control: no-store

{
  "ok": true,
  "postgres": true,
  "redis": true
}`,
    note: "세 값 중 하나라도 false이면 이벤트를 보내기 전에 연결부터 복구하세요.",
    next: "키 선택으로 이동",
  },
  {
    id: "keys",
    label: "키 선택",
    summary: "요청이 실행되는 위치에 맞는 인증 키를 선택합니다.",
    title: "키를 안전한 위치에 준비",
    description: "앱은 SDK Key를, 신뢰할 수 있는 고객사 서버는 Server Key를 사용합니다.",
    requestLabel: "환경 변수",
    request: `export NUDGEON_API_URL="http://localhost:8080"
export NUDGEON_APP_ID="REPLACE_WITH_APP_ID"
export NUDGEON_SDK_KEY="pk_REPLACE_ME"
export NUDGEON_SERVER_KEY="sk_REPLACE_ME"`,
    responseLabel: "사용 경계",
    response: `모바일 · RN · Flutter   → SDK Key (pk_)
고객사 백엔드          → Server Key (sk_)
NudgeOn 관리 API          → nudgeon_session`,
    note: "Server Key는 모바일 앱이나 브라우저 번들에 절대 포함하지 마세요.",
    next: "첫 이벤트로 이동",
  },
  {
    id: "event",
    label: "첫 이벤트",
    summary: "고유한 insert_id로 테스트 이벤트 한 건을 저장합니다.",
    title: "첫 이벤트 전송",
    description: "재시도할 때는 최초 insert_id를 그대로 유지해야 중복을 안전하게 처리할 수 있습니다.",
    requestLabel: "요청",
    request: `POST <API_BASE_URL>/v1/track
Authorization: Bearer pk_REPLACE_ME

{
  "batch": [{
    "insert_id": "<UUID>",
    "external_id": "customer-123",
    "event": "Product Viewed"
  }]
}`,
    responseLabel: "응답",
    response: `HTTP/1.1 202 Accepted

{
  "accepted": 1,
  "request_id": "<REQUEST_UUID>"
}`,
    note: "202는 receipt와 outbox 저장 완료이며 분석 반영, 저니 실행, 푸시 수신 완료가 아닙니다.",
    next: "토큰 등록으로 이동",
  },
  {
    id: "token",
    label: "토큰 등록",
    summary: "식별된 고객의 테스트 기기 푸시 토큰을 등록합니다.",
    title: "푸시 토큰 등록",
    description: "APNs 또는 FCM에서 새 토큰을 받았을 때 SDK Key로 다시 등록하세요.",
    requestLabel: "요청",
    request: `POST <API_BASE_URL>/v1/devices/token
Authorization: Bearer pk_REPLACE_ME

{
  "device": {
    "device_id": "<UUID>",
    "platform": "ios"
  },
  "push_token": "<PROVIDER_TOKEN>",
  "os_permission": "granted",
  "external_id": "customer-123"
}`,
    responseLabel: "응답",
    response: `HTTP/1.1 202 Accepted

{
  "request_id": "<REQUEST_UUID>"
}`,
    note: "202는 토큰 등록 작업이 ingest 큐에 발행됐다는 뜻이며, 실제 푸시 수신 성공을 뜻하지 않습니다.",
    next: "실제 기기 확인으로 이동",
  },
  {
    id: "device",
    label: "실제 기기 확인",
    summary: "테스트 푸시를 요청하고 기기 수신과 열기를 직접 확인합니다.",
    title: "첫 테스트 푸시 검증",
    description: "콘솔 세션으로 테스트 발송을 요청한 뒤 실제 기기와 메시지 로그를 함께 확인하세요.",
    requestLabel: "요청",
    request: `POST <API_BASE_URL>/v1/apps/<APP_ID>/test-push
Cookie: nudgeon_session=<SESSION>

{
  "external_id": "customer-123",
  "title": "NudgeOn 연동 테스트",
  "body": "첫 번째 푸시가 도착했습니다."
}`,
    responseLabel: "응답",
    response: `HTTP/1.1 202 Accepted

{
  "queued": 1,
  "test_run_id": "<RUN_UUID>"
}`,
    note: "queued는 발송 큐 진입 수입니다. APNs·FCM 전달과 실제 기기 수신은 별도로 확인하세요.",
    next: "문제 해결 보기",
  },
];

const navigationGroups = [
  {
    label: "시작하기",
    icon: IconRocket,
    items: [
      { label: "첫 푸시 체크리스트", href: "#checklist", active: true },
      { label: "개념 가이드", href: "#concepts" },
    ],
  },
  {
    label: "SDK 연동",
    icon: IconBook2,
    items: [
      { label: "SDK 시작하기", href: "#sdk-quickstart" },
      { label: "플랫폼 가이드", href: "#platform-guides" },
      { label: "푸시 권한 가이드", href: "#push-permissions" },
    ],
  },
  {
    label: "푸시와 저니",
    icon: IconRoute,
    items: [
      { label: "푸시 만들기", href: "#push-create" },
      { label: "저니(시나리오)", href: "#journeys" },
      { label: "세그먼트", href: "#segments" },
    ],
  },
  {
    label: "API 참조",
    icon: IconCode,
    items: [
      { label: "인증", href: "#authentication" },
      { label: "푸시 API", href: "#push-api" },
      { label: "저니 API", href: "#journey-api" },
      { label: "웹훅", href: "#webhooks" },
    ],
  },
  {
    label: "직접 설치·운영",
    icon: IconServer2,
    items: [
      { label: "직접 설치 가이드", href: "#self-hosting" },
      { label: "운영 가이드", href: "#operations" },
      { label: "보안 가이드", href: "#security" },
    ],
  },
  {
    label: "문제 해결",
    icon: IconHelpCircle,
    items: [
      { label: "오류 코드", href: "#error-codes" },
      { label: "자주 묻는 질문", href: "#faq" },
      { label: "디버깅 가이드", href: "#debugging" },
    ],
  },
  {
    label: "릴리즈·호환성",
    icon: IconGitBranch,
    items: [
      { label: "릴리즈 노트", href: "#release-notes" },
      { label: "호환성 가이드", href: "#compatibility" },
    ],
  },
];

const searchItems = [
  { id: "ready", label: "서버 준비 상태 확인", detail: "GET /readyz", step: 0, icon: IconActivityHeartbeat },
  { id: "keys", label: "SDK Key와 Server Key 선택", detail: "pk_ · sk_ · nudgeon_session", step: 1, icon: IconKey },
  { id: "event", label: "첫 이벤트 전송", detail: "POST /v1/track", step: 2, icon: IconCode },
  { id: "token", label: "푸시 토큰 등록", detail: "POST /v1/devices/token", step: 3, icon: IconDeviceMobile },
  { id: "device", label: "실제 기기 테스트 푸시", detail: "POST /test-push", step: 4, icon: IconBell },
  { id: "auth-errors", label: "401 · 403 인증 오류", detail: "문제 해결", step: 1, icon: IconShieldLock },
  { id: "accepted", label: "202 Accepted의 의미", detail: "저장 · 큐 · 기기 수신 구분", step: 2, icon: IconAlertTriangle },
];

function createDocumentSearchItems(navigation) {
  return navigation
    .flatMap((group) => group.items
      .filter((item) => item.href !== "#checklist")
      .map((item) => ({
        id: `document-${item.href.slice(1)}`,
        label: item.label,
        detail: group.label,
        href: item.href,
        icon: group.icon,
      })));
}

const resourceSections = [
  {
    id: "concepts",
    eyebrow: "개념",
    title: "접수와 수신을 구분하세요",
    body: "서버 응답, 제공자 접수, 실제 기기 수신과 열기는 서로 다른 상태입니다.",
    icon: IconActivityHeartbeat,
    href: "#concepts",
  },
  {
    id: "sdk",
    eyebrow: "SDK",
    title: "네 플랫폼에서 같은 계약",
    body: "iOS, Android, React Native, Flutter의 식별과 토큰 흐름을 한 기준으로 확인합니다.",
    icon: IconDeviceMobile,
    href: "#sdk-quickstart",
  },
  {
    id: "push",
    eyebrow: "푸시와 저니",
    title: "첫 푸시 다음은 자동화",
    body: "첫 기기 검증을 마친 뒤 이벤트 기반 세그먼트와 저니로 확장합니다.",
    icon: IconRoute,
    href: "#journeys",
  },
  {
    id: "api",
    eyebrow: "API",
    title: "키와 실행 위치를 먼저 확인",
    body: "앱, 고객사 서버, NudgeOn 관리 도구의 인증 경계를 명확하게 구분합니다.",
    icon: IconCode,
    href: "#authentication",
  },
  {
    id: "operations",
    eyebrow: "직접 설치·운영",
    title: "운영 절차는 API와 분리",
    body: "Docker, 데이터베이스, TLS, 백업과 복구 절차를 독립적인 운영 문서로 제공합니다.",
    icon: IconServer2,
    href: "#operations",
  },
  {
    id: "troubleshooting",
    eyebrow: "문제 해결",
    title: "오류 코드에서 바로 시작",
    body: "401, 403, 409, 429, 503과 푸시 미수신 원인을 빠르게 좁힙니다.",
    icon: IconHelpCircle,
    href: "#error-codes",
  },
  {
    id: "release",
    eyebrow: "릴리즈·호환성",
    title: "지원 범위를 과장하지 않습니다",
    body: "NudgeOn는 Push MVP Alpha입니다. 검증된 플랫폼과 제한을 버전별로 공개합니다.",
    icon: IconGitBranch,
    href: "#compatibility",
  },
];

const englishChecklistSteps = [
  {
    id: "ready",
    label: "Readiness",
    summary: "Confirm that the API and its stores are ready to accept requests.",
    title: "Check service readiness",
    description: "Start the integration after both PostgreSQL and Redis report a healthy connection.",
    requestLabel: "Request",
    request: "GET <API_BASE_URL>/readyz",
    responseLabel: "Response",
    response: `HTTP/1.1 200 OK
content-type: application/json
cache-control: no-store

{
  "ok": true,
  "postgres": true,
  "redis": true
}`,
    note: "If any value is false, restore that connection before sending events.",
    next: "Continue to key selection",
  },
  {
    id: "keys",
    label: "Choose keys",
    summary: "Use the credential that matches where each request runs.",
    title: "Keep each key in the right place",
    description: "Apps use an SDK Key. Only a trusted customer server should use a Server Key.",
    requestLabel: "Environment variables",
    request: `export NUDGEON_API_URL="http://localhost:8080"
export NUDGEON_APP_ID="REPLACE_WITH_APP_ID"
export NUDGEON_SDK_KEY="pk_REPLACE_ME"
export NUDGEON_SERVER_KEY="sk_REPLACE_ME"`,
    responseLabel: "Credential boundary",
    response: `Mobile · RN · Flutter  → SDK Key (pk_)
Customer backend        → Server Key (sk_)
NudgeOn management API     → nudgeon_session`,
    note: "Never ship a Server Key in a mobile app or browser bundle.",
    next: "Continue to your first event",
  },
  {
    id: "event",
    label: "First event",
    summary: "Store one test event with a unique insert_id.",
    title: "Send your first event",
    description: "Reuse the original insert_id when retrying so NudgeOn can handle duplicates safely.",
    requestLabel: "Request",
    request: `POST <API_BASE_URL>/v1/track
Authorization: Bearer pk_REPLACE_ME

{
  "batch": [{
    "insert_id": "<UUID>",
    "external_id": "customer-123",
    "event": "Product Viewed"
  }]
}`,
    responseLabel: "Response",
    response: `HTTP/1.1 202 Accepted

{
  "accepted": 1,
  "request_id": "<REQUEST_UUID>"
}`,
    note: "202 confirms receipt and outbox persistence. It does not confirm analytics processing, journey execution, or device delivery.",
    next: "Continue to token registration",
  },
  {
    id: "token",
    label: "Register token",
    summary: "Register the test device’s push token for an identified customer.",
    title: "Register a push token",
    description: "Register again with the SDK Key whenever APNs or FCM issues a new token.",
    requestLabel: "Request",
    request: `POST <API_BASE_URL>/v1/devices/token
Authorization: Bearer pk_REPLACE_ME

{
  "device": {
    "device_id": "<UUID>",
    "platform": "ios"
  },
  "push_token": "<PROVIDER_TOKEN>",
  "os_permission": "granted",
  "external_id": "customer-123"
}`,
    responseLabel: "Response",
    response: `HTTP/1.1 202 Accepted

{
  "request_id": "<REQUEST_UUID>"
}`,
    note: "202 means the token-registration task was published to the ingest queue; it does not confirm device delivery.",
    next: "Continue to device verification",
  },
  {
    id: "device",
    label: "Verify device",
    summary: "Request a test push, then confirm receipt and open on a real device.",
    title: "Verify your first test push",
    description: "Request a test send with a console session, then inspect both the real device and message logs.",
    requestLabel: "Request",
    request: `POST <API_BASE_URL>/v1/apps/<APP_ID>/test-push
Cookie: nudgeon_session=<SESSION>

{
  "external_id": "customer-123",
  "title": "NudgeOn integration test",
  "body": "Your first push has arrived."
}`,
    responseLabel: "Response",
    response: `HTTP/1.1 202 Accepted

{
  "queued": 1,
  "test_run_id": "<RUN_UUID>"
}`,
    note: "queued is the number of messages admitted to the send queue. Verify APNs or FCM delivery and real-device receipt separately.",
    next: "View troubleshooting",
  },
];

const englishNavigationGroups = [
  {
    label: "Get started",
    icon: IconRocket,
    items: [
      { label: "First push checklist", href: "#checklist", active: true },
      { label: "Concepts", href: "#concepts" },
    ],
  },
  {
    label: "SDK integration",
    icon: IconBook2,
    items: [
      { label: "SDK quickstart", href: "#sdk-quickstart" },
      { label: "Platform guides", href: "#platform-guides" },
      { label: "Push permissions", href: "#push-permissions" },
    ],
  },
  {
    label: "Push & journeys",
    icon: IconRoute,
    items: [
      { label: "Create a push", href: "#push-create" },
      { label: "Journeys", href: "#journeys" },
      { label: "Segments", href: "#segments" },
    ],
  },
  {
    label: "API reference",
    icon: IconCode,
    items: [
      { label: "Authentication", href: "#authentication" },
      { label: "Push API", href: "#push-api" },
      { label: "Journey API", href: "#journey-api" },
      { label: "Webhooks", href: "#webhooks" },
    ],
  },
  {
    label: "Self-host & operate",
    icon: IconServer2,
    items: [
      { label: "Self-hosting guide", href: "#self-hosting" },
      { label: "Operations guide", href: "#operations" },
      { label: "Security guide", href: "#security" },
    ],
  },
  {
    label: "Troubleshooting",
    icon: IconHelpCircle,
    items: [
      { label: "Error codes", href: "#error-codes" },
      { label: "FAQ", href: "#faq" },
      { label: "Debugging guide", href: "#debugging" },
    ],
  },
  {
    label: "Releases & compatibility",
    icon: IconGitBranch,
    items: [
      { label: "Release notes", href: "#release-notes" },
      { label: "Compatibility guide", href: "#compatibility" },
    ],
  },
];

const englishSearchItems = [
  { id: "ready", label: "Check service readiness", detail: "GET /readyz", step: 0, icon: IconActivityHeartbeat },
  { id: "keys", label: "Choose an SDK Key or Server Key", detail: "pk_ · sk_ · nudgeon_session", step: 1, icon: IconKey },
  { id: "event", label: "Send your first event", detail: "POST /v1/track", step: 2, icon: IconCode },
  { id: "token", label: "Register a push token", detail: "POST /v1/devices/token", step: 3, icon: IconDeviceMobile },
  { id: "device", label: "Send a real-device test push", detail: "POST /test-push", step: 4, icon: IconBell },
  { id: "auth-errors", label: "401 · 403 authentication errors", detail: "Troubleshooting", step: 1, icon: IconShieldLock },
  { id: "accepted", label: "What 202 Accepted means", detail: "Receipt · queue · device delivery", step: 2, icon: IconAlertTriangle },
];

const englishResourceSections = [
  {
    id: "concepts",
    eyebrow: "Concepts",
    title: "Separate receipt from delivery",
    body: "Server response, provider acceptance, device receipt, and open are distinct states.",
    icon: IconActivityHeartbeat,
    href: "#concepts",
  },
  {
    id: "sdk",
    eyebrow: "SDK",
    title: "One contract across four platforms",
    body: "Use the same identity and token flow across iOS, Android, React Native, and Flutter.",
    icon: IconDeviceMobile,
    href: "#sdk-quickstart",
  },
  {
    id: "push",
    eyebrow: "Push & journeys",
    title: "Automate after the first push",
    body: "Once a real device is verified, expand into event-based segments and journeys.",
    icon: IconRoute,
    href: "#journeys",
  },
  {
    id: "api",
    eyebrow: "API",
    title: "Check the key and execution context first",
    body: "Keep authentication boundaries clear between apps, customer servers, and NudgeOn management tools.",
    icon: IconCode,
    href: "#authentication",
  },
  {
    id: "operations",
    eyebrow: "Self-host & operate",
    title: "Keep operations separate from the API",
    body: "Docker, database, TLS, backup, and recovery procedures live in a dedicated operations guide.",
    icon: IconServer2,
    href: "#operations",
  },
  {
    id: "troubleshooting",
    eyebrow: "Troubleshooting",
    title: "Start with the error code",
    body: "Quickly narrow down 401, 403, 409, 429, 503, and missing-push issues.",
    icon: IconHelpCircle,
    href: "#error-codes",
  },
  {
    id: "release",
    eyebrow: "Releases & compatibility",
    title: "No claims beyond verified support",
    body: "NudgeOn is Push MVP Alpha. Verified platforms and constraints are published by version.",
    icon: IconGitBranch,
    href: "#compatibility",
  },
];

const copyByLanguage = {
  ko: {
    language: "ko",
    metaTitle: "NudgeOn 개발자센터 | 첫 푸시 체크리스트",
    brand: "NudgeOn 개발자센터",
    brandHome: "NudgeOn 개발자센터 홈",
    navigation: navigationGroups,
    searchItems: [...searchItems, ...createDocumentSearchItems(navigationGroups)],
    checklist: checklistSteps,
    guides: documentContentByLanguage.ko,
    resources: resourceSections,
    ui: {
      closeMenu: "메뉴 닫기",
      docsNavigation: "문서 탐색",
      openMenu: "문서 메뉴 열기",
      searchPlaceholder: "문서, 오류 코드 검색",
      openSearch: "문서 검색 열기",
      quickLinks: "빠른 링크",
      consoleReady: "콘솔 준비 중",
      consoleAria: "콘솔은 공개 준비 중입니다",
      localeName: "한국어",
      localeAria: "현재 언어는 한국어입니다. 영어로 전환",
      searchTitle: "NudgeOn 문서 검색",
      searchQuery: "문서 검색어",
      closeSearch: "검색 닫기",
      popularDocs: "자주 찾는 문서",
      resultSuffix: "검색 결과",
      keyboardHint: "↑↓ 이동 · ENTER 선택 · ESC 닫기",
      searchResults: "검색 결과",
      noResults: "일치하는 공개 문서가 없습니다.",
      noResultsHint: "오류 코드나 기능 이름으로 다시 검색해 보세요.",
      copied: "복사됨",
      copy: "복사",
      copySuccess: "코드를 복사했습니다.",
      copyError: "복사하지 못했어요. 코드를 직접 선택해 주세요.",
      checklistLabel: "첫 푸시 체크리스트",
      checklistSteps: "체크리스트 단계",
      tocLabel: "이 페이지 목차",
      toc: ["준비 상태 확인", "다음 단계", "관련 문서", "문제 해결"],
      nextSteps: "다음 단계",
      resourcesTitle: "필요한 문서로 이어서 이동하세요",
      openGuide: "문서 열기",
      sourceTitle: "오픈소스 문서",
      sourceBody: "NudgeOn 저장소에서 소스 코드와 변경 이력을 확인할 수 있습니다.",
      heroTitle: "첫 푸시 체크리스트",
      heroBody: "이벤트 저장부터 실제 기기 수신·열기까지 검증하세요.",
      heroAction: "체크리스트 시작",
      guidesKicker: "개발 문서",
      guidesTitle: "필요한 내용을 주제별로 확인하세요",
      guideSteps: "진행 순서",
      implementationSource: "구현 기준",
      lightMode: "라이트 모드",
      darkMode: "다크 모드",
      switchLight: "라이트 모드로 전환",
      switchDark: "다크 모드로 전환",
    },
  },
  en: {
    language: "en",
    metaTitle: "NudgeOn Developer Center | First Push Checklist",
    brand: "NudgeOn Developer Center",
    brandHome: "NudgeOn Developer Center home",
    navigation: englishNavigationGroups,
    searchItems: [...englishSearchItems, ...createDocumentSearchItems(englishNavigationGroups)],
    checklist: englishChecklistSteps,
    guides: documentContentByLanguage.en,
    resources: englishResourceSections,
    ui: {
      closeMenu: "Close menu",
      docsNavigation: "Documentation navigation",
      openMenu: "Open documentation menu",
      searchPlaceholder: "Search docs and error codes",
      openSearch: "Open documentation search",
      quickLinks: "Quick links",
      consoleReady: "Console coming soon",
      consoleAria: "The public console is coming soon",
      localeName: "English",
      localeAria: "Current language is English. Switch to Korean",
      searchTitle: "Search NudgeOn documentation",
      searchQuery: "Documentation search query",
      closeSearch: "Close search",
      popularDocs: "Popular documentation",
      resultSuffix: "search results",
      keyboardHint: "↑↓ move · ENTER select · ESC close",
      searchResults: "Search results",
      noResults: "No public documentation matched your search.",
      noResultsHint: "Try an error code or feature name.",
      copied: "Copied",
      copy: "Copy",
      copySuccess: "Code copied.",
      copyError: "Could not copy. Select the code manually.",
      checklistLabel: "First push checklist",
      checklistSteps: "Checklist steps",
      tocLabel: "On this page",
      toc: ["Check readiness", "Next steps", "Related docs", "Troubleshooting"],
      nextSteps: "Next steps",
      resourcesTitle: "Continue with the guide you need",
      openGuide: "Open guide",
      sourceTitle: "Open-source documentation",
      sourceBody: "View the source code and change history in the NudgeOn repository.",
      heroTitle: "First push checklist",
      heroBody: "Verify every step from event persistence to real-device receipt and open.",
      heroAction: "Start the checklist",
      guidesKicker: "Developer documentation",
      guidesTitle: "Explore every topic in its own guide",
      guideSteps: "Workflow",
      implementationSource: "Implementation source",
      lightMode: "Light mode",
      darkMode: "Dark mode",
      switchLight: "Switch to light mode",
      switchDark: "Switch to dark mode",
    },
  },
};

function Brand({ content }) {
  return (
    <a className="brand" href="#checklist" aria-label={content.brandHome}>
      <span className="brand-mark" aria-hidden="true">
        <img src="/assets/nudgeon-logo.png" alt="" />
      </span>
      <span>{content.brand}</span>
    </a>
  );
}

function Sidebar({ content, inert, open, activeHref, onClose, onNavigate }) {
  return (
    <>
      <button
        className={`sidebar-backdrop ${open ? "is-open" : ""}`}
        type="button"
        aria-label={content.ui.closeMenu}
        onClick={onClose}
      />
      <aside className={`sidebar ${open ? "is-open" : ""}`} aria-label={content.ui.docsNavigation} inert={inert}>
        <div className="sidebar-brand-row">
          <Brand content={content} />
          <button className="icon-button sidebar-close" type="button" aria-label={content.ui.closeMenu} onClick={onClose}>
            <IconX size={20} stroke={1.8} />
          </button>
        </div>
        <nav className="side-navigation">
          {content.navigation.map((group, groupIndex) => {
            const GroupIcon = group.icon;
            return (
              <section className="nav-group" key={`navigation-group-${groupIndex}`}>
                <p className="nav-group-title">
                  <GroupIcon size={17} stroke={1.7} />
                  <span>{group.label}</span>
                </p>
                <ul>
                  {group.items.map((item, itemIndex) => (
                    <li key={`navigation-item-${groupIndex}-${itemIndex}`}>
                      <a
                        className={activeHref === item.href ? "is-active" : ""}
                        href={item.href}
                        aria-current={activeHref === item.href ? "page" : undefined}
                        onClick={() => {
                          onNavigate(item.href);
                          onClose();
                        }}
                      >
                        <span className="nav-item-dot" aria-hidden="true" />
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </nav>
      </aside>
    </>
  );
}

function SearchDialog({ content, open, query, setQuery, onClose, onSelect }) {
  const inputRef = useRef(null);
  const dialogRef = useRef(null);
  const [activeResult, setActiveResult] = useState(0);
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return content.searchItems.slice(0, 5);
    return content.searchItems.filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(normalized));
  }, [content.searchItems, query]);

  useEffect(() => {
    setActiveResult(0);
  }, [query]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  function handleKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length === 0) return;
      setActiveResult((index) => Math.min(index + 1, results.length - 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      setActiveResult((index) => Math.max(index - 1, 0));
    }
    if (event.key === "Enter" && results[activeResult]) {
      event.preventDefault();
      onSelect(results[activeResult]);
    }
  }

  function keepFocusInside(event) {
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll("button:not([disabled]), input, [href], [tabindex]:not([tabindex='-1'])");
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="search-overlay" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={keepFocusInside}
      >
        <h2 className="sr-only" id="search-dialog-title">{content.ui.searchTitle}</h2>
        <div className="search-dialog-input">
          <IconSearch size={21} stroke={1.8} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={content.ui.searchPlaceholder}
            aria-label={content.ui.searchQuery}
            role="combobox"
            aria-autocomplete="list"
            aria-controls="search-results"
            aria-expanded="true"
            aria-activedescendant={results[activeResult] ? `search-result-${activeResult}` : undefined}
          />
          <button className="icon-button" type="button" onClick={onClose} aria-label={content.ui.closeSearch}>
            <IconX size={19} stroke={1.8} />
          </button>
        </div>
        <div className="search-dialog-meta">
          <span>{query ? (content.language === "ko" ? `“${query}” ${content.ui.resultSuffix}` : `${content.ui.resultSuffix} for “${query}”`) : content.ui.popularDocs}</span>
          <span className="keyboard-hint">{content.ui.keyboardHint}</span>
        </div>
        <div className="search-results" id="search-results" role="listbox" aria-label={content.ui.searchResults}>
          {results.length > 0 ? (
            results.map((item, index) => {
              const ResultIcon = item.icon;
              return (
                <button
                  id={`search-result-${index}`}
                  className={index === activeResult ? "is-active" : ""}
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeResult}
                  onMouseEnter={() => setActiveResult(index)}
                  onClick={() => onSelect(item)}
                >
                  <span className="search-result-icon"><ResultIcon size={19} stroke={1.7} /></span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <IconChevronRight size={18} stroke={1.8} />
                </button>
              );
            })
          ) : (
            <div className="search-empty">
              <IconSearch size={24} stroke={1.6} />
              <p>{content.ui.noResults}</p>
              <small>{content.ui.noResultsHint}</small>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Topbar({ content, inert, theme, onLanguage, onMenu, onSearch, onTheme }) {
  return (
    <header className="topbar" inert={inert}>
      <button className="icon-button mobile-menu" type="button" onClick={onMenu} aria-label={content.ui.openMenu}>
        <IconMenu2 size={22} stroke={1.8} />
      </button>
      <div className="mobile-brand"><Brand content={content} /></div>
      <button className="search-trigger" type="button" onClick={onSearch}>
        <IconSearch size={19} stroke={1.8} />
        <span>{content.ui.searchPlaceholder}</span>
        <kbd>⌘ K</kbd>
      </button>
      <nav className="utility-nav" aria-label={content.ui.quickLinks}>
        <a href="https://github.com/marvinkim-photo/nudgeon" target="_blank" rel="noreferrer">
          <IconBrandGithub size={20} stroke={1.8} />
          <span>GitHub</span>
        </a>
        <span className="utility-disabled" aria-label={content.ui.consoleAria}>
          <IconTerminal2 size={19} stroke={1.7} />
          <span>{content.ui.consoleReady}</span>
        </span>
        <button className="theme-utility-button" type="button" onClick={onTheme} aria-label={theme === "dark" ? content.ui.switchLight : content.ui.switchDark}>
          {theme === "dark" ? <IconSun size={19} stroke={1.8} /> : <IconMoon size={19} stroke={1.8} />}
          <span>{theme === "dark" ? content.ui.lightMode : content.ui.darkMode}</span>
        </button>
        <button className="language-button" type="button" aria-label={content.ui.localeAria} onClick={onLanguage}>
          <IconWorld size={20} stroke={1.7} />
          <span className="language-name">{content.ui.localeName}</span>
          <small aria-hidden="true">{content.language === "ko" ? "EN" : "KO"}</small>
        </button>
      </nav>
      <button className="icon-button mobile-language" type="button" onClick={onLanguage} aria-label={content.ui.localeAria}>
        <IconWorld size={20} stroke={1.8} />
        <span aria-hidden="true">{content.language === "ko" ? "EN" : "KO"}</span>
      </button>
      <button className="icon-button mobile-theme" type="button" onClick={onTheme} aria-label={theme === "dark" ? content.ui.switchLight : content.ui.switchDark}>
        {theme === "dark" ? <IconSun size={20} stroke={1.8} /> : <IconMoon size={20} stroke={1.8} />}
      </button>
      <button className="icon-button mobile-search" type="button" onClick={onSearch} aria-label={content.ui.openSearch}>
        <IconSearch size={21} stroke={1.8} />
      </button>
    </header>
  );
}

function renderCodeLine(line) {
  const method = line.match(/^(GET|POST|PUT|PATCH|DELETE)(.*)$/);
  if (method) {
    return <><span className="token-method">{method[1]}</span>{method[2]}</>;
  }

  const status = line.match(/^(HTTP\/1\.1\s+)(\d{3}\s+.*)$/);
  if (status) {
    return <>{status[1]}<span className="token-success">{status[2]}</span></>;
  }

  const property = line.match(/^(\s*)("[^"]+")(\s*:\s*)(.*)$/);
  if (property) {
    return <>{property[1]}<span className="token-property">{property[2]}</span>{property[3]}<span className="token-value">{property[4]}</span></>;
  }

  return line || " ";
}

function CodeBlock({ content, label, value, copied, onCopy }) {
  const lines = value.split("\n");
  return (
    <div className="code-section">
      <div className="code-label-row"><span>{label}</span></div>
      <div className="code-block">
        <pre><code className="code-lines">
          {lines.map((line, index) => (
            <span className="code-line" key={`${index}-${line}`}>
              <span className="line-number" aria-hidden="true">{index + 1}</span>
              <span className="line-content">{renderCodeLine(line)}</span>
            </span>
          ))}
        </code></pre>
        <button className="copy-button" type="button" onClick={() => onCopy(value)} aria-label={copied ? content.ui.copied : content.ui.copy}>
          {copied ? <IconCheck size={17} stroke={2} /> : <IconCopy size={17} stroke={1.8} />}
          <span>{copied ? content.ui.copied : content.ui.copy}</span>
        </button>
      </div>
    </div>
  );
}

function Checklist({ content, activeStep, setActiveStep, announce }) {
  const [copied, setCopied] = useState("");
  const copyTimerRef = useRef(null);
  const stepRefs = useRef([]);
  const step = content.checklist[activeStep];

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  useEffect(() => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    stepRefs.current[activeStep]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [activeStep]);

  async function handleCopy(value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      announce("");
      window.requestAnimationFrame(() => announce(content.ui.copySuccess));
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(""), 1600);
    } catch {
      announce(content.ui.copyError);
      setCopied("");
    }
  }

  function handleStepKeyDown(event, index) {
    const lastIndex = content.checklist.length - 1;
    let nextIndex = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = index === lastIndex ? 0 : index + 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = index === 0 ? lastIndex : index - 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = lastIndex;
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveStep(nextIndex);
    window.requestAnimationFrame(() => stepRefs.current[nextIndex]?.focus());
  }

  function goNext() {
    if (activeStep < content.checklist.length - 1) {
      setActiveStep(activeStep + 1);
      return;
    }
    document.querySelector("#error-codes")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <section className="checklist-panel" aria-label={content.ui.checklistLabel}>
      <div className="checklist-steps" role="tablist" aria-label={content.ui.checklistSteps}>
        {content.checklist.map((item, index) => (
          <button
            ref={(node) => { stepRefs.current[index] = node; }}
            key={item.id}
            className={index === activeStep ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={index === activeStep}
            aria-controls="checklist-detail"
            id={`checklist-tab-${item.id}`}
            tabIndex={index === activeStep ? 0 : -1}
            onClick={() => setActiveStep(index)}
            onKeyDown={(event) => handleStepKeyDown(event, index)}
          >
            <span className="step-number">{index + 1}</span>
            <span className="step-copy">
              <strong>{item.label}</strong>
              <small>{item.summary}</small>
            </span>
          </button>
        ))}
      </div>
      <article className="runbook" id="checklist-detail" role="tabpanel" aria-labelledby={`checklist-tab-${step.id}`} tabIndex={-1}>
        <div className="runbook-heading">
          <span className="runbook-step-label">STEP {activeStep + 1}</span>
          <h2>{step.title}</h2>
          <p>{step.description}</p>
        </div>
        <CodeBlock content={content} label={step.requestLabel} value={step.request} copied={copied === step.request} onCopy={handleCopy} />
        <CodeBlock content={content} label={step.responseLabel} value={step.response} copied={copied === step.response} onCopy={handleCopy} />
        <div className="warning-note">
          <IconAlertTriangle size={19} stroke={1.9} aria-hidden="true" />
          <p>{step.note}</p>
        </div>
        <button className="next-step" type="button" onClick={goNext}>
          {step.next}
          <IconChevronRight size={20} stroke={1.9} />
        </button>
      </article>
    </section>
  );
}

function GuideArticles({ content, announce }) {
  const [copiedGuide, setCopiedGuide] = useState("");
  const resetTimerRef = useRef(null);

  useEffect(() => () => window.clearTimeout(resetTimerRef.current), []);

  async function copyGuideCode(guide) {
    try {
      await navigator.clipboard.writeText(guide.code);
      setCopiedGuide(guide.id);
      announce("");
      window.requestAnimationFrame(() => announce(content.ui.copySuccess));
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopiedGuide(""), 1800);
    } catch {
      announce("");
      window.requestAnimationFrame(() => announce(content.ui.copyError));
    }
  }

  return (
    <section className="guide-library" aria-labelledby="guide-library-title">
      <div className="guide-library-heading">
        <p className="section-kicker">{content.ui.guidesKicker}</p>
        <h2 id="guide-library-title">{content.ui.guidesTitle}</h2>
      </div>
      <div className="guide-list">
        {content.guides.map((guide) => (
          <article className="guide-article" id={guide.id} key={guide.id} tabIndex={-1}>
            <header className="guide-article-header">
              <p>{guide.eyebrow}</p>
              <h2>{guide.title}</h2>
              <span>{guide.intro}</span>
              <code>{guide.endpoint}</code>
            </header>
            <div className="guide-workflow">
              <p>{content.ui.guideSteps}</p>
              <ol>
                {guide.steps.map((step, index) => (
                  <li key={`${guide.id}-step-${index}`}>
                    <span aria-hidden="true">{index + 1}</span>
                    <div>
                      <h3>{step.title}</h3>
                      <p>{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <CodeBlock
              content={content}
              label={guide.codeLabel}
              value={guide.code}
              copied={copiedGuide === guide.id}
              onCopy={() => copyGuideCode(guide)}
            />
            <div className="warning-note guide-note">
              <IconAlertTriangle size={19} stroke={1.9} aria-hidden="true" />
              <p>{guide.note}</p>
            </div>
            <p className="guide-source"><strong>{content.ui.implementationSource}</strong> · {guide.source}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function PageToc({ content }) {
  return (
    <aside className="page-toc" aria-label={content.ui.tocLabel}>
      <p>{content.ui.tocLabel}</p>
      <a className="is-active" href="#checklist">{content.ui.toc[0]}</a>
      <a href="#resources">{content.ui.toc[1]}</a>
      <a href="#resources">{content.ui.toc[2]}</a>
      <a href="#error-codes">{content.ui.toc[3]}</a>
    </aside>
  );
}

function ResourceSections({ content }) {
  return (
    <section className="resources" id="resources" aria-labelledby="resources-title">
      <div className="resources-heading">
        <p className="section-kicker">{content.ui.nextSteps}</p>
        <h2 id="resources-title">{content.ui.resourcesTitle}</h2>
      </div>
      <div className="resource-list">
        {content.resources.map((resource) => {
          const ResourceIcon = resource.icon;
          return (
            <article key={resource.id}>
              <span className="resource-icon"><ResourceIcon size={21} stroke={1.7} /></span>
              <div>
                <p>{resource.eyebrow}</p>
                <h3>{resource.title}</h3>
                <span>{resource.body}</span>
              </div>
              <a href={resource.href} aria-label={`${resource.title} · ${content.ui.openGuide}`}>
                <IconChevronRight size={20} stroke={1.8} />
              </a>
            </article>
          );
        })}
      </div>
      <a className="source-note" id="source" href="https://github.com/marvinkim-photo/nudgeon" target="_blank" rel="noreferrer">
        <IconBrandGithub size={22} stroke={1.8} />
        <div>
          <strong>{content.ui.sourceTitle}</strong>
          <p>{content.ui.sourceBody}</p>
        </div>
        <IconChevronRight className="source-note-arrow" size={20} stroke={1.8} />
      </a>
    </section>
  );
}

export function App() {
  const [activeStep, setActiveStep] = useState(0);
  const [activeHref, setActiveHref] = useState(() => {
    if (typeof window === "undefined") return "#checklist";
    return window.location.hash || "#checklist";
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState(() => {
    if (typeof window === "undefined") return "ko";
    try {
      return window.localStorage.getItem("nudgeon-docs-language") === "en" ? "en" : "ko";
    } catch {
      return "ko";
    }
  });
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "dark";
    try {
      const savedTheme = window.localStorage.getItem("nudgeon-docs-theme");
      if (savedTheme === "light" || savedTheme === "dark") return savedTheme;
    } catch {
      // Use the operating-system preference when storage is unavailable.
    }
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  const [announcement, setAnnouncement] = useState("");
  const priorFocusRef = useRef(null);
  const content = copyByLanguage[language];

  function openSearch() {
    priorFocusRef.current = document.activeElement;
    setSearchOpen(true);
  }

  function closeSearch(restoreFocus = true) {
    setSearchOpen(false);
    setQuery("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => priorFocusRef.current?.focus?.());
    }
  }

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    setAnnouncement(content.language === "ko"
      ? `${nextTheme === "light" ? content.ui.lightMode : content.ui.darkMode}로 전환했습니다.`
      : `Switched to ${nextTheme === "light" ? content.ui.lightMode.toLowerCase() : content.ui.darkMode.toLowerCase()}.`);
  }

  useEffect(() => {
    function handleKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
      if (event.key === "Escape") {
        closeSearch();
        setSidebarOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    function syncHash() {
      setActiveHref(window.location.hash || "#checklist");
    }
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.body.style.backgroundColor = theme === "light" ? "#f6f8fa" : "#101116";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f6f8fa" : "#101116");
    try {
      window.localStorage.setItem("nudgeon-docs-theme", theme);
    } catch {
      // The active theme still applies when storage is blocked.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = content.language;
    document.title = content.metaTitle;
    try {
      window.localStorage.setItem("nudgeon-docs-language", content.language);
    } catch {
      // Language switching remains available when storage is blocked.
    }
    setAnnouncement(content.language === "ko" ? "한국어 문서로 전환했습니다." : "Switched to English documentation.");
  }, [content]);

  useEffect(() => {
    if (!searchOpen && !sidebarOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [searchOpen, sidebarOpen]);

  function selectSearchResult(item) {
    closeSearch(false);

    if (item.href) {
      setActiveHref(item.href);
      window.location.hash = item.href;
      window.requestAnimationFrame(() => {
        const article = document.querySelector(item.href);
        article?.scrollIntoView({ behavior: "smooth", block: "start" });
        article?.focus({ preventScroll: true });
      });
      return;
    }

    setActiveStep(item.step);
    setActiveHref("#checklist");
    window.location.hash = "checklist";
    window.requestAnimationFrame(() => {
      const panel = document.querySelector("#checklist-detail");
      panel?.scrollIntoView({ behavior: "smooth", block: "center" });
      panel?.focus({ preventScroll: true });
    });
  }

  function startChecklist() {
    setActiveStep(0);
    document.querySelector(".checklist-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="docs-app" data-theme={theme} lang={content.language}>
      <Sidebar
        content={content}
        inert={searchOpen}
        open={sidebarOpen}
        activeHref={activeHref}
        onClose={() => setSidebarOpen(false)}
        onNavigate={setActiveHref}
      />
      <Topbar
        content={content}
        inert={searchOpen || sidebarOpen}
        theme={theme}
        onLanguage={() => setLanguage(language === "ko" ? "en" : "ko")}
        onMenu={() => setSidebarOpen(true)}
        onSearch={openSearch}
        onTheme={toggleTheme}
      />
      <main className="main-content" inert={searchOpen || sidebarOpen}>
        <div className="content-grid">
          <div className="primary-content">
            <section className="hero" id="checklist">
              <div className="status-label"><span aria-hidden="true" />Push MVP Alpha</div>
              <h1>{content.ui.heroTitle}</h1>
              <p>{content.ui.heroBody}</p>
              <button className="primary-button" type="button" onClick={startChecklist}>
                {content.ui.heroAction}
                <IconChevronRight size={21} stroke={1.9} />
              </button>
            </section>
            <Checklist content={content} activeStep={activeStep} setActiveStep={setActiveStep} announce={setAnnouncement} />
            <GuideArticles content={content} announce={setAnnouncement} />
            <ResourceSections content={content} />
          </div>
          <PageToc content={content} />
        </div>
      </main>
      <button
        className={`theme-toggle ${sidebarOpen ? "sidebar-visible" : ""}`}
        type="button"
        inert={searchOpen}
        onClick={toggleTheme}
        aria-label={theme === "dark" ? content.ui.switchLight : content.ui.switchDark}
      >
        {theme === "dark" ? <IconSun size={19} stroke={1.8} /> : <IconMoon size={19} stroke={1.8} />}
        <span>{theme === "dark" ? content.ui.lightMode : content.ui.darkMode}</span>
        <IconChevronDown size={15} stroke={1.8} />
      </button>
      <SearchDialog
        content={content}
        open={searchOpen}
        query={query}
        setQuery={setQuery}
        onClose={closeSearch}
        onSelect={selectSearchResult}
      />
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </div>
  );
}
