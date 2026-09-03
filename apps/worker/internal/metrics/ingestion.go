package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	ProjectionCommitted = promauto.NewCounter(prometheus.CounterOpts{
		Name: "nudgeon_ingest_receipts_projected_total",
		Help: "Unique receipt projection markers after CH write and successful PG commit acknowledgement",
	})
	ProjectionAge = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "nudgeon_ingest_receipt_to_projection_seconds",
		Help:    "PG pre-commit receipt timestamp to worker post-commit observation; NOT commit-to-commit latency; depends on synchronized clocks",
		Buckets: []float64{.01, .05, .1, .25, .5, 1, 2, 5, 10, 30, 60, 120},
	})
	ProjectionClockSkew = promauto.NewCounter(prometheus.CounterOpts{
		Name: "nudgeon_ingest_projection_clock_skew_total",
		Help: "Committed receipts with a future received_at; excluded from latency histogram, not event count",
	})
	ProjectionStage = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "nudgeon_ingest_projection_stage_seconds",
		Help:    "Projection operation attempts including failures; SQL stages include network and server execution, not pure lock wait",
		Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2, 5, 10, 30},
	}, []string{"stage", "outcome"})
	ProjectionCHRows = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nudgeon_ingest_clickhouse_rows_acknowledged_total",
		Help: "Rows acknowledged by synchronous CH insert, including retry writes; NOT unique projection count",
	}, []string{"table"})
	ProjectionCHDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "nudgeon_ingest_clickhouse_insert_seconds",
		Help:    "Synchronous CH prepare, append and send attempts including failures",
		Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2, 5, 10, 30},
	}, []string{"table", "outcome"})
)
