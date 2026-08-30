// Package config — 12-Factor 환경변수 설정 (PRD-08 1장)
package config

import (
	"cmp"
	"os"
)

type Config struct {
	DatabaseURL   string // PostgreSQL
	RedisURL      string
	ClickHouseURL string // http(s) DSN — API와 동일 변수
	HealthAddr    string // 헬스·지표 리슨 주소
}

func Load() Config {
	return Config{
		DatabaseURL:   cmp.Or(os.Getenv("DATABASE_URL"), "postgres://onda:onda@localhost:5433/onda"),
		RedisURL:      cmp.Or(os.Getenv("REDIS_URL"), "redis://localhost:6379"),
		ClickHouseURL: cmp.Or(os.Getenv("CLICKHOUSE_URL"), "http://onda:onda@localhost:8123/onda"),
		HealthAddr:    cmp.Or(os.Getenv("HEALTH_ADDR"), ":9090"),
	}
}
