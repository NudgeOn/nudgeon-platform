package main

import (
	"runtime"

	"github.com/prometheus/client_golang/prometheus"
)

// Populated by the build; unknown is honest for an uninstrumented build.
var buildRevision = "unknown"
var buildSourceSHA256 = "unknown"
var buildDirty = "unknown"

func registerBuildInfo() {
	gauge := prometheus.NewGauge(prometheus.GaugeOpts{
		Name:        "nudgeon_worker_build_info",
		Help:        "Build-time worker source identity, not proof of deployed API or release provenance",
		ConstLabels: prometheus.Labels{"revision": buildRevision, "source_sha256": buildSourceSHA256, "dirty": buildDirty, "go_version": runtime.Version()},
	})
	gauge.Set(1)
	prometheus.MustRegister(gauge)
}
