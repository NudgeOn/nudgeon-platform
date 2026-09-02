package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSecret(t *testing.T, value string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "value")
	if err := os.WriteFile(path, []byte(value+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadFromFiles(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("REDIS_URL", "")
	t.Setenv("CLICKHOUSE_URL", "")
	t.Setenv("DATABASE_URL_FILE", writeSecret(t, "postgres://nudgeon:secret@postgres:5432/nudgeon"))
	t.Setenv("REDIS_URL_FILE", writeSecret(t, "redis://:secret@redis:6379"))
	t.Setenv("CLICKHOUSE_URL_FILE", writeSecret(t, "http://nudgeon:secret@clickhouse:8123/nudgeon"))

	cfg, err := Load("DATABASE_URL", "REDIS_URL", "CLICKHOUSE_URL")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cfg.DatabaseURL, "nudgeon:secret") || !strings.Contains(cfg.RedisURL, ":secret") {
		t.Fatalf("secret file values were not loaded: %#v", cfg)
	}
}

func TestLoadRejectsInlineAndFile(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://inline")
	t.Setenv("DATABASE_URL_FILE", writeSecret(t, "postgres://file"))
	_, err := Load("DATABASE_URL")
	if err == nil || !strings.Contains(err.Error(), "동시에 설정할 수 없습니다") {
		t.Fatalf("expected ambiguity error, got %v", err)
	}
}
