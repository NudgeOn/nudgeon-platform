# Redis 유실 대응 런북

Redis를 잃거나 비운 뒤에 **무엇이 잘못됐는지 확인하는 절차**다.
확인 도구는 `cmd/reconcile`이며 읽기 전용이다 — 아무것도 자동으로 고치지 않는다.

## 0. 왜 Redis 유실이 특별한가

Redis는 이 시스템에서 큐만 담당하지 않는다. 큐 메시지는 재적재로 복구되지만,
**발송 정확성을 지키는 상태값이 Redis에만 있다.**

| Redis에 있는 것 | 잃으면 |
| --- | --- |
| 발송 멱등 키 (`SetNX` + 20초 리스) | **"이미 보냈는지"를 알 수 없다 → 중복 발송** |
| 재시도 카운터 (`send:attempts:*`) | 백오프 상태가 사라져 재시도 횟수가 초기화된다 |
| 수집 중복 억제 (`dedup:evt:*`) | 같은 이벤트가 중복 집계된다 |
| 빈도 제한 (`freqcap:*`) | 사용자당 발송 상한이 무너진다 |
| DLQ pending (`dlq_pending\|...`) | 적재 중이던 실패 건의 상태가 사라진다 |

Compose 기본 구성은 `appendonly yes` · `appendfsync everysec`다.
**everysec은 최대 1초 유실을 허용한다** — 그 1초에 걸친 멱등 키만큼 중복 발송이 가능하다.
완전 휘발(AOF 없이 재기동, 볼륨 삭제, `FLUSHALL`)은 그보다 훨씬 넓은 구간을 연다.

PRD-08 5장이 이 상황의 2차 방어로 지정한 것이 **`message_log` 대사**이고,
그 구현이 이 문서가 다루는 도구다.

## 1. 먼저 할 것 — 유실 구간을 특정한다

대사 범위를 좁히려면 언제부터 언제까지 Redis가 정상이 아니었는지 알아야 한다.

```bash
# AOF 마지막 저장 시각과 재기동 시각
docker exec <redis> redis-cli INFO persistence | grep -E "aof_last_write_status|rdb_last_save_time"
docker exec <redis> redis-cli INFO server | grep uptime_in_seconds
```

`uptime_in_seconds`가 짧고 `aof_enabled:0`이면 **완전 휘발**로 간주한다.

## 2. 대사 실행

```bash
export DATABASE_URL=postgres://... CLICKHOUSE_URL=http://...
go run ./apps/worker/cmd/reconcile --since 24h
```

유실 구간에 맞춰 `--since`를 잡는다. 테넌트가 많으면 `--tenant`로 나눠 실행한다.

| 옵션 | 뜻 |
| --- | --- |
| `--since 24h` | 대사 기간. 기본 24시간 |
| `--tenant <uuid>` · `--app <uuid>` | 범위 한정. 비우면 전체 |
| `--samples 20` | 분류별 표본 출력 수 |
| `--json` | 기계 판독용 출력 |

| 종료 코드 | 뜻 |
| --- | --- |
| `0` | 조치가 필요한 발견 없음 |
| `1` | 발견 있음 — **"판단 불가"도 포함한다** |
| `2` | 실행 실패 |

범위가 상한(`--max-keys`, 기본 50만)을 넘으면 수치를 **최소값**으로 보고하고 종료 코드 1을 낸다.
잘라낸 결과를 이상 없음으로 읽는 것이 대사에서 가장 위험하므로, 모르는 것을 모른다고 말한다.

## 3. 분류별 대응

### 중복 발송

같은 멱등 키에 **서로 다른 `message_id`로 성공 발송이 둘 이상**이다.
`message_id`가 같은 행이 여럿인 것은 projection 재적재로 생기는 무해한 중복이라 세지 않는다.

- **되돌릴 수 없다.** 이미 고객 단말에 도착했다.
- 중복 발송 시각이 Redis 유실 구간과 겹치는지 먼저 확인한다. 겹치지 않으면 다른 원인이다
  (리스 만료 후 재전달, 워커 크래시 등 — 그 경우 P0-02 범위다).
- 규모와 채널을 파악해 고객 고지 여부를 판단한다. 알림톡·SMS는 **건당 원가가 실재**하므로
  중복분이 곧 비용이다.

### 누락

`journey_outbox`는 발행 완료(`published_at IS NOT NULL`)인데 `message_log`에 결과가 없다.

- **재발행 전에 실제로 미발송인지 확인한다.** 발송은 됐는데 결과 기록만 실패한 경우라면
  재발행이 곧 중복 발송이 된다.
- 확인 경로: 공급자 콘솔의 발송 이력, `message_lifecycle`의 해당 시각 이벤트.
- 미발송이 확실하면 `journey_outbox`에 원본 `payload`가 남아 있으므로 재발행할 수 있다.

### 미발행 정체

15분 넘게 발행되지 않은 `journey_outbox` 행이다. Redis 유실과 무관할 수 있다.

- `nudgeon_outbox_relay_round_errors_total`과 outbox relay 프로세스 상태를 먼저 본다.
- `relay_attempt_count`가 계속 오르면 발행 자체가 실패하고 있는 것이고,
  0에서 멈춰 있으면 릴레이가 아예 돌지 않는 것이다.

## 4. 대사로 알 수 없는 것

이 도구는 **발송 원장**만 본다. 다음은 별도 확인이 필요하다.

- **수집 중복** — `dedup:evt:*` 유실로 같은 이벤트가 두 번 적재됐을 수 있다.
  `raw_ingestions` replay가 수집 계층의 최종 복구 수단이다(PRD-01).
- **빈도 제한 초과** — `freqcap:*`이 초기화돼 상한을 넘겨 보냈을 수 있다.
  `message_log`를 사용자·기간으로 집계해 확인한다.
- **정확히 한 번 전달** — 공급자 응답이 불명확한 경우까지 보장하지 않는다(P0-02).

## 5. 재발 방지

| 조치 | 상태 |
| --- | --- |
| AOF `everysec` 기본 구성 | 적용됨 (`deploy/compose.yaml`) |
| `NudgeOnRedisDurabilityRisk` · `RedisMemoryPressure` 경보 | 적용됨 (`deploy/observability/ops-alerts.yml`) |
| 대사 도구 | 이 문서 |
| Redis 복제·페일오버 | **미구성** — 단일 인스턴스다 |
| 정기 자동 대사 | **미구성** — 현재는 수동 실행 |

Redis 복제와 정기 대사는 [출시 체크리스트](RELEASE-CHECKLIST.md) P1-07 범위다.

## 6. 관련 문서

- [DLQ 경보 대응 런북](DLQ-RUNBOOK.md) — 재시도 소진 건의 처리
- [운영 모니터 안내](OPERATIONS-MONITOR.md) — 지표와 경보 전반
- [출시 체크리스트](RELEASE-CHECKLIST.md) — 무엇이 검증됐고 무엇이 아닌지
