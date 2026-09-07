package metrics

import (
	"context"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/ops"
)

const (
	QueuePollInterval = 10 * time.Second
	QueueQueryTimeout = 2 * time.Second
)

// QueueCollector — 스트림 트림으로 인한 유실을 관측한다.
//
// 기존 backlog 경보는 "얼마나 밀렸는가"를 본다. 이 collector는 "이미 잘려나갔는가"와
// "잘리기까지 얼마나 남았는가"를 본다. 둘은 다른 사건이며, 밀림 경보가 울리기 전에
// 잘려나갈 수 있다.
type QueueCollector struct {
	mu   sync.RWMutex
	clk  clock.Clock
	load func(context.Context) ([]ops.QueueStat, error)

	stats       []ops.QueueStat
	valid       bool
	success     bool
	lastSuccess time.Time
	duration    time.Duration
	errors      uint64

	length, added, read, pending     *prometheus.Desc
	trimLoss, unreadTrimmed, fill    *prometheus.Desc
	healthy, last, failures, elapsed *prometheus.Desc
}

func NewQueueCollector(clk clock.Clock, load func(context.Context) ([]ops.QueueStat, error)) *QueueCollector {
	desc := func(name, help string, labels []string) *prometheus.Desc {
		return prometheus.NewDesc("nudgeon_queue_"+name, help, labels, nil)
	}
	sl := []string{"stream"}
	gl := []string{"stream", "group"}
	return &QueueCollector{clk: clk, load: load,
		length:   desc("length", "Entries currently retained in the stream", sl),
		added:    desc("entries_added_total", "Entries ever added to the stream; unaffected by trimming", sl),
		fill:     desc("fill_ratio", "Current length divided by the configured MAXLEN; the only pre-loss signal", sl),
		read:     desc("group_entries_read_total", "Entries ever read by the consumer group", gl),
		pending:  desc("group_pending", "Entries delivered to the group but not acknowledged", gl),
		trimLoss: desc("group_trim_loss", "1 when entries were trimmed before this group consumed them; this is data loss, not lag", gl),
		unreadTrimmed: desc("group_unread_trimmed_estimate",
			"Lower-bound estimate of unconsumed entries lost to trimming; read only when group_trim_loss is 1", gl),
		healthy:  desc("collector_success", "Whether the most recent Redis snapshot succeeded", nil),
		last:     desc("collector_last_success_timestamp_seconds", "Unix timestamp of last successful snapshot", nil),
		failures: desc("collector_errors_total", "Failed snapshots; the last successful values are retained", nil),
		elapsed:  desc("collector_duration_seconds", "Duration of the latest snapshot attempt", nil),
	}
}

func (c *QueueCollector) Refresh(ctx context.Context) error {
	started := c.clk.Now()
	qctx, cancel := context.WithTimeout(ctx, QueueQueryTimeout)
	defer cancel()
	stats, err := c.load(qctx)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.duration = c.clk.Now().Sub(started)
	if err != nil {
		// 실패는 UNKNOWN이다. 마지막 성공값을 유지하고 0으로 덮지 않는다 —
		// 0은 "유실 없음"으로 읽히기 때문이다.
		c.success = false
		c.errors++
		return err
	}
	c.stats, c.valid, c.success = stats, true, true
	c.lastSuccess = c.clk.Now()
	return nil
}

func (c *QueueCollector) Run(ctx context.Context) error {
	t := time.NewTicker(QueuePollInterval)
	defer t.Stop()
	_ = c.Refresh(ctx)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			_ = c.Refresh(ctx)
		}
	}
}

// Ready — 첫 성공 전에는 준비되지 않은 것으로 본다.
func (c *QueueCollector) Ready(context.Context) error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.valid {
		return errQueueNotReady
	}
	return nil
}

var errQueueNotReady = queueErr("queue collector has no successful snapshot yet")

type queueErr string

func (e queueErr) Error() string { return string(e) }

func (c *QueueCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{c.length, c.added, c.fill, c.read, c.pending,
		c.trimLoss, c.unreadTrimmed, c.healthy, c.last, c.failures, c.elapsed} {
		ch <- d
	}
}

func (c *QueueCollector) Collect(ch chan<- prometheus.Metric) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	success, last := 0.0, 0.0
	if c.success {
		success = 1
	}
	if !c.lastSuccess.IsZero() {
		last = float64(c.lastSuccess.Unix())
	}
	ch <- prometheus.MustNewConstMetric(c.healthy, prometheus.GaugeValue, success)
	ch <- prometheus.MustNewConstMetric(c.last, prometheus.GaugeValue, last)
	ch <- prometheus.MustNewConstMetric(c.failures, prometheus.CounterValue, float64(c.errors))
	ch <- prometheus.MustNewConstMetric(c.elapsed, prometheus.GaugeValue, c.duration.Seconds())

	if !c.valid {
		return // 첫 성공 전에는 0을 내보내지 않는다.
	}
	for _, s := range c.stats {
		ch <- prometheus.MustNewConstMetric(c.length, prometheus.GaugeValue, float64(s.Length), s.Stream)
		ch <- prometheus.MustNewConstMetric(c.added, prometheus.CounterValue, float64(s.EntriesAdded), s.Stream)
		ch <- prometheus.MustNewConstMetric(c.fill, prometheus.GaugeValue, s.FillRatio, s.Stream)
		ch <- prometheus.MustNewConstMetric(c.read, prometheus.CounterValue, float64(s.EntriesRead), s.Stream, s.Group)
		ch <- prometheus.MustNewConstMetric(c.pending, prometheus.GaugeValue, float64(s.Pending), s.Stream, s.Group)
		loss := 0.0
		if s.TrimLoss {
			loss = 1
		}
		ch <- prometheus.MustNewConstMetric(c.trimLoss, prometheus.GaugeValue, loss, s.Stream, s.Group)
		ch <- prometheus.MustNewConstMetric(c.unreadTrimmed, prometheus.GaugeValue, float64(s.UnreadTrimmed), s.Stream, s.Group)
	}
}
