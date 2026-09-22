export const customerDataGuide = {
  ko: {
    id: 'customer-data', nav: '이벤트와 사용자 속성', title: '행동과 프로필을 같은 이름으로 연결합니다.',
    intro: '이벤트는 고객이 한 행동, 사용자 속성은 고객의 현재 프로필입니다. 개발 담당자와 이름·값·전송 시점을 정한 뒤 콘솔에서 실제 수집을 확인하세요.',
    where: '데이터 → 이벤트 · 속성 · 유저 검색',
    steps: [
      ['6개 기본 이벤트를 확인하세요', '이벤트 탭에서 sign_up(회원가입), login(로그인), purchase_completed(구입), product_viewed(상품 조회), add_to_cart(장바구니 담기), checkout_started(결제 시작)를 선택하세요. 권장 속성과 JSON 예시를 복사해 개발 담당자에게 전달할 수 있습니다. 구입에는 order_id·total_amount·currency·item_count를 함께 보내는 것을 권장합니다.'],
      ['11개 기본 속성을 확인하세요', '속성 탭에는 first_name·last_name·email·phone·dob·gender·home_city·country·language·timezone·created_at이 준비돼 있습니다. 생일은 1995-03-15, 국가는 KR, 언어는 ko, 시간대는 Asia/Seoul처럼 값을 맞춥니다. created_at은 우리 서비스 가입일입니다. 수집된 속성 사전과 수집 오류도 함께 확인하세요.'],
      ['테스트 고객으로 조건을 확인하세요', '프로필에 country = KR이 표시되는지, 최근 이벤트에 purchase_completed가 들어왔는지 확인하세요. 세그먼트의 행동·속성 조건과 저니의 진입·전환·분기·이벤트 대기에서 기본 이름을 선택할 수 있습니다. membership_level 같은 커스텀 속성과 기존 이벤트도 직접 입력할 수 있습니다.'],
    ],
    check: '테스트 고객의 실제 이벤트와 속성 값이 보이고, 개발 담당자와 합의한 이름으로 세그먼트·저니 조건을 구성했습니다.',
    note: '기본 목록은 자동 수집을 뜻하지 않습니다. 앱에서 식별 후 전송해야 하며 기존 purchase 이벤트는 자동으로 이름이 바뀌지 않습니다. 속성에 null을 보내면 값이 삭제됩니다. 프로필 속성과 푸시 수신 동의는 별도로 관리합니다. 생일 속성만으로 매년 생일 저니가 자동 실행되지는 않습니다.',
    links: [['네 SDK 이벤트·속성 연동', 'events-attributes'], ['세그먼트', 'segments'], ['저니', 'journeys']],
  },
  en: {
    id: 'customer-data', nav: 'Events and attributes', title: 'Connect actions and profiles with shared names.',
    intro: 'Events describe what a customer did; attributes describe their current profile. Agree on names, values and sending moments with your developer, then verify actual collection in the console.',
    where: 'Data → Events · Attributes · User search',
    steps: [
      ['Explore six standard events', 'Select sign_up, login, purchase_completed, product_viewed, add_to_cart or checkout_started in Events. Copy the recommended properties and JSON example for your developer. For a completed purchase, include order_id, total_amount, currency and item_count.'],
      ['Explore eleven standard attributes', 'Attributes lists first_name, last_name, email, phone, dob, gender, home_city, country, language, timezone and created_at. Agree on values such as 1995-03-15 for birth date, KR for country, ko for language and Asia/Seoul for timezone. created_at is the signup date in your service. Check the collected dictionary and collection errors too.'],
      ['Check conditions against a test customer', 'Confirm country = KR in the profile and purchase_completed in recent events. Choose standard names in segment event and attribute conditions, and journey entry, conversion, branches and event waits. You can also type custom attributes such as membership_level and existing event names.'],
    ],
    check: 'Actual events and attribute values appear for your test customer, and segment or journey conditions use the names agreed with your developer.',
    note: 'Presets do not collect data automatically: your app must identify the customer and send it. Existing purchase events are not renamed. Sending null removes an attribute. Profile values and push consent are managed separately. A birth date alone does not schedule an annual birthday journey.',
    links: [['Events and attributes in all four SDKs', 'events-attributes'], ['Segments', 'segments'], ['Journeys', 'journeys']],
  },
};
