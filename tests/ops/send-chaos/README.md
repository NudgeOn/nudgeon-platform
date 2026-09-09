# M-4 중복 발송 카오스 — 발송 중 워커 kill -9 반복

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env --profile full --profile app up -d
USERS=600 KILLS=10 KILL_INTERVAL_MS=700 node tests/ops/send-chaos/run.mjs
```

## 무엇이 실제인가

- 실제 워커 컨테이너를 `docker kill -s KILL`로 죽이고 `docker start`로 되살린다(프로세스 밖 신호, 도커 재시작 정책과 무관).
- 발송 대상은 **프로세스 밖 SMTP 싱크**(Mailpit, `MP_MAX_MESSAGES=0`). 워커가 몇 번 죽든 싱크는 살아 있으므로 "공급자가 실제로 몇 통 받았나"가 남는다. 이 실행의 메일만 세도록 제목에 실행 ID를 넣는다 — 이전 실행의 잔여 재시도(리퍼로 되살아난 발송이 싱크 없는 동안 백오프하다 다음 싱크로 들어온 것)를 중복으로 오판한 적이 있다.
- 대사: outbox 발송 의도 == N, `message_log` sent 고유 message_id == 멱등 키 == N, sent 행 == N(크래시로 유실된 로그를 재전달이 복구한 행 포함, 이중 로그 0), failed 0, **싱크 실수신 == N**.

## 2026-09-10 실측 (로컬 docker, 이메일 채널)

| 실행 | N | kill -9 | 발송 중에 맞은 kill | 싱크 실수신 | 공급자 중복 | message_log 고유/행 | 복구 재기록 | 수렴 |
|---|---|---|---|---|---|---|---|---|
| A | 600 | 10 (0.7s 간격) | 2 | 600 | **0** | 600/600 | 10 | 22s |
| B | 3,000 | 10 (0.5s 간격) | 4 | 3,001 | **1** | 3,000/3,001 | 19 | 303s (리퍼 5분 대기) |

B의 1건은 설계된 at-least-once 창이다: SMTP 전송이 끝난 직후, Redis에 `sent`를 커밋하기 전에 죽으면 리스(20초)가 만료된 뒤 재전달이 다시 보낸다. 공급자 응답 없이 "보냈는지"를 알 방법이 없으므로 이 창은 0으로 만들 수 없고, 대신 공급자·단말 쪽에서 접는다:

- 이메일: `Message-ID: <message_id@nudgeon>`가 결정적이라 실제 메일함(Gmail 등)은 같은 메시지로 접는다. Mailpit은 접지 않아 위 표에 그대로 보인다.
- APNs: `apns-id`·`apns-collapse-id`를 message_id로 보낸다(이 실측 뒤 추가). 단말에서 하나로 접힌다.
- FCM: `collapse_key`는 기기당 4개 제한이 있어 쓰지 않는다. SDK가 message_id로 중복 표시를 막는 것이 후속.

## 경계

- 죽은 워커가 클레임한 `journey_states`는 리퍼가 `claimReap`(5분) 뒤 회수한다. kill이 스케줄러 배치 중에 떨어지면 그 배치는 최대 6분 늦게 나간다(B의 수렴 303초). 중복은 아니지만 O-3(기상 정확도)에는 영향이 있다.
- 싱크가 없는 동안 실패한 발송은 5회 백오프 뒤 DLQ로 간다. 이 러너는 싱크를 먼저 띄우므로 해당 없음.
- 푸시 채널은 실공급자가 필요해 이 러너로 돌리지 않았다. 멱등·리스·DLQ 상태기계는 세 채널이 같은 SendLoop를 쓴다(플랫폼 PR #8).
