package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func decodeWorkload(t *testing.T, cfg loadConfig, sequence int64) map[string]any {
	t.Helper()
	body, err := workloadBody(cfg, loadJob{sequence: sequence, scheduledAt: time.Unix(10, 0)})
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func eventAt(body map[string]any, index int) map[string]any {
	return body["batch"].([]any)[index].(map[string]any)
}

func TestReturningWorkloadsReuseSeedIdentityAcrossRuns(t *testing.T) {
	cfg := loadConfig{runID: "seed-run", workload: "seed", identitySeed: "pool", identityCount: 10000}
	seeded := decodeWorkload(t, cfg, 42)
	cfg.runID, cfg.workload = "measure-run", "M0"
	measured := decodeWorkload(t, cfg, 10042)
	if eventAt(seeded, 0)["anon_id"] != eventAt(measured, 0)["anon_id"] {
		t.Fatal("returning identity changed")
	}
	if seeded["device"].(map[string]any)["device_id"] != measured["device"].(map[string]any)["device_id"] {
		t.Fatal("returning device changed")
	}
	if eventAt(seeded, 0)["insert_id"] == eventAt(measured, 0)["insert_id"] {
		t.Fatal("runs reused event insert IDs")
	}
}
func TestMixedProfileCreatesExactlyOnePercentNewIdentities(t *testing.T) {
	cfg := loadConfig{runID: "mixed", workload: "M1", identitySeed: "pool", identityCount: 10000}
	newCount := 0
	for sequence := int64(0); sequence < 1000; sequence++ {
		mixed := eventAt(decodeWorkload(t, cfg, sequence), 0)
		cfg.workload = "M0"
		returning := eventAt(decodeWorkload(t, cfg, sequence), 0)
		cfg.workload = "M1"
		if mixed["anon_id"] != returning["anon_id"] {
			newCount++
		}
	}
	if newCount != 10 {
		t.Fatalf("new=%d", newCount)
	}
}
func TestBatchHasTenUniqueEventsOneIdentityAndExactPropertiesSize(t *testing.T) {
	cfg := loadConfig{runID: "batch", workload: "M4", identitySeed: "pool", identityCount: 10000}
	ids := map[any]bool{}
	for request := int64(0); request < 2; request++ {
		body := decodeWorkload(t, cfg, request)
		batch := body["batch"].([]any)
		if len(batch) != 10 {
			t.Fatalf("batch length=%d", len(batch))
		}
		anon := eventAt(body, 0)["anon_id"]
		for i := range batch {
			event := eventAt(body, i)
			if ids[event["insert_id"]] {
				t.Fatal("duplicate insert ID")
			}
			ids[event["insert_id"]] = true
			if event["anon_id"] != anon {
				t.Fatal("one device request used multiple identities")
			}
			properties, _ := json.Marshal(event["properties"])
			if len(properties) != 1024 {
				t.Fatalf("properties=%d bytes", len(properties))
			}
			if event["properties"].(map[string]any)["load_sequence"] != float64(request*10+int64(i)) {
				t.Fatal("event sequence mismatch")
			}
		}
	}
}
func TestLegacyM2PayloadRemainsByteIdentical(t *testing.T) {
	job := loadJob{sequence: 42, scheduledAt: time.Unix(10, 0)}
	legacy, _ := trackBody("same", job)
	current, _ := workloadBody(loadConfig{runID: "same", workload: "M2"}, job)
	if !bytes.Equal(legacy, current) {
		t.Fatal("legacy diagnostic workload changed")
	}
}
func TestBatchAcknowledgmentRequiresExactCount(t *testing.T) {
	for _, accepted := range []string{"1", "9", "10", "11", "null"} {
		client := &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 202, Body: io.NopCloser(strings.NewReader(`{"accepted":` + accepted + `}`)), Header: make(http.Header)}, nil
		})}
		cfg := loadConfig{url: "https://load.test", key: "synthetic", runID: "batch", workload: "M4", identitySeed: "pool", identityCount: 10000}
		result := postTrackConfig(context.Background(), client, cfg, loadJob{scheduledAt: time.Unix(10, 0)})
		if (result.err == nil) != (accepted == "10") {
			t.Fatalf("ack=%s result=%+v", accepted, result)
		}
	}
}
func TestWorkloadValidationAndEventAccounting(t *testing.T) {
	for _, cfg := range []loadConfig{{workload: "M3"}, {workload: "M0"}, {workload: "M4", identitySeed: "pool", identityCount: 0}, {workload: "M2", identitySeed: "unused"}} {
		if cfg.validateWorkload() == nil {
			t.Fatalf("accepted invalid config=%+v", cfg)
		}
	}
	cfg := loadConfig{workload: "M4", identitySeed: "pool", identityCount: 10000}
	if err := cfg.validateWorkload(); err != nil {
		t.Fatal(err)
	}
	result := loadResult{expected: 100, counters: counterSnapshot{scheduled: 100, started: 90, accepted: 80, acceptedInWindow: 79, dropped: 10}}
	report := result.report(cfg, nil)
	events := report["events"].(map[string]int64)
	if events["scheduled"] != 1000 || events["accepted"] != 800 || events["failed_total"] != 200 || events["dropped"] != 100 {
		t.Fatalf("events=%v", events)
	}
}
