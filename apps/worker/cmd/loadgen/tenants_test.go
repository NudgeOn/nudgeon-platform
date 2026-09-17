package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var fixtureTenants = []tenantKey{
	{TenantID: "11111111-1111-4111-8111-111111111111", Key: "secret-fixture-one"},
	{TenantID: "22222222-2222-4222-8222-222222222222", Key: "secret-fixture-two"},
	{TenantID: "33333333-3333-4333-8333-333333333333", Key: "secret-fixture-three"},
}

func TestTenantKeysArePrivateValidatedAndExclusive(t *testing.T) {
	file := filepath.Join(t.TempDir(), "keys.json")
	data, _ := json.Marshal(fixtureTenants)
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	cfg := loadConfig{keysFile: file}
	if err := cfg.resolveKey(); err != nil {
		t.Fatal(err)
	}
	if cfg.tenantCount() != 3 || cfg.requestKey(4) != fixtureTenants[1].Key {
		t.Fatal("key rotation failed")
	}
	report, _ := json.Marshal(map[string]any{"tenant_ids": cfg.tenantIDs()})
	if strings.Contains(string(report), "secret") {
		t.Fatal("key leaked")
	}
	cfg = loadConfig{keysFile: file, key: "existing"}
	if cfg.resolveKey() == nil {
		t.Fatal("accepted conflicting credential inputs")
	}
	for _, bad := range []string{`[]`, `[{"tenant_id":"bad","sdk_key":"secret"}]`, string(data[:len(data)-1]) + `,{"tenant_id":"11111111-1111-4111-8111-111111111111","sdk_key":"other"}]`} {
		if err := os.WriteFile(file, []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		cfg = loadConfig{keysFile: file}
		err := cfg.resolveKey()
		if err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("bad file result=%v", err)
		}
	}
}
func TestMixedIdentityFractionAppliesPerTenant(t *testing.T) {
	cfg := loadConfig{runID: "tenant-mix", workload: "M1", identitySeed: "pool", identityCount: 100, tenants: fixtureTenants}
	newByTenant := make([]int, 3)
	anonByTenant := []map[any]bool{{}, {}, {}}
	for sequence := int64(0); sequence < 300; sequence++ {
		mixed := eventAt(decodeWorkload(t, cfg, sequence), 0)
		cfg.workload = "M0"
		existing := eventAt(decodeWorkload(t, cfg, sequence), 0)
		cfg.workload = "M1"
		tenant := cfg.tenantIndex(sequence)
		if mixed["anon_id"] != existing["anon_id"] {
			newByTenant[tenant]++
		}
		anonByTenant[tenant][existing["anon_id"]] = true
		if mixed["properties"].(map[string]any)["load_tenant_id"] != fixtureTenants[tenant].TenantID {
			t.Fatal("payload assigned to wrong tenant")
		}
	}
	for i, count := range newByTenant {
		if count != 1 || len(anonByTenant[i]) != 100 {
			t.Fatalf("tenant=%d new=%d identities=%d", i, count, len(anonByTenant[i]))
		}
	}
	for id := range anonByTenant[0] {
		if anonByTenant[1][id] || anonByTenant[2][id] {
			t.Fatal("tenant pools overlap")
		}
	}
}
func TestTenantCountsRetainUnsentRequestsAndEnforcePerTenantRate(t *testing.T) {
	cfg := loadConfig{tenants: fixtureTenants, minRateRatio: 0.99}
	recorder := newTenantRecorder(cfg, 10)
	recorder.record(0, eventStarted, false)
	recorder.record(0, eventAccepted, true)
	recorder.record(1, eventStarted, false)
	recorder.record(1, eventNetworkError, false)
	got := recorder.snapshot()
	if got[0].Expected != 4 || got[1].Expected != 3 || got[2].Expected != 3 || got[0].Dropped != 3 || got[1].Failed != 3 || got[2].Dropped != 3 {
		t.Fatalf("counts=%+v", got)
	}
	if len(evaluateTenants(got, cfg)) != 3 {
		t.Fatal("per-tenant failure not detected")
	}
	// A small tenant must not be hidden by a larger tenant's aggregate throughput.
	got = []tenantResult{{TenantID: fixtureTenants[0].TenantID, Expected: 100, Started: 100, Accepted: 100, InWindow: 98}}
	if len(evaluateTenants(got, cfg)) != 1 {
		t.Fatal("per-tenant late acceptance ignored")
	}
}
