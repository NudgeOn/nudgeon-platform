const koGuides = [
  {
    id: "push-create",
    eyebrow: "푸시 만들기",
    title: "테스트 푸시로 발송 경로를 먼저 확인하세요",
    intro:
      "일반 캠페인을 시작하기 전에 식별된 고객 한 명을 대상으로 토큰, 권한, 공급자 credential, 메시지 로그까지 한 번에 점검합니다.",
    endpoint: "POST /v1/apps/<APP_ID>/test-push",
    steps: [
      {
        title: "대상 고객과 기기를 준비합니다",
        body: "external_id가 identify로 등록되어 있고, 디바이스 토큰이 active이며 OS 푸시 권한이 granted인지 확인합니다.",
      },
      {
        title: "발송 credential을 확인합니다",
        body: "앱에 FCM 또는 APNs credential이 등록되어 있어야 합니다. 등록 직후의 unverified 상태는 비동기 검증이 끝날 때까지 기다립니다.",
      },
      {
        title: "큐 등록 이후를 따로 검증합니다",
        body: "Editor 이상 권한의 콘솔 세션으로 테스트를 요청한 뒤 메시지 로그, APNs·FCM 전달, 실제 기기 수신과 열기를 각각 확인합니다.",
      },
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
    note: "202 응답의 queued는 발송 큐에 들어간 디바이스 수입니다. 공급자 전달이나 실제 기기 수신 성공을 뜻하지 않습니다. 세그먼트 대상 단발 발송은 1노드 blast 저니로 구성합니다.",
    source: "API 가이드 · 앱·키·발송 설정",
  },
  {
    id: "journeys",
    eyebrow: "저니(시나리오)",
    title: "초안 → 검증 → 활성화 순서로 배포하세요",
    intro:
      "저니는 메시지, 대기, 조건 분기, 이벤트 대기, A/B 분기를 연결합니다. 활성화된 버전은 불변이며 진행 중인 고객은 진입한 버전을 끝까지 실행합니다.",
    endpoint: "POST /v1/apps/<APP_ID>/journeys",
    steps: [
      {
        title: "편집 가능한 초안을 만듭니다",
        body: "Editor 이상 권한으로 저니 이름과 definition을 저장합니다. draft 또는 paused 상태에서만 초안을 변경할 수 있습니다.",
      },
      {
        title: "활성화 직전에 검증합니다",
        body: "validate 응답의 issues와 예상 대상 수를 확인하고 revision을 보관합니다. 그래프 v2는 이 revision이 필수입니다.",
      },
      {
        title: "같은 revision으로 활성화합니다",
        body: "검증 후 초안이 바뀌면 409가 반환됩니다. 다시 검증한 뒤 새 revision으로 활성화하고 버전별 리포트를 확인합니다.",
      },
    ],
    codeLabel: "그래프 v2 초안 예시",
    code: `POST <API_BASE_URL>/v1/apps/<APP_ID>/journeys
Cookie: nudgeon_session=<SESSION>
Content-Type: application/json

{
  "name": "상품 조회 후 혜택 안내",
  "definition": {
    "schema_version": 2,
    "entry": {
      "type": "trigger",
      "trigger_event": "product_viewed"
    },
    "start_node_id": "offer",
    "nodes": [{
      "id": "offer",
      "type": "message",
      "push": {
        "title": "혜택이 도착했습니다",
        "body": "지금 앱에서 확인해 보세요."
      }
    }],
    "edges": [{
      "id": "offer-end",
      "source": "offer",
      "source_port": "next",
      "target": null
    }],
    "exit": {},
    "settings": {
      "category": "marketing",
      "reentry": "never"
    }
  }
}`,
    note: "그래프 v2 활성화 요청에는 직전 validate 응답의 revision을 그대로 전달해야 합니다. 활성 버전의 진행 고객을 다른 버전으로 옮기지 않습니다.",
    source: "저니 그래프 v2 · 정의와 호환성",
  },
  {
    id: "segments",
    eyebrow: "세그먼트",
    title: "조건을 미리보기한 뒤 발송 대상을 저장하세요",
    intro:
      "Segment DSL v1의 고객 속성, 이벤트 행동, 채널 도달 가능성, 기기 버전 조건을 AND·OR 그룹으로 조합합니다.",
    endpoint: "POST /v1/apps/<APP_ID>/segments/preview",
    steps: [
      {
        title: "작은 조건부터 구성합니다",
        body: "속성 이름과 연산자를 명시하고, 여러 조건은 그룹 안과 그룹 사이의 AND·OR 관계를 구분합니다.",
      },
      {
        title: "미리보기로 대상을 확인합니다",
        body: "세션 인증으로 근사 고객 수와 최대 10명의 샘플을 확인합니다. 같은 조건의 결과는 60초 동안 캐시됩니다.",
      },
      {
        title: "검토한 definition을 저장합니다",
        body: "Editor 이상 권한으로 세그먼트를 생성한 뒤 저니의 blast 진입 대상에 연결합니다. 미리보기 수치는 근사값입니다.",
      },
    ],
    codeLabel: "세그먼트 미리보기",
    code: `POST <API_BASE_URL>/v1/apps/<APP_ID>/segments/preview
Cookie: nudgeon_session=<SESSION>
Content-Type: application/json

{
  "category": "marketing",
  "definition": {
    "version": 1,
    "operator": "AND",
    "groups": [{
      "operator": "AND",
      "conditions": [
        {
          "type": "attribute",
          "key": "country",
          "op": "eq",
          "value": "KR"
        },
        {
          "type": "channel",
          "op": "push_reachable"
        }
      ]
    }]
  }
}`,
    note: "approx_count는 ClickHouse 근사 집계입니다. 발송 직전에는 세그먼트 상태와 현재 대상 정책을 다시 확인하세요.",
    source: "API 가이드 · 세그먼트",
  },
];

const enGuides = [
  {
    id: "push-create",
    eyebrow: "Create a push",
    title: "Verify the delivery path with a test push first",
    intro:
      "Before launching a campaign, use one identified customer to verify the token, permission, provider credential, and message log end to end.",
    endpoint: "POST /v1/apps/<APP_ID>/test-push",
    steps: [
      {
        title: "Prepare the customer and device",
        body: "Confirm that external_id was registered through identify, the device token is active, and the OS push permission is granted.",
      },
      {
        title: "Check the delivery credential",
        body: "The app needs an FCM or APNs credential. A newly registered credential remains unverified until asynchronous validation finishes.",
      },
      {
        title: "Verify each stage after queueing",
        body: "Request the test with an Editor-or-higher console session, then check the message log, APNs or FCM delivery, and real-device receipt and open separately.",
      },
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
    note: "queued in a 202 response is the number of devices admitted to the send queue. It does not confirm provider delivery or real-device receipt. Model a one-off segment send as a one-node blast journey.",
    source: "API guide · App, key, and delivery settings",
  },
  {
    id: "journeys",
    eyebrow: "Journeys",
    title: "Publish in draft → validate → activate order",
    intro:
      "A journey connects messages, delays, conditional branches, event waits, and A/B splits. Activated versions are immutable, and each customer finishes the version they entered.",
    endpoint: "POST /v1/apps/<APP_ID>/journeys",
    steps: [
      {
        title: "Create an editable draft",
        body: "Save a journey name and definition with Editor-or-higher access. A draft can only be changed while its journey is draft or paused.",
      },
      {
        title: "Validate immediately before activation",
        body: "Review issues and the estimated audience from validate, then keep its revision. Graph v2 activation requires that revision.",
      },
      {
        title: "Activate the same revision",
        body: "If the draft changes after validation, the API returns 409. Validate again, activate the new revision, and inspect reports by immutable version.",
      },
    ],
    codeLabel: "Graph v2 draft example",
    code: `POST <API_BASE_URL>/v1/apps/<APP_ID>/journeys
Cookie: nudgeon_session=<SESSION>
Content-Type: application/json

{
  "name": "Offer after product view",
  "definition": {
    "schema_version": 2,
    "entry": {
      "type": "trigger",
      "trigger_event": "product_viewed"
    },
    "start_node_id": "offer",
    "nodes": [{
      "id": "offer",
      "type": "message",
      "push": {
        "title": "Your offer is ready",
        "body": "Open the app to see it now."
      }
    }],
    "edges": [{
      "id": "offer-end",
      "source": "offer",
      "source_port": "next",
      "target": null
    }],
    "exit": {},
    "settings": {
      "category": "marketing",
      "reentry": "never"
    }
  }
}`,
    note: "Pass the exact revision returned by the latest validate call when activating graph v2. Customers in an active version are not moved to another version.",
    source: "Journey graph v2 · Definition and compatibility",
  },
  {
    id: "segments",
    eyebrow: "Segments",
    title: "Preview conditions before saving an audience",
    intro:
      "Segment DSL v1 combines customer attributes, event behavior, channel reachability, and device-version conditions in AND and OR groups.",
    endpoint: "POST /v1/apps/<APP_ID>/segments/preview",
    steps: [
      {
        title: "Start with a small condition set",
        body: "Name each attribute and operator explicitly, and distinguish the AND or OR relationship inside a group from the relationship between groups.",
      },
      {
        title: "Preview the audience",
        body: "Use a console session to inspect the approximate count and up to ten samples. Results for the same condition are cached for 60 seconds.",
      },
      {
        title: "Save the reviewed definition",
        body: "Create the segment with Editor-or-higher access, then use it as the blast entry audience for a journey. Preview counts are approximate.",
      },
    ],
    codeLabel: "Segment preview",
    code: `POST <API_BASE_URL>/v1/apps/<APP_ID>/segments/preview
Cookie: nudgeon_session=<SESSION>
Content-Type: application/json

{
  "category": "marketing",
  "definition": {
    "version": 1,
    "operator": "AND",
    "groups": [{
      "operator": "AND",
      "conditions": [
        {
          "type": "attribute",
          "key": "country",
          "op": "eq",
          "value": "KR"
        },
        {
          "type": "channel",
          "op": "push_reachable"
        }
      ]
    }]
  }
}`,
    note: "approx_count is a ClickHouse approximate aggregate. Recheck the segment status and current audience policy immediately before sending.",
    source: "API guide · Segments",
  },
];

export const guideContentByLanguage = {
  ko: koGuides,
  en: enGuides,
};
