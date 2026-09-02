import { guideContentByLanguage } from "./guideContent.js";

const koDocuments = [
  {
    id: "concepts",
    eyebrow: "시작하기 · 개념",
    title: "NudgeOn 핵심 개념",
    intro: "이벤트를 안전하게 접수하고 고객과 디바이스를 식별한 뒤, 세그먼트와 저니를 거쳐 FCM·APNs 푸시로 전달하는 흐름을 이해합니다.",
    endpoint: "POST /v1/track → 세그먼트 → 저니 → FCM·APNs",
    steps: [
      { title: "식별자를 역할별로 나눕니다", body: "고객은 바뀌지 않는 external_id, 로그인 전 사용자는 anon_id, 설치 단위는 device_id로 식별합니다. 이벤트 재시도에는 같은 insert_id를 유지합니다." },
      { title: "실행 위치에 맞는 키를 씁니다", body: "앱과 브라우저는 pk_ SDK Key, 신뢰할 수 있는 서버는 sk_ Server Key, 관리 API는 로그인 세션을 사용합니다." },
      { title: "접수와 전달을 구분합니다", body: "202, 제공자 접수, 실제 기기 도달, 열기는 서로 다른 상태입니다. message_id로 단계별 기록을 연결합니다." },
    ],
    codeLabel: "이벤트 접수 예시",
    code: `POST <API_BASE_URL>/v1/track
Authorization: Bearer pk_REPLACE_ME
Content-Type: application/json

{
  "batch": [{
    "insert_id": "<UUID>",
    "external_id": "customer-123",
    "event": "Product Viewed",
    "properties": { "product_id": "sku-42" }
  }]
}`,
    note: "NudgeOn는 현재 Push MVP Alpha이며 실제 채널은 FCM·APNs입니다. /v1/track의 202는 PostgreSQL 원본과 outbox 커밋까지만 보장합니다.",
    source: "API 가이드 · PUSH-CONTRACT · README",
  },
  {
    id: "sdk-quickstart",
    eyebrow: "SDK 연동",
    title: "SDK 시작하기",
    intro: "iOS·Android 네이티브 코어와 React Native·Flutter 브리지는 초기화, 식별, 이벤트 수집, 푸시 등록이라는 공통 흐름을 사용합니다.",
    endpoint: "initialize → identify → track → register push token",
    steps: [
      { title: "앱 시작 시 한 번 초기화합니다", body: "콘솔에서 발급한 pk_ SDK Key와 HTTPS API 호스트를 사용합니다. sk_ Server Key를 앱에 포함하면 안 됩니다." },
      { title: "로그인과 행동을 연결합니다", body: "로그인 후 안정적인 external_id로 identify하고 의미 있는 행동이 일어날 때 track을 호출합니다." },
      { title: "토큰과 권한 변화를 동기화합니다", body: "APNs·FCM 토큰 또는 OS 권한이 바뀌면 다시 등록하고, 로그아웃 시 로컬 reset과 서버의 기기 연결 해제를 구분합니다." },
    ],
    codeLabel: "iOS 초기화 예시",
    code: `import NudgeOnSDK

NudgeOn.initialize(config: NudgeOnConfig(
    sdkKey: "pk_...",
    apiHost: URL(string: "https://ingest.example.com")!
))
NudgeOn.identify(externalId: "customer-123")
NudgeOn.track("Product Viewed", properties: ["product_id": "sku-42"])`,
    note: "SPM·Maven Central·npm·pub.dev 공개 패키지와 신규 설치 검증은 아직 완료되지 않았습니다. 현재 확인된 경로는 소스 체크아웃과 로컬 샘플입니다.",
    source: "iOS · Android · React Native · Flutter SDK README",
  },
  {
    id: "platform-guides",
    eyebrow: "SDK 연동",
    title: "플랫폼별 연동 가이드",
    intro: "플랫폼별 푸시 진입점을 연결하되 식별자, 오프라인 큐, 토큰 상태의 소유권은 네이티브 코어에 유지합니다.",
    endpoint: "iOS · Android · React Native · Flutter",
    steps: [
      { title: "iOS 콜백을 직접 전달합니다", body: "swizzling 없이 AppDelegate에서 APNs 토큰·수신·열기를 전달합니다. 이미지와 delivered 보고에는 NSE와 App Group이 필요합니다." },
      { title: "Android 메시징 서비스를 연결합니다", body: "NudgeOn FirebaseMessagingService를 등록하거나 기존 서비스에서 onNewToken과 원격 메시지를 전달합니다. Android 13 이상은 Activity Result로 권한 완료를 확인합니다." },
      { title: "브리지는 상태를 복제하지 않습니다", body: "React Native와 Flutter는 호출과 이벤트만 iOS·Android 네이티브 코어에 전달합니다." },
    ],
    codeLabel: "Android 로컬 샘플 빌드",
    code: `cd nudgeon-android-sdk
./gradlew :sample-app:assembleDebug`,
    note: "실제 Android FCM 수신, iOS NSE delivered, Android 13 권한 시점, RN·Flutter 호스트 앱 연결은 신규 설치 기준 검증이 남아 있습니다.",
    source: "각 SDK README · RELEASE-CHECKLIST",
  },
  {
    id: "push-permissions",
    eyebrow: "SDK 연동",
    title: "푸시 권한과 수신 동의",
    intro: "OS 알림 권한, APNs·FCM 토큰, 서비스 수준의 푸시 수신 동의를 서로 다른 상태로 관리하고 변경 시 서버에 동기화합니다.",
    endpoint: "POST /v1/devices/token · /v1/subscriptions · /v1/devices/logout",
    steps: [
      { title: "OS 권한을 정규화합니다", body: "권한 결과를 granted, denied, undetermined 중 하나로 저장합니다." },
      { title: "토큰과 계정 변화를 다시 등록합니다", body: "토큰 갱신, 권한 변경, 로그인 계정 변경 때마다 /v1/devices/token을 다시 호출합니다." },
      { title: "동의와 로그아웃을 분리합니다", body: "서비스 수신 동의는 /v1/subscriptions, 로그아웃 기기 연결 해제는 /v1/devices/logout으로 동기화합니다." },
    ],
    codeLabel: "토큰과 권한 동기화",
    code: `POST <API_BASE_URL>/v1/devices/token
Authorization: Bearer pk_REPLACE_ME
Content-Type: application/json

{
  "external_id": "customer-123",
  "device": {
    "device_id": "<UUID>",
    "platform": "ios",
    "app_version": "1.2.0"
  },
  "push_token": "<APNS_OR_FCM_TOKEN>",
  "os_permission": "granted"
}`,
    note: "토큰 저장과 202 응답은 권한 허용이나 기기 도달 증명이 아닙니다. 토큰 소유권과 실제 수신을 별도로 확인하세요.",
    source: "API 가이드 · ingestion schema · SDK README",
  },
  {
    id: "authentication",
    eyebrow: "API 참조",
    title: "인증과 키 선택",
    intro: "요청이 실행되는 위치에 따라 SDK Key, Server Key 또는 관리 콘솔 세션을 선택합니다.",
    endpoint: "pk_ · sk_ · nudgeon_session",
    steps: [
      { title: "SDK Key는 수집에 사용합니다", body: "pk_ 키는 앱의 이벤트·사용자 식별·푸시 토큰 수집용이며 Authorization: Bearer 또는 X-Api-Key 헤더를 지원합니다." },
      { title: "Server Key는 서버에만 보관합니다", body: "sk_ 키의 ingest_only 범위는 수집 전용입니다. 고객 삭제 같은 관리 작업에는 full 범위가 필요합니다." },
      { title: "관리 API는 세션을 사용합니다", body: "로그인으로 HttpOnly nudgeon_session 쿠키가 생성됩니다. 2FA가 필요하면 totp_required 또는 enrollment_required가 반환됩니다." },
    ],
    codeLabel: "콘솔 로그인",
    code: `POST <API_BASE_URL>/v1/auth/login
Content-Type: application/json

{
  "email": "owner@example.com",
  "password": "REPLACE_WITH_YOUR_PASSWORD"
}`,
    note: "Server Key는 모바일 앱이나 브라우저 번들에 넣지 마세요. 원본 키는 생성 시 한 번만 표시됩니다.",
    source: "API 가이드 · auth controller · API key guard",
  },
  {
    id: "push-api",
    eyebrow: "API 참조",
    title: "푸시 API",
    intro: "SDK Key 기반 디바이스 등록과 세션 기반 발송 관리 API를 분리하고, 테스트 발송 뒤 메시지 로그와 실제 기기 수신을 함께 확인합니다.",
    endpoint: "POST /v1/devices/token · /v1/apps/<APP_ID>/test-push",
    steps: [
      { title: "디바이스는 SDK Key로 등록합니다", body: "/v1/devices/token은 pk_ SDK Key로 디바이스, 공급자 토큰, OS 권한을 등록합니다." },
      { title: "발송 관리는 역할을 확인합니다", body: "FCM·APNs credential 등록은 Admin 이상, 테스트 푸시는 Editor 이상 세션이 필요합니다." },
      { title: "message_id로 상태를 연결합니다", body: "message_id는 발송 로그와 SDK delivered·opened 이벤트를 연결합니다. FCM은 data-only 문자열 맵, APNs는 aps와 nudgeon 객체를 사용합니다." },
    ],
    codeLabel: "테스트 푸시 요청",
    code: `POST <API_BASE_URL>/v1/apps/<APP_ID>/test-push
Cookie: nudgeon_session=<SESSION>
Content-Type: application/json

{
  "external_id": "customer-123",
  "title": "NudgeOn 연동 테스트",
  "body": "첫 번째 푸시가 도착했습니다."
}`,
    note: "queued는 큐 등록, sent는 공급자 접수를 뜻하며 실제 도달이 아닙니다. 공개 OpenAPI는 일부 계약만 포함합니다.",
    source: "API 가이드 · PUSH-CONTRACT · test-push controller",
  },
  {
    id: "journey-api",
    eyebrow: "API 참조",
    title: "저니 API",
    intro: "세션 기반 관리 API로 저니 초안을 생성하고 검증한 뒤, 동일한 revision을 불변 버전으로 활성화합니다.",
    endpoint: "GET·POST /v1/apps/<APP_ID>/journeys",
    steps: [
      { title: "역할에 맞게 조회·수정합니다", body: "조회와 검증은 관리 세션이 필요하며 생성·수정·활성화·중지·보관은 owner, admin, editor 역할만 가능합니다." },
      { title: "활성화 직전에 검증합니다", body: "검증은 issues, 예상 대상 수, revision을 반환합니다. Graph v2 활성화에는 같은 revision이 필요하며 초안 변경 시 409가 발생합니다." },
      { title: "활성 버전을 불변으로 유지합니다", body: "활성화는 새 불변 버전을 만듭니다. draft 또는 paused 상태에서만 수정할 수 있습니다." },
    ],
    codeLabel: "저니 목록 조회",
    code: `GET <API_BASE_URL>/v1/apps/<APP_ID>/journeys
Cookie: nudgeon_session=<SESSION>`,
    note: "Graph v2는 JOURNEY_GRAPH_V2_ENABLED capability로 제한됩니다. 비활성 환경은 message와 delay만 지원합니다.",
    source: "API 가이드 · journeys controller · journey contract",
  },
  {
    id: "webhooks",
    eyebrow: "API 참조 · 미구현",
    title: "웹훅 — 현재 미구현",
    intro: "현재 저장소에는 고객이 URL을 등록하고 NudgeOn 이벤트를 수신하는 공개 웹훅 API가 없습니다.",
    endpoint: "공개 endpoint 없음",
    steps: [
      { title: "공개 route가 없습니다", body: "API 애플리케이션에 웹훅 controller 또는 공개 route가 등록되어 있지 않습니다." },
      { title: "내부 callback과 구분합니다", body: "worker의 HandleCallback은 채널 제공자 응답용 내부 plugin 인터페이스이며 고객 대상 outbound webhook이 아닙니다." },
      { title: "계약부터 정의해야 합니다", body: "URL 등록, 서명 검증, delivery schema, 재시도 정책, delivery log는 아직 정의·구현되지 않았습니다." },
    ],
    codeLabel: "저장소 확인 명령",
    code: `rg -n -i 'webhook|HandleCallback' \\
  apps/api/src apps/worker/internal/channel`,
    note: "문서 메뉴가 지원 중이라는 의미는 아닙니다. 임의로 추측한 URL에 키나 고객 데이터를 전송하지 마세요.",
    source: "app module · worker channel plugin",
  },
  {
    id: "self-hosting",
    eyebrow: "직접 설치·운영",
    title: "Docker Compose로 NudgeOn를 직접 설치하세요",
    intro: "PostgreSQL, ClickHouse, Redis와 API·콘솔·워커를 한 Compose 스택으로 기동하고 단일 테넌트 최초 관리자를 설정합니다.",
    endpoint: "deploy/compose.yaml · deploy/.env",
    steps: [
      { title: "Compose 환경 파일을 준비합니다", body: "deploy/.env.example을 복사하고 설치마다 새로운 32바이트 NUDGEON_MASTER_KEY를 생성합니다." },
      { title: "실제 origin을 설정합니다", body: "CORS_ORIGIN과 NEXT_PUBLIC_API_URL을 실제 주소로 설정합니다. 콘솔 API 주소는 빌드 시 포함되므로 도메인이 바뀌면 이미지를 다시 빌드합니다." },
      { title: "마이그레이션 뒤 준비 상태를 확인합니다", body: "migrator 완료 후 API·워커가 시작됩니다. /readyz가 성공하면 MODE=single_tenant 최초 관리자 설정을 한 번만 수행합니다." },
    ],
    codeLabel: "Compose 기동",
    code: `cp deploy/.env.example deploy/.env
# deploy/.env에 새 NUDGEON_MASTER_KEY를 설정합니다.
docker compose -f deploy/compose.yaml \\
  --env-file deploy/.env \\
  --profile full --profile app up -d --build
curl -fsS http://localhost:8080/readyz`,
    note: "빈 서버 설치 시간, 커스텀 도메인 세션·CORS, 실제 관리형 DB 연결은 아직 출시 검증 게이트입니다.",
    source: "DEPLOY · compose.yaml · RELEASE-CHECKLIST",
  },
  {
    id: "operations",
    eyebrow: "직접 설치·운영",
    title: "상태 확인부터 복구까지 하나의 운영 런북으로 관리하세요",
    intro: "마이그레이션, 헬스체크, Prometheus 지표, 저장소별 백업과 복구 검증을 하나의 변경 절차로 묶습니다.",
    endpoint: "/healthz · /readyz · worker /metrics",
    steps: [
      { title: "마이그레이션을 먼저 실행합니다", body: "nudgeon-migrate는 추가형 upgrade SQL 이후 PostgreSQL·ClickHouse 스키마를 멱등 적용합니다. 앱 서비스보다 먼저 실행합니다." },
      { title: "상태와 지표를 함께 감시합니다", body: "API /healthz·/readyz, 워커 /healthz·/metrics, 구조화 JSON 로그를 함께 확인합니다." },
      { title: "저장소별 복구를 시험합니다", body: "PostgreSQL WAL·스냅샷, ClickHouse 백업, Redis AOF를 따로 보존하고 빈 서버 복원과 큐·중복 억제 상태까지 시험합니다." },
    ],
    codeLabel: "운영 상태 확인",
    code: `curl -fsS http://localhost:8080/healthz
curl -fsS http://localhost:8080/readyz
curl -fsS http://localhost:9090/healthz
curl -fsS http://localhost:9090/metrics`,
    note: "자동 복원, RPO/RTO, DLQ 경보, 24시간 soak, N-1 롤백은 아직 검증 목표입니다. outbox가 모든 Redis 유실 복구나 중복 발송 0%를 보장하지 않습니다.",
    source: "DEPLOY · compose.yaml · RELEASE-CHECKLIST",
  },
  {
    id: "security",
    eyebrow: "직접 설치·운영",
    title: "키·크리덴셜·조직 권한을 서로 다른 경계로 보호하세요",
    intro: "수집 키, 서버 키, 콘솔 세션, 공급자 크리덴셜과 마스터 키를 용도별로 분리하고 최소 권한을 적용합니다.",
    endpoint: "키 경계 · 세션 · AES-256-GCM · TOTP",
    steps: [
      { title: "수집 키와 서버 키를 분리합니다", body: "pk_ 키는 앱 수집용이고 sk_ 키는 신뢰할 수 있는 백엔드 전용입니다. 원본 키는 발급 시 한 번만 노출됩니다." },
      { title: "공급자 비밀을 암호화합니다", body: "FCM·APNs credential은 무작위 DEK와 마스터 키를 사용하는 AES-256-GCM 봉투 암호화로 저장하며 목록 API는 원문을 반환하지 않습니다." },
      { title: "조직 접근을 최소화합니다", body: "콘솔은 HttpOnly·Secure·SameSite=Lax 세션, 테넌트 범위 조회, 역할 권한, TOTP와 감사 로그를 사용합니다." },
    ],
    codeLabel: "운영 환경 경계",
    code: `MODE=single_tenant
CORS_ORIGIN=https://console.example.com
NEXT_PUBLIC_API_URL=https://api.example.com
NUDGEON_MASTER_KEY=<SECRET_MANAGER_VALUE>`,
    note: "마스터 키를 저장소나 이미지에 포함하지 마세요. 전체 권한 매트릭스, 교차 테넌트 검사, TOTP 강화, SECURITY 정책, SBOM·서명은 아직 출시 게이트입니다.",
    source: "API 가이드 · envelope encryption · RELEASE-CHECKLIST",
  },
  {
    id: "error-codes",
    eyebrow: "문제 해결",
    title: "오류 코드와 재시도",
    intro: "HTTP 상태 코드로 오류 종류를 먼저 구분하고 재시도 가능한 경우와 요청 수정이 필요한 경우를 나눕니다.",
    endpoint: "400 · 401 · 403 · 404 · 409 · 429 · 503",
    steps: [
      { title: "인증과 권한을 먼저 구분합니다", body: "401은 키·세션 인증 실패, 403은 역할·scope·2FA 제한, 404는 리소스 부재 또는 tenant 격리입니다." },
      { title: "충돌은 상태를 고칩니다", body: "409는 중복, 현재 상태, 저니 revision 충돌입니다. 같은 요청을 반복하기 전에 리소스 상태를 다시 조회합니다." },
      { title: "재시도 규칙을 지킵니다", body: "429는 Retry-After 이후 재시도합니다. /v1/track 503은 동일 insert_id로 제한적으로 재시도하고 400·409는 요청이나 상태를 수정합니다." },
    ],
    codeLabel: "인증 오류 확인",
    code: `GET <API_BASE_URL>/v1/auth/me
# Cookie가 없으면 HTTP 401이 반환됩니다.`,
    note: "202는 downstream 완료가 아닙니다. 모든 오류에 request_id가 있다고 가정하지 말고 키·비밀번호·푸시 토큰을 로그나 문의에 첨부하지 마세요.",
    source: "API 가이드 · rate-limit guard · ingestion service",
  },
  {
    id: "faq",
    eyebrow: "문제 해결",
    title: "자주 묻는 질문",
    intro: "초기 연동 문제는 잘못된 키 종류, 비동기 처리, rate limit, 세션·CORS 또는 저장소 준비 상태에서 주로 발생합니다.",
    endpoint: "상태 코드 · request_id · 배포·SDK 버전",
    steps: [
      { title: "왜 202인데 데이터가 바로 안 보이나요?", body: "202는 영속 접수 또는 큐 등록입니다. 분석 반영, 공급자 전달, 실제 기기 수신은 각각 별도 단계입니다." },
      { title: "왜 브라우저 관리 API가 401인가요?", body: "nudgeon_session 쿠키, 정확한 CORS_ORIGIN, credentialed request, SameSite·Secure 조건을 함께 확인합니다." },
      { title: "어떤 정보로 문의해야 하나요?", body: "발생 시각, 경로, 상태 코드, request_id, 키 종류, 배포·SDK 버전만 공유하고 비밀값은 제거합니다." },
    ],
    codeLabel: "기본 상태와 세션 확인",
    code: `curl -i <API_BASE_URL>/readyz
curl -i -b cookies.txt <API_BASE_URL>/v1/auth/me`,
    note: "API Key, 비밀번호, 푸시 토큰, FCM·APNs 원문을 첨부하지 마세요. /track 외 비동기 API는 요청 단위 중복 제거를 보장하지 않습니다.",
    source: "API 가이드 · 오류 코드와 문제 해결",
  },
  {
    id: "debugging",
    eyebrow: "문제 해결",
    title: "디버깅 가이드",
    intro: "상태 확인, 수집 요청 추적, 메시지 전달 확인 순서로 문제 범위를 좁힙니다.",
    endpoint: "/readyz → ingestion-errors → message-log → worker metrics",
    steps: [
      { title: "서비스와 저장소를 확인합니다", body: "/healthz는 API 프로세스 생존, /readyz는 PostgreSQL과 Redis 연결을 확인합니다." },
      { title: "수집 요청을 추적합니다", body: "응답 request_id와 발생 시각을 기록하고 data/ingestion-errors에서 endpoint, reason, detail을 대조합니다." },
      { title: "전달 경로를 분리해 확인합니다", body: "message-log 상태·failure detail, worker JSON 로그와 /metrics를 함께 봅니다. 제공자와 실제 기기 수신은 별도 검증합니다." },
    ],
    codeLabel: "최근 수집 오류 조회",
    code: `GET <API_BASE_URL>/v1/apps/<APP_ID>/data/ingestion-errors?limit=100
Cookie: nudgeon_session=<SESSION>`,
    note: "/readyz는 ClickHouse, APNs·FCM, 최종 기기 수신을 검사하지 않습니다. 오류 payload를 공유하기 전에 고객 데이터를 마스킹하세요.",
    source: "health controller · data controller · message-log · worker metrics",
  },
  {
    id: "release-notes",
    eyebrow: "릴리즈·호환성",
    title: "미출시 알파 변경과 배포된 릴리즈를 구분하세요",
    intro: "현재 작업 브랜치의 기능은 소스 구현 상태이며 v* 태그와 레지스트리 산출물이 확인되기 전에는 정식 릴리즈가 아닙니다.",
    endpoint: "git tag · GHCR release workflow",
    steps: [
      { title: "소스 구현을 릴리즈로 부르지 않습니다", body: "미출시 브랜치에는 저니 메시지 채널 확장과 발송기 선택 경로가 포함될 수 있지만 배포 증거가 아닙니다." },
      { title: "현재 체크아웃의 태그를 확인합니다", body: "package manifest 버전만으로 배포를 판단하지 않고 v* 태그와 대응 이미지·패키지를 함께 확인합니다." },
      { title: "산출물과 검증 범위를 기록합니다", body: "릴리즈 workflow는 API·콘솔·워커 멀티 아키텍처 이미지를 만들도록 구성되어 있으며 실제 레지스트리 결과는 별도 확인합니다." },
    ],
    codeLabel: "현재 릴리즈 근거 확인",
    code: `git describe --tags --always --dirty
git tag --list 'v*' --sort=-version:refname`,
    note: "manifest의 0.1.0은 배포 증거가 아닙니다. 공급자·고객 E2E, SBOM, 이미지 서명, 자동 변경 로그는 별도 검증이 필요합니다.",
    source: "release workflow · package manifest · RELEASE-CHECKLIST",
  },
  {
    id: "compatibility",
    eyebrow: "릴리즈·호환성",
    title: "도구·데이터 저장소·저니 스키마 호환성을 함께 확인하세요",
    intro: "빌드 도구 버전, Compose 저장소 버전, 관리형 서비스 후보와 v1/v2 저니 배포 순서를 하나의 호환성 계약으로 봅니다.",
    endpoint: "Node 22+ · pnpm 11.1.3 · Go 1.25 · PostgreSQL 16 · ClickHouse 24.8 · Redis 7",
    steps: [
      { title: "도구 버전을 맞춥니다", body: "개발·CI 기준은 Node.js 22 이상, pnpm 11.1.3, Go 1.25입니다." },
      { title: "저장소 버전을 확인합니다", body: "번들 Compose는 PostgreSQL 16, ClickHouse 24.8, Redis 7을 사용합니다. 관리형 서비스 후보는 검증 대상이지 인증 완료 목록이 아닙니다." },
      { title: "저니 v2를 순서대로 배포합니다", body: "호환 워커 전체 배포, API 배포, feature flag 활성화, 콘솔 공개 순서를 지키고 v2 실행 이후 구형 워커로 롤백하지 않습니다." },
    ],
    codeLabel: "로컬 도구 버전 확인",
    code: `node --version
pnpm --version
go version
docker compose version`,
    note: "API·스키마는 알파이며 바뀔 수 있습니다. 관리형 DB, N-1, 최소 OS·패키지 버전, 네 SDK 신규 설치·실기기 수신 인증 매트릭스는 아직 없습니다.",
    source: "package config · DEPLOY · JOURNEY-GRAPH · RELEASE-CHECKLIST",
  },
];

