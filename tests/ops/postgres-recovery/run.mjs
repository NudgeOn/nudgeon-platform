import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const req = createRequire(path.join(root, 'apps/api/package.json'));
const { Pool } = req('pg');
const name = `nudgeon-pg-recovery-${randomUUID().slice(0, 8)}`;
const evidence = path.join(root, '.nudgeon', name);
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const result = { scope: 'local PostgreSQL TLS and client recovery; NOT managed failover certification', name, startedAt: new Date().toISOString(), pass: false, checks: {} };
const children = new Set();
let created = false, controller, interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  for (const child of children) child.kill('SIGTERM');
});
async function command(bin, args, timeout = 60000) {
  const child = spawn(bin, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (code !== 0) throw new Error(`${bin} failed (${code}): ${stderr.slice(-1000)}`);
    return stdout.trim();
  } finally { clearTimeout(timer); children.delete(child); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (interrupted) throw new Error('interrupted');
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`timeout: ${label}`);
}
async function startClient(url, baseline = false) {
  const child = fork(path.join(root, 'tests/ops/postgres-recovery/client.cjs'), [], {
    env: { ...process.env, DATABASE_URL: url, RECOVERY_BASELINE: String(baseline) }, silent: true,
  });
  children.add(child);
  const messages = []; let exited = false, exitCode;
  // Raw driver stderr may include a URL; never persist it.
  child.stdout.resume(); child.stderr.resume();
  child.on('message', message => messages.push(message));
  child.on('exit', code => { exited = true; exitCode = code; children.delete(child); });
  child.on('error', () => { exited = true; });
  async function next(event) {
    await until(() => exited || messages.some(m => m.event === event), `client ${event}`);
    assert(!exited, `client exited before ${event}`);
    return messages.splice(messages.findIndex(m => m.event === event), 1)[0];
  }
  await next('ready');
  return { child, next, exited: () => exited, exitCode: () => exitCode };
}
try {
  result.containersBefore = (await command('docker', ['ps', '--format', '{{.Names}}'])).split('\n').filter(Boolean).sort();
  result.revision = await command('git', ['rev-parse', 'HEAD']);
  result.sourceSHA256 = createHash('sha256').update(await fs.readFile(path.join(root, 'apps/api/src/infra/postgres.ts'))).digest('hex');
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=NudgeOn local recovery CA', '-keyout', path.join(evidence, 'ca.key'), '-out', path.join(evidence, 'ca.crt')]);
  await command('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', path.join(evidence, 'server.key'), '-out', path.join(evidence, 'server.csr')]);
  await fs.writeFile(path.join(evidence, 'server.ext'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  await command('openssl', ['x509', '-req', '-in', path.join(evidence, 'server.csr'), '-CA', path.join(evidence, 'ca.crt'), '-CAkey', path.join(evidence, 'ca.key'), '-CAcreateserial', '-days', '1', '-extfile', path.join(evidence, 'server.ext'), '-out', path.join(evidence, 'server.crt')]);
  created = true;
  await command('docker', ['run', '-d', '--name', name, '--memory', '256m', '--cpus', '1', '--publish', '127.0.0.1::5432', '--mount', `type=bind,source=${evidence},target=/fixture,readonly`, '-e', 'POSTGRES_PASSWORD=local-recovery-only', '-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_DB=fixture', '--entrypoint', 'sh', 'postgres:16', '-c', 'cp /fixture/server.key /tmp/server.key && cp /fixture/server.crt /tmp/server.crt && chmod 600 /tmp/server.key && chown postgres:postgres /tmp/server.key /tmp/server.crt && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key']);
  const mapping = await command('docker', ['port', name, '5432/tcp']);
  assert.match(mapping, /^127\.0\.0\.1:\d+$/);
  const base = `postgres://fixture:local-recovery-only@localhost:${mapping.split(':')[1]}/fixture`;
  const url = new URL(base);
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.set('sslrootcert', path.join(evidence, 'ca.crt'));
  controller = new Pool({ connectionString: url.href, connectionTimeoutMillis: 1000, query_timeout: 3000, max: 1 });
  controller.on('error', () => {});
  await until(async () => { try { await controller.query('SELECT 1'); return true; } catch { return false; } }, 'PG startup', 30000);

  const baseline = await startClient(url.href, true);
  baseline.child.send('query');
  const idle = await baseline.next('query_ok');
  assert.equal(idle.tls, true);
  await controller.query('SELECT pg_terminate_backend($1)', [idle.pid]);
  await until(baseline.exited, 'baseline process crash');
  assert.notEqual(baseline.exitCode(), 0);
  result.checks.baselineCrashesOnIdleDisconnect = true;

  const fixed = await startClient(url.href);
  fixed.child.send('query');
  const before = await fixed.next('query_ok');
  await controller.query('SELECT pg_terminate_backend($1)', [before.pid]);
  await fixed.next('idle_error_handled');
  fixed.child.send('query');
  const after = await fixed.next('query_ok');
  assert.notEqual(after.pid, before.pid); assert.equal(after.tls, true);
  result.checks.sameProcessReconnectsWithTLS = true;
  fixed.child.send('exhaust');
  const acquisition = await fixed.next('acquisition_bounded');
  assert(acquisition.elapsedMs >= 900 && acquisition.elapsedMs < 5000, 'pool acquisition deadline');
  fixed.child.send('query');
  await fixed.next('query_ok');
  result.checks.exhaustedPoolDeadlineAndRecovery = true;
  fixed.child.send('close');
  await until(fixed.exited, 'fixed process graceful exit');
  assert.equal(fixed.exitCode(), 0);

  for (const [label, connectionString] of [
    ['untrustedCertificateRejected', `${base}?sslmode=verify-full`],
    ['wrongHostnameRejected', url.href.replace('@localhost:', '@127.0.0.1:')],
    ['invalidPasswordRejected', url.href.replace('local-recovery-only', 'wrong-password')],
  ]) {
    const client = await startClient(connectionString);
    client.child.send('query');
    await client.next('query_failed');
    result.checks[label] = true;
    client.child.send('close');
    await until(client.exited, 'negative-case client exit');
    assert.equal(client.exitCode(), 0);
  }
  result.pass = true;
} catch (error) {
  result.error = error.message;
} finally {
  await controller?.end();
  for (const child of children) child.kill('SIGKILL');
  if (created) {
    try {
      const state = JSON.parse(await command('docker', ['inspect', name, '--format', '{{json .State}}']));
      result.oomKilled = state.OOMKilled;
      if (state.OOMKilled) result.pass = false;
      await command('docker', ['rm', '-f', '-v', name]);
    } catch { result.pass = false; result.cleanupFailed = true; }
  }
  result.containersAfter = (await command('docker', ['ps', '--format', '{{.Names}}'])).split('\n').filter(Boolean).sort();
  result.unrelatedContainersUnchanged = JSON.stringify(result.containersBefore) === JSON.stringify(result.containersAfter);
  if (!result.unrelatedContainersUnchanged || interrupted) result.pass = false;
  // The short-lived local certificate private keys are not useful evidence.
  for (const file of ['ca.key', 'server.key']) await fs.rm(path.join(evidence, file), { force: true });
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ pass: result.pass, checks: result.checks, evidence, error: result.error }));
  process.exitCode = result.pass ? 0 : 1;
}
