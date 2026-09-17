import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const finite = (value, min = 0) => typeof value === 'number' && Number.isFinite(value) && value >= min;

// Only allowlisted numeric fields reach the report. Never serialize input objects,
// Docker inspect output, credentials, endpoints, or subprocess stderr.
export function evaluate(plan, phaseId, measurements = {}, environment = {}) {
  const phase = plan.phases.find((p) => p.id === phaseId);
  if (!phase) throw new Error('Unknown phase');
  const reasons = [];
  const requireNumber = (object, key, min = 0) => {
    if (!finite(object[key], min)) { reasons.push(`missing_or_invalid:${key}`); return null; }
    return object[key];
  };
  const free = requireNumber(environment, 'free_disk_bytes', 1);
  const vm = requireNumber(environment, 'vm_memory_bytes', 1);
  const existing = requireNumber(environment, 'existing_memory_bytes');
  const memory = requireNumber(measurements, 'candidate_memory_bytes', 1);
  const observedPeak = requireNumber(measurements, 'measured_peak_memory_bytes', 1);
  const bytesPerEvent = requireNumber(measurements, 'measured_storage_bytes_per_event', 1);
  const backup = requireNumber(measurements, 'backup_restore_sort_bytes', 1);
  const generator = requireNumber(measurements, 'generator_memory_bytes', 1);
  const sampleEvents = requireNumber(measurements, 'sample_events', 1);
  const sampleSeconds = requireNumber(measurements, 'sample_duration_seconds', 1);
  const sampleRate = requireNumber(measurements, 'generator_validated_rps', 1);
  const measuredAt = typeof measurements.measured_at === 'string' ? Date.parse(measurements.measured_at) : NaN;
  const now = typeof environment.observed_at === 'string' ? Date.parse(environment.observed_at) : NaN;
  if (!Number.isFinite(measuredAt) || !Number.isFinite(now) || measuredAt > now || now - measuredAt > 24 * 3600 * 1000) reasons.push('measurements_not_current');
  if (measurements.isolated_target !== true) reasons.push('isolated_target_not_confirmed');
  const repeats = phase.consecutive_runs + (phase.extra_required_workloads_once?.length ?? 0);
  // Include retained evidence across every repeat + required workload, without reset.
  const requests = phase.rate_rps * phase.duration_seconds * repeats;
  const events = requests * phase.batch_size;
  const warmupEvents = phase.rate_rps * plan.preflight.warmup_seconds * phase.batch_size * repeats;
  // Current loadgen writes 17 bytes on start + 17 bytes on acknowledgment per request.
  // Reserve double that for batch support/reconciliation, plus fixed report overhead.
  const evidenceBytes = (requests + warmupEvents) * 68 + 64 * MiB;
  const storageGrowth = bytesPerEvent === null ? null : bytesPerEvent * (events + warmupEvents);
  const requiredDisk = storageGrowth === null || backup === null ? null :
    plan.preflight.minimum_disk_safety_gib * GiB + storageGrowth * plan.preflight.forecast_storage_multiplier + backup + evidenceBytes;
  const requiredMemory = memory === null || existing === null || generator === null ? null : memory + existing + generator;
  const allowedMemory = vm === null ? null : vm * (1 - plan.normal_load_gates.min_vm_headroom_fraction);
  if (free !== null && free < plan.preflight.minimum_disk_safety_gib * GiB) reasons.push('disk_below_safety_reserve');
  if (requiredDisk !== null && free !== null && requiredDisk > free) reasons.push('insufficient_disk_forecast');
  if (requiredMemory !== null && allowedMemory !== null && requiredMemory > allowedMemory) reasons.push('insufficient_memory_headroom');
  if (observedPeak !== null && memory !== null && observedPeak > memory * plan.normal_load_gates.max_container_rss_fraction_of_limit) reasons.push('measured_peak_exceeds_candidate_limit');
  if (sampleRate !== null && sampleRate < phase.rate_rps * plan.preflight.generator_validation_rate_multiplier) reasons.push('generator_not_validated_at_required_rate');
  const safeNumbers = [requests, events, warmupEvents, evidenceBytes, storageGrowth, requiredDisk, requiredMemory].filter((n) => n !== null);
  if (safeNumbers.some((n) => !Number.isSafeInteger(Math.ceil(n)))) reasons.push('forecast_overflow');
  return {
    schema_version: 1,
    phase: phaseId,
    observed_at: Number.isFinite(now) ? new Date(now).toISOString() : null,
    outcome: reasons.length ? 'NO_GO_PREFLIGHT' : 'RESOURCE_PREFLIGHT_READY',
    reasons,
    capacity_qualified: false,
    load_started: false,
    scope: 'resource forecast only; requires separate G0, correctness, workload and prerequisite gate evidence',
    environment: { free_disk_bytes: free, vm_memory_bytes: vm, existing_memory_bytes: existing },
    measurements: { candidate_memory_bytes: memory, measured_peak_memory_bytes: observedPeak,
      measured_storage_bytes_per_event: bytesPerEvent, backup_restore_sort_bytes: backup,
      generator_memory_bytes: generator, sample_events: sampleEvents, sample_duration_seconds: sampleSeconds,
      generator_validated_rps: sampleRate },
    forecast: { retained_runs: repeats, requests, events, warmup_events: warmupEvents,
      evidence_bytes: evidenceBytes, storage_growth_bytes: storageGrowth, required_disk_bytes: requiredDisk,
      required_memory_bytes: requiredMemory, allowed_memory_bytes: allowedMemory },
  };
}

