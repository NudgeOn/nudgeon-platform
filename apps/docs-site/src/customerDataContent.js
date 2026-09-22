const events = `sign_up             method
login               method
purchase_completed  order_id, total_amount, currency, item_count
product_viewed      product_id, price, currency
add_to_cart         product_id, quantity, price, currency
checkout_started    cart_id, item_count, total_amount, currency`;

const attributes = `first_name  "Minji"          last_name  "Kim"
email       "minji@example.com"
phone       "+821012345678"  // E.164
dob         "1995-03-15"     // YYYY-MM-DD
gender      "F"              // M, F, O, N, P, U
home_city   "Seoul"
country     "KR"             // ISO 3166-1 alpha-2
language    "ko"             // ISO 639-1
timezone    "Asia/Seoul"     // IANA
created_at  "2026-09-23T09:00:00+09:00" // RFC 3339`;

// Call after SDK initialization; these snippets run inside the app's login flow.
const sdkExamples = [
  { label: "iOS · Swift · SPM 0.2.8+", code: `import NudgeOnSDK

NudgeOn.identify(externalId: "customer-123")
NudgeOn.track(NudgeOnEvents.login, properties: ["method": "email"])
NudgeOn.setUserAttributes([
    NudgeOnAttributes.firstName: .string("Minji"),
    NudgeOnAttributes.dateOfBirth: .string("1995-03-15"),
    NudgeOnAttributes.country: .string("KR"),
    NudgeOnAttributes.timezone: .string("Asia/Seoul"),
    "membership_level": .string("gold")
])
NudgeOn.setUserAttributes([NudgeOnAttributes.phone: .null])` },
  { label: "Android · Kotlin · Maven Central 0.2.8+", code: `import io.nudgeon.sdk.NudgeOn
import io.nudgeon.sdk.NudgeOnEvents
import io.nudgeon.sdk.NudgeOnAttributes

NudgeOn.identify("customer-123")
NudgeOn.track(NudgeOnEvents.LOGIN, mapOf("method" to "email"))
NudgeOn.setUserAttributes(mapOf(
    NudgeOnAttributes.FIRST_NAME to "Minji",
    NudgeOnAttributes.DOB to "1995-03-15",
    NudgeOnAttributes.COUNTRY to "KR",
    NudgeOnAttributes.TIMEZONE to "Asia/Seoul",
    "membership_level" to "gold"
))
NudgeOn.setUserAttributes(mapOf(NudgeOnAttributes.PHONE to null))` },
  { label: "React Native · source / 0.1.3 candidate", code: `import NudgeOn, { NudgeOnEvents, NudgeOnAttributes } from '@nudgeon/react-native';

await NudgeOn.identify('customer-123');
await NudgeOn.track(NudgeOnEvents.login, { method: 'email' });
await NudgeOn.setUserAttributes({
  [NudgeOnAttributes.firstName]: 'Minji',
  [NudgeOnAttributes.dateOfBirth]: '1995-03-15',
  [NudgeOnAttributes.country]: 'KR',
  [NudgeOnAttributes.timezone]: 'Asia/Seoul',
  membership_level: 'gold',
});
await NudgeOn.setUserAttributes({ [NudgeOnAttributes.phone]: null });` },
  { label: "Flutter · source / 0.1.3 candidate", code: `import 'package:nudgeon_flutter/nudgeon_flutter.dart';

await NudgeOn.identify('customer-123');
await NudgeOn.track(NudgeOnEvents.login, properties: {'method': 'email'});
await NudgeOn.setUserAttributes({
  NudgeOnAttributes.firstName: 'Minji',
  NudgeOnAttributes.dateOfBirth: '1995-03-15',
  NudgeOnAttributes.country: 'KR',
  NudgeOnAttributes.timezone: 'Asia/Seoul',
  'membership_level': 'gold',
});
await NudgeOn.setUserAttributes({NudgeOnAttributes.phone: null});` },
];
const links = [
  { label: "API · events / attributes", href: "https://github.com/NudgeOn/nudgeon-platform/blob/main/docs-public/API.md" },
  ...["ios", "android", "rn", "flutter"].map(platform => ({ label: `${platform} SDK · README`, href: `https://github.com/NudgeOn/nudgeon-${platform}-sdk#readme` })),
];

