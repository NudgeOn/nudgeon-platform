package channel

import (
	"context"
	"errors"
	"testing"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/metrics"
	dto "github.com/prometheus/client_model/go"
)

func dlqErrorCount(t *testing.T, stage string) float64 {
	t.Helper()
	m := &dto.Metric{}
	if err := metrics.DLQOperationErrors.WithLabelValues(stage).Write(m); err != nil {
		t.Fatal(err)
	}
	return m.GetCounter().GetValue()
}

func TestDLQOperationMetricsCountFailedAttemptsOnly(t *testing.T) {
	w, mr, fk := newTestWorker(t, nil)
	ctx := context.Background()
	before := map[string]float64{}
	for _, stage := range []string{"marker", "state", "store", "finalize"} {
		before[stage] = dlqErrorCount(t, stage)
	}
	mr.Set("send:idem:t1:idem-1", "processing|owner")
	p := pendingDLQ{MessageID: "synthetic", Class: "retryable", Attempts: 5, At: fk.Now()}
	if _, err := beginDLQ(ctx, w.rdb, "send:idem:t1:idem-1", "processing|stale", p); err == nil {
		t.Fatal("stale owner succeeded")
	}
	raw, err := beginDLQ(ctx, w.rdb, "send:idem:t1:idem-1", "processing|owner", p)
	if err != nil {
		t.Fatal(err)
	}
	finish := func(value string, persist func(pendingDLQ) error) error {
		_, err := finishDLQ(ctx, w.rdb, "send:idem:t1:idem-1", "attempts", "retryat", value, persist)
		return err
	}
	if finish("dlq_pending|invalid", func(pendingDLQ) error { t.Fatal("invalid state persisted"); return nil }) == nil {
		t.Fatal("bad state accepted")
	}
	for i := 0; i < 3; i++ {
		if finish(raw, func(pendingDLQ) error { return errors.New("database unavailable") }) == nil {
			t.Fatal("store error swallowed")
		}
	}
	failing := &failCommitRedis{Cmdable: w.rdb, fail: true}
	w.rdb = failing
	if finish(raw, func(pendingDLQ) error { return nil }) == nil {
		t.Fatal("finalize error swallowed")
	}
	failing.fail = false
	if err := finish(raw, func(pendingDLQ) error { return nil }); err != nil {
		t.Fatal(err)
	}
	for stage, want := range map[string]float64{"marker": 1, "state": 1, "store": 3, "finalize": 1} {
		if got := dlqErrorCount(t, stage) - before[stage]; got != want {
			t.Fatalf("%s attempts=%v want=%v", stage, got, want)
		}
	}
}
