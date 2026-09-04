import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const project = 'nudgeon-local-ops-20260903a';
const evidence = path.join(root, '.nudgeon', project);
const binary = process.env.OPS_LOADGEN_BIN;
const base = 'http://127.0.0.1:18180';
const env = { ...process.env, OPS_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
const compose = ['compose', '-p', project, '-f', 'tests/ops/local/compose.yaml'];
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const save = (name, value) => fs.writeFile(path.join(evidence, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(command, args, input) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [], err = [];
  child.stdout.on('data', x => out.push(x));
  child.stderr.on('data', x => err.push(x));
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}: ${Buffer.concat(err).toString().slice(-3000)}`);
  return Buffer.concat(out);
}
const dc = (...args) => run('docker', [...compose, ...args]);
const pg = (sql, restored = false) => run('docker', [...compose, 'exec', '-T', restored ? 'postgres-restored' : 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'nudgeon', '-d', 'nudgeon', '-Atc', sql]).then(x => x.toString().trim());
const ch = (sql, restored = false) => run('docker', [...compose, 'exec', '-T', restored ? 'clickhouse-restored' : 'clickhouse', 'clickhouse-client', '--user', 'nudgeon', '--password', 'local-ops-only', '--database', 'nudgeon', '--query', sql]).then(x => x.toString().trim());
const redis = (...args) => dc('exec', '-T', 'redis', 'redis-cli', '--raw', ...args).then(x => x.toString().trim());
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const hash = value => createHash('sha256').update(value).digest('hex');

async function until(check, label, timeout = 120000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch (e) { last = e.message; }
    await sleep(2000);
  }
  throw new Error(`timeout: ${label}${last ? ` (${last})` : ''}`);
}

async function state() {
  try { return JSON.parse(await fs.readFile(path.join(evidence, 'credentials.local.json'), 'utf8')); }
  catch {
    const response = await fetch(`${base}/v1/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `local-ops-${randomUUID()}@example.com`, password: randomUUID(), name: 'Local Operations Test', tenant_name: 'ISOLATED LOCAL OPS' }),
    });
    if (!response.ok) throw new Error(`signup HTTP ${response.status}`);
    const s = await response.json();
    s.cookie = response.headers.get('set-cookie')?.split(';')[0];
    await save('credentials.local.json', s);
    console.log('Created a synthetic tenant in the isolated database; keys not logged.');
    return s;
  }
}

async function counts(runID, restored = false) {
  const [p, c] = await Promise.all([
    pg(`SELECT count(*),count(*) FILTER(WHERE projected_at IS NOT NULL) FROM event_receipts WHERE properties->>'load_run_id'=${quote(runID)}`, restored),
    ch(`SELECT count(),uniqExact(insert_id) FROM events WHERE JSONExtractString(properties,'load_run_id')=${quote(runID)}`, restored),
  ]);
  const [receipts, projected] = p.split('|').map(Number);
  const [events, uniqueEvents] = c.split('\t').map(Number);
  return { receipts, projected, events, uniqueEvents };
}

async function reconcile(runID, accepted, restored = false, started = accepted) {
  let current;
  try {
    await until(async () => {
      current = await counts(runID, restored);
      return current.receipts >= accepted && current.receipts <= started &&
        current.projected === current.receipts && current.events === current.receipts &&
        current.uniqueEvents === current.receipts;
    }, `projection ${runID}`, 180000);
  } catch (error) {
    return { ...current, accepted, started, pass: false, reason: error.message };
  }
  const [p, c] = await Promise.all([
    pg(`SELECT insert_id::text FROM event_receipts WHERE properties->>'load_run_id'=${quote(runID)} ORDER BY insert_id::text`, restored),
    ch(`SELECT toString(insert_id) FROM events WHERE JSONExtractString(properties,'load_run_id')=${quote(runID)} ORDER BY toString(insert_id)`, restored),
  ]);
  return { ...current, accepted, started, committedWithout202: current.receipts - accepted, allStartedPersisted: current.receipts === started, pgIdsSHA256: hash(p), chIdsSHA256: hash(c), pass: p === c };
}

