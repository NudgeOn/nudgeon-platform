import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const project = `nudgeon-dlq-storage-${randomUUID().slice(0, 8)}`;
const evidence = path.join(root, '.nudgeon', project);
await fs.mkdir(evidence, {recursive: true, mode: 0o700});
const result = {project, startedAt: new Date().toISOString(), pass: false};
let activeChild, interrupted = false, cleaning = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; activeChild?.kill('SIGTERM'); });
async function run(command, args, env = {}) {
  if (interrupted && !cleaning) throw new Error('test interrupted');
  const child = spawn(command, args, {cwd: root, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  activeChild = child;
  const out = [], err = [];
  child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
  const timeout = setTimeout(() => child.kill('SIGTERM'), 120000);
  const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});
  clearTimeout(timeout);
  activeChild = undefined;
  const output = Buffer.concat(out).toString(), errors = Buffer.concat(err).toString();
  if (code !== 0) throw new Error(`${command} (${code})\n${output}\n${errors}`);
  return output.trim();
}
const dc = (...args) => run('docker', ['compose', '-p', project, '-f', 'tests/ops/dlq-storage/compose.yaml', ...args]);
try {
  result.containersBefore = (await run('docker', ['ps', '--format', '{{.Names}}'])).split('\n').sort();
  await dc('up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '60');
  await dc('exec', '-T', 'redis', 'redis-cli', 'SET', 'dlq-storage-qa-project', project);
  const output = await run('go', ['test', '-race', '-p', '1', '-count=1', '-v',
    './apps/worker/internal/channel', './apps/worker/internal/dlq', './apps/worker/internal/message',
    '-run', '^Test(DLQStoragePostgresRedis|PostgresDLQStateLifecycle|PostgresDLQFailureCycle|MessageDLQDatabaseErrors)$'], {
    GOCACHE: '/tmp/nudgeon-go-build-cache',
    DLQ_TEST_DATABASE_URL: 'postgres://nudgeon:local-storage-only@127.0.0.1:19395/nudgeon?sslmode=disable',
    DLQ_STORAGE_WRITER_URL: 'postgres://dlq_writer:local-writer-only@127.0.0.1:19395/nudgeon?sslmode=disable',
    DLQ_STORAGE_REDIS_URL: 'redis://127.0.0.1:19379', DLQ_STORAGE_QA_PROJECT: project,
  });
  await fs.writeFile(path.join(evidence, 'integration.log'), output, {mode: 0o600});
  console.log(output);
  for (const name of ['DLQStoragePostgresRedis', 'PostgresDLQStateLifecycle', 'PostgresDLQFailureCycle', 'MessageDLQDatabaseErrors']) {
    assert(output.includes(`--- PASS: Test${name}`), `missing actual PASS: ${name}`);
  }
  assert(!output.includes('--- SKIP'), 'integration test skipped');
  result.integrationLogSha256 = createHash('sha256').update(output).digest('hex');
  result.pass = true;
} catch (error) {
  result.error = error.message; process.exitCode = 1;
} finally {
  cleaning = true;
  try {await fs.writeFile(path.join(evidence, 'containers.log'), await dc('logs', '--no-color'), {mode: 0o600});} catch {}
  try {
    await dc('stop', '-t', '10');
    const text = await dc('ps', '-a', '--format', 'json');
    result.testContainers = JSON.parse(text.startsWith('[') ? text : `[${text.split('\n').filter(Boolean).join(',')}]`);
    assert.equal(result.testContainers.length, 3);
    assert(result.testContainers.every(c => c.State === 'exited' && c.ExitCode === 0), 'unclean test shutdown');
    result.containersAfter = (await run('docker', ['ps', '--format', '{{.Names}}'])).split('\n').sort();
    assert.deepEqual(result.containersAfter, result.containersBefore, 'pre-existing container set changed');
  } catch (error) {result.cleanupError = error.message; result.pass = false; process.exitCode = 1;}
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2), {mode: 0o600});
  console.log(JSON.stringify(result, null, 2));
}
