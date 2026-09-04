package channel

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/metrics"
	"github.com/redis/go-redis/v9"
)

const statusDLQPending = "dlq_pending|"

// A persistent marker fences provider calls while only the DLQ write is retried.
// No TTL: a prolonged DB outage must not turn this back into a fresh send.
// Successful persistence atomically replaces it with the normal 7-day terminal
// marker. Redis durability/retention and stream retention remain prerequisites.
type pendingDLQ struct {
	FailureID string    `json:"failure_id"`
	MessageID string    `json:"message_id"`
	Class     string    `json:"class"`
	Detail    string    `json:"detail"`
	Attempts  int       `json:"attempts"`
	At        time.Time `json:"at"`
}

var errDLQStateChanged = errors.New("DLQ state changed; leave the queue item pending")

var markDLQPending = redis.NewScript(`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`)

var commitDLQ = redis.NewScript(`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('DEL', KEYS[2], KEYS[3])
return 1`)

func beginDLQ(ctx context.Context, rdb redis.Cmdable, key, lease string, p pendingDLQ) (rawValue string, resultErr error) {
	defer func() {
		if resultErr != nil {
			metrics.DLQOperationErrors.WithLabelValues("marker").Inc()
		}
	}()
	p.FailureID = uuid.NewString()
	if len(p.Detail) > 1024 {
		p.Detail = strings.ToValidUTF8(p.Detail[:1024], "") + " [truncated]"
	}
	data, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	raw := statusDLQPending + string(data)
	n, err := markDLQPending.Run(ctx, rdb, []string{key}, lease, raw).Int()
	if err != nil {
		return "", err
	}
	if n != 1 {
		return "", errDLQStateChanged
	}
	return raw, nil
}

func finishDLQ(ctx context.Context, rdb redis.Cmdable, key, attemptsKey, retryAtKey, raw string,
	persist func(pendingDLQ) error) (pendingDLQ, error) {
	var p pendingDLQ
	if !strings.HasPrefix(raw, statusDLQPending) || len(raw) > 8192 {
		metrics.DLQOperationErrors.WithLabelValues("state").Inc()
		return p, errors.New("invalid DLQ pending state")
	}
	if err := json.Unmarshal([]byte(strings.TrimPrefix(raw, statusDLQPending)), &p); err != nil {
		metrics.DLQOperationErrors.WithLabelValues("state").Inc()
		return p, errors.New("invalid DLQ pending state")
	}
	if _, err := uuid.Parse(p.FailureID); err != nil || p.MessageID == "" || p.At.IsZero() || p.Attempts < maxSendAttempts ||
		(p.Class != "retryable" && p.Class != "rate_limited") {
		metrics.DLQOperationErrors.WithLabelValues("state").Inc()
		return p, errors.New("invalid DLQ pending fields")
	}
	if err := persist(p); err != nil {
		metrics.DLQOperationErrors.WithLabelValues("store").Inc()
		return p, err
	}
	n, err := commitDLQ.Run(ctx, rdb, []string{key, attemptsKey, retryAtKey}, raw,
		statusFailed+"|"+p.Class+"_exhausted", int64(idemCommitTTL/time.Second)).Int()
	if err != nil {
		metrics.DLQOperationErrors.WithLabelValues("finalize").Inc()
		return p, err
	}
	if n != 1 {
		metrics.DLQOperationErrors.WithLabelValues("finalize").Inc()
		return p, errDLQStateChanged
	}
	return p, nil
}
