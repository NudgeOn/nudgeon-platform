// Bounded generator-only validation. The target is always this process's own
// loopback responder; no endpoint/key option and no production service access.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, statfs, open } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';

const [binary, output, rateArg = '7500', secondsArg = '60'] = process.argv.slice(2);
const rate = Number(rateArg), seconds = Number(secondsArg);
if (!binary || !isAbsolute(binary) || !output || !Number.isInteger(rate) || rate < 1 || rate > 10000 || !Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
  throw new Error('Usage: node run.mjs /absolute/loadgen NEW_OUTPUT_DIR [rate 1..10000] [seconds 1..600]');
}
const expected = rate * seconds;
const diskReserve = 20 * 1024 ** 3;
const before = await statfs(process.cwd());
if (before.bavail * before.bsize < diskReserve + expected * 40 + 64 * 1024 ** 2) throw new Error('Insufficient disk reserve; no generator started');
const dir = resolve(output);
await mkdir(dir, { mode: 0o700 }); // no recursive/overwrite
const sourceHash = createHash('sha256').update(await readFile(binary)).digest('hex');
const seen = new Uint8Array(expected); // bounded max 6 MB, responder only
let received = 0, invalid = 0, duplicate = 0, bytes = 0;
const key = 'pk_loopback_generator_fixture';
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.url !== '/v1/track' || req.headers.authorization !== `Bearer ${key}`) throw new Error();
    const parts = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw new Error();
      parts.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(parts));
    const batch = body.batch;
    if (!Array.isArray(batch) || batch.length !== 1) throw new Error();
    const event = batch[0], seq = event.properties?.load_sequence;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= expected || event.properties.load_run_id !== 'generator-validation' || Buffer.byteLength(JSON.stringify(event.properties)) !== 1024) throw new Error();
    if (seen[seq]) { duplicate++; res.writeHead(409); res.end('{}'); return; }
    seen[seq] = 1; received++; bytes += size;
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"accepted":1}');
  } catch { invalid++; res.writeHead(400); res.end('{}'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const log = await open(resolve(dir, 'generator.log'), 'wx', 0o600);
const samples = await open(resolve(dir, 'resources.jsonl'), 'wx', 0o600);
const startedAt = new Date();
const child = spawn(binary, ['--url', `http://127.0.0.1:${server.address().port}`, '--key-file', '-',
  '--rate', String(rate), '--dur', `${seconds}s`, '--concurrency', '64', '--queue-capacity', '128',
  '--request-timeout', '3s', '--max-p99', '500ms', '--run-id', 'generator-validation',
  '--workload', 'M0', '--identity-seed', 'generator-only', '--identity-count', '10000',
  '--output-dir', resolve(dir, 'loadgen')], { env: { ...process.env, GOMAXPROCS: '2' }, stdio: ['pipe', log.fd, log.fd] });
child.stdin.on('error', () => {}); child.stdin.end(key);
let resourceAbort = null, maxGeneratorRss = 0, maxResponderRss = 0, sampling = Promise.resolve();
function abort(reason) { if (!resourceAbort) { resourceAbort = reason; child.kill('SIGTERM'); } }
const interrupt = () => abort('interrupted');
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const interval = setInterval(() => {
  sampling = sampling.then(async () => {
    if (!child.pid || child.exitCode !== null) return;
    let rss;
    try {
      rss = execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    } catch { if (child.exitCode === null) abort('resource_probe_failed'); return; }
    const generatorRss = Number(rss) * 1024;
    const responderRss = process.memoryUsage().rss;
    if (!Number.isFinite(generatorRss) || generatorRss <= 0) { abort('invalid_resource_sample'); return; }
    maxGeneratorRss = Math.max(maxGeneratorRss, generatorRss); maxResponderRss = Math.max(maxResponderRss, responderRss);
    const disk = await statfs(dir);
    const free = disk.bavail * disk.bsize;
    await samples.write(`${JSON.stringify({ elapsed_ms: Date.now() - startedAt.getTime(), generator_rss_bytes: generatorRss, responder_rss_bytes: responderRss, free_disk_bytes: free, received })}\n`);
    if (generatorRss > 512 * 1024 ** 2 || responderRss > 512 * 1024 ** 2) abort('memory_budget_exceeded');
    if (free < diskReserve) abort('disk_reserve_exceeded');
  }).catch(() => abort('resource_evidence_failed'));
}, 1000);
const watchdog = setTimeout(() => abort('duration_watchdog'), (seconds + 15) * 1000);
const hardStop = setTimeout(() => child.kill('SIGKILL'), (seconds + 25) * 1000);
let code;
try { code = await new Promise((done, reject) => { child.once('close', done); child.once('error', reject); }); }
finally {
  clearInterval(interval); clearTimeout(watchdog); clearTimeout(hardStop);
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  await sampling; await log.close(); await samples.close();
  server.closeAllConnections(); await new Promise(done => server.close(done));
}
let summary = null;
try { summary = JSON.parse(await readFile(resolve(dir, 'loadgen/summary.json'), 'utf8')); } catch {}
const passed = code === 0 && !resourceAbort && summary?.outcome === 'PASS' && received === expected && invalid === 0 && duplicate === 0 && summary.counters.accepted === received;
const result = {
  schema_version: 1, scope: 'bounded loopback generator validation only; no platform, DB, provider or managed-service capacity qualification',
  outcome: passed ? 'PASS_GENERATOR' : resourceAbort ? 'ABORTED_RESOURCE' : 'INVALID_GENERATOR',
  started_at: startedAt.toISOString(), completed_at: new Date().toISOString(),
  binary_sha256: sourceHash, rate_rps: rate, duration_seconds: seconds, expected_requests: expected,
  received_requests: received, invalid_requests: invalid, duplicate_requests: duplicate,
  body_bytes: bytes, max_generator_rss_bytes: maxGeneratorRss, max_responder_rss_bytes: maxResponderRss,
  gomaxprocs: 2, resource_abort: resourceAbort, loadgen_outcome: summary?.outcome ?? null,
  capacity_qualified: false, physical_device_push: false,
};
await writeFile(resolve(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result));
process.exitCode = passed ? 0 : 1;
