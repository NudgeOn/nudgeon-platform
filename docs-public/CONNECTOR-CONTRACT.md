# NudgeOn 커넥터 계약 v0 — `send.message.v1` · `connector.manifest.v0` · `message.lifecycle.v1`

상태: **초안 고정(2026-09-02)**. 이 문서와 `packages/queue-schemas/schemas/*.schema.json`이 단일 출처이며, 스키마 파일이 문서보다 우선한다.
목적: 새 채널(알림톡·SMS·브랜드메시지·LINE·웹훅·인앱…)을 **엔진 수정 없이** 붙이고, 채널 간 성과·원가를 **같은 기준**으로 비교하며, 나중에 외부 개발자가 커넥터를 공급할 수 있게 하는 세 계약을 고정한다.

```
저니/캠페인 엔진 ──(정책 판정: 동의·quiet hours·cap·광고표기)──▶ stream:send.message  [send.message.v1]
                                                                        │
                                                                        ▼
                                                     채널 워커 ──▶ 커넥터(manifest 선언) ──▶ 공급자
                                                                        │             ▲
                                                                        │             └── 공급자 콜백 (/v1/connectors/{id}/callback/…)
                                                                        ▼
SDK($push_delivered/$opened) ──▶ ingestion ──▶ stream:message.lifecycle [message.lifecycle.v1] ──▶ message_log 롤업·리포트
```

## 1. 왜 세 개인가

| 계약 | 방향 | 답하는 질문 |
|---|---|---|
| `send.message.v1` | 엔진 → 커넥터 | "누구에게, 어떤 근거로, 무엇을, 실패하면 무엇으로 보내는가" |
| `connector.manifest.v0` | 커넥터 → 엔진 | "나는 어떤 채널이고, 무엇을 받을 수 있고, 무엇을 보고할 수 있고, 어떤 규제 특성이 있는가" |
| `message.lifecycle.v1` | 커넥터·콜백·SDK → 리포트 | "그 메시지에 실제로 무슨 일이 있었는가" |

기존 `send.push` / `send.email`은 v1 호환을 위해 그대로 두고, **신규 채널은 `send.message.v1`만 구현한다.** 푸시·이메일은 P1에서 어댑터로 `send.message.v1` 위에 올린다.

## 2. `send.message.v1` 핵심 규칙

1. **멱등 키는 엔드포인트까지 포함한다.** `idempotency_key = (journey_id, version, user_id, node_index, endpoint_id)`. `endpoint_id`는 device_id(푸시) 또는 identity endpoint id(전화·이메일·카카오 사용자). CLAUDE.md 규칙 6의 채널 중립 확장이며 `target.endpoint_id`는 필수다.
2. **`message_id`는 발송 시점에 1회 생성**하고 재시도·폴백에서도 바뀌지 않는다. 공급자 영수증·SDK 이벤트·lifecycle·message_log가 전부 이 키로 조인된다.
3. **동의와 정책은 엔진의 책임, 렌더는 커넥터의 책임.** `consent.basis`가 없으면 스키마가 거절한다. `policy.ad_label_required=true`면 커넥터는 채널 규칙에 맞게 `(광고)` 표기와 수신거부 안내를 삽입한다. 커넥터는 정책을 재판정하지 않는다.
4. **크리덴셜은 큐에 싣지 않는다.** `connector.credential_ref`만 전달하고 채널 워커가 봉투 암호화 저장소에서 복호화한다.
5. **content는 capability 단위다.** `push` `email` `text` `template` `buttons` `webhook` `in_app` 중 하나 이상. manifest `capabilities.content`에 없는 종류가 오면 커넥터는 `unsupported`로 실패 분류하고, 엔진은 사전에 거를 수 있다(두 스키마의 enum은 테스트로 동일성을 강제한다).
6. **폴백은 최대 3단계**, 각 단계는 트리거 조건(`on`)을 명시한다. 예: 알림톡 `invalid_target`·`permanent_content`·`retry_exhausted` → SMS.
7. **개인정보 최소화.** `target.value`(전화·이메일)는 큐에 평문으로 실리므로 스트림 보존 기간·접근 통제는 sub-07 규칙을 따른다. `metadata`는 문자열 32개 이하로 제한한다.

## 3. `connector.manifest.v0` 핵심 규칙

