# NudgeOn 푸시 페이로드 공통 계약 (R-01)

발송(worker)과 4개 SDK(iOS·Android·RN·Flutter)가 공유하는 **단일 계약**. worker가 이 형태로 방출하고,
각 SDK의 `PushPayload.parse`가 이 형태를 읽는다. 재시도해도 `message_id`는 불변(발송 시점 1회 생성).
**계약 버전: 2026-09-10 (SDK 0.1.2 이상).**

## 논리 필드
| 필드 | 필수 | worker 방출 | 의미 |
|---|---|---|---|
| `message_id` | ✅ | 항상 | 발송 안정 ID. `message_log.message_id`·SDK 도달/오픈 이벤트를 잇는 조인 키. 없으면 "NudgeOn 메시지 아님"으로 SDK가 무시(타 SDK 공존). 같은 ID 재수신은 SDK가 접는다(서버 at-least-once 창) |
| `title` / `body` | ✅ | 항상(무음 제외) | 알림 제목·본문 |
| `journey_id` | — | 저니 발송일 때 | 소속 저니. SDK가 `$push_received`/`$push_opened` 속성에 실어 보낸다. 테스트 발송·수동 발송은 키 자체가 없다 |
| `deep_link` | — | 있을 때 | 오픈 시 라우팅할 딥링크 |
| `image_url` | — | 있을 때 | 리치 알림 이미지. iOS는 NSE가 첨부, Android는 SDK가 BigPicture로 그린다. `PushPayload.imageUrl`로 앱에도 노출 |
| `data` | — | 있을 때 | 사용자 커스텀 속성(문자열 맵) |
| `silent` | — | 무음 푸시일 때 | 사용자 미노출 백그라운드 푸시(앱 삭제 감지 ping). SDK는 표시·이벤트·리스너 없이 소비한다 |
| `campaign_id` | — | **방출 안 함(예약)** | SDK는 파싱하지만 현재 캠페인 엔티티가 없어 항상 비어 있다 |

## 전송별 직렬화 (플랫폼 특성상 형태가 다름 — 논리 계약은 동일)

### FCM (Android) — 평면 `data` 문자열 맵, **data-only(알림 블록 없음)**
data-only라 OS가 알림을 만들지 않는다. `onMessageReceived`가 항상 호출되고 **Android SDK가 알림을 그린다**
(`NudgeOnConfig.autoDisplayNotifications`, 기본 true — 제목·본문·큰 이미지·탭 시 앱 진입). 앱이 직접 그리려면 false로 두고
`onPushReceived` 리스너에서 그린다. 탭은 `NudgeOn.handleLaunchIntent(intent)`가 `$push_opened`·`onPushOpened`로 잇는다.
```json
{ "message": {
    "token": "<device_token>",
    "android": { "priority": "high" },
    "data": {
      "message_id": "<uuid>",
      "journey_id": "<uuid>",
      "title": "제목", "body": "본문",
      "deep_link": "myapp://x",
      "image_url": "https://.../i.png",
      "data": "{\"k\":\"v\"}"
    }
} }
```
무음: `data`에 `"silent": "1"`만 더 있고 `title`/`body`가 없다.

### APNs (iOS) — `aps.alert` + 중첩 `nudgeon` 오브젝트, `mutable-content:1`(NSE)
iOS SDK: `PushPayload.parse(userInfo)` (`userInfo["nudgeon"]["message_id"]`). NSE는 `nudgeon.image_url` 첨부·`nudgeon.message_id` 도달 보고.
헤더 `apns-id`·`apns-collapse-id` = `message_id` (재전송이 단말에서 하나로 접힌다).
```json
{ "aps": { "alert": { "title": "제목", "body": "본문" }, "mutable-content": 1 },
  "nudgeon": {
    "message_id": "<uuid>",
    "journey_id": "<uuid>",
    "deep_link": "myapp://x",
    "image_url": "https://.../i.png",
    "data": { "k": "v" }
  } }
```
무음: `{ "aps": { "content-available": 1 }, "nudgeon": { "message_id": "<uuid>" } }` — alert·mutable-content 없음, 헤더 `apns-push-type: background`.
iOS SDK는 `content-available`이 있고 alert이 없으면 `silent=true`로 본다.

### 브리지 (RN·Flutter)
네이티브 `PushPayload`를 그대로 직렬화한다: `messageId`, `journeyId?`, `campaignId?`, `title`, `body`, `deepLink?`, `imageUrl?`, `data`, `silent`.
무음 푸시는 네이티브가 소비하므로 브리지 리스너에는 오지 않는다(`silent`는 형태 대칭용).

## 검증 지점
- **worker**: `apps/worker/internal/channel/fcm.go:fcmData` / `apns.go:apnsPayload` — 골든 테스트
  `channel/worker_test.go:TestPushContractPayloads` (일반·journey_id 없음·무음 세 케이스).
- **iOS**: `nudgeon-ios-sdk` `PushPayload.parse` + `PushPayloadTests`(위 APNs fixture·무음), `SeenMessagesTests`(중복 접기·무음 소비).
- **Android**: `nudgeon-android-sdk` `PushPayload.parse` + `PushPayloadTest`(image_url·silent·journey_id), 표시는 `PushNotifications`(에뮬레이터 확인 09-10).
- **RN/Flutter**: 브리지 직렬화 테스트(`index.test.ts`, `nudgeon_flutter_test.dart`).

## 계약 이력
- 2026-09-10 (SDK 0.1.2): 문서와 구현 대조에서 네 가지 어긋남 정정 — (1) worker가 `journey_id`를 방출하지 않던 것 추가,
  (2) `image_url`을 Android SDK가 버리던 것 → BigPicture 표시 + 4 SDK `PushPayload.imageUrl`, (3) 무음(`silent`) 푸시를 문서화하고
  iOS `PushPayload.silent` 추가, (4) "Android 자동 표시"가 실제로는 앱 책임이던 것 → SDK가 표시(`autoDisplayNotifications`).
  `campaign_id`는 예약으로 명시. RN/Flutter Android 브리지의 존재하지 않는 좌표 `io.nudgeon:nudgeon-android` → `nudgeon-sdk` 정정.
- 2026-09-01 (R-01): worker가 이전에 FCM `data["nudgeon.message_id"]`·APNs 최상위 `"nudgeon.message_id"`(둘 다
  SDK와 불일치)를 방출하던 것을 위 계약으로 정정. deep_link를 저니 노드→발송에 연결. iOS/worker 골든 테스트 통과.
