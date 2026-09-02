-- NudgeOn — ClickHouse 수집 테이블 4종 (PRD-01 5.2)
-- 원칙: CH = 수집된 모든 기록(append-only). 모든 테이블 ORDER BY 선두는 tenant_id (PRD-06 4장).
-- 마이그레이션: 순번 SQL. migrator가 순서대로 적용.

-- 1) 수신 payload 원본 (검증 전) — 감사·replay·디버깅. 최종 유실 0의 안전망.
CREATE TABLE IF NOT EXISTS nudgeon.raw_ingestions
(
    tenant_id   UUID,
    app_id      UUID,
    endpoint    LowCardinality(String),   -- track | identify | attributes | devices_token | delete
    api_key_id  UUID,
    payload     String,                   -- 원본 JSON
    received_at DateTime64(3, 'UTC'),
    request_id  UUID
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(received_at)
ORDER BY (tenant_id, app_id, received_at)
TTL toDateTime(received_at) + INTERVAL 30 DAY;   -- 원본은 30일만 보존

-- 2) 검증·정규화된 이벤트 — 세그먼트 평가·분석의 원천.
--    중복 제거: ReplacingMergeTree는 ORDER BY 키 기준 — 재전송 건은 server_ts가 달라지므로
--    클라이언트 고정값(client_ts, insert_id)을 키에 포함한다 (PRD-01 5.2 v0.2 개정).
--    1차 방어는 ingest-consumer의 Redis dedup(7일), 본 엔진은 2차 방어.
CREATE TABLE IF NOT EXISTS nudgeon.events
(
    tenant_id  UUID,
    app_id     UUID,
    event_name LowCardinality(String),
    user_id    UUID,                      -- 내부 ID (병합 반영은 user_merges 매핑 조인)
    device_id  UUID,
    properties String,                    -- JSON 직렬화 (CH JSON 타입 전환은 v1.5 검토)
    client_ts  DateTime64(3, 'UTC'),
    server_ts  DateTime64(3, 'UTC'),      -- 수신 시각 (정렬·집계의 신뢰 기준)
    insert_id  UUID                       -- 멱등 처리용
)
ENGINE = ReplacingMergeTree(server_ts)
PARTITION BY toYYYYMM(server_ts)
ORDER BY (tenant_id, app_id, event_name, user_id, client_ts, insert_id)
TTL toDateTime(server_ts) + INTERVAL 180 DAY;    -- 기본 보존 180일 (플랜별 조정 여지)

-- 3) 속성 변경 이력 — "이 속성이 왜 이 값이지?" 추적 (프로필 변경 감사)
CREATE TABLE IF NOT EXISTS nudgeon.attr_changes
(
    tenant_id  UUID,
    app_id     UUID,
    user_id    UUID,
    attr_key   String,
    old_value  String,                    -- JSON 직렬화 (없으면 빈 문자열)
    new_value  String,                    -- null unset이면 빈 문자열 + change_kind=unset
    change_kind LowCardinality(String),   -- set | unset | merge
    source     LowCardinality(String),    -- sdk | server | console | system
    changed_at DateTime64(3, 'UTC'),
    request_id UUID
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(changed_at)
ORDER BY (tenant_id, app_id, user_id, attr_key, changed_at);

-- 4) 검증 실패 건 — 콘솔 수집 오류 대시보드의 데이터 소스 (PRD-05)
CREATE TABLE IF NOT EXISTS nudgeon.ingestion_errors
(
    tenant_id  UUID,
    app_id     UUID,
    endpoint   LowCardinality(String),
    reason     LowCardinality(String),    -- schema_invalid | type_mismatch | limit_exceeded | ...
    detail     String,
    payload    String,                    -- 실패 원문 (문제 재현용)
    request_id UUID,
    received_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(received_at)
ORDER BY (tenant_id, app_id, received_at)
TTL toDateTime(received_at) + INTERVAL 90 DAY;