- 파일명 `nudgeon.connector.json`. `id`는 전역 유일(`kakao_alimtalk_nhn`, `sms_nhn`, `push_fcm` …).
- `runtime.type`: v0는 `in_process_go`(코어·Certified)와 `remote_http`(외부 커넥터, HMAC 서명 필수) 두 가지. remote 규약은 고정 경로 `POST {endpoint}/validate`, `POST {endpoint}/send`, `POST {endpoint}/callback/parse`.
- `lifecycle.reports`에 **실제로 보고 가능한 상태만** 적는다. 리포트는 여기 없는 상태를 '미지원'으로 표시해 0과 구분한다(알림톡은 `opened`가 없고 `clicked`만 있음).
- `compliance`는 정책 엔진의 입력이다: `requires_template_approval`, `ad_label`, `unsubscribe`, `quiet_hours_default`, `pii_in_transit`.
- `contract_tests`: Certified 등급은 9개 표준 계약 테스트 전부 통과가 조건이다.
- v1(Registry 단계)에서 추가될 필드: `signature`, `sbom`, `sandbox`, `pricing`, `maintainer_sla`. v0 파일은 v1에서도 유효하도록 **추가만** 한다.

## 4. `message.lifecycle.v1` 핵심 규칙

- 상태: `accepted → sent → delivered → opened|clicked`, 종결 `failed|unsubscribed|bounced`. `failed`는 `failure_class` 필수.
- `source`로 출처를 구분한다: `engine`(accepted·정책 skip), `connector`(sent·동기 failed), `provider_callback`(delivered·failed·bounced), `sdk`($push_delivered·$push_opened).
- `fallback_index`와 `attempt`로 폴백 체인의 어느 단계·몇 번째 시도인지 기록한다. 원가(`cost`)는 단계별로 누적된다.
- SDK 이벤트는 ingestion을 거쳐 이 스트림으로 **변환**된다. SDK 페이로드 계약 자체는 `PUSH-CONTRACT.md`가 유지한다.

## 5. 첫 reference connector: 카카오 알림톡 + SMS 폴백

`packages/queue-schemas/examples/`에 예시 세 개가 있다.

| 파일 | 내용 |
|---|---|
| `send.message.kakao_alimtalk.json` | 주문 배송 알림톡(템플릿+버튼) → 실패 시 SMS 폴백 |
| `connector.manifest.kakao_alimtalk_nhn.json` | NHN Cloud 알림톡 커넥터 선언(비동기 영수증, 템플릿 승인 필수, 마케팅 불가) |
| `message.lifecycle.delivered.json` | 콜백으로 수신한 delivered 이벤트와 원가 |

P0~P1 구현 순서: (1) 채널 워커가 `stream:send.message`를 구독하고 manifest로 커넥터를 찾는다 → (2) 알림톡 커넥터(mock 공급자로 계약 테스트 9종) → (3) 실제 NHN Cloud 샌드박스 → (4) SMS 커넥터 + 폴백 → (5) 콜백 수신 엔드포인트 → (6) message_log를 lifecycle 기준으로 롤업.

## 6. 호환성·버전 규칙

- 스키마는 `$id`에 버전을 박는다. **하위 호환 추가는 같은 버전에서 필드 추가**, 파괴 변경은 `send.message.v2`처럼 새 파일·새 envelope type.
- envelope `type`에 `send.message`, `message.lifecycle`을 추가했고, 스트림 키 `stream:send.message`, `stream:message.lifecycle`과 컨슈머 그룹 `cg:channel.message`, `cg:lifecycle`을 TS(`@nudgeon/queue-schemas`)·Go(`libqueue-go`) 양쪽에 동일하게 등록했다.
- 검증: `pnpm --filter @nudgeon/queue-schemas test` (ajv 2020-12, 예시 검증 + 불변식 테스트).

## 7. 열린 질문 (P1 전 결정)

1. 브랜드메시지(구 친구톡)의 `content`는 `text`+`buttons`+`image_url`로 충분한가, 아니면 캐러셀 전용 capability가 필요한가.
2. `target.value`를 큐에서 제거하고 워커가 endpoint registry에서 조회하는 방식(PII 최소화)으로 갈지 — 처리량·PG 부하와 트레이드오프.
3. remote_http 커넥터의 타임아웃·재시도 책임 분담(엔진 vs 커넥터).
4. `in_app`은 발송이 아니라 '노출 자격 부여'에 가깝다. 별도 `expose.in_app.v1`로 분리할지 P2 인앱 설계 때 결정.
