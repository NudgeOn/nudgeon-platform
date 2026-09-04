package metrics

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	"github.com/prometheus/client_golang/prometheus"
)

// SnapshotCollector never performs dependency IO from a scrape or readiness
// request. Failed/incomplete refreshes retain the last complete data and mark
// it unavailable; a first failed refresh must not manufacture zero backlog.
type SnapshotCollector struct {
	mu                                    sync.RWMutex
	refreshMu                             sync.Mutex
	clk                                   clock.Clock
	load                                  func(context.Context) (map[string]float64, error)
	descs                                 map[string]*prometheus.Desc
	values                                map[string]float64
	success                               bool
	last                                  time.Time
	duration                              time.Duration
	errors                                uint64
	healthy, timestamp, failures, elapsed *prometheus.Desc
}

func NewSnapshotCollector(component string, clk clock.Clock, definitions map[string]string,
	load func(context.Context) (map[string]float64, error)) *SnapshotCollector {
	desc := func(name, help string) *prometheus.Desc {
		return prometheus.NewDesc("nudgeon_ops_"+component+"_"+name, help, nil, nil)
	}
	c := &SnapshotCollector{clk: clk, load: load, descs: make(map[string]*prometheus.Desc),
		healthy:   desc("collector_success", "Whether the latest complete observation succeeded"),
		timestamp: desc("collector_last_success_timestamp_seconds", "Last complete observation; zero before first success"),
		failures:  desc("collector_errors_total", "Failed or incomplete observation attempts"),
		elapsed:   desc("collector_duration_seconds", "Duration of latest observation attempt"),
	}
	for name, help := range definitions {
		c.descs[name] = desc(name, help)
	}
	return c
}

func (c *SnapshotCollector) Refresh(ctx context.Context) error {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()
	start := c.clk.Now()
	queryCtx, cancel := context.WithTimeout(ctx, DLQQueryTimeout)
	defer cancel()
	values, err := c.load(queryCtx)
	if err == nil {
		err = queryCtx.Err()
	}
	if err == nil {
		if len(values) != len(c.descs) {
			err = errors.New("incomplete observation")
		}
		for name := range c.descs {
			v, ok := values[name]
			if !ok || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
				err = errors.New("invalid observation")
			}
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.duration = c.clk.Now().Sub(start)
	c.success = err == nil
	if err != nil {
		c.errors++
		return err
	}
	c.values = make(map[string]float64, len(values))
	for k, v := range values {
		c.values[k] = v
	}
	c.last = c.clk.Now()
	return nil
}

func (c *SnapshotCollector) Run(ctx context.Context) error {
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

func (c *SnapshotCollector) Ready(context.Context) error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.values == nil || !c.success || c.clk.Now().Sub(c.last) > DLQStaleAfter {
		return errors.New("operations observation unavailable or stale")
	}
	return nil
}

func (c *SnapshotCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range c.descs {
		ch <- d
	}
	for _, d := range []*prometheus.Desc{c.healthy, c.timestamp, c.failures, c.elapsed} {
		ch <- d
	}
}

func (c *SnapshotCollector) Collect(ch chan<- prometheus.Metric) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	success, last := float64(0), float64(0)
	if c.success {
		success = 1
	}
	if !c.last.IsZero() {
		last = float64(c.last.UnixNano()) / 1e9
	}
	ch <- prometheus.MustNewConstMetric(c.healthy, prometheus.GaugeValue, success)
	ch <- prometheus.MustNewConstMetric(c.timestamp, prometheus.GaugeValue, last)
	ch <- prometheus.MustNewConstMetric(c.failures, prometheus.CounterValue, float64(c.errors))
	ch <- prometheus.MustNewConstMetric(c.elapsed, prometheus.GaugeValue, c.duration.Seconds())
	for name, value := range c.values {
		ch <- prometheus.MustNewConstMetric(c.descs[name], prometheus.GaugeValue, value)
	}
}
