-- NudgeOn — 발송 로그 (PRD-04 5장). append-only, "왜 안 갔는지"까지 status로 기록.
-- delivered/opened는 SDK 시스템 이벤트($push_delivered/$push_opened)를
-- ingest 경로로 수신 후 message_id 조인 롤업 (S6, IT-8).

CREATE TABLE IF NOT EXISTS nudgeon.message_log
(
    tenant_id       UUID,
    app_id          UUID,
    message_id      UUID,
    idempotency_key String,                  -- (journey_id, version, user_id, node_index, device_id)
    journey_id      UUID,
    journey_version UInt32,
    node_index      UInt16,
    campaign_ref    String,
    user_id         UUID,
    device_id       UUID,
    channel         LowCardinality(String),  -- push_fcm | push_apns | (v1.5: alimtalk …)
    status          LowCardinality(String),  -- sent | failed | skipped_quiet_hours | skipped_cap | skipped_unreachable | duplicate
    failure_class   LowCardinality(String),  -- retryable | rate_limited | permanent_content | invalid_target | ''
    failure_detail  String,
    sent_at         DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(sent_at)
ORDER BY (tenant_id, app_id, sent_at, message_id);
