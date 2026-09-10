#!/usr/bin/env bash
# NudgeOn 복원 — scripts/backup.sh 산출물을 빈(마이그레이션만 적용된) 스택에 넣는다.
#
#   scripts/restore.sh <백업 디렉터리>
#   환경: 대상 컨테이너 PG_CONTAINER/CH_CONTAINER/REDIS_CONTAINER, PG_USER/PG_DB, CH_USER/CH_PASSWORD/CH_DB
#
# 절차: api·worker를 멈춘 상태에서 실행한다. PostgreSQL은 DB를 비우고 pg_restore(스키마+데이터),
# ClickHouse는 마이그레이션이 만든 테이블에 Native INSERT(MV가 대상 테이블을 다시 채운다),
# Redis는 RDB를 올린 뒤 AOF를 다시 쓴다. 같은 NUDGEON_MASTER_KEY로 api/worker를 띄워야 크리덴셜이 풀린다.
set -euo pipefail
IN=${1:?백업 디렉터리}
PG_CONTAINER=${PG_CONTAINER:?}; CH_CONTAINER=${CH_CONTAINER:?}; REDIS_CONTAINER=${REDIS_CONTAINER:?}
PG_USER=${PG_USER:-nudgeon}; PG_DB=${PG_DB:-nudgeon}
CH_USER=${CH_USER:-nudgeon}; CH_PASSWORD=${CH_PASSWORD:-nudgeon}; CH_DB=${CH_DB:-nudgeon}

# 1. PostgreSQL — 마이그레이터가 만든 빈 스키마를 버리고 덤프의 스키마+데이터로 바꾼다.
#    (덤프에는 schema_migrations도 들어 있어 이후 마이그레이터가 같은 체크섬을 건너뛴다.)
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$PG_DB" --no-owner --no-privileges --exit-on-error < "$IN/postgres.dump"

# 2. ClickHouse — 테이블은 마이그레이션이 이미 만들었다. 비어 있는지 확인하고 Native로 넣는다.
while read -r t; do
  [ -z "$t" ] && continue
  n=$(docker exec "$CH_CONTAINER" clickhouse-client --user "$CH_USER" --password "$CH_PASSWORD" --query "SELECT count() FROM $CH_DB.$t")
  if [ "$n" != "0" ]; then echo "복원 대상 $CH_DB.$t 가 비어 있지 않다($n행) — 중단" >&2; exit 1; fi
  if [ ! -s "$IN/clickhouse/$t.native" ]; then continue; fi # 빈 테이블 덤프 — INSERT할 것이 없다
  docker exec -i "$CH_CONTAINER" clickhouse-client --user "$CH_USER" --password "$CH_PASSWORD" \
    --query "INSERT INTO $CH_DB.$t FORMAT Native" < "$IN/clickhouse/$t.native"
done < "$IN/clickhouse/tables.txt"

# 3. Redis — appendonly가 켜진 서버는 AOF가 없으면 dump.rdb를 무시하고 빈 AOF를 만든다(Redis 7). 그래서
#    대상 컨테이너를 멈추고 → 볼륨에 RDB만 두고 → appendonly=no인 임시 서버로 RDB를 올린 뒤 AOF로 다시 쓰고 →
#    원래 컨테이너를 다시 띄운다(AOF 매니페스트를 찾아 그대로 올린다).
REDIS_VOLUME=$(docker inspect "$REDIS_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
REDIS_IMAGE=$(docker inspect "$REDIS_CONTAINER" --format '{{.Config.Image}}')
[ -n "$REDIS_VOLUME" ] || { echo "Redis /data 볼륨을 찾지 못했다" >&2; exit 1; }
docker stop "$REDIS_CONTAINER" >/dev/null
docker run --rm -v "$REDIS_VOLUME:/data" -v "$IN/redis.rdb:/restore.rdb:ro" alpine sh -c 'rm -rf /data/appendonlydir /data/dump.rdb && cp /restore.rdb /data/dump.rdb && chown 999:999 /data/dump.rdb'
loader=$(docker run -d --rm -v "$REDIS_VOLUME:/data" "$REDIS_IMAGE" redis-server --appendonly no --save "")
for _ in $(seq 1 60); do docker exec "$loader" redis-cli PING 2>/dev/null | grep -q PONG && break; sleep 1; done
loaded=$(docker exec "$loader" redis-cli DBSIZE)
docker exec "$loader" redis-cli CONFIG SET appendonly yes >/dev/null
for _ in $(seq 1 120); do docker exec "$loader" redis-cli INFO persistence | grep -q "aof_rewrite_in_progress:0" && break; sleep 1; done
docker stop "$loader" >/dev/null
docker start "$REDIS_CONTAINER" >/dev/null
for _ in $(seq 1 60); do docker exec "$REDIS_CONTAINER" redis-cli PING 2>/dev/null | grep -q PONG && break; sleep 1; done
echo "restore ← $IN: redis keys loaded=$loaded now=$(docker exec "$REDIS_CONTAINER" redis-cli DBSIZE)"
