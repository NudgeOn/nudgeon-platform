# Onda

<p align="center">
  <img src="docs-public/assets/onda-logo-pigeon.png" alt="Onda — 메시지를 전달하는 전서구 로고 시안" width="440" />
</p>

**한국 시장 네이티브 오픈소스 고객 인게이지먼트 플랫폼.**
Push부터 알림톡까지, 하나의 세그먼트·저니 엔진 위에서 — 셀프호스팅 가능한 한국형 Braze.

> ⚠️ 개발 중인 Push 중심 MVP입니다. 핵심 경로의 코드가 있으나 재시도·일시정지·SDK 연동·운영 검증이 남아 있습니다. API·스키마는 예고 없이 변경됩니다.

## 전체 아키텍처

고객 앱의 이벤트를 수집하고, 고객 조건과 저니에 따라 푸시를 발송합니다. 아래 그림은 **현재 코드의 구성과 연결**을 기준으로 하며, 운영 완료를 의미하지 않습니다.

```mermaid
flowchart TB
  subgraph clients["고객 앱 · 고객사 서버"]
    direction LR
    bridges["React Native · Flutter<br/>무상태 브리지"]
    native["iOS · Android 코어 SDK<br/>식별 · 이벤트 · 오프라인 큐 · 푸시"]
    backend["고객사 백엔드<br/>Server Key"]
    bridges --> native
  end

  subgraph control["관리 · 수집 API"]
    direction LR
    console["관리 콘솔 · Next.js<br/>온보딩 · 고객 · 세그먼트 · 저니 · 리포트"]
    management["관리 API · NestJS<br/>세션 인증 · 테넌트별 리소스 접근"]
    segmentApi["세그먼트 DSL → SQL<br/>미리보기 · 활성화 시 대상 스냅샷"]
    ingestion["Ingestion API · NestJS<br/>API Key · 입력 검증 · Rate Limit"]
    console <-->|"공유 API 클라이언트"| management
    management --> segmentApi
  end

  subgraph queues["Redis · libqueue 경유 Redis Streams"]
    direction LR
    ingestQ["stream:ingest"]
    eventsQ["stream:events"]
    entryQ["stream:journey.entry"]
    sendQ["stream:send.push"]
    redisState["중복 억제 · 빈도 제한 · 캐시"]
  end

  subgraph engine["실행 엔진 · Go 워커"]
    direction LR
    ingestWorker["Ingest Consumer<br/>고객·디바이스 갱신 · 병합 · 이벤트 적재"]
    trigger["Trigger Matcher<br/>이벤트 → 저니 진입·이탈"]
    scheduler["Scheduler<br/>대기·메시지 노드 · 정책 · 디바이스별 발송"]
    relay["Outbox Relay<br/>커밋된 발송 작업을 큐로 전달"]
    channel["Channel Worker<br/>크리덴셜 검증·복호화 · PushPlugin"]
  end

  subgraph storage["데이터 저장"]
    direction LR
    pg[("PostgreSQL<br/>테넌트 · 멤버 · 키 · 암호화 크리덴셜<br/>고객 · 디바이스 · 저니 상태 · Outbox")]
    ch[("ClickHouse<br/>수집 원본 · 이벤트 · 프로필 미러<br/>대상 스냅샷 · 발송 로그 · 사용량")]
  end

  subgraph delivery["외부 Push 채널"]
    direction LR
    providers["FCM · APNs"]
    device["고객 디바이스<br/>알림 수신 · 열기"]
  end

  native -->|"SDK Key · HTTPS"| ingestion
  backend -->|"Server Key · HTTPS"| ingestion
  ingestion --> ingestQ
  ingestion -->|"원본 비동기 적재"| ch
  ingestion -->|"Rate Limit"| redisState
  management <--> pg
  management -->|"로그 · 리포트 조회"| ch
  segmentApi <--> ch
  segmentApi -->|"단발 캠페인 대상 참조"| entryQ
  ingestQ --> ingestWorker
  ingestWorker --> pg
  ingestWorker -->|"이벤트 · 프로필 미러"| ch
  ingestWorker --> eventsQ
  eventsQ --> trigger
  trigger <--> pg
  trigger --> entryQ
  entryQ --> scheduler
  ch -->|"대상 스냅샷 읽기"| scheduler
  scheduler <--> pg
  scheduler -->|"빈도 제한"| redisState
  scheduler -->|"발송 생략 사유"| ch
  pg -->|"Outbox"| relay
  relay --> sendQ
  sendQ --> channel
  channel <--> pg
  channel -->|"중복 억제"| redisState
  channel -->|"발송 결과"| ch
  channel --> providers
  providers --> device
  device -->|"수신·오픈 콜백"| native
  native -.->|"도달·오픈 이벤트: 발송 ID 연결 미완성"| ingestion

  pending["미구현: segment 워커의 주기 평가·대사"]
  future["v1.5 이후 계획<br/>알림톡 · SMS · 이메일 · 분기 저니"]
  pending -.-> ch
  channel -.-> future

  classDef active fill:#eaf6fb,stroke:#1685ad,color:#102b46
  classDef data fill:#f2f5f9,stroke:#708499,color:#102b46
  classDef planned fill:#fff8e7,stroke:#b38b35,color:#684f12,stroke-dasharray:5 5
  class ingestion,management,segmentApi,ingestWorker,trigger,scheduler,relay,channel active
  class pg,ch,redisState data
  class pending,future planned
```

