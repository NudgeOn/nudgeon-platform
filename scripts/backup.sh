#!/usr/bin/env bash
# NudgeOn 백업 — PostgreSQL(pg_dump 커스텀 포맷) + ClickHouse(테이블별 Native) + Redis(RDB 스냅샷).
#
#   scripts/backup.sh <출력 디렉터리>
#   환경: PG_CONTAINER(nudgeon-postgres-1) CH_CONTAINER(nudgeon-clickhouse-1) REDIS_CONTAINER(nudgeon-redis-1)
#         PG_USER/PG_DB(nudgeon) CH_USER/CH_PASSWORD/CH_DB(nudgeon)
#
# 복원은 scripts/restore.sh. 리허설(빈 스택 복원 + 정합 대조)은 tests/ops/backup-restore/run.mjs.
# 주의: NUDGEON_MASTER_KEY는 여기 포함되지 않는다. 크리덴셜 복호화에 필요하므로 별도로 안전하게 보관하라.
set -euo pipefail
OUT=${1:?출력 디렉터리}
PG_CONTAINER=${PG_CONTAINER:-nudgeon-postgres-1}
CH_CONTAINER=${CH_CONTAINER:-nudgeon-clickhouse-1}
REDIS_CONTAINER=${REDIS_CONTAINER:-nudgeon-redis-1}
PG_USER=${PG_USER:-nudgeon}; PG_DB=${PG_DB:-nudgeon}
CH_USER=${CH_USER:-nudgeon}; CH_PASSWORD=${CH_PASSWORD:-nudgeon}; CH_DB=${CH_DB:-nudgeon}
mkdir -p "$OUT/clickhouse"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 1. PostgreSQL — 현재 상태(테넌트·유저·디바이스·저니·outbox·세션). 커스텀 포맷은 병렬·선택 복원이 된다.
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc --no-owner --no-privileges > "$OUT/postgres.dump"

# 2. ClickHouse — MaterializedView와 그 대상 테이블은 제외한다. 대상 테이블은 복원 시 원본 테이블 INSERT가
#    MV를 다시 태워 채운다(둘 다 복원하면 두 배가 된다). 테이블 목록은 tables.txt에 남긴다.
docker exec "$CH_CONTAINER" clickhouse-client --user "$CH_USER" --password "$CH_PASSWORD" --query "
  SELECT name FROM system.tables WHERE database='$CH_DB' AND engine NOT LIKE '%MaterializedView%'
    AND name NOT IN (SELECT extract(create_table_query, 'TO [a-z_]+\\.([a-z_]+)') FROM system.tables WHERE database='$CH_DB' AND engine='MaterializedView')
  ORDER BY name FORMAT TSVRaw" > "$OUT/clickhouse/tables.txt"
while read -r t; do
  [ -z "$t" ] && continue
  docker exec "$CH_CONTAINER" clickhouse-client --user "$CH_USER" --password "$CH_PASSWORD" \
    --query "SELECT * FROM $CH_DB.$t FORMAT Native" > "$OUT/clickhouse/$t.native"
done < "$OUT/clickhouse/tables.txt"

# 3. Redis — 큐·발송 멱등 키·빈도 제한 상태. BGSAVE 스냅샷을 복사한다(AOF everysec와 별개 시점 스냅샷).
docker exec "$REDIS_CONTAINER" redis-cli --rdb /data/nudgeon-backup.rdb >/dev/null
docker cp "$REDIS_CONTAINER:/data/nudgeon-backup.rdb" "$OUT/redis.rdb"
docker exec "$REDIS_CONTAINER" rm -f /data/nudgeon-backup.rdb

cat > "$OUT/manifest.json" <<JSON
{"started_at":"$started","finished_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "postgres":{"container":"$PG_CONTAINER","db":"$PG_DB","bytes":$(stat -f%z "$OUT/postgres.dump" 2>/dev/null || stat -c%s "$OUT/postgres.dump")},
 "clickhouse":{"container":"$CH_CONTAINER","db":"$CH_DB","tables":$(wc -l < "$OUT/clickhouse/tables.txt" | tr -d ' ')},
 "redis":{"container":"$REDIS_CONTAINER","bytes":$(stat -f%z "$OUT/redis.rdb" 2>/dev/null || stat -c%s "$OUT/redis.rdb")},
 "note":"NUDGEON_MASTER_KEY is NOT included; keep it with this backup."}
JSON
echo "backup → $OUT"; cat "$OUT/manifest.json"
