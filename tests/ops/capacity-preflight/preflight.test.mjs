import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from './preflight.mjs';
const plan = JSON.parse(readFileSync(new URL('../../../docs-public/capacity/test-plan.json', import.meta.url)));
const GiB = 1024 ** 3;
const measurement = {
  measured_at: '2026-09-18T00:00:00Z', isolated_target: true,
  candidate_memory_bytes: 5 * GiB, measured_peak_memory_bytes: 3 * GiB,
  measured_storage_bytes_per_event: 4096, backup_restore_sort_bytes: 10 * GiB,
  generator_memory_bytes: GiB, sample_events: 30000, sample_duration_seconds: 60,
  generator_validated_rps: 7500,
};
const environment = { observed_at: '2026-09-18T01:00:00Z', free_disk_bytes: 10 * 1024 * GiB, vm_memory_bytes: 32 * GiB, existing_memory_bytes: GiB };

test('resource readiness never qualifies capacity or starts load', () => {
  const result = evaluate(plan, 'G1', measurement, environment);
  assert.equal(result.outcome, 'RESOURCE_PREFLIGHT_READY');
  assert.equal(result.capacity_qualified, false);
  assert.equal(result.load_started, false);
  assert.equal(result.forecast.retained_runs, 3); // M0 twice and M1 once
  assert.equal(result.forecast.events, 540000);
  assert.equal(result.forecast.warmup_events, 18000);
});

test('missing measurements fail closed rather than using candidate assumptions', () => {
  const result = evaluate(plan, 'G1', {}, environment);
  assert.equal(result.outcome, 'NO_GO_PREFLIGHT');
  assert(result.reasons.includes('missing_or_invalid:measured_storage_bytes_per_event'));
  assert.equal(result.forecast.required_disk_bytes, null);
});

test('disk must include retained runs, evidence, reserve, backup and amplified growth', () => {
  const baseline = evaluate(plan, 'G1', measurement, environment);
  const result = evaluate(plan, 'G1', measurement, { ...environment, free_disk_bytes: baseline.forecast.required_disk_bytes - 1 });
  assert(result.reasons.includes('insufficient_disk_forecast'));
});

test('24-hour 5000 eps growth is counted, including batch semantics', () => {
  const soak = evaluate(plan, 'S5000', measurement, { ...environment, free_disk_bytes: 100 * GiB });
  assert.equal(soak.forecast.events, 432000000);
  assert(soak.reasons.includes('insufficient_disk_forecast'));
  const batch = evaluate(plan, 'B5000', measurement, environment);
  assert.equal(batch.forecast.events, 18000000);
  assert.equal(batch.forecast.requests, 1800000);
});

test('preserves VM headroom for existing services and load generator', () => {
  const result = evaluate(plan, 'G1', measurement, { ...environment, vm_memory_bytes: 8 * GiB });
  assert(result.reasons.includes('insufficient_memory_headroom'));
});

test('rejects NaN, infinity, negative, stale and future measurements', () => {
  for (const value of [NaN, Infinity, -1, '4096']) {
    assert(evaluate(plan, 'G1', { ...measurement, measured_storage_bytes_per_event: value }, environment).reasons.includes('missing_or_invalid:measured_storage_bytes_per_event'));
  }
  for (const measured_at of ['2026-09-16T00:00:00Z', '2026-09-19T00:00:00Z', 'bad']) {
    assert(evaluate(plan, 'G1', { ...measurement, measured_at }, environment).reasons.includes('measurements_not_current'));
  }
});

test('invalid target, excessive peak, insufficient generator rate block readiness', () => {
  const result = evaluate(plan, 'G1', { ...measurement, isolated_target: false, measured_peak_memory_bytes: 5 * GiB, generator_validated_rps: 100 }, environment);
  assert(result.reasons.includes('isolated_target_not_confirmed'));
  assert(result.reasons.includes('measured_peak_exceeds_candidate_limit'));
  assert(result.reasons.includes('generator_not_validated_at_required_rate'));
});

test('only allowlisted measurements appear in evidence', () => {
  const result = evaluate(plan, 'G1', { ...measurement, password: 'SECRET', url: 'postgres://SECRET@host' }, { ...environment, token: 'SECRET' });
  assert(!JSON.stringify(result).includes('SECRET'));
});

test('unknown phases reject and unsafe integer forecasts block readiness', () => {
  assert.throws(() => evaluate(plan, 'unknown', measurement, environment));
  assert(evaluate(plan, 'G1', { ...measurement, measured_storage_bytes_per_event: Number.MAX_VALUE }, environment).reasons.includes('forecast_overflow'));
});
