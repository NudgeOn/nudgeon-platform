# 첫 실기기 푸시 런북 — 크리덴셜 등록 → 발송 → 수신 → 열기 → 리포트 대사

목표: **실제 단말에서 NudgeOn 푸시 1건을 받고 탭해서, 도달/오픈 리포트에 같은 `message_id`로 잡히는 것**을 확인한다.
이것이 베타 선언의 하드 게이트(G0)이며, 성공하면 `docs/dev` Go/No-Go 원장의 IT-3·IT-8·M-1을 Go로 올린다.

전제: 샘플앱(iOS `nudgeon-ios-sdk/Examples/NudgeOnDemo`, Android `nudgeon-android-sdk/sample-app`)이 빌드된다. 소요 시간은 크리덴셜이 준비돼 있으면 약 1시간.

## 0. 준비물

| 항목 | 어디서 | 비고 |
|---|---|---|
| FCM 서비스 계정 JSON | Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 | HTTP v1 API. `project_id`·`client_email`·`private_key` 포함 |
| `google-services.json` | Firebase 콘솔 → Android 앱 추가 (패키지명 = 샘플앱 applicationId) | Android 샘플앱에만 필요 |
| APNs 인증 키 `.p8` + Key ID + Team ID | Apple Developer → Keys → APNs 활성화 | Bundle ID = 샘플앱 번들 ID. 개발 빌드는 `environment: sandbox` |
| 실단말 | iPhone(iOS 15+), Android(13+ 권장 — 알림 권한 팝업 검증) | B-2는 실제 단말의 수신 증거를 기록. 모의 콜백 기록과 구분 |
| NudgeOn 실행 환경 | `docker compose … --profile full --profile app up -d` | 단말에서 접근 가능한 API 주소 필요 (아래 1단계) |

## 1. NudgeOn를 단말이 닿는 주소로 띄우기

단말은 `localhost`에 못 닿는다. 같은 Wi-Fi의 Mac IP 또는 터널을 쓴다.

```bash
# Mac IP 확인 후 deploy/.env 에 반영 (콘솔 번들은 빌드 시점에 API 주소를 인라인하므로 --build 필수)
ipconfig getifaddr en0                          # 예: 192.168.0.10
sed -i '' 's#NEXT_PUBLIC_API_URL=.*#NEXT_PUBLIC_API_URL=http://192.168.0.10:8080#' deploy/.env
docker compose -f deploy/compose.yaml --env-file deploy/.env --profile full --profile app up -d --build
```

iOS는 HTTP 평문 접근에 ATS 예외가 필요하다. 샘플앱 Info.plist에 `NSAllowsLocalNetworking`(또는 개발용 `NSAllowsArbitraryLoads`)이 있는지 확인한다. 외부 네트워크면 `cloudflared tunnel --url http://localhost:8080` 같은 HTTPS 터널이 더 간단하다.

## 2. 콘솔에서 앱·키·크리덴셜 등록

1. 권장 설치는 [Safe Boot 위자드](DEPLOY.md)의 DB 설정 → 관리자 계정 생성 → 로그인 → 선택형 OTP 순서다. 대시보드에서 온보딩을 열고 **`app_id`와 SDK Key(`pk_…`)** 를 준비한다. Safe Boot 단일 테넌트에서는 `/signup`을 사용하지 않는다. 공개 가입은 `MODE=multi_tenant`에서만 제공한다.
2. `/onboarding` 위저드에서 FCM 서비스 계정 JSON과 APNs p8·Key ID·Team ID·Bundle ID를 등록한다. API로 직접 하려면:

```bash
# 세션 쿠키는 로그인 응답의 nudgeon_session. Owner/Admin만 가능.
curl -X PUT http://<host>:8080/v1/apps/<app_id>/credentials \
  -H 'Content-Type: application/json' -b 'nudgeon_session=<cookie>' \
  -d '{"kind":"push_fcm","service_account": <서비스계정 JSON 그대로>}'

curl -X PUT http://<host>:8080/v1/apps/<app_id>/credentials \
  -H 'Content-Type: application/json' -b 'nudgeon_session=<cookie>' \
  -d '{"kind":"push_apns","p8":"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----","key_id":"ABC123DEFG","team_id":"TEAM123456","bundle_id":"io.nudgeon.demo","environment":"sandbox"}'
```

3. `GET /v1/apps/<app_id>/credentials` 에서 `status`가 `unverified` → **`verified`** 로 바뀌는지 확인한다. 채널 워커가 비동기로 실검증한다(C-1). `error`면 `status_detail`을 읽는다 — 대부분 잘못된 Bundle ID·sandbox/production 불일치·서비스 계정 권한 문제다.

## 3. 샘플앱 설정·설치

- **iOS**: `Examples/NudgeOnDemo`의 설정(스킴 환경 변수 또는 `project.yml`의 Info.plist 설정)에 `NUDGEON_SDK_KEY=pk_…`, `NUDGEON_API_HOST=http://<host>:8080`. 서명 팀·Bundle ID를 APNs 키에 등록한 값과 맞추고 **Push Notifications capability**와 NSE 타깃의 App Group을 확인한 뒤 실기기에 설치.
- **Android**: `sample-app/google-services.json` 배치, `local.properties`(gitignore)에 `nudgeon.sdkKey=pk_…`, `nudgeon.apiHost=http://<host>:8080`. `./gradlew :sample-app:installDebug`.

