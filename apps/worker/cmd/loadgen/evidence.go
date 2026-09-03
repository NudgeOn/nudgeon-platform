package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	eventStarted       byte = 1
	eventAccepted      byte = 2
	eventDropped       byte = 3
	eventHTTPError     byte = 4
	eventNetworkError  byte = 5
	eventResponseError byte = 6
	eventRecordBytes        = 17
)

var errEvidence = errors.New("INVALID_GENERATOR: evidence write failed; retained files are incomplete")

// An append-only binary journal avoids request-count-sized RAM bitmaps. A
// record is kind:uint8, sequence:uint64 LE, count:uint64 LE (ranges for drops).
// A 64 KiB buffer is flushed every second, and files are fsynced on completion.
// A missing summary or an interrupted summary must never be treated as PASS.
type evidenceRecorder struct {
	mu      sync.Mutex
	dir     string
	events  *bufio.Writer
	samples io.Writer
	files   []*os.File
	err     error
	cancel  context.CancelFunc
}

func newEvidence(dir string, metadata any, cancel context.CancelFunc) (*evidenceRecorder, error) {
	if dir == "" {
		return nil, nil
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0700); err != nil {
		return nil, err
	}
	// Never overwrite or append to a previous run, even with the same run ID.
	if err := os.Mkdir(dir, 0700); err != nil {
		return nil, err
	}
	r := &evidenceRecorder{dir: dir, cancel: cancel}
	if err := writeJSONExclusive(filepath.Join(dir, "manifest.json"), metadata); err != nil {
		return nil, err
	}
	for _, name := range []string{"events.bin", "samples.jsonl"} {
		f, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			for _, opened := range r.files {
				_ = opened.Close()
			}
			return nil, err
		}
		r.files = append(r.files, f)
	}
	r.events = bufio.NewWriterSize(r.files[0], 64*1024)
	r.samples = r.files[1]
	return r, nil
}

func writeJSONExclusive(name string, value any) error {
	f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err = json.NewEncoder(f).Encode(value); err != nil {
		return err
	}
	return f.Sync()
}

// All failures cancel generation immediately. Do not print response bodies,
// Authorization headers, request URLs or raw network errors in artifacts.
func (r *evidenceRecorder) fail(err error) error {
	if err != nil && r.err == nil {
		r.err = errEvidence
		r.cancel()
	}
	return r.err
}

func (r *evidenceRecorder) record(kind byte, sequence, count int64) {
	if r == nil {
		return
	}
	var record [eventRecordBytes]byte
	record[0] = kind
	binary.LittleEndian.PutUint64(record[1:9], uint64(sequence))
	binary.LittleEndian.PutUint64(record[9:17], uint64(count))
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return
	}
	_, err := r.events.Write(record[:])
	r.fail(err)
}

func (r *evidenceRecorder) sample(value any) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return
	}
	if r.fail(r.events.Flush()) != nil {
		return
	}
	r.fail(json.NewEncoder(r.samples).Encode(value))
}

func (r *evidenceRecorder) finish(summary any) error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fail(r.events.Flush())
	for _, f := range r.files {
		r.fail(f.Sync())
		r.fail(f.Close())
	}
	if r.err != nil {
		return r.err
	}
	return r.fail(writeJSONExclusive(filepath.Join(r.dir, "summary.json"), summary))
}

func (c counterSnapshot) report() map[string]int64 {
	return map[string]int64{
		"scheduled": c.scheduled, "enqueued": c.enqueued, "dropped": c.dropped,
		"started": c.started, "accepted": c.accepted, "accepted_in_window": c.acceptedInWindow,
		"accepted_after_window": c.accepted - c.acceptedInWindow,
		"http_errors":           c.httpErrors, "network_errors": c.networkErrors,
		"response_errors": c.responseErrors, "timeouts": c.timeouts,
		"connections_acquired": c.connectionsAcquired, "connections_reused": c.connectionsReused,
		"tcp_connections_opened": c.connectionsOpened,
	}
}

func (s latencyStats) report() map[string]any {
	return map[string]any{"p50_ns": int64(s.p50), "p99_ns": int64(s.p99), "max_ns": int64(s.max), "count": s.count, "overflow": s.overflow}
}

func (r loadResult) report(cfg loadConfig, runErr error) map[string]any {
	outcome := "PASS"
	violations := evaluate(r, cfg)
	if len(violations) != 0 {
		outcome = "FAIL"
	}
	if runErr != nil {
		outcome = "ABORTED"
	}
	return map[string]any{
		"schema_version": 1, "run_id": r.runID, "outcome": outcome, "violations": violations,
		"scope":    "single-event track HTTP acceptance only; no database or analytics reconciliation",
		"expected": r.expected, "failed_total": r.failedTotal(), "rate_rps": cfg.rate,
		"active_duration_ns": int64(r.activeDuration), "wall_duration_ns": int64(r.wallDuration), "drain_duration_ns": int64(r.drainDuration),
		"counters": r.counters.report(), "http_status_counts": r.httpStatusCounts,
		"latency":      map[string]any{"queue": r.queueLatency.report(), "service": r.serviceLatency.report(), "end_to_end": r.endToEndLatency.report()},
		"completed_at": time.Now().UTC(),
	}
}
