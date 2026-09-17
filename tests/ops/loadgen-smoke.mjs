// Tests the built CLI against a loopback-only synthetic responder. No NudgeOn
// services, databases, provider credentials or Docker containers are used.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { reconstruct } from './loadgen-failures/reconstruct.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary)) throw new Error('Usage: node tests/ops/loadgen-smoke.mjs /absolute/path/to/loadgen');
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'nudgeon-loadgen-smoke-'));
const key = 'pk_synthetic_loadgen_smoke_only';
const tenants = [1, 2, 3].map(n => ({tenant_id: `${n}`.repeat(8) + '-' + `${n}`.repeat(4) + '-4' + `${n}`.repeat(3) + '-8' + `${n}`.repeat(3) + '-' + `${n}`.repeat(12), sdk_key: `pk_synthetic_tenant_${n}`}));
const keysFile = path.join(evidence, 'keys.json');
await fs.writeFile(keysFile, JSON.stringify(tenants), {mode: 0o600});
let mode = 'normal', requestCount = 0, firstRequest;
const observedIDs = new Set();
const observedByRun = new Map();
const observedBodies = new Map();
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  assert.equal(req.url, '/v1/track');
  assert([key, ...tenants.map(t => t.sdk_key)].some(k => req.headers.authorization === `Bearer ${k}`));
  const body = JSON.parse(Buffer.concat(chunks));
  observedBodies.set(`${body.batch[0].properties.load_run_id}:${Math.floor(body.batch[0].properties.load_sequence/body.batch.length)}`,body);
  for (const event of body.batch) {
    observedIDs.add(event.insert_id);
    const run = event.properties.load_run_id;
    if (event.properties.load_tenant_id) {
      const tenant = tenants.find(t => t.tenant_id === event.properties.load_tenant_id);
      assert.equal(req.headers.authorization, `Bearer ${tenant.sdk_key}`);
    }
    if (!observedByRun.has(run)) observedByRun.set(run, []);
    observedByRun.get(run).push(event);
  }
  requestCount++;
  firstRequest?.(); firstRequest = undefined;
  if (mode === 'late') await new Promise(resolve => setTimeout(resolve, 150));
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ accepted: mode === 'invalid' ? 0 : body.batch.length }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

