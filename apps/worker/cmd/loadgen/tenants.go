package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/google/uuid"
)

type tenantKey struct {
	TenantID string `json:"tenant_id"`
	Key      string `json:"sdk_key"`
}

func (c *loadConfig) resolveTenantKeys() error {
	if c.key != "" || c.keyFile != "" {
		return errors.New("--keys-file cannot be combined with --key or --key-file")
	}
	f, err := os.Open(c.keysFile)
	if err != nil {
		return errors.New("cannot open --keys-file")
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 1024*1024+1))
	if err != nil || len(data) > 1024*1024 {
		return errors.New("invalid or oversized --keys-file")
	}
	var tenants []tenantKey
	if json.Unmarshal(data, &tenants) != nil || len(tenants) < 1 || len(tenants) > 100 {
		return errors.New("--keys-file must contain 1..100 tenant/key objects")
	}
	ids, keys := map[string]bool{}, map[string]bool{}
	for i := range tenants {
		item := &tenants[i]
		id, err := uuid.Parse(item.TenantID)
		if err != nil || id == uuid.Nil {
			return errors.New("invalid tenant_id in --keys-file")
		}
		item.TenantID = id.String()
		if strings.TrimSpace(item.Key) == "" || len(item.Key) > 4096 || strings.ContainsAny(item.Key, "\r\n") || ids[item.TenantID] || keys[item.Key] {
			return errors.New("invalid or duplicate tenant/key in --keys-file")
		}
		ids[item.TenantID], keys[item.Key] = true, true
	}
	c.tenants = tenants
	c.key = tenants[0].Key // existing basic configuration validation; never serialized
	return nil
}
func (c loadConfig) tenantCount() int {
	if len(c.tenants) > 0 {
		return len(c.tenants)
	}
	return 1
}
func (c loadConfig) tenantIndex(sequence int64) int { return int(sequence % int64(c.tenantCount())) }
func (c loadConfig) requestKey(sequence int64) string {
	if len(c.tenants) > 0 {
		return c.tenants[c.tenantIndex(sequence)].Key
	}
	return c.key
}
func (c loadConfig) tenantIDs() []string {
	ids := make([]string, len(c.tenants))
	for i, item := range c.tenants {
		ids[i] = item.TenantID
	}
	return ids
}
func (c loadConfig) identityNamespace(base string, sequence int64) string {
	if len(c.tenants) > 0 {
		return base + ":tenant:" + c.tenants[c.tenantIndex(sequence)].TenantID
	}
	return base
}

type tenantResult struct {
	TenantID       string `json:"tenant_id"`
	Expected       int64  `json:"expected_requests"`
	Started        int64  `json:"started_requests"`
	Accepted       int64  `json:"accepted_requests"`
	InWindow       int64  `json:"accepted_in_window"`
	Failed         int64  `json:"failed_requests"`
	Dropped        int64  `json:"dropped_requests"`
	NetworkErrors  int64  `json:"network_errors"`
	HTTPErrors     int64  `json:"http_errors"`
	ResponseErrors int64  `json:"response_errors"`
}
type tenantRecorder struct {
	mu      sync.Mutex
	results []tenantResult
}

func newTenantRecorder(cfg loadConfig, expected int64) *tenantRecorder {
	r := &tenantRecorder{results: make([]tenantResult, len(cfg.tenants))}
	for i, item := range cfg.tenants {
		count := expected / int64(len(cfg.tenants))
		if int64(i) < expected%int64(len(cfg.tenants)) {
			count++
		}
		r.results[i] = tenantResult{TenantID: item.TenantID, Expected: count}
	}
	return r
}
func (r *tenantRecorder) record(sequence int64, kind byte, inWindow bool) {
	if len(r.results) == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	item := &r.results[sequence%int64(len(r.results))]
	switch kind {
	case eventStarted:
		item.Started++
	case eventAccepted:
		item.Accepted++
		if inWindow {
			item.InWindow++
		}
	case eventNetworkError:
		item.NetworkErrors++
	case eventHTTPError:
		item.HTTPErrors++
	case eventResponseError:
		item.ResponseErrors++
	}
}
func (r *tenantRecorder) snapshot() []tenantResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := append([]tenantResult(nil), r.results...)
	for i := range result {
		result[i].Failed = result[i].Expected - result[i].Accepted
		result[i].Dropped = result[i].Expected - result[i].Started
	}
	return result
}
func evaluateTenants(results []tenantResult, cfg loadConfig) []string {
	var failures []string
	for _, r := range results {
		if r.Expected == 0 || r.Started > r.Expected || r.InWindow > r.Accepted || r.Started != r.Accepted+r.NetworkErrors+r.HTTPErrors+r.ResponseErrors ||
			ratio(r.Dropped, r.Expected) > cfg.maxDropRate || ratio(r.NetworkErrors+r.HTTPErrors+r.ResponseErrors, r.Started) > cfg.maxErrorRate || ratio(r.InWindow, r.Expected) < cfg.minRateRatio {
			failures = append(failures, fmt.Sprintf("tenant %s request/accounting/rate gate failed", r.TenantID))
		}
	}
	return failures
}
