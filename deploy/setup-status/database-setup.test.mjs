import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { databaseSetup, validPassword } from './database-setup.mjs';
import { createStatusServer } from './server.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nudgeon-db-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { NUDGEON_DATABASE_SETUP_REQUIRED: 'true', NUDGEON_PUBLIC_ORIGIN: 'http://localhost:8080',
    NUDGEON_SETUP_TOKEN_FILE: join(dir, 'token'), NUDGEON_DATABASE_CONFIG_FILE: join(dir, 'config') };
  await writeFile(env.NUDGEON_SETUP_TOKEN_FILE, 'test-install-token\n', { mode: 0o600 });
  const setup = databaseSetup(env), request = { headers: { origin: env.NUDGEON_PUBLIC_ORIGIN } };
  const body = { token: 'test-install-token', password: "PG '$:@/#% test 비밀번호", request_id: randomUUID() };
  return { env, setup, request, body };
}

test('passwords preserve spaces, Unicode and URL special characters; reject unsafe lengths and controls', () => {
  for (const v of ['short', 'a'.repeat(129), 'abcdefghijkl\n', '\0abcdefghijkl', 123, null]) assert.equal(validPassword(v), false);
  assert.equal(validPassword("PG '$:@/#% test 비밀번호"), true);
  assert.equal(validPassword('가'.repeat(128)), true);
});
test('token and exact origin are required; configured installs cannot change credentials', async t => {
  const { env, setup, request, body } = await fixture(t);
  assert.equal((await setup.submit({ headers: {} }, body)).status, 403);
  assert.equal((await setup.submit({ headers: { origin: 'https://evil.example' } }, body)).status, 403);
  assert.equal((await setup.submit(request, { ...body, token: 'incorrect' })).status, 403);
  assert.equal((await setup.submit(request, { ...body, password: 'short' })).status, 400);
  const closed = databaseSetup({ ...env, NUDGEON_DATABASE_SETUP_REQUIRED: 'false' });
  assert.deepEqual(await closed.status(), { required: false, submitted: false });
  assert.equal((await closed.submit(request, body)).status, 409);
  await assert.rejects(closed.readForInstaller(), /setup_closed/);
});
test('save is private, preserves password exactly, and retries are idempotent without readback', async t => {
  const { env, setup, request, body } = await fixture(t);
  assert.deepEqual(await setup.status(), { required: true, submitted: false });
  assert.equal((await setup.submit(request, body)).status, 200);
  assert.equal((await setup.submit(request, body)).status, 200);
  assert.equal((await setup.submit(request, { ...body, request_id: randomUUID() })).status, 409);
  assert.equal((await setup.submit(request, { ...body, password: 'changed-password-123' })).status, 409);
  assert.equal(await setup.readForInstaller(), body.password);
  assert.equal((await stat(env.NUDGEON_DATABASE_CONFIG_FILE)).mode & 0o777, 0o600);
  assert.deepEqual(await setup.status(), { required: true, submitted: true });
});
test('competing requests publish exactly one complete configuration', async t => {
  const { env, setup, request, body } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => setup.submit(request, { ...body, request_id: randomUUID(), password: `valid-password-${i}` })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 11);
  assert.match(JSON.parse(await readFile(env.NUDGEON_DATABASE_CONFIG_FILE, 'utf8')).password, /^valid-password-\d+$/);
});
test('HTTP rejects invalid bodies, enforces limits and never returns a password', async t => {
  const { env, body } = await fixture(t);
  const server = createStatusServer(env);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/setup-status/v1/database`;
  const post = (data, type = 'application/json') => fetch(url, { method: 'POST', headers: { 'content-type': type, origin: env.NUDGEON_PUBLIC_ORIGIN }, body: data });
  assert.equal((await post('null')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('x'.repeat(5000))).status, 413);
  assert.equal((await post(JSON.stringify(body), 'text/plain')).status, 415);
  assert.equal((await post(JSON.stringify(body))).status, 200);
  const response = await fetch(url);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { required: true, submitted: true });
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 405);
});