async function run(label, args = [], interrupt = false, logLabel = label) {
  const outputDir = path.join(evidence, label);
  const credentials = args.includes('--keys-file') ? [] : ['--key-file', '-'];
  const child = spawn(binary, ['--url', url, ...credentials, '--rate', '200', '--dur', '1s',
    '--concurrency', '8', '--request-timeout', '1s', '--max-p99', '500ms', '--run-id', label,
    '--output-dir', outputDir, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', data => output.push(data));
  child.stderr.on('data', data => output.push(data));
  child.stdin.on('error', () => {});
  if (interrupt) firstRequest = () => setTimeout(() => child.kill('SIGTERM'), 10);
  child.stdin.end(key);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timeout);
  const text = Buffer.concat(output).toString();
  assert([key, ...tenants.map(t => t.sdk_key)].every(k => !text.includes(k)), 'key leaked in output');
  await fs.writeFile(path.join(evidence, `${logLabel}.log`), text, { mode: 0o600 });
  let summary;
  try { summary = JSON.parse(await fs.readFile(path.join(outputDir, 'summary.json'), 'utf8')); } catch {}
  return { code, summary, outputDir, text };
}

function uuidV5(namespace, value) {
  const bytes = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

try {
  const normal = await run('normal');
  assert.equal(normal.code, 0, normal.text);
  assert.equal(normal.summary.outcome, 'PASS');
  assert.equal(normal.summary.failed_total, 0);
  assert.equal(normal.summary.counters.accepted, 200);
  assert(normal.summary.counters.accepted_in_window >= 198);
  assert(normal.summary.counters.connections_reused > 0);
  const journal = await fs.readFile(path.join(normal.outputDir, 'events.bin'));
  assert.equal(journal.length, 200 * 2 * 17);
  const starts = new Set(), successes = new Set();
  const namespace = uuidV5('6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'nudgeon-loadgen:v1:normal');
  for (let offset = 0; offset < journal.length; offset += 17) {
    const sequence = Number(journal.readBigUInt64LE(offset + 1));
    assert.equal(journal.readBigUInt64LE(offset + 9), 1n);
    const id = uuidV5(namespace, `event:${sequence}`);
    assert(observedIDs.has(id), 'reconstructed ID missing from actual request');
    if (journal[offset] === 1) { assert(!starts.has(id)); starts.add(id); }
    else { assert.equal(journal[offset], 2); assert(starts.has(id)); assert(!successes.has(id)); successes.add(id); }
  }
  assert.equal(successes.size, 200);
  const samples = (await fs.readFile(path.join(normal.outputDir, 'samples.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const last = samples.at(-1);
  for (const histogram of Object.values(last.histograms)) {
    assert.equal(histogram.count, 200);
    assert.equal(histogram.buckets.reduce((total, [, count]) => total + count, histogram.overflow), 200);
  }

  const profiles = {};
  for (const workload of ['seed', 'M0', 'M1', 'M4']) {
    const label = `profile-${workload}`;
    profiles[workload] = await run(label, ['--workload', workload, '--identity-seed', 'smoke-pool', '--identity-count', '200']);
    assert.equal(profiles[workload].code, 0, profiles[workload].text);
    assert.equal(profiles[workload].summary.events.accepted, workload === 'M4' ? 2000 : 200);
    for (const event of observedByRun.get(label)) assert.equal(Buffer.byteLength(JSON.stringify(event.properties)), 1024);
  }
  const seeded = new Set(observedByRun.get('profile-seed').map(e => e.anon_id));
  assert.equal(seeded.size, 200);
  assert(observedByRun.get('profile-M0').every(e => seeded.has(e.anon_id)));
  assert.equal(observedByRun.get('profile-M1').filter(e => !seeded.has(e.anon_id)).length, 2);
  const batched = observedByRun.get('profile-M4');
  assert(batched.every(e => seeded.has(e.anon_id)));
  assert.equal(new Set(batched.map(e => e.insert_id)).size, 2000);
  const batchJournal = await fs.readFile(path.join(profiles.M4.outputDir, 'events.bin'));
  const batchNamespace = uuidV5('6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'nudgeon-loadgen:v1:profile-M4');
  let reconstructed = 0;
  for (let offset = 0; offset < batchJournal.length; offset += 17) {
    if (batchJournal[offset] !== 2) continue;
    const request = Number(batchJournal.readBigUInt64LE(offset + 1));
    for (let i = 0; i < 10; i++) {
      assert(observedIDs.has(uuidV5(batchNamespace, `event:${request * 10 + i}`)));
      reconstructed++;
    }
  }
  assert.equal(reconstructed, 2000);

  const tenantSeed = await run('tenant-seed', ['--keys-file', keysFile, '--workload', 'seed', '--identity-seed', 'multi-pool', '--identity-count', '100', '--rate', '300']);
  assert.equal(tenantSeed.code, 0, tenantSeed.text);
  const tenantMixed = await run('tenant-mixed', ['--keys-file', keysFile, '--workload', 'M1', '--identity-seed', 'multi-pool', '--identity-count', '100', '--rate', '300']);
  assert.equal(tenantMixed.code, 0, tenantMixed.text);
  assert.equal(tenantMixed.summary.tenants.length, 3);
  assert(tenantMixed.summary.tenants.every(t => t.expected_requests === 100 && t.accepted_requests === 100 && t.failed_requests === 0));
  for (const tenant of tenants) {
    const pool = new Set(observedByRun.get('tenant-seed').filter(e => e.properties.load_tenant_id === tenant.tenant_id).map(e => e.anon_id));
    assert.equal(pool.size, 100);
    const events = observedByRun.get('tenant-mixed').filter(e => e.properties.load_tenant_id === tenant.tenant_id);
    assert.equal(events.filter(e => !pool.has(e.anon_id)).length, 1);
  }
  const tenantAbort = await run('tenant-abort', ['--keys-file', keysFile, '--rate', '30', '--dur', '30s'], true);
  assert.equal(tenantAbort.summary.outcome, 'ABORTED');
  assert.equal(tenantAbort.summary.tenants.reduce((n,t) => n + t.expected_requests, 0), 900);
  assert.equal(tenantAbort.summary.tenants.reduce((n,t) => n + t.failed_requests, 0), tenantAbort.summary.failed_total);

  mode = 'late';
  const late = await run('late', ['--rate', '10', '--dur', '100ms']);
  assert.equal(late.code, 1); assert.equal(late.summary.counters.accepted, 1);
  assert.equal(late.summary.counters.accepted_in_window, 0); assert.equal(late.summary.failed_total, 0);
  assert.equal(late.summary.outcome, 'FAIL');

  mode = 'invalid';
  const invalid = await run('invalid', ['--rate', '20', '--dur', '100ms']);
  assert.equal(invalid.code, 1); assert.equal(invalid.summary.counters.accepted, 0);
  assert.equal(invalid.summary.counters.response_errors, 2); assert.equal(invalid.summary.failed_total, 2);

  mode = 'normal';
  const before = requestCount;
  const duplicate = await run('normal', [], false, 'duplicate');
  assert.equal(duplicate.code, 1); assert.equal(requestCount, before, 'requests sent before evidence preflight');

  const interrupted = await run('interrupted', ['--rate', '10', '--dur', '30s'], true);
  assert.equal(interrupted.code, 1); assert.equal(interrupted.summary.outcome, 'ABORTED');
  const c = interrupted.summary.counters;
  assert.equal(c.started + c.dropped, 300);
  assert.equal(interrupted.summary.failed_total, 300 - c.accepted);

  // Reconstruct payload fields, including nanosecond timestamps, from saved evidence.
  for (const label of ['normal', 'profile-seed', 'profile-M0', 'profile-M1', 'profile-M4', 'tenant-seed', 'tenant-mixed']) {
    const manifest = JSON.parse(await fs.readFile(path.join(evidence,label,'manifest.json'),'utf8'));
    for (const event of observedByRun.get(label)) {
      const batchSize=manifest.batch_size ?? 1;
      const sequence=event.properties.load_sequence;
      assert.deepEqual(reconstruct(manifest,Math.floor(sequence/batchSize)),observedBodies.get(`${label}:${Math.floor(sequence/batchSize)}`));
    }
  }
  const exported = path.join(evidence,'invalid-export');
  execFileSync(process.execPath, ['tests/ops/loadgen-failures/export.mjs', invalid.outputDir, exported], {stdio:'pipe'});
  const exportResult=JSON.parse(await fs.readFile(path.join(exported,'result.json'),'utf8'));
  assert.equal(exportResult.requests_sent,0); assert.equal(exportResult.failed_requests,2);
  assert.equal(exportResult.status,'REVIEW_REQUIRED_NO_SEND');
  const failures=(await fs.readFile(path.join(exported,'failed-requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  for (const failure of failures) assert.deepEqual(failure.payload.batch[0],observedByRun.get('invalid').find(e => e.properties.load_sequence===failure.request_sequence));

  const summary = { scope: 'CLI on loopback synthetic responder only; not platform capacity',
    casesPassed: 12, normalRequests: 200, reconstructedAcceptedIDs: successes.size,
    tcpConnectionsOpened: normal.summary.counters.tcp_connections_opened,
    connectionsReused: normal.summary.counters.connections_reused,
    evidence };
  await fs.writeFile(path.join(evidence, 'smoke-summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
