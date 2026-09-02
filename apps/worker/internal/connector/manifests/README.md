# 커넥터 매니페스트 디렉터리

워커가 기동 시 이 디렉터리의 `*.json`을 모두 읽어 검증한다 (`connector.LoadDir`).
경로는 환경변수 `ONDA_CONNECTOR_MANIFESTS`로 바꿀 수 있고, 기본값은 `/etc/onda/connectors`다.
디렉터리가 없으면 빈 목록으로 본다 — 커넥터를 안 쓰는 배포가 기동에 실패하면 안 되기 때문이다.

여기에 매니페스트를 놓는 것이 곧 "그 커넥터를 켠다"는 뜻이다.

- `id`가 중복되면 기동이 실패한다.
- `runtime.type = in_process_go`인데 Go 구현이 등록돼 있지 않으면 기동이 실패한다
  (구현은 자기 패키지 `init()`에서 `alimtalk.Register`를 부르고, `cmd/worker`가 블랭크 임포트한다).
- 스키마 단일 출처는 `packages/queue-schemas/schemas/connector.manifest.v0.schema.json`,
  Go 투영은 `apps/worker/internal/connector/manifest.go`다.

테스트용 목(mock) 벤더의 매니페스트는 목 패키지에 임베드돼 있다. 여기에 복사해 두지 않는다 —
운영 배포에 목이 딸려 들어가는 사고를 막기 위해서다.
