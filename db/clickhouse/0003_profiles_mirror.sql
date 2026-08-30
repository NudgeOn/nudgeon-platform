-- Onda — profiles_mirror (PRD-02 3.1). PG 현재 상태를 CH로 미러링해
-- 세그먼트 평가를 CH 단일 쿼리로 만든다 (속성·채널 조건 = 미러, 행동 조건 = events 조인).
--
-- 동기화: ingest-consumer(sub-01)가 PG upsert 성공 시 mirror upsert 행을 동일
-- 마이크로배치에 동봉 (별도 CDC 없음). 야간 풀 스냅샷 잡이 대사·보정 (G-4, S4).
-- push_reachable 사전 계산 플래그가 아니라 구성 요소 3필드를 분리 보관하고
-- 쿼리 시점에 카테고리(marketing/transactional)에 맞게 조합한다 (PRD-02 2.3 v0.2).

CREATE TABLE IF NOT EXISTS onda.profiles_mirror
(
    tenant_id     UUID,
    app_id        UUID,
    user_id       UUID,
    external_id   String,                    -- 없으면 빈 문자열 (익명)
    std_attrs     String,                    -- JSON 직렬화
    custom_attrs  String,                    -- JSON 직렬화
    -- push_reachable 구성 요소 (3필드 분리 — 2.3)
    push_opt_in   UInt8,                      -- subscriptions.push == opted_in
    os_permission_granted UInt8,             -- 활성 디바이스 중 granted 존재
    token_active  UInt8,                      -- 활성 토큰 존재
    platforms     Array(String),             -- 보유 플랫폼 (ios/android)
    status        LowCardinality(String),    -- active | merged | deleted
    updated_at    DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, app_id, user_id);
