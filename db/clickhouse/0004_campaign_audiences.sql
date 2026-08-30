-- Onda — 발송/진입 대상 스냅샷 (PRD-02 4.2 v0.2).
-- audience_ref 하나가 "그 시점에 세그먼트 조건을 만족한 user_id 집합"이다.
-- push_reachable 필터는 적용하지 않는다 — 진입 원칙(PRD-03 3.1)과 정합.
-- 스케줄러가 audience_ref 커서로 journey_states를 벌크 생성한다 (IT-2).

CREATE TABLE IF NOT EXISTS onda.campaign_audiences
(
    audience_ref UUID,
    tenant_id    UUID,
    app_id       UUID,
    user_id      UUID,
    created_at   DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (audience_ref, user_id)
TTL toDateTime(created_at) + INTERVAL 7 DAY;   -- 스냅샷은 단기 보존(진입 완료 후 불필요)