function memBytes(text) {
  const m = text.trim().match(/^([\d.]+)([KMGT]?i?B)/);
  if (!m) return 0;
  const exp = { B: 0, KiB: 1, MiB: 2, GiB: 3, TiB: 4, KB: 1, MB: 2, GB: 3 }[m[2]] ?? 0;
  return Number(m[1]) * 1024 ** exp;
}

async function load(rate, seconds, concurrency, label, options = {}) {
  if (!binary || !binary.startsWith('/tmp/nudgeon-local-ops.')) throw new Error('OPS_LOADGEN_BIN must be an explicit task temporary binary');
  const s = await state();
  const runID = `${label}-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const loadEvidence = path.join(evidence, `loadgen-${runID}`);
  const child = spawn(binary, ['--url', options.restored ? 'http://127.0.0.1:18181' : base, '--key-file', '-', '--rate', String(rate), '--dur', `${seconds}s`, '--concurrency', String(concurrency), '--request-timeout', '3s', '--max-p99', '500ms', '--run-id', runID, '--output-dir', loadEvidence], { cwd: root, env });
  child.stdin.on('error', () => {}); // Early preflight failure may close stdin.
  child.stdin.end(s.sdk_key);
  let output = '', done = false, safetyStop;
  child.stdout.on('data', x => { output += x; });
  child.stderr.on('data', x => { output += x; });
  const metrics = [];
  const monitor = (async () => {
    while (!done) {
      try {
        const raw = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
        const containers = raw.toString().trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
        const total = containers.reduce((n, x) => n + memBytes(x.MemUsage.split('/')[0]), 0);
        metrics.push({ at: new Date().toISOString(), totalMemoryBytes: total, containers: containers.filter(x => x.Name.startsWith(project)) });
        if (total > 7.1 * 1024 ** 3) { safetyStop = 'Docker total memory exceeded 7.1 GiB'; child.kill('SIGTERM'); }
      } catch (e) { metrics.push({ error: e.message }); }
      if (!done) await sleep(5000);
    }
  })();
  const hardStop = setTimeout(() => { safetyStop = 'load/drain exceeded duration + 40s'; child.kill('SIGTERM'); }, (seconds + 40) * 1000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(hardStop); done = true; await monitor;
  await fs.writeFile(path.join(evidence, `${label}.log`), output);
  await save(`${label}-resources.json`, metrics);
  let summary, summaryError;
  try {
    summary = JSON.parse(await fs.readFile(path.join(loadEvidence, 'summary.json'), 'utf8'));
    if (summary.schema_version !== 1 || summary.run_id !== runID || !summary.counters ||
        !Number.isSafeInteger(summary.counters.accepted) || !Number.isSafeInteger(summary.counters.started)) {
      throw new Error('loadgen summary schema/run mismatch');
    }
  } catch (error) { summaryError = error.message; summary = undefined; }
  const accepted = summary?.counters.accepted ?? null;
  const dropped = summary?.counters.dropped ?? null;
  const started = summary?.counters.started ?? null;
  const result = { label, runID, startedAt, completedAt: new Date().toISOString(), rate, seconds, concurrency,
    exitCode: code === 0 && (summaryError || summary?.outcome !== 'PASS') ? 1 : code,
    safetyStop, accepted, dropped, started, acceptedInWindow: summary?.counters.accepted_in_window ?? null,
    failedTotal: summary?.failed_total ?? null, loadEvidence, summaryError };
  if (!options.skipReconcile && !summaryError) result.reconciliation = await reconcile(runID, accepted, options.restored, started);
  await save(`${label}.json`, result);
  console.log(output.trim());
  console.log(JSON.stringify(result));
  return result;
}

async function ramp() {
  await until(async () => (await fetch(`${base}/readyz`)).ok, 'isolated API readiness');
  await state();
  const results = [];
  results.push(await load(50, 5, 32, 'warmup'));
  for (const [rate, seconds, concurrency] of [[200, 15, 128], [500, 20, 256], [1000, 20, 512], [2000, 10, 512], [5000, 5, 512]]) {
    const r = await load(rate, seconds, concurrency, `ramp-${rate}`);
    results.push(r);
    if (r.exitCode !== 0 || !r.reconciliation?.pass || r.safetyStop) {
      console.log(`Stopped escalation after ${rate} req/s failed a gate.`);
      break;
    }
    await sleep(3000);
  }
  await save('ramp-summary.json', results);
  if (results.some(r => r.exitCode !== 0 || !r.reconciliation?.pass || r.safetyStop)) process.exitCode = 1;
}

async function recovery() {
  await dc('stop', '-t', '20', 'worker');
  let r;
  try {
    r = await load(20, 5, 32, 'worker-offline', { skipReconcile: true });
    r.beforeRestart = await counts(r.runID);
  } finally { await dc('start', 'worker'); }
  if (r.summaryError) throw new Error(`Recovery load evidence unavailable: ${r.summaryError}`);
  r.afterRestart = await reconcile(r.runID, r.accepted);
  r.pass = r.accepted === 100 && r.beforeRestart.projected === 0 && r.afterRestart.pass;
  await save('worker-recovery.json', r);
  console.log(JSON.stringify(r));
  if (!r.pass) process.exitCode = 1;
}

async function injectDLQ(number) {
  const s = await state();
  if (number === 1) await pg(`INSERT INTO credentials(tenant_id,app_id,kind,ciphertext,dek_wrapped,status) VALUES(${quote(s.tenant_id)},${quote(s.app_id)},'push_fcm',decode('00','hex'),decode('00','hex'),'verified')`);
  const idem = `local-ops-dlq-${number}-${randomUUID()}`;
  const envelope = {
    id: randomUUID(), type: 'send.push', schema_ver: 1, tenant_id: s.tenant_id, app_id: s.app_id,
    occurred_at: new Date().toISOString(), trace_id: randomUUID(),
    payload: { idempotency_key: idem, message_id: randomUUID(), user_id: randomUUID(), device_id: randomUUID(), push_token: 'LOCAL_TEST_NOT_A_PROVIDER_TOKEN', platform: 'android', content: { push: { title: 'Local fault test', body: 'Never sent externally' } }, category: 'transactional' },
  };
  // Fault injection: simulate four previous failures. The actual worker performs
  // the fifth credential-decryption failure and writes the actual DLQ + metric.
  await redis('SET', `send:attempts:${s.tenant_id}:${idem}`, '4');
  await redis('XADD', 'stream:send.push', '*', 'envelope', JSON.stringify(envelope));
  await until(async () => (await pg(`SELECT count(*) FROM send_dlq WHERE tenant_id=${quote(s.tenant_id)} AND idempotency_key=${quote(idem)}`)) === '1', 'actual worker DLQ');
  return { idem, tenantId: s.tenant_id, appId: s.app_id, injectedAt: new Date().toISOString() };
}

async function alerts() {
  await until(async () => (await fetch('http://127.0.0.1:19191/-/ready')).ok, 'Prometheus');
  await sleep(10000);
  const first = await injectDLQ(1);
  await sleep(20000);
  const firstNotifications = await (await fetch('http://127.0.0.1:19194')).json();
  const firstAlerts = await (await fetch('http://127.0.0.1:19191/api/v1/alerts')).json();
  console.log(`First DLQ persisted; received notifications=${firstNotifications.length}`);
  const second = await injectDLQ(2);
  const notifications = await until(async () => {
    const n = await (await fetch('http://127.0.0.1:19194')).json();
    return n.some(x => x.body.alerts?.some(a => a.labels.alertname === 'NudgeOnDLQEntries' && a.status === 'firing')) ? n : null;
  }, 'actual local Alertmanager notification', 45000);
  const result = { first, second, firstNotifications, firstAlerts, notifications, firstEventAlerted: firstNotifications.length > 0, repeatedEventAlerted: true };
  await save('alerts.json', result);
  // Remove only this deliberately corrupt fixture; keep the DLQ for restoration.
  await pg(`DELETE FROM credentials WHERE tenant_id=${quote(first.tenantId)} AND app_id=${quote(first.appId)} AND kind='push_fcm'`);
  console.log(JSON.stringify({ firstEventAlerted: result.firstEventAlerted, repeatedEventAlerted: true }));
  if (!result.firstEventAlerted) process.exitCode = 1;
}

async function metadata() {
  const images = JSON.parse((await run('docker', ['image', 'inspect', 'nudgeon-api:latest', 'nudgeon-worker:latest', 'postgres:16', 'clickhouse/clickhouse-server:24.8', 'redis:7', 'prom/prometheus:v3.5.0', 'prom/alertmanager:v0.28.1'])).toString());
  const files = ['apps/worker/cmd/loadgen/main.go', 'apps/worker/cmd/loadgen/latency.go', 'apps/worker/cmd/loadgen/evidence.go', 'apps/worker/internal/channel/worker.go', 'apps/worker/internal/metrics/metrics.go', 'deploy/observability/alerts.yml', 'tests/ops/local/compose.yaml'];
  const sourceHashes = {};
  for (const file of files) sourceHashes[file] = hash(await fs.readFile(path.join(root, file)));
  const result = {
    recordedAt: new Date().toISOString(), project,
    gitCommit: (await run('git', ['rev-parse', 'HEAD'])).toString().trim(),
    dirtyWorktree: (await run('git', ['status', '--porcelain'])).toString(),
    dockerResources: (await run('docker', ['info', '--format', '{{.MemTotal}} bytes / {{.NCPU}} CPUs'])).toString().trim(),
    images: images.map(x => ({ tags: x.RepoTags, id: x.Id, created: x.Created })), sourceHashes,
  };
  await save('metadata.json', result);
  console.log(`Recorded image IDs and source hashes; project=${project}`);
}

async function diagnostics() {
  const logs = await run('docker', ['logs', '--tail', '1000', `${project}-worker-1`]);
  await fs.writeFile(path.join(evidence, 'worker.log'), logs, { mode: 0o600 });
  const names = (await run('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}'])).toString().trim().split('\n').filter(Boolean);
  const containers = JSON.parse((await run('docker', ['inspect', ...names])).toString());
  await save('containers.json', containers.map(x => ({ name: x.Name, image: x.Image, restarts: x.RestartCount, state: x.State })));
  console.log(`Saved isolated worker logs and ${containers.length} container states.`);
}

async function snapshot(restored = false) {
  const tables = (await pg("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename", restored)).split('\n');
  const pgCounts = {}, pgRowsSHA256 = {};
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('unexpected table identifier');
    pgCounts[table] = Number(await pg(`SELECT count(*) FROM public.${table}`, restored));
    pgRowsSHA256[table] = hash(await pg(`SELECT to_jsonb(t)::text FROM public.${table} t ORDER BY to_jsonb(t)::text`, restored));
  }
  const p = await pg('SELECT insert_id::text FROM event_receipts ORDER BY insert_id::text', restored);
  const c = await ch('SELECT toString(insert_id) FROM events ORDER BY toString(insert_id)', restored);
  const chRowsSHA256 = hash(await ch('SELECT * FROM events ORDER BY insert_id FORMAT JSONEachRow', restored));
  return { pgCounts, pgRowsSHA256, pgReceiptIds: hash(p), chEventIds: hash(c), chRowsSHA256, idsMatch: p === c };
}

async function backup() {
  await dc('stop', '-t', '20', 'api', 'worker');
  const startedAt = Date.now();
  const expected = await snapshot();
  await redis('SET', 'local-ops:restore-marker', project);
  await redis('SAVE');
  const dump = await run('docker', [...compose, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'nudgeon', '-d', 'nudgeon', '-Fc', '--no-owner', '--no-acl']);
  await fs.writeFile(path.join(evidence, 'postgres.dump'), dump, { mode: 0o600 });
  await run('docker', ['cp', `${project}-redis-1:/data/dump.rdb`, path.join(evidence, 'redis.rdb')]);
  const chResult = await ch("BACKUP DATABASE nudgeon TO Disk('backups','local-ops-snapshot')");
  const result = { capturedAt: new Date().toISOString(), milliseconds: Date.now() - startedAt, expected, postgresBytes: dump.length, postgresSHA256: hash(dump), clickhouse: chResult };
  await save('backup.json', result);
  await dc('stop', '-t', '20', 'postgres', 'clickhouse', 'redis', 'prometheus', 'alertmanager', 'receiver');
  console.log(JSON.stringify(result));
}

async function restore() {
  const startedAt = Date.now();
  await dc('--profile', 'restore', 'create', 'postgres-restored', 'clickhouse-restored', 'redis-restored');
  await run('docker', ['cp', path.join(evidence, 'redis.rdb'), `${project}-redis-restored-1:/data/dump.rdb`]);
  await dc('--profile', 'restore', 'start', 'postgres-restored', 'clickhouse-restored', 'redis-restored');
  await until(async () => (await pg('SELECT 1', true)) === '1', 'fresh PostgreSQL');
  await until(async () => (await ch('SELECT 1', true)) === '1', 'fresh ClickHouse');
  await run('docker', [...compose, 'exec', '-T', 'postgres-restored', 'pg_restore', '-U', 'nudgeon', '-d', 'nudgeon', '--no-owner', '--no-acl', '--exit-on-error'], await fs.readFile(path.join(evidence, 'postgres.dump')));
  await ch("RESTORE DATABASE nudgeon FROM Disk('backups','local-ops-snapshot')", true);
  const actual = await snapshot(true);
  const original = JSON.parse(await fs.readFile(path.join(evidence, 'backup.json'), 'utf8'));
  const marker = (await dc('exec', '-T', 'redis-restored', 'redis-cli', '--raw', 'GET', 'local-ops:restore-marker')).toString().trim();
  await dc('--profile', 'restore', 'up', '-d', 'api-restored', 'worker-restored');
  await until(async () => (await fetch('http://127.0.0.1:18181/readyz')).ok, 'restored API readiness');
  const result = { milliseconds: Date.now() - startedAt, actual, expected: original.expected, dataMatches: JSON.stringify(actual) === JSON.stringify(original.expected), redisMarkerMatches: marker === project, apiReady: true };
  result.newTraffic = await load(20, 5, 32, 'restored-new-traffic', { restored: true });
  result.pass = result.dataMatches && result.redisMarkerMatches && result.newTraffic.exitCode === 0 && result.newTraffic.reconciliation.pass;
  await save('restore.json', result);
  console.log(JSON.stringify(result));
  if (!result.pass) process.exitCode = 1;
}

const phase = process.argv[2];
if (phase === 'ramp') await ramp();
else if (phase === 'recovery') await recovery();
else if (phase === 'alerts') await alerts();
else if (phase === 'stability') {
  const r = await load(100, 300, 128, 'stability-5min');
  if (r.exitCode !== 0 || !r.reconciliation?.pass) process.exitCode = 1;
  const notifications = await (await fetch('http://127.0.0.1:19194')).json();
  await save('alerts-after-stability.json', notifications);
  console.log(`Resolved notification: ${notifications.some(x => x.body.alerts?.some(a => a.status === 'resolved'))}`);
}
else if (phase === 'backup') await backup();
else if (phase === 'restore') await restore();
else if (phase === 'metadata') await metadata();
else if (phase === 'diagnostics') await diagnostics();
else if (phase === 'stability-reconcile') {
  const initial = JSON.parse(await fs.readFile(path.join(evidence, 'stability-5min.json'), 'utf8'));
  const output = await fs.readFile(path.join(evidence, 'stability-5min.log'), 'utf8');
  const started = Number(output.match(/HTTP 시작:\s*(\d+)/)?.[1] ?? 0);
  const result = { ...initial, started, reconciliation: await reconcile(initial.runID, initial.accepted, false, started) };
  await save('stability-5min-final-reconciliation.json', result);
  console.log(JSON.stringify(result));
}
else if (phase === 'stop') console.log((await dc('--profile', 'alerts', '--profile', 'restore', 'stop', '-t', '20')).toString());
else throw new Error('phase required: ramp/recovery/alerts/stability/stability-reconcile/backup/restore/metadata/diagnostics/stop');
console.log(`Evidence: ${evidence}`);