앱을 열고 **알림 권한 허용**을 진행한다. 로컬 device_id·푸시 토큰 표시만으로 서버 등록 성공을 판단하지 않는다. 콘솔 `/users` 에서 해당 사용자를 찾아 `token_status=active`, `os_permission=granted`인지 확인한다.

샘플앱에서 `identify("<external_id>")`를 호출해 두면(버튼 제공) 다음 단계의 테스트 발송 대상이 된다.

## 4. 테스트 발송

콘솔 온보딩에서 고객 ID로 기기를 조회한 뒤 발송 가능한 한 대를 선택한다. API로 조회하려면 `GET /v1/apps/<app_id>/test-push-targets?external_id=<URL encoded ID>`의 `eligible: true` 기기를 사용한다. `device_id`를 생략하면 해당 고객의 여러 기기를 대상으로 할 수 있으므로 단일 기기 시험에서는 명시한다.

```bash
curl -X POST http://<host>:8080/v1/apps/<app_id>/test-push \
  -H 'Content-Type: application/json' -b 'nudgeon_session=<cookie>' \
  -H 'Idempotency-Key: <이번 요청의 UUID>' \
  -d '{"external_id":"<샘플앱에서 identify한 값>","device_id":"<선택한 서버 device UUID>","title":"NudgeOn 실기기 1호","body":"이 알림을 탭하세요"}'
# → 202 {"state":"accepted","queued":1,"test_run_id":"…","messages":[…],…}
```

`queued`는 영속 접수 건수이며 Redis 발행·공급자 전달 완료를 뜻하지 않는다. 대상 없음/조건 불충족은 400이다. 응답 유실 시 같은 본문과 같은 `Idempotency-Key`로 접수 결과를 다시 확인한다. 같은 키로 본문을 바꾸면 409이며 새 발송이 필요할 때만 새 UUID를 만든다. 최근 이력은 `GET /v1/apps/<app_id>/test-push-runs`에서 확인한다.

## 5. 수신 → 열기 → 대사

1. 단말에 알림이 뜬다. iOS는 NSE 실행 경로에서 `nudgeon.message_id`를 읽어 **`$push_delivered`** 를 보고한다. 백그라운드·종료 상태는 각각 확인하고, 실제 기기 수신과 SDK 보고 도착을 별도로 기록한다. Android는 `onMessageReceived`에서 표시와 동시에 보고한다.
2. 알림을 **탭**한다 → 앱이 열리며 **`$push_opened`** 전송, 딥링크가 있으면 라우팅.
3. 대사: 아래 세 곳의 `message_id`가 같아야 한다.

| 위치 | 확인 방법 | 기대 |
|---|---|---|
| 발송 로그 | 콘솔 `/logs` 또는 ClickHouse `nudgeon.message_log` | `status=sent`, `channel=push_fcm|push_apns` |
| 도달/오픈 이벤트 | ClickHouse events: `event_name IN ('$push_delivered','$push_opened')` | `properties.message_id` = 위 값 |
| 리포트 | `GET /v1/apps/<app_id>/analytics/dashboard` (또는 콘솔 대시보드) | 도달 1·오픈 1 |

```sql
-- ClickHouse (docker exec -it nudgeon-clickhouse clickhouse-client)
SELECT message_id, channel, status, sent_at FROM nudgeon.message_log
WHERE tenant_id = toUUID('<tenant_id>') AND app_id = toUUID('<app_id>')
ORDER BY sent_at DESC LIMIT 5;
SELECT event_name, JSONExtractString(properties, 'message_id') AS mid, occurred_at
  FROM nudgeon.events
WHERE tenant_id = toUUID('<tenant_id>') AND app_id = toUUID('<app_id>')
  AND event_name IN ('$push_delivered', '$push_opened')
ORDER BY occurred_at DESC LIMIT 5;
```

## 6. 성공 기준과 기록

- [ ] iOS·Android 각각 수신 1건, 탭 1건, 세 곳 `message_id` 일치
- [ ] 크리덴셜 `verified`, 워커 로그에 4xx 없음
- [ ] 앱 종료 상태(cold)에서도 iOS `$push_delivered`가 들어옴 (NSE 경로)
- [ ] 결과를 `docs/dev/DEV-MAIN-개발기획서.md` 7장 IT-3·IT-8·M-1에 판정자·일자와 함께 기입, `REMAINING-WORK`의 3-A를 닫음

## 7. 자주 막히는 곳

| 증상 | 원인 | 조치 |
|---|---|---|
| APNs `BadDeviceToken` | 개발 빌드인데 `environment: production` | 크리덴셜을 `sandbox`로 재등록 |
| FCM 404/`SENDER_ID_MISMATCH` | 서비스 계정 프로젝트와 `google-services.json` 프로젝트가 다름 | 같은 Firebase 프로젝트로 통일 |
| iOS `$push_delivered`가 안 옴 | NSE 미포함, App Group 불일치, 또는 앱이 identify/토큰 등록 전이라 공유 설정이 비어 있음 | NSE 타깃·App Group 확인, 앱을 한 번 포그라운드로 열어 공유 설정 저장 |
| 단말이 API에 못 붙음 | localhost 주소, ATS, 방화벽 | 1단계 주소·ATS 예외·터널 |
| 알림은 오는데 SDK가 무시 | `nudgeon.message_id`/`message_id` 없음 | 워커 버전 확인 (`PUSH-CONTRACT.md` R-01 이후) |
