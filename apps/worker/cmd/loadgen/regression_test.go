package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"
)

func testConfig(url string) loadConfig {
	return loadConfig{url: url, key: "pk_synthetic_only", rate: 40, duration: 250 * time.Millisecond,
		concurrency: 2, queueCapacity: 4, requestTimeout: time.Second, minRateRatio: .99,
		runID: "regression-test"}
}

func ackResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusAccepted, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestHTTPConnectionReuse(t *testing.T) {
	var connections atomic.Int64
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"accepted":1}`)
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	server.Start()
	defer server.Close()
	client := server.Client()
	defer client.CloseIdleConnections()
	for i := 0; i < 10; i++ {
		out := postTrack(context.Background(), client, server.URL, "pk_synthetic_only", "reuse-test", loadJob{sequence: int64(i), scheduledAt: time.Now()}, nil)
		if out.err != nil || out.statusCode != http.StatusAccepted {
			t.Fatalf("request %d: %+v", i, out)
		}
	}
	if got := connections.Load(); got != 1 {
		t.Fatalf("10 requests opened %d connections, want 1", got)
	}
	t.Log("10 sequential requests / 1 TCP connection")
}

func TestResponseContract(t *testing.T) {
	for name, body := range map[string]string{
		"empty": "", "missing": "{}", "null": "null", "zero": `{"accepted":0}`,
		"partial_batch": `{"accepted":2}`, "string": `{"accepted":"1"}`, "invalid": "<html>bad gateway</html>",
		"trailing": `{"accepted":1}{}`, "oversized": strings.Repeat(" ", maxResponseBytes) + `{"accepted":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) { return ackResponse(body), nil })}
			out := postTrack(context.Background(), client, "http://load.test", "pk_test", "contract", loadJob{}, nil)
			if !errors.Is(out.err, errResponse) {
				t.Fatalf("out=%+v", out)
			}
		})
	}
}

func TestSlowResponseBodyCountsAsTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	out := postTrack(ctx, server.Client(), server.URL, "pk_test", "slow-body", loadJob{}, nil)
	if out.err == nil || !isTimeout(out.err) {
		t.Fatalf("headers alone incorrectly succeeded: %+v", out)
	}
}

type failingReadCloser struct{ closed bool }

func (r *failingReadCloser) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (r *failingReadCloser) Close() error             { r.closed = true; return nil }

func TestTruncatedBodyFailsAndCloses(t *testing.T) {
	body := &failingReadCloser{}
	client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) { return &http.Response{StatusCode: 202, Body: body}, nil })}
	out := postTrack(context.Background(), client, "http://load.test", "pk_test", "truncated", loadJob{}, nil)
	if !errors.Is(out.err, io.ErrUnexpectedEOF) || !body.closed {
		t.Fatalf("out=%+v closed=%v", out, body.closed)
	}
}

func TestRedirectDoesNotSendToAnotherTarget(t *testing.T) {
	var leaked atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { leaked.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client := &http.Client{CheckRedirect: noRedirect, Timeout: time.Second}
	defer client.CloseIdleConnections()
	out := postTrack(context.Background(), client, server.URL, "pk_test", "redirect", loadJob{}, nil)
	if out.err != nil || out.statusCode != 307 || leaked.Load() != 0 {
		t.Fatalf("out=%+v redirected=%d", out, leaked.Load())
	}
}

func TestLateSuccessCannotPassThroughputGate(t *testing.T) {
	cfg := testConfig("http://load.test")
	cfg.rate = 10
	cfg.duration = 100 * time.Millisecond
	client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		time.Sleep(150 * time.Millisecond)
		return ackResponse(`{"accepted":1}`), nil
	})}
	r, err := runLoad(context.Background(), cfg, client)
	if err != nil {
		t.Fatal(err)
	}
	if r.counters.accepted != 1 || r.counters.acceptedInWindow != 0 || r.failedTotal() != 0 {
		t.Fatalf("result=%+v", r)
	}
	if got := evaluate(r, cfg); len(got) != 1 || !strings.Contains(got[0], "처리량") {
		t.Fatalf("late completion falsely passed: %v", got)
	}
}

func TestBackpressureIncludesDropsInFailedTotal(t *testing.T) {
	cfg := testConfig("http://load.test")
	cfg.rate = 200
	cfg.duration = 100 * time.Millisecond
	cfg.concurrency = 1
	cfg.queueCapacity = 1
	client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		time.Sleep(80 * time.Millisecond)
		return ackResponse(`{"accepted":1}`), nil
	})}
	r, err := runLoad(context.Background(), cfg, client)
	if err != nil {
		t.Fatal(err)
	}
	c := r.counters
	if c.dropped == 0 || r.failedTotal() != c.dropped || c.accepted+c.dropped != r.expected {
		t.Fatalf("result=%+v", r)
	}
	if len(evaluate(r, cfg)) == 0 {
		t.Fatal("backpressure falsely passed")
	}
}

