package metrics

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/dlq"
	"github.com/prometheus/client_golang/prometheus"
)

const DLQPollInterval = 5 * time.Second
const DLQQueryTimeout = 2 * time.Second
const DLQStaleAfter = 15 * time.Second

type DLQCollector struct {
	mu                                                              sync.RWMutex
	clk                                                             clock.Clock
	load                                                            func(context.Context) ([]dlq.Bucket, error)
	rows                                                            map[[2]string]dlq.Bucket
	valid, success                                                  bool
	lastSuccess                                                     time.Time
	duration                                                        time.Duration
	errors                                                          uint64
	unresolved, replaying, oldest, healthy, last, failures, elapsed *prometheus.Desc
}

func NewDLQCollector(clk clock.Clock, load func(context.Context) ([]dlq.Bucket, error)) *DLQCollector {
	desc := func(name, help string, labels []string) *prometheus.Desc {
		return prometheus.NewDesc("nudgeon_channel_dlq_"+name, help, labels, nil)
	}
	labels := []string{"stream", "failure_class"}
	return &DLQCollector{clk: clk, load: load,
		unresolved: desc("unresolved_count", "Persisted DLQ items awaiting verified operator resolution, including replaying items", labels),
		replaying:  desc("replaying_count", "Unresolved DLQ items that have been queued for replay; not proof of recovery", labels),
		oldest:     desc("oldest_created_timestamp_seconds", "Oldest unresolved failure timestamp; zero only after a successful empty snapshot", labels),
		healthy:    desc("collector_success", "Whether the most recent database snapshot succeeded", nil),
		last:       desc("collector_last_success_timestamp_seconds", "Unix timestamp of last successful database snapshot", nil),
		failures:   desc("collector_errors_total", "Failed database snapshots (last successful backlog is retained)", nil),
		elapsed:    desc("collector_duration_seconds", "Duration of latest database snapshot attempt", nil),
	}
}

func (c *DLQCollector) Refresh(ctx context.Context) error {
	started := c.clk.Now()
	queryCtx, cancel := context.WithTimeout(ctx, DLQQueryTimeout)
	defer cancel()
	rows, err := c.load(queryCtx)
	next := make(map[[2]string]dlq.Bucket, len(rows))
	if err == nil {
		for _, row := range rows {
			key := [2]string{dlq.Label(row.Stream, dlq.Streams), dlq.Label(row.FailureClass, dlq.Classes)}
			if row.Unresolved < 0 || row.Replaying < 0 || row.Replaying > row.Unresolved || (row.Unresolved > 0 && row.Oldest.IsZero()) {
				err = errors.New("invalid DLQ snapshot")
				break
			}
			current := next[key]
			current.Unresolved += row.Unresolved
			current.Replaying += row.Replaying
			if current.Oldest.IsZero() || (!row.Oldest.IsZero() && row.Oldest.Before(current.Oldest)) {
				current.Oldest = row.Oldest
			}
			next[key] = current
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.duration = c.clk.Now().Sub(started)
	c.success = err == nil
	if err != nil {
		c.errors++
		return err
	} // Never replace unknown/failed data with zero.
	c.rows = next
	c.valid = true
	c.lastSuccess = c.clk.Now()
	return nil
}

func (c *DLQCollector) Run(ctx context.Context) error {
	_ = c.Refresh(ctx)
	ticker := time.NewTicker(DLQPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			_ = c.Refresh(ctx)
		}
	}
}

func (c *DLQCollector) Ready(context.Context) error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.valid || !c.success || c.clk.Now().Sub(c.lastSuccess) > DLQStaleAfter {
		return errors.New("DLQ snapshot unavailable or stale")
	}
	return nil
}

func (c *DLQCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{c.unresolved, c.replaying, c.oldest, c.healthy, c.last, c.failures, c.elapsed} {
		ch <- d
	}
}

func (c *DLQCollector) Collect(ch chan<- prometheus.Metric) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	success, last := float64(0), float64(0)
	if c.success {
		success = 1
	}
	if !c.lastSuccess.IsZero() {
		last = float64(c.lastSuccess.UnixNano()) / 1e9
	}
	ch <- prometheus.MustNewConstMetric(c.healthy, prometheus.GaugeValue, success)
	ch <- prometheus.MustNewConstMetric(c.last, prometheus.GaugeValue, last)
	ch <- prometheus.MustNewConstMetric(c.failures, prometheus.CounterValue, float64(c.errors))
	ch <- prometheus.MustNewConstMetric(c.elapsed, prometheus.GaugeValue, c.duration.Seconds())
	if !c.valid {
		return
	} // No initial DB snapshot: unknown, not an empty queue.
	for _, stream := range dlq.Streams {
		for _, class := range dlq.Classes {
			row := c.rows[[2]string{stream, class}]
			oldest := float64(0)
			if !row.Oldest.IsZero() {
				oldest = float64(row.Oldest.UnixNano()) / 1e9
			}
			ch <- prometheus.MustNewConstMetric(c.unresolved, prometheus.GaugeValue, float64(row.Unresolved), stream, class)
			ch <- prometheus.MustNewConstMetric(c.replaying, prometheus.GaugeValue, float64(row.Replaying), stream, class)
			ch <- prometheus.MustNewConstMetric(c.oldest, prometheus.GaugeValue, oldest, stream, class)
		}
	}
}

func ObserveDLQEntry(stream, class string) {
	DLQEntries.WithLabelValues(dlq.Label(stream, dlq.Streams), dlq.Label(class, dlq.Classes)).Inc()
}

func init() {
	for _, stage := range []string{"marker", "state", "store", "finalize"} {
		DLQOperationErrors.WithLabelValues(stage)
	}
	// Useful for rate charts; the durable gauge is the source for paging.
	for _, stream := range dlq.Streams {
		for _, class := range dlq.Classes {
			DLQEntries.WithLabelValues(stream, class)
		}
	}
}
