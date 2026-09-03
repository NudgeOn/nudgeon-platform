import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const project = `nudgeon-dlq-qa-${randomUUID().slice(0, 8)}`;
const evidence = path.join(root, '.nudgeon', project);
const dcArgs = ['compose', '-p', project, '-f', 'tests/ops/dlq/compose.yaml'];
const base = 'http://127.0.0.1:19294';
const readHTTP = route => fetch(base + route, { signal: AbortSignal.timeout(5000) });
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const save = (name, value) => fs.writeFile(path.join(evidence, name), JSON.stringify(value, null, 2), { mode: 0o600 });

async function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [], err = [];
  child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
  const timeout = setTimeout(() => child.kill('SIGTERM'), 90000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`${command} failed (${code}): ${Buffer.concat(err).toString().slice(-2000)}`);
  return Buffer.concat(out).toString().trim();
}
const dc = (...args) => run('docker', [...dcArgs, ...args]);
const sql = text => dc('exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'nudgeon', '-d', 'nudgeon', '-Atc', text);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = async route => {
  const response = await readHTTP(route);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    if (abort.signal.aborted) throw new Error('test interrupted');
    try { const value = await check(); if (value) return value; } catch (error) { last = error.message; }
    await sleep(1000);
  }
  throw new Error(`timeout: ${label}${last ? ` (${last})` : ''}`);
}
async function notified(name, status, after = 0) {
  const notifications = await get('/notifications');
  return notifications.find(n => Date.parse(n.received_at) >= after && n.body.alerts?.some(a => a.labels.alertname === name && a.status === status));
}
async function query(expression) {
  const result = await get(`/prometheus/api/v1/query?query=${encodeURIComponent(expression)}`);
  assert.equal(result.status, 'success');
  return result.data.result;
}
const backlog = 'sum(nudgeon_channel_dlq_unresolved_count)';
const result = { project, evidence, startedAt: new Date().toISOString(), scope: 'synthetic PostgreSQL DLQ → actual observer → Prometheus → Alertmanager → local webhook; no provider send', steps: {} };

