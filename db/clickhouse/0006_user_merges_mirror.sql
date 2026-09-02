-- NudgeOn — user_merges 미러 (PRD-01 3.2, G-9 / R-10). PG user_merges(병합 간선)를 CH로
-- 미러링해 세그먼트/분석의 이벤트 조건이 병합 이전 user_id로 적재된 과거 이벤트를
-- canonical(최종 잔존) 사용자에게 귀속시키도록 한다.
--
-- 동기화: ingest-consumer(sub-01)가 병합이 발생한 마이크로배치에서, 이번 배치가 건드린
-- canonical(to_user_id) 사용자로 향하는 간선을 PG에서 읽어 동봉 upsert 한다 (별도 CDC 없음).
-- 체인 병합(X→Y, 이후 Y→Z)은 merge.go가 PG에서 경로 압축(prior to_user_id=Y → Z)하므로
-- 여기 간선은 항상 최종 canonical을 가리키도록 갱신된다. 쿼리는 argMax(to_user_id, merged_at)로
-- from_user_id별 최신 간선만 채택한다(ReplacingMergeTree 병합 지연에도 정확).

CREATE TABLE IF NOT EXISTS nudgeon.user_merges
(
    tenant_id    UUID,
    app_id       UUID,
    from_user_id UUID,                        -- tombstone된 (병합 소스) 내부 ID
    to_user_id   UUID,                         -- canonical (최종 잔존) 내부 ID
    merged_at    DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(merged_at)
ORDER BY (tenant_id, app_id, from_user_id);