- **실선**: 코드에 연결이 존재합니다. 실기기·장애 복구·부하 검증 통과를 뜻하지는 않습니다.
- **점선**: 아직 완성되지 않은 연결 또는 향후 구현 범위입니다. 현재 실제 채널 구현은 FCM/APNs Push입니다.
- **배포**: Docker Compose로 API·콘솔·워커와 PostgreSQL·ClickHouse·Redis를 구성합니다. 외부 DB 연결 설정과 Prometheus 지표도 포함하며, 관리형 DB 호환성과 백업 복구는 별도 검증이 필요합니다.
- **SDK**: 네이티브 코어가 상태를 관리하고 RN/Flutter는 이를 호출합니다. SDK 배포와 4개 플랫폼의 전체 연동 검증은 진행 중입니다.

## 구조

```
apps/
  api/        NestJS — 관리 API + Ingestion API
  console/    Next.js — 어드민 콘솔
  worker/     Go — 실행 엔진 (--role: ingest-consumer|scheduler|trigger-matcher|segment|channel)
packages/
  openapi/         OpenAPI 3.1 스펙 + 공유 클라이언트 (자동 생성은 예정)
  queue-schemas/   큐 메시지 JSON Schema (단일 출처)
  libqueue-ts/     Redis Streams 래퍼 (TS, 생산)
  libqueue-go/     Redis Streams 래퍼 (Go, 생산·소비)
  segment-dsl/     세그먼트 DSL 스키마 + 골든 테스트
db/
  postgres/        Atlas 선언적 스키마
  clickhouse/      순번 SQL 마이그레이션
deploy/            Docker Compose
```

## 빠른 시작 (개발)

```bash
# 데이터 서비스만 (앱은 로컬 실행)
docker compose -f deploy/compose.yaml --profile full up -d
export ONDA_MASTER_KEY=$(openssl rand -base64 32)
go run ./apps/worker/cmd/migrate db        # 스키마 적용 (멱등)
pnpm install && pnpm build
pnpm --filter @onda/api dev                # 관리·Ingestion API :8080
go run ./apps/worker/cmd/worker --role=all # 워커 (전 역할)
pnpm --filter @onda/console dev            # 콘솔 :3000
```

## 셀프호스팅 (원-커맨드)

```bash
cp .env.example .env
echo "ONDA_MASTER_KEY=$(openssl rand -base64 32)" >> .env
docker compose -f deploy/compose.yaml --profile full --profile app up -d
# → 콘솔 :3000 · API :8080 · 워커 metrics :9090
```

자세한 배포·관리형 DB·백업·업그레이드는 [docs-public/DEPLOY.md](docs-public/DEPLOY.md).

## 운영 도구

```bash
go run ./apps/worker/cmd/seed --tenant <uuid> --app <uuid> --users 500000   # 합성 데이터
go run ./apps/worker/cmd/loadgen --key pk_... --rate 5000 --dur 30s          # 수집 부하
node tests/isolation/run.mjs                                                  # 테넌트 격리 검증
```

## 라이선스

MIT
