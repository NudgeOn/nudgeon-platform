# 관리형 저장소 검증 기록 — B-4

현재 결과는 **NOT_RUN**이다. 로컬 PG/Redis TLS 회귀와 로컬 Docker 복원은
통과했지만 실제 관리형 PostgreSQL·Redis·ClickHouse 대상의 합격 증거는 아니다.
이 문서는 대상 환경이 준비됐을 때 사용할 실행 순서와 기록 양식이다.
연결 정보를 자동으로 찾거나 클라우드 자원을 생성하는 도구는 아니다.

## 시작에 필요한 환경 정보

공유 문서에는 비밀번호·DSN·SDK 키 대신 설정 파일의 위치와 환경 별칭만 적는다.

| 입력 | 기록 |
|---|---|
| 격리된 시험 서버/환경 별칭 | 미제공 |
| 접속 방법과 비밀 설정 파일 위치 | 미제공 |
| PG·Redis·CH 제공자/버전/토폴로지 | 미확인 |
| 서비스별 CA 파일의 컨테이너 내부 경로 | 미확인 |
| 시험 전용 DB·사용자·tenant/app 범위 | 미확인 |
| API·worker·migrator 소스 커밋/이미지 digest | 실행 시 기록 |
| 백업 저장 위치와 별도 빈 복원 대상 | 미제공 |
| CPU·메모리·디스크 예산과 중단 기준 | 실측 필요 |
| 제공자 장애 전환 기능과 시험 범위 | 미확인 |

기존 사용자 DB를 초기화하거나 기존 Redis를 비우지 않는다. 복원은 시험용 빈
대상에만 한다. 실제 FCM/APNs 발송은 이 검증에 포함하지 않는다.
기존 Docker 백업/복원 러너는 컨테이너용이며 관리형 서비스에 그대로 적용한
것으로 간주하지 않는다. 제공자별 백업·복원 경로가 실제로 동작해야 한다.

## 순서와 완료 조건

각 단계는 시작/종료 시각(UTC와 KST), 검사한 커밋, 명령, 결과 파일의 경로와
SHA-256, 실패 원인을 남긴다. 처음에는 모든 행을 `NOT_RUN`으로 유지한다.

| 단계 | 검증 내용 | 합격 증거 |
|---|---|---|
| 1. 연결 | API(Node), worker·migrator(Go)가 각각 실제 서비스에 연결 | 실제 클라이언트별 TLS·인증 성공, `/readyz`와 worker 상태. TCP 포트 접속만으로 완료하지 않음 |
| 2. 거부 | 별도 시험 클라이언트의 잘못된 CA·호스트명·인증 정보 | TLS/인증 오류로 거부. 단순 timeout/connection refused를 인증서 검증 성공으로 세지 않음 |
| 3. 스키마 | 빈 시험 DB migration, 같은 소스로 재실행 | PG migration 체크섬 유지, PG/CH 스키마 확인, 재실행 후 데이터 유지 |
| 4. 수집 | 합성 이벤트를 두 시험 tenant/app에서 입력 | tenant별 원래 insert ID·payload·접수 수와 PG/CH 결과 대사, 교차 노출 없음 |
| 5. 연결 복구 | 시험 연결 중단 및 지원되는 제공자 장애 전환 | API/worker의 끊김·복구 시각, 재시작 여부, 새 연결·DNS 전환 결과. 복구 중 접수 결과 불명확 요청도 별도 기록 |
| 6. 백업/복원 | 시험 데이터를 백업해 별도 빈 대상에 복원 | PG/CH 원본·집계와 Redis 상태 대사, 같은 마스터키로 시험 크리덴셜 복호화, 복원 API 동작 |
| 7. 복구 목표 | 백업 시점과 복원 후 서비스 재개 측정 | 실측 RPO/RTO. 로컬의 과거 26초 결과를 관리형 수치로 복사하지 않음 |
| 8. 정리 | 이번 실행의 자원/접속만 정리 | 원래 서비스 유지, 시험 데이터·백업 보존/삭제 범위 기록, 미해결 오류 목록 |

서비스가 다르거나 토폴로지가 바뀌면 결과 적용 범위도 달라진다. 예를 들어
단일 Redis TLS 연결 결과로 Cluster/Sentinel/IAM 인증까지 지원한다고 적지 않는다.
연결 복구 성공과 수집/발송 중복 방지 성공은 각각 별도 증거를 요구한다.

## 결과 기록 양식

아래 JSON은 **예시 양식**이며 실행 결과가 아니다. 비밀 값을 채우지 않는다.

```json
{
  "status": "NOT_RUN",
  "environment_alias": null,
  "source_revision": null,
  "image_digests": {},
  "started_at_utc": null,
  "finished_at_utc": null,
  "display_timezone": "Asia/Seoul",
  "service_versions_and_topology": {},
  "checks": [],
  "evidence_files_and_sha256": {},
  "unresolved_failures": [],
  "rpo_seconds": null,
  "rto_seconds": null,
  "real_provider_sends": 0,
  "capacity_qualified": false
}
```

관리형 저장소를 통과해도 B-5 부하 시험은 별도다. 실측 성장량·메모리를
[자원 사전 점검](../tests/ops/capacity-preflight/README.md)에 넣고
[단계별 부하 계획](CAPACITY-PLAN.md)에 따라 진행한다. 24시간 시험은 실제
24시간 원본 로그와 대사가 있어야 완료다.

관련 구현/경계: [배포 설정](DEPLOY.md),
[PG 로컬 회귀](../tests/ops/postgres-recovery/README.md),
[Redis 로컬 회귀](../tests/ops/redis-recovery/README.md),
[Docker 복원 리허설](../tests/ops/backup-restore/README.md),
[Beta 남은 작업](BETA-REMAINING-2026-09-18.md).
