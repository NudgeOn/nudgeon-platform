package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (c loadConfig) workloadName() string {
	if c.workload == "" {
		return "M2"
	}
	return c.workload
}
func (c loadConfig) batchSize() int {
	if c.workloadName() == "M4" {
		return 10
	}
	return 1
}
func (c loadConfig) validateWorkload() error {
	switch c.workloadName() {
	case "M2":
		if c.identitySeed != "" {
			return errors.New("M2 does not use --identity-seed")
		}
	case "seed", "M0", "M1", "M4":
		if !validRunID.MatchString(c.identitySeed) || c.identityCount < 1 || c.identityCount > 1000000 {
			return errors.New("seed/M0/M1/M4 require a valid --identity-seed and --identity-count in 1..1000000")
		}
	default:
		return errors.New("unsupported workload: use seed, M0, M1, M2 or M4")
	}
	return nil
}

// A single request has one device and one identity, including M4's ten events.
// Shared seed IDs are independent of measurement run IDs. No SQL/credentials are
// embedded: a separate seed run and database reconciliation must prove existence.
func workloadBody(cfg loadConfig, job loadJob) ([]byte, error) {
	if cfg.workloadName() == "M2" {
		return trackBody(cfg.runID, job)
	}
	identityRun := "identity-pool:" + cfg.identitySeed
	identitySequence := job.sequence % int64(cfg.identityCount)
	if cfg.workloadName() == "M1" && job.sequence%100 == 99 {
		identityRun = cfg.runID
		identitySequence = job.sequence
	}
	batch := make([]map[string]any, cfg.batchSize())
	for i := range batch {
		sequence := job.sequence*int64(cfg.batchSize()) + int64(i)
		properties := map[string]any{
			"load_run_id": cfg.runID, "load_sequence": sequence,
			"load_request_sequence": job.sequence, "load_workload": cfg.workloadName(),
			"padding": "",
		}
		encoded, err := json.Marshal(properties)
		if err != nil {
			return nil, err
		}
		if len(encoded) > 1024 {
			return nil, errors.New("workload properties exceed 1024 bytes")
		}
		properties["padding"] = strings.Repeat("x", 1024-len(encoded))
		batch[i] = map[string]any{
			"insert_id":  deterministicID(cfg.runID, "event", sequence),
			"anon_id":    deterministicID(identityRun, "anon", identitySequence),
			"event":      fmt.Sprintf("load_event_%02d", sequence%10),
			"properties": properties,
			"client_ts":  job.scheduledAt.UTC().Format(time.RFC3339Nano),
		}
	}
	return json.Marshal(map[string]any{
		"batch":  batch,
		"device": map[string]any{"device_id": deterministicID(identityRun, "device", identitySequence), "platform": "android"},
	})
}