func TestHistogramBoundedAndConservative(t *testing.T) {
	r := &latencyRecorder{}
	for us := uint64(0); us <= uint64(latencyLimit/time.Microsecond); us += 37 {
		upper := latencyUpperBound(latencyIndex(us))
		if upper < time.Duration(us)*time.Microsecond {
			t.Fatalf("underestimate at %d us: %s", us, upper)
		}
		if us >= 2048 && float64(uint64(upper/time.Microsecond)-us)/float64(us) > .001 {
			t.Fatalf("precision at %d", us)
		}
	}
	allocs := testing.AllocsPerRun(10, func() {
		for i := 0; i < 10000; i++ {
			r.record(time.Duration(i) * time.Microsecond)
		}
	})
	if allocs != 0 {
		t.Fatalf("record allocations=%f", allocs)
	}
	if bytes := unsafe.Sizeof(*r); bytes > 150*1024 {
		t.Fatalf("histogram=%d bytes", bytes)
	}
	if got := r.stats(); got.count != 110000 || got.overflow != 0 {
		t.Fatalf("stats=%+v", got)
	}
	t.Logf("histogram=%d bytes; record=0 allocations; buckets=%d", unsafe.Sizeof(*r), latencyBuckets)
}

func TestHistogramOverflowAlwaysFails(t *testing.T) {
	r := &latencyRecorder{}
	for i := 0; i < 999; i++ {
		r.record(time.Millisecond)
	}
	r.record(61 * time.Second)
	stats := r.stats()
	if stats.overflow != 1 || stats.count != 1000 || stats.p99 != time.Millisecond || stats.max != 61*time.Second {
		t.Fatalf("stats=%+v", stats)
	}
	result := loadResult{expected: 1000, counters: counterSnapshot{scheduled: 1000, enqueued: 1000, started: 1000, accepted: 1000, acceptedInWindow: 1000}, endToEndLatency: stats}
	if got := evaluate(result, loadConfig{minRateRatio: .99}); len(got) != 1 || !strings.Contains(got[0], "histogram") {
		t.Fatalf("overflow not rejected: %v", got)
	}
}

func TestHistogramConcurrentRecording(t *testing.T) {
	r := &latencyRecorder{}
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 1000; i++ {
				r.record(time.Duration(i) * time.Microsecond)
				if i%100 == 0 {
					_ = r.snapshot()
					_ = r.stats()
				}
			}
		}()
	}
	wg.Wait()
	s := r.snapshot()
	var total uint64
	for _, bucket := range s.Buckets {
		total += bucket[1]
	}
	if s.Count != 8000 || total != 8000 {
		t.Fatalf("count=%d bins=%d", s.Count, total)
	}
}

func TestIdentityAndPayloadAreReproducible(t *testing.T) {
	job := loadJob{sequence: 42, scheduledAt: time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)}
	a, err := trackBody("fixed-run", job)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := trackBody("fixed-run", job)
	if !bytes.Equal(a, b) {
		t.Fatal("payload changed on retry")
	}
	var body struct {
		Batch []struct {
			InsertID string `json:"insert_id"`
		}
	}
	if err := json.Unmarshal(a, &body); err != nil {
		t.Fatal(err)
	}
	if body.Batch[0].InsertID != deterministicID("fixed-run", "event", 42) {
		t.Fatal("manifest identity differs")
	}
	for _, other := range []string{deterministicID("other-run", "event", 42), deterministicID("fixed-run", "event", 43), deterministicID("fixed-run", "anon", 42)} {
		if other == body.Batch[0].InsertID {
			t.Fatal("identity collision across domains")
		}
	}
}

