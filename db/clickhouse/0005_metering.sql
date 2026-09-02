-- NudgeOn — 계측 (PRD-06 5장, T-7). 과금 설계의 전제 데이터.
-- tenant_usage_daily: 일 단위 롤업 MV. MAU(월 활성 프로필 근사)·채널별 발송량.

-- 발송량 일 롤업 (message_log → 일·채널·상태·카테고리 차원)
CREATE TABLE IF NOT EXISTS nudgeon.usage_sends_daily
(
    tenant_id  UUID,
    app_id     UUID,
    day        Date,
    channel    LowCardinality(String),
    status     LowCardinality(String),
    sends      UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, app_id, day, channel, status);

CREATE MATERIALIZED VIEW IF NOT EXISTS nudgeon.mv_usage_sends_daily
TO nudgeon.usage_sends_daily AS
SELECT
    tenant_id, app_id,
    toDate(sent_at) AS day,
    channel, status,
    count() AS sends
FROM nudgeon.message_log
GROUP BY tenant_id, app_id, day, channel, status;

-- 활성 유저 일 집계 (이벤트 기준) — MAU는 조회 시 30일 uniqCombined
CREATE TABLE IF NOT EXISTS nudgeon.usage_active_users_daily
(
    tenant_id UUID,
    app_id    UUID,
    day       Date,
    users     AggregateFunction(uniqCombined, UUID)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, app_id, day);

CREATE MATERIALIZED VIEW IF NOT EXISTS nudgeon.mv_usage_active_users_daily
TO nudgeon.usage_active_users_daily AS
SELECT
    tenant_id, app_id,
    toDate(server_ts) AS day,
    uniqCombinedState(user_id) AS users
FROM nudgeon.events
GROUP BY tenant_id, app_id, day;
