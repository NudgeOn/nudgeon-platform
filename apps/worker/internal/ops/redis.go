package ops

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	scanCallsLimit = 256
	scanCountHint  = 256 // Redis COUNT is a hint, not a strict response-size limit.
	scanPageLimit  = 1024
	pendingLimit   = 10000
	markerLimit    = 8192
)

var PendingDefinitions = map[string]string{
	"push_pending_observed_count":               "Unique push DLQ pending markers observed during last complete bounded scan, NOT an atomic snapshot",
	"push_oldest_observed_timestamp_seconds":    "Oldest push DLQ pending failure time observed during last complete scan",
	"message_pending_observed_count":            "Unique message DLQ pending markers observed during last complete bounded scan, NOT an atomic snapshot",
	"message_oldest_observed_timestamp_seconds": "Oldest message DLQ pending failure time observed during last complete scan",
}

// Read-only compatibility observer for existing persistent markers: no new
// index, migration, TTL or change to the send/ACK protocol. Scan duplicates are
// deduplicated; empty pages with a nonzero cursor do not end the pass. Budget or
// parse failures are UNKNOWN, never a partial/zero success. This is intentionally
// a small-installation guardrail, not the high-scale indexed observer for G2/G3.
func PendingSnapshot(ctx context.Context, rdb redis.Cmdable) (map[string]float64, error) {
	values := map[string]float64{}
	for k := range PendingDefinitions {
		values[k] = 0
	}
	seen := make(map[string]struct{})
	var cursor uint64
	for calls := 0; calls < scanCallsLimit; calls++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		keys, next, err := rdb.Scan(ctx, cursor, "send*:idem:*", scanCountHint).Result()
		if err != nil {
			return nil, err
		}
		if len(keys) > scanPageLimit {
			return nil, errors.New("pending scan page budget exceeded")
		}
		pipe := rdb.Pipeline()
		type item struct {
			key, channel string
			value        *redis.StringCmd
		}
		var items []item
		for _, key := range keys {
			channel := ""
			switch {
			case strings.HasPrefix(key, "send:idem:"):
				channel = "push"
			case strings.HasPrefix(key, "send:message:idem:"):
				channel = "message"
			default:
				continue
			}
			if len(key) > 1024 {
				return nil, errors.New("pending key size budget exceeded")
			}
			if _, ok := seen[key]; ok {
				continue
			}
			// Bounded GETRANGE avoids downloading an unbounded value. Include one
			// extra byte to reject truncated pending JSON. A vanished key is empty.
			items = append(items, item{key, channel, pipe.GetRange(ctx, key, 0, markerLimit)})
		}
		if len(items) > 0 {
			if _, err := pipe.Exec(ctx); err != nil {
				return nil, err
			}
		}
		for _, item := range items {
			if _, ok := seen[item.key]; ok {
				continue
			}
			raw, err := item.value.Result()
			if err != nil {
				return nil, err
			}
			if !strings.HasPrefix(raw, "dlq_pending|") {
				continue
			}
			var p struct {
				FailureID string    `json:"failure_id"`
				MessageID string    `json:"message_id"`
				Class     string    `json:"class"`
				Attempts  int       `json:"attempts"`
				At        time.Time `json:"at"`
			}
			if len(raw) > markerLimit || json.Unmarshal([]byte(strings.TrimPrefix(raw, "dlq_pending|")), &p) != nil {
				return nil, errors.New("invalid pending marker")
			}
			if _, err := uuid.Parse(p.FailureID); err != nil || p.MessageID == "" || p.At.Unix() <= 0 || p.Attempts < 5 ||
				(p.Class != "retryable" && p.Class != "rate_limited") {
				return nil, errors.New("invalid pending marker fields")
			}
			if len(seen) >= pendingLimit {
				return nil, errors.New("pending count budget exceeded")
			}
			seen[item.key] = struct{}{}
			values[item.channel+"_pending_observed_count"]++
			timestamp := item.channel + "_oldest_observed_timestamp_seconds"
			at := float64(p.At.UnixNano()) / 1e9
			if values[timestamp] == 0 || at < values[timestamp] {
				values[timestamp] = at
			}
		}
		cursor = next
		if cursor == 0 {
			return values, nil
		}
	}
	return nil, errors.New("pending scan call budget exceeded")
}

var RedisDefinitions = map[string]string{
	"used_memory_bytes":  "Redis INFO used_memory; not container RSS",
	"maxmemory_bytes":    "Redis configured maxmemory; zero means no Redis memory limit",
	"evicted_keys_count": "Redis lifetime evicted_keys, a snapshot gauge that resets with Redis",
	"noeviction":         "Whether Redis reports maxmemory_policy=noeviction",
	"aof_enabled":        "Whether Redis reports appendonly persistence enabled; not proof of durable backup",
	"aof_last_write_ok":  "Whether Redis reports the latest AOF write as ok",
}

func RedisSnapshot(ctx context.Context, rdb redis.Cmdable) (map[string]float64, error) {
	info, err := rdb.Info(ctx, "memory", "stats", "persistence").Result()
	if err != nil {
		return nil, err
	}
	fields := make(map[string]string)
	for _, line := range strings.Split(info, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if ok {
			fields[key] = value
		}
	}
	values := map[string]float64{}
	for metric, field := range map[string]string{"used_memory_bytes": "used_memory", "maxmemory_bytes": "maxmemory", "evicted_keys_count": "evicted_keys", "aof_enabled": "aof_enabled"} {
		v, err := strconv.ParseUint(fields[field], 10, 64)
		if err != nil {
			return nil, errors.New("incomplete Redis INFO")
		}
		values[metric] = float64(v)
	}
	policy := fields["maxmemory_policy"]
	if policy == "" {
		return nil, errors.New("missing Redis memory policy")
	}
	values["noeviction"] = 0
	if policy == "noeviction" {
		values["noeviction"] = 1
	}
	values["aof_last_write_ok"] = 0
	if values["aof_enabled"] == 1 {
		status := fields["aof_last_write_status"]
		if status != "ok" && status != "err" {
			return nil, errors.New("missing Redis AOF status")
		}
		if status == "ok" {
			values["aof_last_write_ok"] = 1
		}
	}
	return values, nil
}
