// Package config — 12-Factor 환경변수 설정 (PRD-08 1장)
package config

import (
	"cmp"
	"fmt"
	"os"
	"strings"
)

type Config struct {
	DatabaseURL   string // PostgreSQL
	RedisURL      string
	ClickHouseURL string // http(s) DSN — API와 동일 변수
	HealthAddr    string // 헬스·지표 리슨 주소
}

// Load는 설정을 읽고, required로 명시한 환경변수가 없으면 에러를 반환한다 (fail-fast).
// 각 바이너리는 "실제로 사용하는" 변수만 required로 넘긴다 — 안 쓰는 설정을 강요하지 않는다
// (예: migrate/seed는 Redis 불필요). 조용한 localhost 기본값은 예측 불가 동작을 낳으므로 금지한다.
// HEALTH_ADDR는 외부 연결 대상이 아닌 바인드 주소이므로 안전한 기본값을 유지한다.
func Load(required ...string) (Config, error) {
	cfg := Config{
		DatabaseURL:   os.Getenv("DATABASE_URL"),
		RedisURL:      os.Getenv("REDIS_URL"),
		ClickHouseURL: os.Getenv("CLICKHOUSE_URL"),
		HealthAddr:    cmp.Or(os.Getenv("HEALTH_ADDR"), ":9090"),
	}
	var missing []string
	for _, key := range required {
		if strings.TrimSpace(os.Getenv(key)) == "" {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		return Config{}, fmt.Errorf(
			"필수 환경변수 누락: %s — 설정 없이 기동 불가(조용한 기본값 금지)",
			strings.Join(missing, ", "))
	}
	return cfg, nil
}
