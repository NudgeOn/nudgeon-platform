package metrics

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/dlq"
	"github.com/prometheus/client_golang/prometheus"
)

func values(t *testing.T, c *DLQCollector) map[string]float64 {
	t.Helper()
	reg := prometheus.NewRegistry()
	reg.MustRegister(c)
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]float64{}
	for _, family := range families {
		for _, metric := range family.Metric {
			key := family.GetName()
			for _, label := range metric.Label {
				key += "|" + label.GetName() + "=" + label.GetValue()
			}
			if metric.Gauge != nil {
				out[key] = metric.Gauge.GetValue()
			} else {
				out[key] = metric.Counter.GetValue()
			}
		}
	}
	return out
}

const backlogKey = "nudgeon_channel_dlq_unresolved_count|failure_class=retryable|stream=stream:send.push"

func TestDLQFirstSnapshotRestartReplayAndResolution(t *testing.T) {
	rows := []dlq.Bucket{{Stream: "stream:send.push", FailureClass: "retryable", Unresolved: 1, Oldest: time.Now().Add(-time.Hour)}}
	c := NewDLQCollector(clock.Real{}, func(context.Context) ([]dlq.Bucket, error) { return rows, nil })
	initial := values(t, c)
	if _, ok := initial[backlogKey]; ok {
		t.Fatal("unread DB was reported as zero")
	}
	if initial["nudgeon_channel_dlq_collector_success"] != 0 || c.Ready(context.Background()) == nil {
		t.Fatal("initial readiness")
	}
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if values(t, c)[backlogKey] != 1 {
		t.Fatal("first existing failure missed without a zero baseline")
	}
	rows[0].Replaying = 1
	_ = c.Refresh(context.Background())
	if values(t, c)[backlogKey] != 1 {
		t.Fatal("replay incorrectly resolved the incident")
	}
	restarted := NewDLQCollector(c.clk, c.load)
	_ = restarted.Refresh(context.Background())
	if values(t, restarted)[backlogKey] != 1 {
		t.Fatal("restart lost durable backlog")
	}
	rows = nil
	_ = c.Refresh(context.Background())
	if v, ok := values(t, c)[backlogKey]; !ok || v != 0 {
		t.Fatal("verified empty snapshot must clear old labels")
	}
}

func TestDLQQueryFailureRetainsSnapshotAndHealth(t *testing.T) {
	fail := false
	c := NewDLQCollector(clock.Real{}, func(context.Context) ([]dlq.Bucket, error) {
		if fail {
			return nil, errors.New("database unavailable")
		}
		return []dlq.Bucket{{Stream: "stream:send.push", FailureClass: "retryable", Unresolved: 2, Oldest: time.Now()}}, nil
	})
	_ = c.Refresh(context.Background())
	before := values(t, c)
	fail = true
	if c.Refresh(context.Background()) == nil {
		t.Fatal("missing query failure")
	}
	after := values(t, c)
	if after[backlogKey] != 2 || after["nudgeon_channel_dlq_collector_success"] != 0 || after["nudgeon_channel_dlq_collector_errors_total"] != 1 {
		t.Fatalf("after=%v", after)
	}
	if before["nudgeon_channel_dlq_collector_last_success_timestamp_seconds"] != after["nudgeon_channel_dlq_collector_last_success_timestamp_seconds"] {
		t.Fatal("failed query advanced freshness")
	}
	if c.Ready(context.Background()) == nil {
		t.Fatal("failed snapshot ready")
	}
}

func TestDLQUnknownDimensionsBoundedAndTimeout(t *testing.T) {
	c := NewDLQCollector(clock.Real{}, func(ctx context.Context) ([]dlq.Bucket, error) {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > DLQQueryTimeout {
			t.Fatal("unbounded query")
		}
		return []dlq.Bucket{{Stream: "secret-vendor-1", FailureClass: "token-1", Unresolved: 1, Oldest: time.Now()},
			{Stream: "secret-vendor-2", FailureClass: "token-2", Unresolved: 2, Oldest: time.Now()}}, nil
	})
	_ = c.Refresh(context.Background())
	v := values(t, c)
	if v["nudgeon_channel_dlq_unresolved_count|failure_class=unknown|stream=unknown"] != 3 {
		t.Fatal("unknown dimensions not folded")
	}
	if len(v) != len(dlq.Streams)*len(dlq.Classes)*3+4 {
		t.Fatalf("metric count=%d", len(v))
	}
	c.mu.Lock()
	c.lastSuccess = time.Now().Add(-DLQStaleAfter - time.Second)
	c.mu.Unlock()
	if c.Ready(context.Background()) == nil {
		t.Fatal("stale snapshot ready")
	}
}

func TestDLQInvalidSnapshotDoesNotReplaceGoodData(t *testing.T) {
	row := dlq.Bucket{Stream: "stream:send.push", FailureClass: "retryable", Unresolved: 1, Oldest: time.Now()}
	c := NewDLQCollector(clock.Real{}, func(context.Context) ([]dlq.Bucket, error) { return []dlq.Bucket{row}, nil })
	_ = c.Refresh(context.Background())
	row.Replaying = 2
	if c.Refresh(context.Background()) == nil || values(t, c)[backlogKey] != 1 {
		t.Fatal("invalid snapshot accepted")
	}
}

func TestDLQScrapesOnlyReadCachedSnapshot(t *testing.T) {
	calls := 0
	c := NewDLQCollector(clock.Real{}, func(context.Context) ([]dlq.Bucket, error) {
		calls++
		return []dlq.Bucket{{Stream: "stream:send.push", FailureClass: "retryable", Unresolved: 1, Oldest: time.Now()}}, nil
	})
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		if values(t, c)[backlogKey] != 1 || c.Ready(context.Background()) != nil {
			t.Fatal("cached snapshot unavailable")
		}
	}
	if calls != 1 {
		t.Fatalf("scrapes/readiness caused extra database calls: %d", calls)
	}
}

func TestDLQFreshnessUsesInjectedClock(t *testing.T) {
	clk := &clock.Fake{Current: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)}
	c := NewDLQCollector(clk, func(context.Context) ([]dlq.Bucket, error) { return nil, nil })
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := c.Ready(context.Background()); err != nil {
		t.Fatal("fresh fake-clock snapshot not ready")
	}
	clk.Advance(DLQStaleAfter + time.Second)
	if c.Ready(context.Background()) == nil {
		t.Fatal("stale snapshot remained ready")
	}
}
