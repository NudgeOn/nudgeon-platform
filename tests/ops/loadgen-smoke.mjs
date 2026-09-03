// Tests the built CLI against a loopback-only synthetic responder. No Onda
// services, databases, provider credentials or Docker containers are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary)) throw new Error('Usage: node tests/ops/loadgen-smoke.mjs /absolute/path/to/loadgen');
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'nudgeon-loadgen-smoke-'));
const key = 'pk_synthetic_loadgen_smoke_only';
let mode = 'normal', requestCount = 0, firstRequest;
const observedIDs = new Set();
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  assert.equal(req.url, '/v1/track');
  assert.equal(req.headers.authorization, `Bearer ${key}`);
  const body = JSON.parse(Buffer.concat(chunks));
  observedIDs.add(body.batch[0].insert_id);
  requestCount++;
  firstRequest?.(); firstRequest = undefined;
  if (mode === 'late') await new Promise(resolve => setTimeout(resolve, 150));
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(mode === 'invalid' ? '{"accepted":0}' : '{"accepted":1}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

async function run(label, args = [], interrupt = false, logLabel = label) {
  const outputDir = path.join(evidence, label);
  const child = spawn(binary, ['--url', url, '--key-file', '-', '--rate', '200', '--dur', '1s',
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
  assert(!text.includes(key), 'key leaked in output');
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

  const summary = { scope: 'CLI on loopback synthetic responder only; not platform capacity',
    casesPassed: 5, normalRequests: 200, reconstructedAcceptedIDs: successes.size,
    tcpConnectionsOpened: normal.summary.counters.tcp_connections_opened,
    connectionsReused: normal.summary.counters.connections_reused,
    evidence };
  await fs.writeFile(path.join(evidence, 'smoke-summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
