package main

import (
	"math"
	"math/bits"
	"sync"
	"time"
)

// Fixed logarithmic histogram: microsecond resolution, 1,024 subdivisions per
// power of two, and at most 0.1% bucket width above 2,048 us. Percentiles use
// conservative upper bounds; max remains exact. No per-request samples remain.
const (
	latencyLimit   = 60 * time.Second
	latencyBuckets = 18 * 1024
)

type latencyStats struct {
	p50, p99, max   time.Duration
	count, overflow uint64
}

type histogramSnapshot struct {
	Count    uint64 `json:"count"`
	Overflow uint64 `json:"overflow"`
	MaxNS    int64  `json:"max_ns"`
	// [bucket index, cumulative count]; schema is independent of Go structs.
	Buckets [][2]uint64 `json:"buckets"`
}

type latencyRecorder struct {
	mu              sync.Mutex
	counts          [latencyBuckets]uint64
	count, overflow uint64
	max             time.Duration
}

func latencyIndex(us uint64) int {
	shift := max(0, bits.Len64(us)-11)
	return shift*1024 + int(us>>shift)
}

func latencyUpperBound(index int) time.Duration {
	if index < 2048 {
		return time.Duration(index) * time.Microsecond
	}
	shift := index/1024 - 1
	upperUS := ((uint64(index%1024) + 1025) << shift) - 1
	return time.Duration(upperUS) * time.Microsecond
}

func (r *latencyRecorder) record(d time.Duration) {
	d = nonNegative(d)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.count++
	r.max = max(r.max, d)
	if d > latencyLimit {
		r.overflow++
		return
	}
	us := uint64((d + time.Microsecond - 1) / time.Microsecond)
	r.counts[latencyIndex(us)]++
}

func (r *latencyRecorder) stats() latencyStats {
	r.mu.Lock()
	defer r.mu.Unlock()
	return latencyStats{p50: r.percentile(.50), p99: r.percentile(.99), max: r.max, count: r.count, overflow: r.overflow}
}

// Caller holds mu. Overflow never disappears from the percentile denominator.
func (r *latencyRecorder) percentile(p float64) time.Duration {
	if r.count == 0 {
		return 0
	}
	rank := uint64(math.Ceil(p * float64(r.count)))
	var seen uint64
	for i, count := range r.counts {
		seen += count
		if seen >= rank {
			return min(latencyUpperBound(i), r.max)
		}
	}
	return r.max
}

func (r *latencyRecorder) snapshot() histogramSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := histogramSnapshot{Count: r.count, Overflow: r.overflow, MaxNS: int64(r.max), Buckets: make([][2]uint64, 0)}
	for i, count := range r.counts {
		if count != 0 {
			s.Buckets = append(s.Buckets, [2]uint64{uint64(i), count})
		}
	}
	return s
}