try {
  for (const name of ['DLQ_WORKER_BIN', 'DLQ_CLI_BIN']) {
    const binary = process.env[name];
    assert(binary?.startsWith('/tmp/nudgeon-dlq-build.'), `explicit temporary ${name} required`);
    result[name + '_sha256'] = createHash('sha256').update(await fs.readFile(binary)).digest('hex');
  }
  result.containersBefore = (await run('docker', ['ps', '--format', '{{.Names}}'])).split('\n');
  await dc('up', '-d', '--pull', 'never', 'postgres', 'gateway', 'alertmanager', 'prometheus');
  await until(async () => (await sql('SELECT 1')) === '1', 'PostgreSQL', 60000);
  await until(async () => (await readHTTP('/prometheus/-/ready')).ok, 'Prometheus', 60000);
  const integration = await run('go', ['test', './apps/worker/internal/dlq', '-run', '^TestPostgresDLQStateLifecycle$', '-count=1', '-v'], {
    GOCACHE: '/tmp/nudgeon-go-build-cache', DLQ_TEST_DATABASE_URL: 'postgres://nudgeon:local-dlq-test-only@127.0.0.1:19295/nudgeon?sslmode=disable',
  });
  assert(integration.includes('--- PASS: TestPostgresDLQStateLifecycle'));
  await fs.writeFile(path.join(evidence, 'postgres-integration.log'), integration, { mode: 0o600 });
  result.steps.postgresStateAndUpgrade = 'pass';

  // The first durable failure exists BEFORE the observer's first snapshot.
  const firstAt = Date.now();
  await sql(`INSERT INTO send_dlq(id,tenant_id,app_id,idempotency_key,failure_class,attempts,envelope)
    VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002','dlq-alert-fixture','retryable',5,'{"type":"send.push"}')`);
  await dc('up', '-d', '--pull', 'never', 'monitor');
  const first = await until(() => notified('NudgeOnDLQEntries', 'firing', firstAt), 'first DLQ webhook');
  result.steps.firstWebhookMilliseconds = Date.parse(first.received_at) - firstAt;
  assert(result.steps.firstWebhookMilliseconds <= 30000);
  console.log(`First pre-existing DLQ alert received in ${result.steps.firstWebhookMilliseconds} ms.`);

  await sql('UPDATE send_dlq SET replayed_at=clock_timestamp()');
  await until(async () => Number((await query('sum(nudgeon_channel_dlq_replaying_count)'))[0]?.value[1]) === 1, 'replaying gauge');
  assert.equal(Number((await query(backlog))[0].value[1]), 1);
  result.steps.replayDoesNotResolve = 'pass';
  await dc('restart', 'monitor');
  await until(async () => (await readHTTP('/monitor/readyz')).ok, 'observer restart');
  await until(async () => Number((await query(backlog))[0]?.value[1]) === 1, 'backlog after restart');
  result.steps.restartBacklog = 'pass';

  const dbFailureAt = Date.now();
  await sql('REVOKE SELECT ON send_dlq FROM dlq_observer');
  await until(() => notified('NudgeOnDLQCollectorFailure', 'firing', dbFailureAt), 'DB collection failure');
  assert.equal(Number((await query(backlog))[0].value[1]), 1);
  assert.equal((await readHTTP('/monitor/readyz')).status, 503);
  await sql('GRANT SELECT ON send_dlq TO dlq_observer');
  await until(async () => (await readHTTP('/monitor/readyz')).ok, 'DB collector recovery');
  result.steps.databaseFailureKeepsLastBacklog = 'pass';
  console.log('Replay/restart/database failure checks passed; cached backlog was not reported as zero.');

  const downAt = Date.now();
  await dc('stop', '-t', '5', 'monitor');
  await until(() => notified('NudgeOnDLQMonitorDown', 'firing', downAt), 'observer down');
  await dc('start', 'monitor');
  await until(async () => (await readHTTP('/monitor/readyz')).ok, 'observer back');
  result.steps.monitorDown = 'pass';

  // Exceed the previous increase(...[5m]) window without another DLQ entry.
  let lastProgress = 0;
  await until(async () => {
    const elapsed = Date.now() - firstAt;
    if (elapsed - lastProgress >= 30000) { console.log(`Unresolved backlog observation: ${Math.floor(elapsed / 1000)} s.`); lastProgress = elapsed; }
    return elapsed >= 330000;
  }, 'five-minute backlog observation', 340000);
  assert.equal(Number((await query(backlog))[0].value[1]), 1);
  const alerts = await get('/prometheus/api/v1/alerts');
  assert(alerts.data.alerts.some(a => a.labels.alertname === 'NudgeOnDLQEntries' && a.state === 'firing'));
  assert(!(await notified('NudgeOnDLQEntries', 'resolved', firstAt)), 'false resolved notification while backlog remained');
  result.steps.unresolvedAfter330Seconds = 'pass';
  console.log('Unresolved DLQ still firing after 330 seconds; no false resolved notification.');

  const observed = await sql(`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM send_dlq WHERE idempotency_key='dlq-alert-fixture'`);
  const resolvedAt = Date.now();
  await dc('run', '--rm', '--no-deps', '-T', 'resolver', 'resolve', '--tenant', '00000000-0000-4000-8000-000000000001',
    '--id', '00000000-0000-4000-8000-000000000003', '--created-at', observed, '--note', 'Synthetic QA fixture disposition verified; no provider send', '--verified');
  await until(async () => Number((await query(backlog))[0]?.value[1]) === 0, 'verified resolution gauge');
  await until(() => notified('NudgeOnDLQEntries', 'resolved', resolvedAt), 'verified resolution webhook', 90000);
  result.steps.verifiedResolution = 'pass';
  result.pass = true;
} catch (error) {
  result.pass = false; result.error = error.message;
  process.exitCode = 1;
} finally {
  try { await save('notifications.json', await get('/notifications')); } catch {}
  try { await fs.writeFile(path.join(evidence, 'containers.log'), await dc('logs', '--no-color'), { mode: 0o600 }); } catch {}
  try { await dc('--profile', 'tools', 'stop', '-t', '10'); } catch (error) { result.cleanupError = error.message; result.pass = false; process.exitCode = 1; }
  try {
    result.containersAfter = (await run('docker', ['ps', '--format', '{{.Names}}'])).split('\n');
    assert.deepEqual([...result.containersAfter].sort(), [...result.containersBefore].sort(), 'pre-existing running containers changed');
    const states = await dc('ps', '-a', '--format', 'json');
    result.testContainers = JSON.parse(states.startsWith('[') ? states : `[${states.split('\n').filter(Boolean).join(',')}]`);
    assert(result.testContainers.every(container => container.State === 'exited'), 'test containers not all stopped');
    assert(result.testContainers.every(container => container.ExitCode === 0), 'test container did not exit cleanly');
  } catch (error) { result.cleanupError = error.message; result.pass = false; process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  await save('result.json', result);
  console.log(JSON.stringify(result, null, 2));
}
