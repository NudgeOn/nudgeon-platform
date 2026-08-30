# 교차 테넌트 격리 스위트 (M-6 / T-8)

테넌트 A의 세션·키로 테넌트 B의 리소스에 접근하면 전부 403/404여야 한다 (PRD-06 8장).
실행 중인 로컬 스택(compose + api)을 대상으로 관리 API 전 엔드포인트를 자동 대입한다.

```bash
# 사전: compose full + api 기동 (deploy/compose.yaml, apps/api)
node tests/isolation/run.mjs
```

신규 엔드포인트는 `run.mjs`의 ENDPOINTS 배열에 추가한다 (OpenAPI 스펙 드리프트 검사는 IT-6).
종료 코드 0 = 전 경로 격리, 1 = 위반 발견.
