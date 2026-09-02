# NudgeOn API 가이드

NudgeOn를 처음 연동하는 개발자와 셀프호스팅 운영자를 위한 문서입니다. 고객 앱과 고객사 서버에서 이벤트·고객·디바이스 정보를 보내는 **Integration API**부터, 콘솔에서 사용하는 **Management API**까지 현재 제공되는 경로를 한곳에 정리했습니다.

> **Alpha · 2026-09-01 코드 기준**<br>
> 이 문서는 현재 저장소의 API 컨트롤러와 스키마를 대조해 작성했습니다. API와 스키마는 아직 예고 없이 변경될 수 있으며, 실제 고객 발송에 필요한 복구·SDK·운영 검증은 진행 중입니다. 먼저 개발·스테이징 환경에서 연동하고, 운영 전에는 [출시 체크리스트](RELEASE-CHECKLIST.md)를 확인하세요.

## 무엇부터 보면 되나요?

원하는 작업에 따라 아래 순서로 읽으면 됩니다.

| 하려는 일 | 먼저 볼 곳 |
| --- | --- |
| 앱에서 행동 이벤트를 보내고 싶어요 | [처음 연동하기](#처음-연동하기) → [Integration API 계약](#integration-api-계약) |
| 앱의 푸시 토큰을 등록하고 싶어요 | [푸시 토큰 등록](#4-푸시-토큰-등록) |
| 백엔드에서 고객 속성을 갱신하고 싶어요 | [고객 식별과 속성 갱신](#3-고객-식별과-속성-갱신) |
| 셀프호스팅을 처음 설정하고 싶어요 | [계정과 세션](#계정과-세션) → [배포 가이드](DEPLOY.md) |
| 콘솔용 API와 권한을 찾고 있어요 | [Management API 전체 목록](#management-api-전체-목록) |
| 요청이 실패했어요 | [자주 막히는 부분](#자주-막히는-부분) → [오류 형식](#오류-형식) |

처음 연동한다면 다음 다섯 단계만 먼저 완료하세요.

1. NudgeOn API를 실행하고 `/readyz` 결과를 확인합니다.
2. 가입 또는 최초 셋업 응답에서 `app_id`, SDK Key, Server Key를 보관합니다.
3. 고유한 `insert_id`로 첫 이벤트를 전송합니다.
4. 앱에서 고객 식별과 푸시 토큰을 등록합니다.
5. 콘솔에서 수집 상태를 확인한 뒤 테스트 푸시를 보냅니다.

## 자주 쓰는 식별자

| 이름 | 누가 정하나요? | 용도 | 예시 |
| --- | --- | --- | --- |
| `app_id` | NudgeOn | NudgeOn 안에서 앱을 구분 | 가입·셋업 응답의 UUID |
| `external_id` | 고객사 | 로그인 고객을 구분하는 변경되지 않는 ID | 회원 번호 `customer-123` |
| `anon_id` | 고객 앱 | 로그인 전 익명 고객을 구분 | 앱이 생성한 UUID |
| `device_id` | 고객 앱 | 앱 설치 단위 디바이스를 구분 | 설치 시 생성해 보관한 UUID |
| `insert_id` | 이벤트 발신자 | 이벤트 중복 처리를 막음 | 이벤트마다 새 UUID |
| `request_id` | NudgeOn | 접수 결과와 서버 로그를 연결 | API 응답의 UUID |

`external_id`에는 이메일이나 전화번호처럼 바뀌거나 민감한 값보다 서비스 내부 회원 ID를 권장합니다. 같은 이벤트를 재시도할 때는 새 `insert_id`를 만들지 말고 최초 값을 그대로 사용하세요.

## 처음 연동하기

### 준비물

- 실행 중인 NudgeOn API 주소
- 가입 또는 최초 셋업에서 받은 `app_id`
- 고객 앱용 SDK Key (`pk_...`)
- 고객사 백엔드용 Server Key (`sk_...`)

아직 키가 없다면 멀티테넌트 모드는 [`POST /v1/auth/signup`](#멀티테넌트-모드-가입), 셀프호스팅은 [`POST /v1/bootstrap/setup`](#셀프호스팅-최초-설정)부터 진행하세요. 키 원문은 발급 응답에서 한 번만 보이므로 안전한 비밀 저장소에 바로 보관해야 합니다.

어떤 키를 써야 할지 헷갈리면 다음 기준을 사용하세요.

| 요청이 실행되는 곳 | 사용할 키 | 가능한 작업 |
| --- | --- | --- |
| iOS·Android·React Native·Flutter 앱 | SDK Key | 이벤트, identify, 푸시 토큰 등록 |
| 고객사 백엔드·서버 배치 | Server Key | 이벤트, identify, 고객 속성 일괄 갱신·삭제 |
| NudgeOn 콘솔·관리 도구 | 로그인 세션 | 앱·키·세그먼트·저니·조직 관리 |

Server Key를 모바일 앱이나 브라우저 번들에 넣으면 안 됩니다.

### 환경 변수 준비

셀프호스팅 기본 API 주소는 `http://localhost:8080`입니다. 다른 환경에서는 배포한 API의 HTTPS 주소로 바꾸세요.

```bash
export NUDGEON_API_URL="http://localhost:8080"
export NUDGEON_APP_ID="REPLACE_WITH_APP_ID"
export NUDGEON_SDK_KEY="pk_REPLACE_ME"
export NUDGEON_SERVER_KEY="sk_REPLACE_ME"
```

모든 JSON 요청은 다음 헤더를 사용합니다.

```http
Content-Type: application/json
Authorization: Bearer <api-key>
```

API 키는 `X-Api-Key: <api-key>`로도 보낼 수 있습니다. 브라우저 URL, 쿼리 문자열, 로그에는 키를 넣지 마세요.

### 1. 서버 상태 확인

```bash
curl -sS "$NUDGEON_API_URL/healthz"
```

```json
{
  "ok": true
}
```

`/healthz`는 API 프로세스가 살아 있는지만 확인합니다. 실제 연동을 시작하기 전에는 PostgreSQL과 Redis 연결까지 확인하는 `/readyz`도 호출하세요.

```bash
curl -sS "$NUDGEON_API_URL/readyz"
```

```json
{
  "ok": true,
  "postgres": true,
  "redis": true
}
```

세 값 중 하나라도 `false`이면 이벤트를 보내기 전에 해당 저장소 연결부터 복구해야 합니다.

### 2. 이벤트 전송

아래 예시는 로그인한 고객이 상품을 본 이벤트 한 건을 보냅니다. `insert_id`는 이벤트마다 새 UUID를 생성하고, 같은 이벤트를 재시도할 때는 동일한 값을 유지해야 합니다. `anon_id` 또는 `external_id` 중 하나는 반드시 포함해야 합니다.

```bash
curl -sS -X POST "$NUDGEON_API_URL/v1/track" \
  -H "Authorization: Bearer $NUDGEON_SDK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "batch": [
      {
        "insert_id": "d81ac6cd-bf59-4d8c-bf91-9e35ed95a53e",
        "external_id": "customer-123",
        "event": "Product Viewed",
        "properties": {
          "product_id": "sku-42",
          "price": 19000
        },
        "client_ts": "2026-09-01T10:30:00+09:00"
      }
    ],
    "device": {
      "device_id": "1d3e9e8b-7596-45e1-94b0-308bdf8b0925",
      "platform": "ios",
      "app_version": "1.2.0",
      "os_version": "26.0",
      "locale": "ko-KR"
    }
  }'
```

성공 응답은 `202 Accepted`입니다.

```json
{
  "accepted": 1,
  "request_id": "067de6d0-47e2-4f28-bf23-eef06c88698c"
}
```

`accepted`는 이번 요청에서 받아들인 이벤트 수이고, `request_id`는 문제를 추적할 때 사용하는 접수 번호입니다. 운영 로그나 지원 요청에는 API Key 대신 이 값을 남기세요.

`202`는 이벤트 접수 기록(receipt)과 전달 작업(outbox)이 PostgreSQL 트랜잭션에 저장됐다는 뜻입니다. 분석 화면 반영, 저니 실행, 푸시 발송 완료를 뜻하지는 않습니다. 저장 전 실패하면 `503`이 반환되며, 같은 `insert_id`로 재시도할 수 있습니다. 중복 `insert_id`는 최초 접수 순서를 유지합니다.

로그인 후 다음 경로를 호출하면 앱에 반영된 누적 이벤트 수와 마지막 이벤트 시각을 확인할 수 있습니다. 분석 저장소 반영은 비동기이므로 `202` 직후에는 잠시 기다려야 할 수 있습니다.

```bash
curl -sS -b cookies.txt \
  "$NUDGEON_API_URL/v1/apps/$NUDGEON_APP_ID/ingest-status"
```

### 3. 고객 식별과 속성 갱신

SDK Key 또는 Server Key로 익명 고객을 로그인 고객과 연결하고 속성을 갱신합니다. 일반적으로 로그인 성공 직후 한 번 호출하고, 계정이 바뀌면 새 `external_id`로 다시 호출합니다. 속성 값이 `null`이면 해당 속성을 해제합니다.

```bash
curl -sS -X POST "$NUDGEON_API_URL/v1/identify" \
  -H "Authorization: Bearer $NUDGEON_SDK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "external_id": "customer-123",
    "anon_id": "0d32f22f-ad64-410d-8512-9e9df1178db7",
    "attributes": {
      "email": "customer@example.com",
      "plan": "pro"
    }
  }'
```

```json
{
  "request_id": "07b44296-bb73-4c5e-a47c-cb83425f128d"
}
```

`external_id`는 고객사 서비스에서 같은 회원을 계속 가리키는 ID여야 합니다. `anon_id`를 함께 보내면 로그인 전 익명 활동과 로그인 고객을 연결할 수 있습니다.

서버에서 여러 고객의 속성을 한 번에 갱신할 때는 Server Key를 사용합니다.

```bash
curl -sS -X POST "$NUDGEON_API_URL/v1/users/attributes" \
  -H "Authorization: Bearer $NUDGEON_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "updates": [
      {
        "external_id": "customer-123",
        "attributes": {
          "plan": "enterprise",
          "churn_risk": null
        }
      }
    ]
  }'
```

```json
{
  "accepted": 1,
  "request_id": "468d7aa7-85aa-4948-a240-54c7e6872145"
}
```

### 4. 푸시 토큰 등록

푸시 토큰 등록은 SDK Key만 허용합니다. 앱이 APNs 또는 FCM에서 새 토큰을 받았을 때, 권한이나 로그인 고객이 바뀌었을 때 다시 호출하세요. `anon_id` 또는 `external_id` 중 하나를 반드시 포함해야 합니다.

```bash
curl -sS -X POST "$NUDGEON_API_URL/v1/devices/token" \
  -H "Authorization: Bearer $NUDGEON_SDK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "device": {
      "device_id": "1d3e9e8b-7596-45e1-94b0-308bdf8b0925",
      "platform": "ios",
      "app_version": "1.2.0",
      "os_version": "26.0",
      "model": "iPhone",
      "locale": "ko-KR"
    },
    "push_token": "REPLACE_WITH_PROVIDER_TOKEN",
    "os_permission": "granted",
    "external_id": "customer-123"
  }'
```

`push_token`은 NudgeOn API Key가 아니라 APNs 또는 FCM이 앱에 발급한 토큰입니다. `device_id`는 같은 앱 설치에서 안정적으로 유지하고, 앱 삭제 후 재설치처럼 새로운 설치라면 새 UUID를 사용하세요.

`os_permission`의 표준값은 `granted`, `denied`, `undetermined`입니다. iOS 원시값 `authorized`, `provisional`, `ephemeral`, `notDetermined`도 서버에서 표준값으로 정규화합니다. 토큰 등록 성공은 NudgeOn가 정보를 접수했다는 뜻이며 실제 푸시 수신 성공을 뜻하지 않습니다.

### 5. 첫 테스트 푸시 보내기

다음 조건이 준비된 뒤 콘솔 세션으로 테스트 푸시를 요청할 수 있습니다.

- 대상 고객의 `external_id`가 identify로 등록됨
- 대상 디바이스의 푸시 토큰 상태가 active이고 OS 권한이 `granted`
- 해당 앱의 FCM 또는 APNs credential이 등록됨
- 로그인한 멤버가 Editor 이상

아직 `cookies.txt`가 없다면 먼저 [로그인과 관리 API 호출](#로그인과-관리-api-호출)의 로그인 예제를 실행하세요.

```bash
curl -sS -b cookies.txt -X POST \
  "$NUDGEON_API_URL/v1/apps/$NUDGEON_APP_ID/test-push" \
  -H "Content-Type: application/json" \
  -d '{
    "external_id": "customer-123",
    "title": "NudgeOn 연동 테스트",
    "body": "첫 번째 푸시가 도착했습니다."
  }'
```

```json
{
  "queued": 1,
  "test_run_id": "a9ae0e49-28d0-4d19-ac73-ab131d401711"
}
```

`queued`는 발송 큐에 넣은 디바이스 수입니다. 이 응답만으로 APNs·FCM 전달이나 실제 디바이스 수신을 확인할 수는 없습니다. 개발 단계에서는 디바이스 수신과 message log를 함께 확인하세요.

## 인증 방식

| 인증 | 용도 | 전달 방법 |
| --- | --- | --- |
| 없음 | 상태 확인, 가입, 로그인, 최초 셀프호스팅 설정 | 인증 헤더 없음 |
| SDK Key (`pk_`) | 고객 앱의 이벤트·식별·푸시 토큰 등록 | `Authorization: Bearer ...` 또는 `X-Api-Key` |
| Server Key (`sk_`) | 신뢰할 수 있는 고객사 서버의 이벤트·식별·속성 갱신·고객 삭제 | `Authorization: Bearer ...` 또는 `X-Api-Key` |
| 세션 쿠키 | 콘솔과 관리 API | `nudgeon_session` HttpOnly 쿠키 |

SDK Key는 앱 바이너리에 포함될 수 있는 수집용 키입니다. Server Key는 고객사 백엔드에서만 보관해야 하며 모바일·웹 클라이언트에 포함하면 안 됩니다.

API Key에는 `full`과 `ingest_only` 스코프가 있습니다. 현재 개인정보 삭제는 `Server Key + full`만 허용합니다. 허용하지 않는 키 종류는 `401`, 부족한 스코프는 `403`을 반환합니다.

가입·최초 셋업·키 발급·회전 응답의 키 원문은 한 번만 노출됩니다. 이후 키 목록은 prefix만 반환합니다.

## Integration API 계약

### 공통 제한

- 요청 본문: 최대 1 MB
- `/v1/track` 배치: 1~100개
- `/v1/users/attributes` 배치: 1~100개
- `external_id`: 1~256자
- 이벤트 이름: 1~128자
- 커스텀 속성 키: 1~128자
- 커스텀 속성 값: JSON 직렬화 기준 최대 1 KB, `null`은 unset
- `device_id`, `insert_id`, `anon_id`: UUID
- `client_ts`: UTC offset을 포함한 ISO 8601 시각
- `platform`: `ios` 또는 `android`
- 스키마에 정의되지 않은 필드는 `400`으로 거부

### 엔드포인트

| Method | Path | 인증 | 성공 | 설명 |
| --- | --- | --- | --- | --- |
| `POST` | `/v1/track` | SDK / Server | `202` | 이벤트 1~100개 접수 |
| `POST` | `/v1/identify` | SDK / Server | `202` | 고객 식별과 속성 갱신 |
| `POST` | `/v1/users/attributes` | Server | `202` | 서버사이드 속성 일괄 갱신 |
| `POST` | `/v1/devices/token` | SDK | `202` | 디바이스 푸시 토큰 등록·갱신 |
| `DELETE` | `/v1/users/{externalId}` | Server + `full` | `202` | 고객 개인정보 삭제 작업 접수 |

고객 삭제 요청 예시:

```bash
curl -sS -X DELETE \
  "$NUDGEON_API_URL/v1/users/customer-123" \
  -H "Authorization: Bearer $NUDGEON_SERVER_KEY"
```

```json
{
  "request_id": "ce6924a8-c89e-4c96-bf95-3e4b587d123d"
}
```

`externalId`가 URL 경로에 들어가므로 예약문자가 있다면 URL encoding이 필요합니다.

### 접수와 재시도

| API | `202`의 의미 | 공개된 중복 제거 계약 |
| --- | --- | --- |
| `/v1/track` | PostgreSQL receipt + outbox 커밋 완료 | `insert_id` 기준. `503`에는 동일 ID로 재시도 |
| 나머지 Integration API | ingest 큐 발행 완료 | 현재 요청 단위 idempotency key 계약 없음 |

`/v1/track` 외 API는 알파 단계에서 정확히 한 번 처리나 요청 단위 중복 제거를 보장하지 않습니다. 네트워크 단절로 결과를 알 수 없을 때 무한 재시도하지 말고, 제한된 백오프와 서버 상태 대사를 함께 사용하세요.

### Rate limit

Integration API에는 테넌트, API Key, SDK 디바이스의 계층별 token bucket이 적용됩니다. 기본값은 다음과 같으며 운영자가 환경변수로 변경할 수 있습니다.

| 계층 | 기본 지속 한도 | 기본 burst |
| --- | ---: | ---: |
| Tenant | 1,000 req/s | 2,000 |
| API Key | 500 req/s | 1,000 |
| SDK Device | 20 req/s | 40 |

응답에는 `X-RateLimit-Limit`, `X-RateLimit-Remaining`이 포함됩니다. 초과하면 `429`와 `Retry-After`가 반환됩니다.

```json
{
  "statusCode": 429,
  "message": "rate limit 초과 (device 계층)",
  "retry_after": 1
}
```

## 계정과 세션

### 멀티테넌트 모드 가입

직접 배포한 `MODE=multi_tenant` 환경에서는 가입 시 테넌트, Owner, 기본 앱, SDK Key, Server Key를 함께 생성하고 `nudgeon_session` 쿠키를 발급합니다. 이 API가 존재한다는 것이 NudgeOn 관리형 Cloud의 공개 가입이 열렸다는 뜻은 아닙니다.

```bash
curl -sS -c cookies.txt -X POST "$NUDGEON_API_URL/v1/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@example.com",
    "password": "REPLACE_WITH_A_STRONG_PASSWORD",
    "name": "Owner",
    "tenant_name": "Example Inc."
  }'
```

```json
{
  "tenant_id": "<uuid>",
  "app_id": "<uuid>",
  "sdk_key": "pk_...",
  "server_key": "sk_..."
}
```

키 원문은 이 응답에서만 확인할 수 있으므로 비밀 저장소에 즉시 보관하세요.

### 셀프호스팅 최초 설정

`MODE=single_tenant`에서는 콘솔이 먼저 설정 상태를 확인합니다.

> **현재 알파 보안 경계:** 아래 Bootstrap mutation은 아직 일회용 설치 소유권 claim을 요구하지 않는다. 최초 Owner를 만들기 전에는 API를 인터넷에 공개하지 않는다. 안전한 claim과 중단 복구를 포함한 목표 계약은 [P0 Docker Setup Wizard PRD](DOCKER-SETUP-WIZARD-PRD.md)에 있으며 현재 API 동작으로 간주하지 않는다.

```bash
curl -sS "$NUDGEON_API_URL/v1/bootstrap/status"
```

`needs_setup: true`이면 최초 한 번만 `POST /v1/bootstrap/setup`을 호출합니다. 요청 필드는 `email`, `password`, `name`이며 응답은 가입 응답과 동일합니다. 설정을 마치면 이 경로는 `409`로 잠깁니다. 자세한 설치 절차는 [배포 가이드](DEPLOY.md)를 참고하세요.

### 로그인과 관리 API 호출

```bash
curl -sS -c cookies.txt -X POST "$NUDGEON_API_URL/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@example.com",
    "password": "REPLACE_WITH_YOUR_PASSWORD"
  }'

curl -sS -b cookies.txt "$NUDGEON_API_URL/v1/auth/me"
```

2FA가 활성화된 계정은 첫 로그인 응답으로 `{"totp_required":true}`를 받을 수 있습니다. 같은 로그인 요청에 `totp`을 추가해 다시 호출하세요. 조직에서 2FA를 강제했지만 아직 등록하지 않은 계정은 `{"enrollment_required":true}`와 제한된 세션을 받으며, 등록 완료 전에는 `/v1/auth/totp/*` 외 관리 API가 `403`을 반환합니다.

프로덕션의 `nudgeon_session` 쿠키는 HttpOnly, Secure, SameSite=Lax로 설정됩니다. 브라우저에서 다른 origin의 API를 호출할 때는 허용된 CORS origin과 credentials 설정이 필요합니다.

## Management API 전체 목록

Management API의 모든 앱 경로는 세션의 테넌트에 묶입니다. 다른 테넌트의 앱이나 리소스는 보통 `404`로 처리해 존재 여부를 노출하지 않습니다.

역할은 `Owner`, `Admin`, `Editor`, `Viewer` 네 가지입니다. 아래 표에서 `Session`은 로그인한 역할 모두, `Editor+`는 Owner/Admin/Editor, `Admin+`는 Owner/Admin, `Owner`는 Owner만을 뜻합니다.

### 상태·인증·조직

| Method | Path | 인증/역할 | 성공 | 설명 |
| --- | --- | --- | --- | --- |
| `GET` | `/healthz` | 없음 | `200` | API liveness |
| `GET` | `/readyz` | 없음 | `200` | PostgreSQL·Redis readiness 결과 |
| `GET` | `/v1/bootstrap/status` | 없음 | `200` | single/multi tenant 모드와 초기 설정 상태 |
| `POST` | `/v1/bootstrap/setup` | 없음·최초 1회 | `201` | 셀프호스팅 Owner·앱·키 생성 |
| `POST` | `/v1/auth/signup` | 없음 | `201` | 멀티테넌트 가입과 기본 리소스 생성 |
| `POST` | `/v1/auth/login` | 없음 | `200` | 로그인·세션 발급 |
| `POST` | `/v1/auth/logout` | 선택적 세션 | `200` | 세션 폐기·쿠키 제거 |
| `GET` | `/v1/auth/me` | Session | `200` | 현재 멤버와 permissions 조회 |
| `GET` | `/v1/auth/totp/status` | Session | `200` | 본인 2FA 상태 |
| `POST` | `/v1/auth/totp/enroll` | Session | `200` | TOTP secret·otpauth URI 1회 발급 |
| `POST` | `/v1/auth/totp/enroll/verify` | Session | `200` | 등록 확인·백업 코드 1회 발급 |
| `POST` | `/v1/auth/totp/disable` | Session | `200` | 코드 재인증 후 본인 2FA 해제 |
| `POST` | `/v1/members/{memberId}/totp/reset` | Admin+ | `200` | 멤버 2FA 관리자 리셋 |
| `GET` | `/v1/tenant` | Session | `200` | 조직 이름·2FA·삭제 유예 상태 |
| `PUT` | `/v1/tenant/security` | Admin+ | `200` | 조직 2FA 강제 설정 |
| `DELETE` | `/v1/tenant` | Owner | `202` | 7일 유예 삭제 요청 |
| `POST` | `/v1/tenant/restore` | Owner | `200` | 유예 기간 삭제 요청 취소 |
| `GET` | `/v1/audit` | Admin+ | `200` | 최근 감사 로그. `limit` 기본 100, 최대 500 |

### 앱·키·발송 설정

| Method | Path | 인증/역할 | 성공 | 설명 |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/apps` | Session | `200` | 테넌트 앱 목록 |
| `GET` | `/v1/apps/{appId}/keys` | Admin+ | `200` | 키 prefix·종류·상태 목록 |
| `POST` | `/v1/apps/{appId}/keys` | Admin+ | `201` | Server Key 추가 발급·원문 1회 반환 |
| `POST` | `/v1/apps/{appId}/keys/{keyId}/rotate` | Admin+ | `201` | SDK Key 회전, 구키 30일 유예 |
| `DELETE` | `/v1/apps/{appId}/keys/{keyId}` | Admin+ | `200` | 키 즉시 폐기 |
| `GET` | `/v1/apps/{appId}/ingest-status` | Session | `200` | 누적 이벤트 수·최근 이벤트 시각 |
| `GET` | `/v1/apps/{appId}/settings` | Session | `200` | 시간대·조용시간·빈도 제한 설정 |
| `PUT` | `/v1/apps/{appId}/settings` | Admin+ | `200` | 발송 설정 변경 |
| `GET` | `/v1/apps/{appId}/credentials` | Session | `200` | 채널 credential 상태·메타데이터 (푸시·이메일) |
| `PUT` | `/v1/apps/{appId}/credentials` | Admin+ | `200` | 채널 credential 등록·교체 |
| `DELETE` | `/v1/apps/{appId}/credentials/{kind}` | Admin+ | `200` | credential 삭제 |
| `POST` | `/v1/apps/{appId}/test-push` | Editor+ | `202` | 고객의 발송 가능 디바이스에 테스트 푸시 큐잉 |
| `POST` | `/v1/apps/{appId}/test-email` | Editor+ | `202` | 템플릿/인라인 HTML을 치환 후 테스트 이메일 큐잉 (`provider` 선택 가능) |
| `POST` | `/v1/webhooks/resend/{appId}` | Svix 서명 | `200` | Resend 이벤트 웹훅 → 발송 수명주기(message.lifecycle) 반영 |

Credential 원문은 목록 API에서 반환하지 않습니다. 등록 직후 상태는 `unverified`이며 channel worker가 비동기로 검증합니다. `kind`는 `push_fcm`, `push_apns`, `email_smtp`, `email_nhn`, `email_resend` 중 하나이며, 이메일 `kind`는 저니 이메일 노드·테스트 이메일의 `provider` 값과 같습니다 (미지정 시 최근 검증된 이메일 발송기로 발송).

Resend(API) credential 등록 본문:

```json
{
  "kind": "email_resend",
  "api_key": "re_xxxxxxxx",
  "from_email": "noreply@yourdomain.com",
  "from_name": "NudgeOn",
  "webhook_secret": "whsec_xxxxxxxx"
}
```

- `webhook_secret`(선택)은 Resend 대시보드 → Webhooks에서 엔드포인트를 만들 때 발급되는 Signing secret입니다. 등록하지 않으면 웹훅은 `401`로 거부됩니다.
- Resend를 SMTP로 쓰려면 `email_smtp`에 `host: smtp.resend.com`, `port: 465`, `security: tls`, `username: resend`, `password: <API 키>`를 등록하면 됩니다 (이 경우 웹훅 리포트는 연결되지 않습니다).

#### Resend 웹훅 (`POST /v1/webhooks/resend/{appId}`)

Resend 대시보드에 `{API_URL}/v1/webhooks/resend/{appId}`를 엔드포인트로 등록하고 `email.sent`, `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`, `email.failed` 이벤트를 켜세요.

- **인증**: 세션·API 키가 아니라 Svix 서명입니다. `svix-id`, `svix-timestamp`, `svix-signature` 헤더와 요청 본문 원문으로 HMAC-SHA256을 검증하며, 타임스탬프가 현재 시각과 300초 이상 차이 나면 거부합니다. 서명 실패·credential 없음·`webhook_secret` 미등록은 `401`입니다.
- **message_id 해석**: 발송 시 실은 태그 `nudgeon_message_id`(객체·배열 형식 모두 허용)를 우선 사용하고, 없으면 `message_log.provider_message_id`(Resend email id)로 역조회합니다. 해석 실패는 `200 {"accepted": false, "reason": "message_id_unresolved"}`로 응답합니다 (4xx면 Resend가 무한 재시도).
- **이벤트 매핑**: `email.sent→sent`, `email.delivered→delivered`, `email.opened→opened`, `email.clicked→clicked`(`click_ref`=링크), `email.bounced→bounced`(`failure_class=invalid_target`), `email.complained→unsubscribed`(`failure_detail=complained`), `email.failed→failed`(`failure_class=permanent_content`). `email.delivery_delayed` 등 그 외 타입은 `200 {"accepted": false, "ignored": "<type>"}`.
- **멱등성**: Resend가 재시도해 같은 이벤트가 여러 번 도착해도 ClickHouse `message_lifecycle`(ReplacingMergeTree)이 `(message_id, status, occurred_at)` 기준으로 중복을 제거합니다.
- 반영된 수명주기는 `GET /v1/apps/{appId}/journeys/{id}/delivery`의 `delivered`/`opened`/`clicked`/`bounced`에 SDK 이벤트와 합산(중복 제거)되어 나타납니다.

테스트 푸시 요청:

```json
{
  "external_id": "customer-123",
  "title": "테스트 알림",
  "body": "NudgeOn 연결을 확인합니다."
}
```

성공하면 `202`와 함께 `queued`, `test_run_id`를 반환합니다. 이는 공급자 전송이나 디바이스 수신 완료가 아니라 큐 등록 완료입니다.

### 고객·데이터·메시지·분석

| Method | Path | 인증/역할 | 성공 | 설명 |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/apps/{appId}/users` | Session | `200` | `q`로 `external_id` 또는 email 완전 일치 검색, 최대 20개 |
| `GET` | `/v1/apps/{appId}/users/{id}` | Session | `200` | 고객·디바이스·이벤트·메시지·저니 상세 |
| `GET` | `/v1/apps/{appId}/data/ingestion-errors` | Session | `200` | 수집 오류. `limit` 기본 100, 최대 500 |
| `GET` | `/v1/apps/{appId}/data/attributes` | Session | `200` | 속성 사전과 세그먼트 참조 수 |
| `DELETE` | `/v1/apps/{appId}/data/attributes/{key}` | Editor+ | `200` | 속성 삭제. 참조 시 `force=true` 필요 |
| `GET` | `/v1/apps/{appId}/message-log` | Session | `200` | 발송 로그와 최근 1시간 실패율 |
| `GET` | `/v1/apps/{appId}/dashboard` | Session | `200` | 대시보드 집계 |
| `GET` | `/v1/apps/{appId}/usage` | Session | `200` | 현재 월 사용량 |
| `GET` | `/v1/apps/{appId}/journeys/{id}/report` | Session | `200` | 저니 버전별 실행·발송 리포트 |

메시지 로그는 `status`, `journey_id`, `limit` 쿼리를 지원하며 `limit`은 기본 100, 최대 500입니다. 저니 리포트의 `version` 쿼리를 생략하면 호환성을 위해 전체 버전 상태·발송 합계를 반환합니다.

### 세그먼트

| Method | Path | 인증/역할 | 성공 | 설명 |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/apps/{appId}/segments` | Session | `200` | 세그먼트 목록 |
| `GET` | `/v1/apps/{appId}/segments/{id}` | Session | `200` | 세그먼트 정의 조회 |
| `POST` | `/v1/apps/{appId}/segments` | Editor+ | `201` | 세그먼트 생성 |
| `PATCH` | `/v1/apps/{appId}/segments/{id}` | Editor+ | `200` | 세그먼트 변경 |
| `DELETE` | `/v1/apps/{appId}/segments/{id}` | Editor+ | `200` | 세그먼트 삭제 |
| `POST` | `/v1/apps/{appId}/segments/preview` | Session | `201` | 근사 고객 수와 최대 10명 샘플 |

세그먼트 정의는 Segment DSL v1을 사용합니다. 미리보기의 고객 수는 ClickHouse `uniqCombined` 근사값이며 동일 조건은 60초 동안 캐시됩니다.

### 저니

| Method | Path | 인증/역할 | 성공 | 설명 |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/apps/{appId}/journeys` | Session | `200` | 저니 목록과 런타임 capability |
| `GET` | `/v1/apps/{appId}/journeys/{id}` | Session | `200` | 초안·revision·공개 A/B 정보 |
| `POST` | `/v1/apps/{appId}/journeys` | Editor+ | `201` | 초안 생성 |
| `PATCH` | `/v1/apps/{appId}/journeys/{id}` | Editor+ | `200` | draft/paused 초안 변경 |
| `POST` | `/v1/apps/{appId}/journeys/{id}/validate` | Session | `201` | 활성화 전 검증·예상 대상 수·revision |
| `POST` | `/v1/apps/{appId}/journeys/{id}/activate` | Editor+ | `201` | 검증 후 불변 버전 공개 |
| `POST` | `/v1/apps/{appId}/journeys/{id}/pause` | Editor+ | `201` | active 저니 일시정지 |
| `DELETE` | `/v1/apps/{appId}/journeys/{id}` | Editor+ | `200` | 저니 보관·진행 실행 종료 |

그래프 v2 활성화 요청에는 직전 validate 응답의 `revision`이 필요합니다. 초안이 바뀌면 `409`가 반환되므로 다시 검증해야 합니다. 노드·edge·A/B 불변 조건과 실행 의미는 [저니 그래프 v2](JOURNEY-GRAPH.md)에 정리돼 있습니다.

## 자주 막히는 부분

문제가 생기면 HTTP 상태 코드와 `message`부터 확인하세요. 아래 항목에서 대부분의 초기 연동 문제를 찾을 수 있습니다.

| 증상 | 먼저 확인할 것 | 해결 방법 |
| --- | --- | --- |
| `401 API 키가 필요합니다` | 인증 헤더가 빠졌는지 | `Authorization: Bearer <key>`를 추가 |
| `401 허용되지 않는 키 종류` | SDK Key와 Server Key를 바꿔 쓰지 않았는지 | 토큰 등록은 SDK Key, 속성 일괄 갱신은 Server Key 사용 |
| `400`과 필드 오류 | UUID 형식, `client_ts` 시간대, 알 수 없는 필드 | 요청을 스키마와 비교하고 정의되지 않은 필드 제거 |
| `403 enrollment_required` | 조직 2FA 강제 정책 | `/v1/auth/totp/enroll` 흐름을 먼저 완료 |
| `202`인데 콘솔에 바로 보이지 않음 | 비동기 worker와 분석 저장소 반영 시간 | 잠시 뒤 ingest status와 worker 상태 확인 |
| 테스트 푸시가 `400` | active 토큰과 `granted` 권한 디바이스 존재 여부 | identify·토큰 등록·OS 권한을 다시 확인 |
| 브라우저 관리 API가 `401` | 쿠키와 CORS credentials 전달 여부 | 로그인 응답 쿠키를 보관하고 credentials 포함 |
| `429` | `Retry-After` 응답 헤더 | 지정된 시간 뒤 지수 백오프로 재시도 |
| `/readyz`의 일부가 `false` | PostgreSQL 또는 Redis 연결 | API 환경변수·네트워크·저장소 상태 확인 |

문제를 재현해 공유할 때는 다음 정보가 유용합니다.

- 요청 경로와 HTTP 상태 코드
- 응답의 `request_id`와 `message`
- 발생 시각과 사용한 키 종류(SDK/Server). 키 원문은 제외
- SDK 플랫폼과 버전, API 배포 버전

API Key, 푸시 토큰, 비밀번호, FCM 서비스 계정, APNs p8 원문은 GitHub Issue나 로그에 올리지 마세요.

## 오류 형식

오류는 HTTP 상태 코드와 JSON 본문으로 반환됩니다. `message`는 단일 문자열이거나 필드별 검증 객체일 수 있습니다.

```json
{
  "statusCode": 400,
  "message": "요청을 처리할 수 없습니다",
  "error": "Bad Request"
}
```

| 상태 | 의미 |
| ---: | --- |
| `400` | JSON 스키마·UUID·상태 전환·업무 규칙 오류 |
| `401` | API Key 또는 세션이 없거나 유효하지 않음 |
| `403` | 역할·권한·API Key scope 부족, 또는 2FA 등록 필요 |
| `404` | 리소스 없음. 다른 테넌트 리소스도 보통 404 |
| `409` | 중복 가입, 최초 설정 잠금, 저니 revision·상태 충돌 |
| `413` | 요청 본문 1 MB 초과 |
| `429` | Rate limit 초과. `Retry-After` 확인 |
| `503` | `/v1/track` durable receipt 저장 실패 |

지원 요청이나 로그 대사에는 응답의 `request_id`를 사용하세요. 비밀 키, 푸시 토큰, credential 원문은 로그나 이슈에 첨부하지 마세요.

## 계약 소스와 현재 제한

- [OpenAPI 3.1 스키마](../packages/openapi/openapi.yaml)는 Integration API와 저니 계약의 기계 판독 가능한 일부를 제공합니다.
- 현재 OpenAPI는 이 문서의 전체 Management API를 아직 포함하지 않습니다. 생성 클라이언트와 drift CI가 완성되기 전까지 실제 컨트롤러와 입력 스키마가 현재 구현의 기준입니다.
- [푸시 페이로드 공통 계약](PUSH-CONTRACT.md)은 worker와 각 SDK가 맞춰야 할 `message_id`·플랫폼 직렬화 형식을 설명합니다.
- [출시 체크리스트](RELEASE-CHECKLIST.md)의 실공급자, 실기기, 장애 복구, 부하, 보안 게이트가 닫히기 전에는 공개 고객 발송의 운영 보장을 선언하지 않습니다.
