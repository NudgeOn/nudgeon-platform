-- NudgeOn — 발송 수명주기 (message.lifecycle.v1). 커넥터·공급자 콜백·SDK 이벤트가 수렴하는 채널 중립 원장.
-- 소비자: apps/worker/internal/lifecycle (stream:message.lifecycle → 이 테이블). received_at 최신 행 우선(Replacing).
CREATE TABLE IF NOT EXISTS nudgeon.message_lifecycle
(
    tenant_id           UUID,
    app_id              UUID,
    message_id          UUID,
    status              LowCardinality(String),   -- accepted|sent|delivered|opened|clicked|failed|unsubscribed|bounced
    occurred_at         DateTime64(3, 'UTC'),
    source              LowCardinality(String),   -- engine|connector|provider_callback|sdk
    channel             LowCardinality(String),
    connector_id        LowCardinality(String),
    provider_message_id String,
    user_id             UUID,
    endpoint_id         UUID,
    failure_class       LowCardinality(String),
    failure_detail      String,
    fallback_index      UInt8,
    attempt             UInt8,
    cost_currency       LowCardinality(String),
    cost_amount         Float64,
    click_ref           String,
    received_at         DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, app_id, message_id, status, occurred_at);

-- message_log에 공급자 메시지 ID 보관 → 공급자 콜백(provider_message_id)과 조인.
ALTER TABLE nudgeon.message_log ADD COLUMN IF NOT EXISTS provider_message_id String DEFAULT '';
