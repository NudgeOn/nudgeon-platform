package metrics

import (
	"context"
	"errors"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	"github.com/prometheus/client_golang/prometheus"
)

func snapshotValues(t *testing.T, c *SnapshotCollector) map[string]float64 {
	t.Helper()
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(c)
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]float64{}
	for _, family := range families {
		m := family.Metric[0]
		if m.Gauge != nil {
			values[family.GetName()] = m.Gauge.GetValue()
		} else {
			values[family.GetName()] = m.Counter.GetValue()
		}
	}
	return values
}

func TestOperationsSnapshotUnknownFailureRecoveryStale(t *testing.T) {
	clk := &clock.Fake{Current: time.Unix(1800000000, 0)}
	fail, calls := true, 0
	c := NewSnapshotCollector("test", clk, map[string]string{"count": "test count"}, func(ctx context.Context) (map[string]float64, error) {
		calls++
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > DLQQueryTimeout {
			t.Fatal("no query bound")
		}
		if fail {
			return nil, errors.New("unavailable")
		}
		return map[string]float64{"count": 3}, nil
	})
	if _, ok := snapshotValues(t, c)["nudgeon_ops_test_count"]; ok {
		t.Fatal("unknown became zero")
	}
	if c.Refresh(context.Background()) == nil || c.Ready(context.Background()) == nil {
		t.Fatal("first failure ready")
	}
	if _, ok := snapshotValues(t, c)["nudgeon_ops_test_count"]; ok {
		t.Fatal("first failure became zero")
	}
	fail = false
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := snapshotValues(t, c)
	if before["nudgeon_ops_test_count"] != 3 || c.Ready(context.Background()) != nil {
		t.Fatal(before)
	}
	fail = true
	clk.Advance(time.Second)
	_ = c.Refresh(context.Background())
	after := snapshotValues(t, c)
	if after["nudgeon_ops_test_count"] != 3 || after["nudgeon_ops_test_collector_success"] != 0 ||
		after["nudgeon_ops_test_collector_last_success_timestamp_seconds"] != before["nudgeon_ops_test_collector_last_success_timestamp_seconds"] {
		t.Fatal(after)
	}
	fail = false
	_ = c.Refresh(context.Background())
	clk.Advance(DLQStaleAfter + time.Second)
	if c.Ready(context.Background()) == nil {
		t.Fatal("stale observer ready")
	}
	_ = snapshotValues(t, c)
	if calls != 4 {
		t.Fatalf("scrape/readiness performed IO: %d calls", calls)
	}
}

func TestOperationsSnapshotRejectsPartialAndInvalid(t *testing.T) {
	for name, values := range map[string]map[string]float64{
		"missing": {}, "extra": {"count": 0, "unknown": 1}, "negative": {"count": -1},
		"nan": {"count": math.NaN()}, "infinite": {"count": math.Inf(1)},
	} {
		t.Run(name, func(t *testing.T) {
			c := NewSnapshotCollector("test", clock.Real{}, map[string]string{"count": "count"}, func(context.Context) (map[string]float64, error) { return values, nil })
			if c.Refresh(context.Background()) == nil {
				t.Fatal("invalid snapshot accepted")
			}
			if _, ok := snapshotValues(t, c)["nudgeon_ops_test_count"]; ok {
				t.Fatal("invalid snapshot published")
			}
		})
	}
}

func TestOperationsSnapshotCanceledLoaderAndConcurrentScrapes(t *testing.T) {
	c := NewSnapshotCollector("test", clock.Real{}, map[string]string{"count": "count"}, func(context.Context) (map[string]float64, error) { return map[string]float64{"count": 0}, nil })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if c.Refresh(ctx) == nil {
		t.Fatal("late loader success accepted after cancellation")
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				_ = c.Refresh(context.Background())
				_ = snapshotValues(t, c)
				_ = c.Ready(context.Background())
			}
		}()
	}
	wg.Wait()
}