func TestRunEvidenceAndConnectionMetrics(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(202)
		_, _ = io.WriteString(w, `{"accepted":1}`)
	}))
	defer server.Close()
	cfg := testConfig(server.URL)
	cfg.concurrency = 1
	cfg.outputDir = filepath.Join(t.TempDir(), "run")
	r, err := runLoad(context.Background(), cfg, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if violations := evaluate(r, cfg); len(violations) != 0 {
		t.Fatalf("violations=%v", violations)
	}
	if r.counters.connectionsOpened != 1 || r.counters.connectionsReused != r.expected-1 {
		t.Fatalf("trace=%+v", r.counters)
	}
	journal, err := os.ReadFile(filepath.Join(cfg.outputDir, "events.bin"))
	if err != nil {
		t.Fatal(err)
	}
	started, accepted := map[uint64]bool{}, map[uint64]bool{}
	for offset := 0; offset < len(journal); offset += eventRecordBytes {
		record := journal[offset : offset+eventRecordBytes]
		seq := binary.LittleEndian.Uint64(record[1:9])
		if binary.LittleEndian.Uint64(record[9:17]) != 1 {
			t.Fatal("unexpected range")
		}
		switch record[0] {
		case eventStarted:
			if started[seq] {
				t.Fatal("duplicate start")
			}
			started[seq] = true
		case eventAccepted:
			if !started[seq] || accepted[seq] {
				t.Fatal("invalid accepted order")
			}
			accepted[seq] = true
		default:
			t.Fatalf("unexpected kind=%d", record[0])
		}
	}
	if int64(len(accepted)) != r.expected {
		t.Fatalf("journal accepted=%d", len(accepted))
	}
	for _, name := range []string{"manifest.json", "samples.jsonl", "summary.json"} {
		data, err := os.ReadFile(filepath.Join(cfg.outputDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte(cfg.key)) {
			t.Fatalf("credential leaked to %s", name)
		}
		info, _ := os.Stat(filepath.Join(cfg.outputDir, name))
		if info.Mode().Perm() != 0600 {
			t.Fatalf("permissions=%v", info.Mode())
		}
	}
	var summary map[string]any
	data, _ := os.ReadFile(filepath.Join(cfg.outputDir, "summary.json"))
	if err := json.Unmarshal(data, &summary); err != nil {
		t.Fatal(err)
	}
	if summary["outcome"] != "PASS" || summary["failed_total"] != float64(0) {
		t.Fatalf("summary=%v", summary)
	}
	if _, err := runLoad(context.Background(), cfg, server.Client()); err == nil {
		t.Fatal("overwrote existing evidence")
	}
}

type failWriter struct{}

func (failWriter) Write([]byte) (int, error) { return 0, errors.New("disk full") }

func TestEvidenceWriteFailureCancelsAndCannotPass(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := &evidenceRecorder{events: bufio.NewWriterSize(failWriter{}, 1), samples: io.Discard, cancel: cancel}
	r.record(eventStarted, 0, 1)
	if ctx.Err() == nil || !errors.Is(r.err, errEvidence) {
		t.Fatal("evidence failure did not cancel")
	}
	if err := r.finish(map[string]any{"outcome": "PASS"}); !errors.Is(err, errEvidence) {
		t.Fatalf("err=%v", err)
	}
}

func TestCancellationRetainsBalancedFailureEvidence(t *testing.T) {
	cfg := testConfig("http://load.test")
	cfg.duration = time.Second
	cfg.outputDir = filepath.Join(t.TempDir(), "cancelled")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		t.Error("request after cancellation")
		return nil, context.Canceled
	})}
	r, err := runLoad(ctx, cfg, client)
	if !errors.Is(err, context.Canceled) || r.counters.started != 0 || r.counters.dropped != r.expected || r.failedTotal() != r.expected {
		t.Fatalf("result=%+v err=%v", r, err)
	}
	data, err := os.ReadFile(filepath.Join(cfg.outputDir, "summary.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte(`"outcome":"ABORTED"`)) {
		t.Fatalf("summary=%s", data)
	}
}

func TestKeyFileAndValidation(t *testing.T) {
	dir := t.TempDir()
	name := filepath.Join(dir, "key")
	if err := os.WriteFile(name, []byte("pk_synthetic_only\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig("http://load.test")
	cfg.key = ""
	cfg.keyFile = name
	if err := cfg.resolveKey(); err != nil {
		t.Fatal(err)
	}
	if cfg.key != "pk_synthetic_only" {
		t.Fatal("key not trimmed")
	}
	if err := cfg.resolveKey(); err == nil {
		t.Fatal("two key sources accepted")
	}
	for _, bad := range []string{"http://user:secret@load.test", "http://load.test?key=secret", "http://load.test#secret", "file:///tmp/key"} {
		cfg := testConfig(bad)
		if err := cfg.validate(); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("invalid URL accepted or reflected: %v", err)
		}
	}
	for _, name := range []string{"drop", "error", "ratio"} {
		cfg := testConfig("http://load.test")
		switch name {
		case "drop":
			cfg.maxDropRate = math.NaN()
		case "error":
			cfg.maxErrorRate = math.NaN()
		case "ratio":
			cfg.minRateRatio = math.NaN()
		}
		if cfg.validate() == nil {
			t.Fatalf("NaN accepted for %s", name)
		}
	}
}

func TestScheduleOffsetForDayAt5000(t *testing.T) {
	const rate = 5000
	const expected = int64(rate * 24 * 60 * 60)
	if got := scheduleOffset(expected-1, rate); got != 24*time.Hour-200*time.Microsecond {
		t.Fatalf("last offset=%s", got)
	}
}

func BenchmarkLatencyRecord(b *testing.B) {
	r := &latencyRecorder{}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		r.record(time.Duration(i%60000000) * time.Microsecond)
	}
	runtime.KeepAlive(r)
}

func Example_deterministicID() {
	// The same run/sequence determines the insert ID without an in-memory map.
	fmt.Println(deterministicID("example", "event", 42) == deterministicID("example", "event", 42))
	// Output: true
}