const enDocuments = [
  {
    id: "concepts",
    eyebrow: "Get started · Concepts",
    title: "NudgeOn core concepts",
    intro: "Learn how NudgeOn accepts events, resolves customers and devices, and routes them through segments and journeys to FCM or APNs.",
    endpoint: "POST /v1/track → segment → journey → FCM·APNs",
    steps: [
      { title: "Give each identifier one job", body: "Use a stable external_id for each customer, anon_id before sign-in, and device_id per installation. Reuse the same insert_id when retrying an event." },
      { title: "Match credentials to execution context", body: "Apps and browsers use a pk_ SDK Key, trusted servers use an sk_ Server Key, and management APIs use a signed-in session." },
      { title: "Separate admission from delivery", body: "A 202 response, provider acceptance, device receipt, and open are distinct states. Join their records with message_id." },
    ],
    codeLabel: "Event admission example",
    code: `POST <API_BASE_URL>/v1/track
Authorization: Bearer pk_REPLACE_ME
Content-Type: application/json

{
  "batch": [{
    "insert_id": "<UUID>",
    "external_id": "customer-123",
    "event": "Product Viewed",
    "properties": { "product_id": "sku-42" }
  }]
}`,
    note: "NudgeOn is currently Push MVP Alpha, with FCM and APNs as its live channels. A 202 from /v1/track confirms the PostgreSQL raw record and outbox commit only.",
    source: "API guide · PUSH-CONTRACT · README",
  },
  {
    id: "sdk-quickstart",
    eyebrow: "SDK integration",
    title: "Get started with the SDK",
    intro: "The iOS and Android native cores and the React Native and Flutter bridges share one initialize, identify, track, and push-registration flow.",
    endpoint: "initialize → identify → track → register push token",
    steps: [
      { title: "Initialize once at startup", body: "Use a console-issued pk_ SDK Key and an HTTPS API host. Never embed an sk_ Server Key in an app." },
      { title: "Connect sign-in to behavior", body: "Call identify with a stable external_id after sign-in, then call track when a meaningful action occurs." },
      { title: "Resync token and permission changes", body: "Register again when the APNs or FCM token or OS permission changes. Distinguish local reset from server-side device detachment at sign-out." },
    ],
    codeLabel: "iOS initialization example",
    code: `import NudgeOnSDK

NudgeOn.initialize(config: NudgeOnConfig(
    sdkKey: "pk_...",
    apiHost: URL(string: "https://ingest.example.com")!
))
NudgeOn.identify(externalId: "customer-123")
NudgeOn.track("Product Viewed", properties: ["product_id": "sku-42"])`,
    note: "Public packages and clean-install verification for SPM, Maven Central, npm, and pub.dev are incomplete. Source checkouts and local samples are the currently verified path.",
    source: "iOS · Android · React Native · Flutter SDK READMEs",
  },
  {
    id: "platform-guides",
    eyebrow: "SDK integration",
    title: "Platform integration guides",
    intro: "Connect each platform's push entry points while keeping identity, offline queues, and token state in the native core.",
    endpoint: "iOS · Android · React Native · Flutter",
    steps: [
      { title: "Forward iOS callbacks explicitly", body: "Forward APNs token, receive, and open callbacks from AppDelegate without swizzling. Rich images and delivered reporting require an NSE and App Group." },
      { title: "Connect Android messaging", body: "Register NudgeOn's FirebaseMessagingService or forward token and remote-message callbacks from your existing service. Observe Android 13+ permission completion through Activity Result." },
      { title: "Keep bridges stateless", body: "React Native and Flutter forward calls and events to the iOS and Android native cores without copying their state." },
    ],
    codeLabel: "Build the local Android sample",
    code: `cd nudgeon-android-sdk
./gradlew :sample-app:assembleDebug`,
    note: "Clean-install proof remains for Android FCM receipt, iOS NSE delivered reporting, Android 13 permission timing, and React Native or Flutter host wiring.",
    source: "SDK READMEs · RELEASE-CHECKLIST",
  },
  {
    id: "push-permissions",
    eyebrow: "SDK integration",
    title: "Push permission and consent",
    intro: "Treat OS notification permission, the APNs or FCM token, and service-level push consent as separate states and sync every change.",
    endpoint: "POST /v1/devices/token · /v1/subscriptions · /v1/devices/logout",
    steps: [
      { title: "Normalize OS permission", body: "Store the permission result as granted, denied, or undetermined." },
      { title: "Resync token and account changes", body: "Call /v1/devices/token again whenever the token, permission, or signed-in account changes." },
      { title: "Keep consent separate from sign-out", body: "Sync service-level consent through /v1/subscriptions and detach a signed-out device through /v1/devices/logout." },
    ],
    codeLabel: "Sync token and permission",
    code: `POST <API_BASE_URL>/v1/devices/token
Authorization: Bearer pk_REPLACE_ME
Content-Type: application/json

{
  "external_id": "customer-123",
  "device": {
    "device_id": "<UUID>",
    "platform": "ios",
    "app_version": "1.2.0"
  },
  "push_token": "<APNS_OR_FCM_TOKEN>",
  "os_permission": "granted"
}`,
    note: "A stored token and a 202 response do not prove permission or device delivery. Verify token ownership and real-device receipt separately.",
    source: "API guide · ingestion schema · SDK READMEs",
  },
  {
    id: "authentication",
    eyebrow: "API reference",
    title: "Authentication and key selection",
    intro: "Choose an SDK Key, Server Key, or management session according to where the request runs.",
    endpoint: "pk_ · sk_ · nudgeon_session",
    steps: [
      { title: "Use SDK Keys for collection", body: "A pk_ key collects app events, identities, and push tokens through either Authorization: Bearer or X-Api-Key." },
      { title: "Keep Server Keys on trusted servers", body: "An sk_ key with ingest_only scope is collection-only. Operations such as customer deletion require full scope." },
      { title: "Use sessions for management", body: "Login creates an HttpOnly nudgeon_session cookie and may return totp_required or enrollment_required." },
    ],
    codeLabel: "Console login",
    code: `POST <API_BASE_URL>/v1/auth/login
Content-Type: application/json

{
  "email": "owner@example.com",
  "password": "REPLACE_WITH_YOUR_PASSWORD"
}`,
    note: "Never embed a Server Key in a mobile app or browser bundle. Raw keys are shown only once at issuance.",
    source: "API guide · auth controller · API key guard",
  },
  {
    id: "push-api",
    eyebrow: "API reference",
    title: "Push API",
    intro: "Keep SDK-key device registration separate from session-based sending APIs, then verify the message log and receiving device after a test send.",
    endpoint: "POST /v1/devices/token · /v1/apps/<APP_ID>/test-push",
    steps: [
      { title: "Register devices with an SDK Key", body: "/v1/devices/token uses a pk_ key to register the device, provider token, and OS permission." },
      { title: "Check management roles", body: "FCM or APNs credential management requires Admin access, while a test push requires an Editor-or-higher session." },
      { title: "Join delivery states with message_id", body: "message_id connects logs to SDK delivered and opened events. FCM uses a data-only string map; APNs uses aps plus a nested nudgeon object." },
    ],
    codeLabel: "Test push request",
    code: `POST <API_BASE_URL>/v1/apps/<APP_ID>/test-push
Cookie: nudgeon_session=<SESSION>
Content-Type: application/json

{
  "external_id": "customer-123",
  "title": "NudgeOn integration test",
  "body": "Your first push has arrived."
}`,
    note: "queued means placed on the send queue, and sent means accepted by the provider—not delivered to the device. Public OpenAPI covers only part of the contract.",
    source: "API guide · PUSH-CONTRACT · test-push controller",
  },
  {
    id: "journey-api",
    eyebrow: "API reference",
    title: "Journey API",
    intro: "Use the session-based management API to create and validate a journey draft, then activate the same revision as an immutable version.",
    endpoint: "GET·POST /v1/apps/<APP_ID>/journeys",
    steps: [
      { title: "Read and mutate by role", body: "Reading and validation need a management session; creating, editing, activating, pausing, and archiving require owner, admin, or editor." },
      { title: "Validate immediately before activation", body: "Validation returns issues, an estimated audience, and revision. Graph v2 activation requires that exact revision; draft changes cause a 409." },
      { title: "Keep active versions immutable", body: "Activation creates a new immutable version. Only draft or paused journeys can be edited." },
    ],
    codeLabel: "List journeys",
    code: `GET <API_BASE_URL>/v1/apps/<APP_ID>/journeys
Cookie: nudgeon_session=<SESSION>`,
    note: "Graph v2 is gated by JOURNEY_GRAPH_V2_ENABLED. When disabled, only message and delay are supported.",
    source: "API guide · journeys controller · journey contract",
  },
  {
    id: "webhooks",
    eyebrow: "API reference · Not implemented",
    title: "Webhooks — not implemented",
    intro: "The current repository does not provide a public customer webhook API for registering a URL and receiving NudgeOn events.",
    endpoint: "No public endpoint",
    steps: [
      { title: "No public route is mounted", body: "The API application contains no webhook controller or public webhook route." },
      { title: "Do not confuse internal callbacks", body: "The worker's HandleCallback interface processes channel-provider responses; it is not a customer-facing outbound webhook." },
      { title: "The contract still needs design", body: "URL registration, signature verification, delivery schemas, retry policy, and delivery logs are not yet defined or implemented." },
    ],
    codeLabel: "Repository verification",
    code: `rg -n -i 'webhook|HandleCallback' \\
  apps/api/src apps/worker/internal/channel`,
    note: "The navigation item does not imply support. Never send keys or customer data to a guessed endpoint.",
    source: "app module · worker channel plugin",
  },
  {
    id: "self-hosting",
    eyebrow: "Self-host & operate",
    title: "Self-host NudgeOn with Docker Compose",
    intro: "Start PostgreSQL, ClickHouse, Redis, the API, console, and worker as one Compose stack, then bootstrap the first single-tenant administrator.",
    endpoint: "deploy/compose.yaml · deploy/.env",
    steps: [
      { title: "Prepare the Compose environment", body: "Copy deploy/.env.example and generate a unique 32-byte NUDGEON_MASTER_KEY for every installation." },
      { title: "Configure real origins", body: "Set CORS_ORIGIN and NEXT_PUBLIC_API_URL to the real addresses. The console API URL is embedded at build time, so rebuild after changing domains." },
      { title: "Check readiness after migration", body: "The API and worker start after the migrator completes. Check /readyz, then finish the one-time MODE=single_tenant administrator setup." },
    ],
    codeLabel: "Start the Compose stack",
    code: `cp deploy/.env.example deploy/.env
# Set a new NUDGEON_MASTER_KEY in deploy/.env.
docker compose -f deploy/compose.yaml \\
  --env-file deploy/.env \\
  --profile full --profile app up -d --build
curl -fsS http://localhost:8080/readyz`,
    note: "A clean-server install, custom-domain session and CORS behavior, and real managed-database connections remain release verification gates.",
    source: "DEPLOY · compose.yaml · RELEASE-CHECKLIST",
  },
  {
    id: "operations",
    eyebrow: "Self-host & operate",
    title: "Run health, migrations, and recovery as one operations playbook",
    intro: "Treat migrations, health checks, Prometheus metrics, and datastore recovery verification as one controlled change process.",
    endpoint: "/healthz · /readyz · worker /metrics",
    steps: [
      { title: "Run migrations first", body: "nudgeon-migrate applies additive upgrade SQL before idempotent PostgreSQL and ClickHouse schemas. Run it before application services." },
      { title: "Monitor health and metrics together", body: "Inspect API /healthz and /readyz, worker /healthz and /metrics, and structured JSON logs together." },
      { title: "Test each datastore recovery path", body: "Protect PostgreSQL WAL or snapshots, ClickHouse backups, and Redis AOF separately, then test clean-server restoration including queue and deduplication state." },
    ],
    codeLabel: "Operational checks",
    code: `curl -fsS http://localhost:8080/healthz
curl -fsS http://localhost:8080/readyz
curl -fsS http://localhost:9090/healthz
curl -fsS http://localhost:9090/metrics`,
    note: "Automated restore, RPO/RTO, DLQ alerts, a 24-hour soak, and N-1 rollback remain unverified. An outbox does not guarantee all Redis recovery or zero duplicates.",
    source: "DEPLOY · compose.yaml · RELEASE-CHECKLIST",
  },
  {
    id: "security",
    eyebrow: "Self-host & operate",
    title: "Protect keys, credentials, and organization access as separate boundaries",
    intro: "Separate collection keys, server keys, console sessions, provider credentials, and the master key by purpose, then apply least privilege.",
    endpoint: "Key boundaries · sessions · AES-256-GCM · TOTP",
    steps: [
      { title: "Separate collection and server keys", body: "A pk_ key is for app collection; an sk_ key belongs only on a trusted backend. Raw keys are shown once." },
      { title: "Encrypt provider secrets", body: "FCM and APNs credentials use AES-256-GCM envelope encryption with a random DEK and master key. List APIs do not return plaintext." },
      { title: "Minimize organization access", body: "The console uses HttpOnly, Secure, SameSite=Lax sessions, tenant-scoped queries, role permissions, TOTP, and audit logs." },
    ],
    codeLabel: "Production boundaries",
    code: `MODE=single_tenant
CORS_ORIGIN=https://console.example.com
NEXT_PUBLIC_API_URL=https://api.example.com
NUDGEON_MASTER_KEY=<SECRET_MANAGER_VALUE>`,
    note: "Never bake the master key into source or images. Full permission coverage, cross-tenant tests, TOTP hardening, a SECURITY policy, SBOMs, and signing remain release gates.",
    source: "API guide · envelope encryption · RELEASE-CHECKLIST",
  },
  {
    id: "error-codes",
    eyebrow: "Troubleshooting",
    title: "Error codes and retry behavior",
    intro: "Classify failures by HTTP status first, then separate retryable failures from requests that must be corrected.",
    endpoint: "400 · 401 · 403 · 404 · 409 · 429 · 503",
    steps: [
      { title: "Separate authentication from authorization", body: "401 means key or session authentication failed; 403 means role, scope, or 2FA restriction; 404 may preserve tenant isolation." },
      { title: "Correct conflicts before retrying", body: "409 signals duplicate, state, or journey-revision conflicts. Read the current resource before repeating a mutation." },
      { title: "Follow the retry contract", body: "Retry 429 after Retry-After. Retry /v1/track 503 with the same insert_id, within limits. Correct 400 and 409 requests first." },
    ],
    codeLabel: "Inspect an authentication error",
    code: `GET <API_BASE_URL>/v1/auth/me
# Without a Cookie, the API returns HTTP 401.`,
    note: "A 202 is not downstream completion. Do not assume every error has a request_id, and never attach keys, passwords, or push tokens to logs or support reports.",
    source: "API guide · rate-limit guard · ingestion service",
  },
  {
    id: "faq",
    eyebrow: "Troubleshooting",
    title: "Frequently asked questions",
    intro: "Most first-integration failures come from the wrong key type, asynchronous processing, rate limits, session/CORS handling, or datastore readiness.",
    endpoint: "Status · request_id · deployment and SDK versions",
    steps: [
      { title: "Why is data missing after a 202?", body: "A 202 confirms durable admission or queue publication. Analytics, provider delivery, and real-device receipt are separate stages." },
      { title: "Why does a browser management call return 401?", body: "Check the nudgeon_session cookie, exact CORS_ORIGIN, credentialed request, and SameSite and Secure conditions together." },
      { title: "What should a support report include?", body: "Share the timestamp, path, status, request_id, key type, and deployment or SDK version after removing secrets." },
    ],
    codeLabel: "Check readiness and session",
    code: `curl -i <API_BASE_URL>/readyz
curl -i -b cookies.txt <API_BASE_URL>/v1/auth/me`,
    note: "Never attach API keys, passwords, push tokens, or raw FCM or APNs credentials. Async APIs other than /track have no request-level deduplication guarantee.",
    source: "API guide · errors and troubleshooting",
  },
  {
    id: "debugging",
    eyebrow: "Troubleshooting",
    title: "Debugging guide",
    intro: "Narrow failures in order: service health, ingestion correlation, then message delivery.",
    endpoint: "/readyz → ingestion-errors → message-log → worker metrics",
    steps: [
      { title: "Check services and stores", body: "/healthz checks API-process liveness, while /readyz checks PostgreSQL and Redis connectivity." },
      { title: "Correlate ingestion", body: "Record the response request_id and timestamp, then compare endpoint, reason, and detail in data/ingestion-errors." },
      { title: "Separate each delivery stage", body: "Inspect message-log status and failure detail with worker JSON logs and /metrics. Provider and real-device receipt need separate verification." },
    ],
    codeLabel: "Read recent ingestion errors",
    code: `GET <API_BASE_URL>/v1/apps/<APP_ID>/data/ingestion-errors?limit=100
Cookie: nudgeon_session=<SESSION>`,
    note: "/readyz does not verify ClickHouse, APNs or FCM, or final device receipt. Redact customer data before sharing error payloads.",
    source: "health controller · data controller · message-log · worker metrics",
  },
  {
    id: "release-notes",
    eyebrow: "Releases & compatibility",
    title: "Separate unreleased alpha work from shipped releases",
    intro: "Features on the current working branch are source implementations, not a release until a v* tag and registry artifacts are verified.",
    endpoint: "git tag · GHCR release workflow",
    steps: [
      { title: "Do not call source work a release", body: "An unreleased branch may contain journey-channel or provider changes, but implementation alone is not shipment evidence." },
      { title: "Verify tags from the active checkout", body: "A package manifest version is insufficient; match a v* tag to the published image or package." },
      { title: "Record artifacts and verification scope", body: "The release workflow is configured for multi-architecture API, console, and worker images. Verify the actual registry result separately." },
    ],
    codeLabel: "Inspect current release evidence",
    code: `git describe --tags --always --dirty
git tag --list 'v*' --sort=-version:refname`,
    note: "A manifest version of 0.1.0 is not shipment evidence. Provider and customer E2E, SBOMs, image signing, and generated changelogs require separate verification.",
    source: "release workflow · package manifest · RELEASE-CHECKLIST",
  },
  {
    id: "compatibility",
    eyebrow: "Releases & compatibility",
    title: "Check toolchain, datastore, and journey-schema compatibility together",
    intro: "Treat build versions, Compose datastore versions, managed-service candidates, and the v1/v2 journey rollout order as one compatibility contract.",
    endpoint: "Node 22+ · pnpm 11.1.3 · Go 1.25 · PostgreSQL 16 · ClickHouse 24.8 · Redis 7",
    steps: [
      { title: "Match tool versions", body: "Development and CI require Node.js 22 or later, pnpm 11.1.3, and Go 1.25." },
      { title: "Check datastore versions", body: "The Compose stack uses PostgreSQL 16, ClickHouse 24.8, and Redis 7. Managed-service candidates are test targets, not a certified matrix." },
      { title: "Roll out journey v2 in order", body: "Deploy all compatible workers, then the API, enable the feature flag, and expose the console. Do not roll back to old workers after v2 executions exist." },
    ],
    codeLabel: "Check local tool versions",
    code: `node --version
pnpm --version
go version
docker compose version`,
    note: "APIs and schemas remain alpha. There is no certified matrix yet for managed databases, N-1 compatibility, minimum OS/package versions, or all four SDK clean installs and real-device delivery.",
    source: "package config · DEPLOY · JOURNEY-GRAPH · RELEASE-CHECKLIST",
  },
];

const documentOrder = [
  "concepts",
  "sdk-quickstart",
  "platform-guides",
  "push-permissions",
  "push-create",
  "journeys",
  "segments",
  "authentication",
  "push-api",
  "journey-api",
  "webhooks",
  "self-hosting",
  "operations",
  "security",
  "error-codes",
  "faq",
  "debugging",
  "release-notes",
  "compatibility",
];

function orderDocuments(supplemental, existing) {
  const byId = new Map([...supplemental, ...existing].map((document) => [document.id, document]));
  return documentOrder.map((id) => byId.get(id)).filter(Boolean);
}

export const documentContentByLanguage = {
  ko: orderDocuments(koDocuments, guideContentByLanguage.ko),
  en: orderDocuments(enDocuments, guideContentByLanguage.en),
};