export const customerDataContent = {
  ko: {
    id: "events-attributes", eyebrow: "SDK 연동 · 고객 데이터", title: "기본 이벤트와 사용자 속성",
    intro: "행동은 track, 프로필은 setUserAttributes로 보냅니다. 6개 기본 이벤트와 11개 기본 속성을 네 SDK에서 같은 이름으로 사용하며, 커스텀 이름도 유지할 수 있습니다.",
    endpoint: "initialize → identify → track / setUserAttributes",
    steps: [
      { title: "버전과 초기화를 확인합니다", body: "iOS SPM·Android Maven Central 0.2.8을 사용하세요. 이벤트 상수는 0.2.7부터, 속성 상수는 0.2.8부터 제공합니다. React Native·Flutter 0.1.3은 소스에 반영됐지만 npm·pub.dev 공개 게시 전입니다. 각 README의 소스 설치 절차를 따르세요. 아래 코드는 SDK 시작하기의 초기화를 마친 앱에서 호출합니다." },
      { title: "식별 후 실제 행동을 전송합니다", body: "로그인 성공 후 안정적인 external_id로 identify하고 login을 track합니다. 가입은 sign_up, 결제 성공은 purchase_completed를 사용합니다. 권장 속성은 필수 스키마가 아니며 금액은 통화 기본 단위의 숫자(12900 KRW, 12.99 USD), currency는 ISO 4217 코드입니다. 상수나 콘솔 목록만으로 자동 수집되지 않고, 기존 purchase 이름도 자동 변환되지 않습니다." },
      { title: "프로필을 갱신하고 필요하면 해제합니다", body: "이름·연락처·생일·도시·국가·언어·시간대·서비스 가입일을 설정합니다. 아래 형식은 권장 규칙입니다. created_at은 서비스 가입 시각이며 NudgeOn 내부 생성 시각과 별개입니다. dob는 문자열로 반복 생일 저니를 자동 생성하지 않습니다. Braze time_zone은 timezone으로 명시적으로 매핑하세요. null은 삭제, 생략한 키는 유지이며 커스텀 속성을 함께 보낼 수 있습니다." },
      { title: "콘솔에서 실제 수집을 검증합니다", body: "데이터 → 이벤트에서 이름과 예시를, 속성 탭에서 기본 목록·수집된 속성 사전을 확인하세요. 테스트 고객의 프로필과 최근 이벤트를 확인한 뒤 세그먼트·저니의 선택기를 사용합니다. 서버 배치는 sk_ Server Key로 POST /v1/users/attributes를 사용하고 키를 앱에 넣지 마세요." },
    ],
    examples: [{ label: "기본 이벤트 · 권장 properties", code: events }, { label: "기본 속성 · 권장 값 형식", code: attributes }, ...sdkExamples],
    note: "identify 전 익명 속성 설정과 속성 요청의 영속 오프라인 재시도는 지원하지 않습니다. 앱에서 필요한 재동기화를 구현하세요. push_subscribe·email_subscribe 속성은 수신 동의를 바꾸지 않습니다. 푸시 동의에는 setPushSubscription을 사용하세요. Android의 null 전송 수정도 0.2.8에 포함됩니다.",
    source: "event-catalog · attribute-catalog · SDK README · API", links,
  },
  en: {
    id: "events-attributes", eyebrow: "SDK integration · Customer data", title: "Standard events and user attributes",
    intro: "Send actions with track and profile values with setUserAttributes. Six standard events and eleven profile keys share the same wire names across all four SDKs. Custom names remain supported.",
    endpoint: "initialize → identify → track / setUserAttributes",
    steps: [
      { title: "Check versions and initialize first", body: "Use iOS SPM or Android Maven Central 0.2.8. Event constants require 0.2.7+ and attribute constants require 0.2.8+. React Native and Flutter 0.1.3 include these changes in source; npm and pub.dev publication is pending. Follow each README for source installation. Run the snippets below after completing SDK quickstart initialization." },
      { title: "Identify the customer and send real actions", body: "After a successful login, identify a stable external_id and track login. Use sign_up for registration and purchase_completed for a successful purchase. Properties are recommendations, not a required schema. Monetary values are numeric base currency units (12900 KRW, 12.99 USD); currency uses ISO 4217. Constants and console presets do not collect events automatically or rename an existing purchase event." },
      { title: "Update or remove profile values", body: "Set names, contact details, birth date, city, country, language, timezone and signup time using the recommended formats below. created_at is your service signup timestamp, separate from NudgeOn’s internal creation time. dob is a string and does not create recurring birthday journeys. Explicitly map Braze time_zone to timezone. null removes a value, omitted keys remain unchanged, and custom attributes can be sent alongside standard keys." },
      { title: "Verify collection in the console", body: "Open Data → Events for names and examples, then Attributes for standard keys and the collected dictionary. Verify a test customer’s profile and recent events before selecting conditions in segments or journeys. Server batches use POST /v1/users/attributes with an sk_ Server Key; never embed that key in an app." },
    ],
    examples: [{ label: "Standard events · recommended properties", code: events }, { label: "Standard attributes · recommended value formats", code: attributes }, ...sdkExamples],
    note: "Anonymous attribute updates before identify and durable offline retries for attribute requests are not supported. Resynchronize from your app as needed. push_subscribe and email_subscribe attributes do not change consent; use setPushSubscription for push consent. Android’s null serialization fix is included in 0.2.8.",
    source: "event-catalog · attribute-catalog · SDK README · API", links,
  },
};
