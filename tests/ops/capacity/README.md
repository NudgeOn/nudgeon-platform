# P0-4a 운영 관측 로컬 검증

저장소 루트에서 `node tests/ops/capacity/run.mjs`를 실행한다.
Go, Node, Docker Desktop과 캐시된 `nudgeon-worker:latest`, `nudgeon-api:latest`,
`postgres:16`, `redis:7`, `prom/prometheus:v3.5.0`, `prom/alertmanager:v0.28.1`이 필요하다.
Linux arm64 worker를 로컬에서 cross-compile하므로 현재 runner는 이 Mac/arm64 시험용이다.
API 이미지는 고정 목적지 HTTP gateway의 Node 런타임으로만 쓰며 API 서버는 시작하지 않는다.

- 임의 Compose 프로젝트·고유 worker-only image tag·새 PG/Redis 볼륨을 사용한다.
- 기존 worker 이미지는 인증서만 복사하는 build stage이며 새 worker 바이너리는 image에 직접 COPY한다.
  기존 image tag를 덮어쓰거나 레지스트리에 올리지 않는다. 배포용 다중 CLI image와 구분한다.
- DB/Redis/observer/Prometheus/Alertmanager는 internal network만 사용한다.
  고정 목적지 gateway만 호스트 loopback `127.0.0.1:19494`에 연결한다.
- 합성 원장 3건, outbox 3건, pending marker 2건을 이용한다. 실제 FCM/APNs/알림톡/SMS는 호출하지 않는다.
- Redis 조회 한도 시험에 `ops-scan-fixture:` 접두사 임시 키 80,000개를 만들고 시험 후 제거한다.
  실제 pending marker는 삭제하지 않는다. 마지막 상태 전이는 합성 fixture 조작이며 발송 복구 증거가 아니다.
- `users.acl`의 무암호 admin과 고정 비밀번호는 격리 시험 전용이다. 운영에 복사하지 않는다.
- PG SELECT-only, Redis 쓰기 금지, 재시작 후 발견, PG timeout, Redis 권한/JSON 오류,
  전체 순회 한도, monitor 중단, 실제 로컬 webhook firing/resolved를 검증한다.
- unit/race 결과에서 실제 DB 환경이 필요한 테스트가 skip되면 이름을 기록한다.
  실제 DLQ 저장 경로 회귀는 [dlq-storage](../dlq-storage/README.md)로 별도 실행한다.
- 완료/실패 시 해당 프로젝트만 정지한다. 기존 실행 컨테이너 집합/이미지 태그 보존을 검사한다.
  볼륨·이미지·로그는 삭제하지 않으며 `.nudgeon/nudgeon-ops-qa-*/`에 증거를 남긴다.
  자기 프로젝트의 활성 endpoint가 없는 시험 네트워크만 해제해 Docker 주소 풀을 반환한다.
  재실행은 항상 새 프로젝트이며 이전 컨테이너를 단순 start하는 용도가 아니다.

증거에는 source manifest, unit JSONL, SQL EXPLAIN, 초기/오류/복구 metrics, webhook 알림,
container logs, 최종 result JSON이 포함된다. 결과 해석은 [운영 감시 문서](../../../docs-public/OPERATIONS-MONITOR.md)를 따른다.
이 시험은 TPS/EPS benchmark, 운영 배포, DB 백업·복원, 24시간 soak가 아니다.
