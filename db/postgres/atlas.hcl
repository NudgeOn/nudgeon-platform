# Atlas 설정 — 선언적 스키마 (ADR-4)
# 적용: atlas schema apply --env local
# diff 확인: atlas schema diff --env local

env "local" {
  src = "file://schema.sql"
  url = getenv("DATABASE_URL")
  dev = "docker://postgres/16/dev?search_path=public"
}
