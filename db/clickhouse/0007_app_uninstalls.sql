-- NudgeOn — 앱 삭제 감지 (silent/일반 푸시 발송 시 공급자 UNREGISTERED/410 → 토큰 active→invalid 전이).
-- append-only 이벤트. 삭제율 = 기간 내 삭제 수 / (기간 말 활성 디바이스 + 삭제 수) 등으로 산출.
CREATE TABLE IF NOT EXISTS nudgeon.app_uninstalls
(
    tenant_id   UUID,
    app_id      UUID,
    user_id     UUID,
    device_id   UUID,
    platform    LowCardinality(String),   -- ios | android
    detected_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(detected_at)
ORDER BY (tenant_id, app_id, detected_at, device_id);