function docker(args) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }); }
  catch { throw new Error('Docker inventory unavailable; no load started'); }
}
function parseMemory(value) {
  const match = /^([\d.]+)(B|KiB|MiB|GiB|TiB)$/.exec(value.trim());
  if (!match) throw new Error('Unrecognized Docker memory units');
  return Number(match[1]) * ({ B: 1, KiB: 1024, MiB, GiB, TiB: 1024 ** 4 })[match[2]];
}
export function probeLocal(path = '.') {
  const fs = statfsSync(path);
  const memory = Number(docker(['info', '--format', '{{.MemTotal}}']).trim());
  const stats = docker(['stats', '--no-stream', '--format', '{{json .}}']).trim();
  const existing = stats ? stats.split('\n').reduce((sum, row) => sum + parseMemory(JSON.parse(row).MemUsage.split('/')[0]), 0) : 0;
  return { observed_at: new Date().toISOString(), free_disk_bytes: fs.bavail * fs.bsize, vm_memory_bytes: memory, existing_memory_bytes: existing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const known = new Set(['--phase', '--measurements', '--environment', '--output']);
    const values = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!known.has(args[i]) || !args[i + 1] || Object.hasOwn(values, args[i])) throw new Error('Expected --phase PHASE [--measurements FILE] [--environment FILE] --output NEW_FILE');
      values[args[i]] = args[i + 1];
    }
    if (!values['--phase'] || !values['--output']) throw new Error('Both --phase and --output are required');
    const plan = JSON.parse(readFileSync(new URL('../../../docs-public/capacity/test-plan.json', import.meta.url), 'utf8'));
    const input = (key) => values[key] ? JSON.parse(readFileSync(values[key], 'utf8')) : {};
    const environment = values['--environment'] ? input('--environment') : probeLocal();
    const result = evaluate(plan, values['--phase'], input('--measurements'), environment);
    writeFileSync(values['--output'], `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ outcome: result.outcome, reasons: result.reasons, load_started: false }));
    process.exitCode = result.outcome === 'RESOURCE_PREFLIGHT_READY' ? 0 : 2;
  } catch { console.error('Preflight failed. Check arguments, input files, Docker availability, and a new output path. No load started.'); process.exitCode = 1; }
}
