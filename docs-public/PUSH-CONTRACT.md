# Onda 푸시 페이로드 공통 계약 (R-01)

발송(worker)과 4개 SDK(iOS·Android·RN·Flutter)가 공유하는 **단일 계약**. worker가 이 형태로 방출하고,
각 SDK의 `PushPayload.parse`가 이 형태를 읽는다. 재시도해도 `message_id`는 불변(발송 시점 1회 생성).

## 논리 필드
| 필드 | 필수 | 의미 |
|---|---|---|
| `message_id` | ✅ | 발송 안정 ID. `message_log.message_id`·SDK 도달/오픈 이벤트를 잇는 조인 키. 없으면 "Onda 메시지 아님"으로 SDK가 무시(타 SDK 공존) |
| `title` / `body` | ✅ | 알림 제목·본문 |
| `deep_link` | — | 오픈 시 라우팅할 딥링크 |
| `image_url` | — | 리치 알림 이미지(iOS NSE 첨부) |
| `campaign_id` / `journey_id` | — | 소속 캠페인·저니 |
| `data` | — | 사용자 커스텀 속성(문자열 맵) |

## 전송별 직렬화 (플랫폼 특성상 형태가 다름 — 논리 계약은 동일)

### FCM (Android) — 평면 `data` 문자열 맵, **data-only(알림 블록 없음)**
`onMessageReceived`가 항상 호출돼 SDK가 `message_id` 포착·자동 표시. Android SDK: `PushPayload.parse(data)`.
```json
{ "message": {
    "token": "<device_token>",
    "android": { "priority": "high" },
    "data": {
      "message_id": "<uuid>",
      "title": "제목", "body": "본문",
      "deep_link": "myapp://x",
      "image_url": "https://.../i.png",
      "data": "{\"k\":\"v\"}"
    }
} }
```

### APNs (iOS) — `aps.alert` + 중첩 `onda` 오브젝트, `mutable-content:1`(NSE)
iOS SDK: `PushPayload.parse(userInfo)` (`userInfo["onda"]["message_id"]`). NSE는 `onda.image_url` 첨부·`onda.message_id` 도달 보고.
```json
{ "aps": { "alert": { "title": "제목", "body": "본문" }, "mutable-content": 1 },
  "onda": {
    "message_id": "<uuid>",
    "deep_link": "myapp://x",
    "image_url": "https://.../i.png",
    "campaign_id": "<uuid>", "journey_id": "<uuid>",
    "data": { "k": "v" }
  } }
```

## 검증 지점
- **worker**: `apps/worker/internal/channel/fcm.go:fcmData` / `apns.go:apnsPayload` — 골든 테스트
  `channel/worker_test.go:TestPushContractPayloads`.
- **iOS**: `onda-ios-sdk` `PushPayload.parse` + `OndaSDKTests.PushPayloadTests`(위 APNs fixture와 동일).
- **Android**: `onda-android-sdk` `PushPayload.parse`(위 FCM data 키와 동일).
- **RN/Flutter**: 네이티브 `PushPayload`를 브리지로 노출(`messageId`/`deepLink`/`data`) — 네이티브 계약을 따른다.

## 계약 이력
- 2026-09-01 (R-01): worker가 이전에 FCM `data["onda.message_id"]`·APNs 최상위 `"onda.message_id"`(둘 다
  SDK와 불일치)를 방출하던 것을 위 계약으로 정정. deep_link를 저니 노드→발송에 연결. iOS/worker 골든 테스트 통과.
  SDK 파서는 이미 본 계약대로 작성돼 있어 코드 변경 불필요(worker측 결함이었음).
