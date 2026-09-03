package main

import (
	"context"
	"encoding/json"
	"io"
	"math/rand/v2"
	"net/http"
	"strings"
	"testing"
	"time"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestTryEnqueueCountsGeneratorDrop(t *testing.T) {
	jobs := make(chan loadJob, 1)
	counters := &loadCounters{}
	tryEnqueue(loadJob{sequence: 1}, jobs, counters)
	tryEnqueue(loadJob{sequence: 2}, jobs, counters)

	got := counters.snapshot()
	if got.scheduled != 2 || got.enqueued != 1 || got.dropped != 1 {
		t.Fatalf("unexpected counters: %+v", got)
	}
}

func TestEvaluateRejectsDropErrorsRateAndP99(t *testing.T) {
	cfg := loadConfig{maxDropRate: 0, maxErrorRate: 0, minRateRatio: 0.99, maxP99: 100 * time.Millisecond}
	result := loadResult{
		expected: 100,
		counters: counterSnapshot{
			scheduled: 100, enqueued: 99, dropped: 1, started: 99,
			accepted: 98, acceptedInWindow: 98, httpErrors: 1,
		},
		endToEndLatency: latencyStats{p99: 150 * time.Millisecond},
	}
	violations := evaluate(result, cfg)
	if len(violations) != 4 {
		t.Fatalf("expected drop, error, rate and p99 violations; got %v", violations)
	}
}

func TestEvaluateAcceptsBalancedRun(t *testing.T) {
	cfg := loadConfig{maxDropRate: 0, maxErrorRate: 0, minRateRatio: 0.99, maxP99: 100 * time.Millisecond}
	result := loadResult{
		expected: 100,
		counters: counterSnapshot{
			scheduled: 100, enqueued: 100, started: 100, accepted: 100, acceptedInWindow: 100,
		},
		endToEndLatency: latencyStats{p99: 20 * time.Millisecond},
	}
	if violations := evaluate(result, cfg); len(violations) != 0 {
		t.Fatalf("unexpected violations: %v", violations)
	}
}

func TestPostTrackCarriesRunIdentityAndClassifiesStatus(t *testing.T) {
	var body map[string]any
	client := &http.Client{Transport: roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/v1/track" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer pk_test" {
			t.Fatalf("authorization=%q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return &http.Response{
			StatusCode: http.StatusTooManyRequests,
			Body:       io.NopCloser(strings.NewReader("")),
			Header:     make(http.Header),
		}, nil
	})}

	job := loadJob{sequence: 42, scheduledAt: time.Now()}
	result := postTrack(context.Background(), client, "https://load.test/", "pk_test", "run-123", job, rand.New(rand.NewPCG(1, 7)))
	if result.err != nil || result.statusCode != http.StatusTooManyRequests {
		t.Fatalf("result=%+v", result)
	}
	batch, ok := body["batch"].([]any)
	if !ok || len(batch) != 1 {
		t.Fatalf("batch=%#v", body["batch"])
	}
	event := batch[0].(map[string]any)
	properties := event["properties"].(map[string]any)
	if properties["load_run_id"] != "run-123" || properties["load_sequence"] != float64(42) {
		t.Fatalf("properties=%#v", properties)
	}
}

func TestLatencyStatsUsesConservativeNearestRank(t *testing.T) {
	r := &latencyRecorder{}
	for _, sample := range []time.Duration{100 * time.Millisecond, 10 * time.Millisecond, 40 * time.Millisecond, 20 * time.Millisecond} {
		r.record(sample)
	}
	stats := r.stats()
	if stats.p50 < 20*time.Millisecond || stats.p50 > 20*time.Millisecond+20*time.Microsecond || stats.p99 != 100*time.Millisecond || stats.max != 100*time.Millisecond || stats.count != 4 {
		t.Fatalf("stats=%+v", stats)
	}
	if again := r.stats(); again != stats {
		t.Fatalf("second stats=%+v first=%+v", again, stats)
	}
}
