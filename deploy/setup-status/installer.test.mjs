import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nudgeon-installer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'), state = join(dir, 'state'); await mkdir(bin);
  const cli = join(dir, 'nudgeon'); await copyFile(new URL('../../nudgeon', import.meta.url), cli);
  const password = " PG '$:@/#% test 비밀번호 ";
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NUDGEON_STATE_DIR: state,
    NUDGEON_PORT: '57599', TEST_DIR: dir, TEST_PASSWORD: password };
  await writeFile(join(bin, 'docker'), `#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2),d=process.env.TEST_DIR;
fs.appendFileSync(d+'/calls',JSON.stringify(a)+'\\n');
if(a[0]==='volume')process.exit(process.env.TEST_EXISTING_VOLUME==='1'||(process.env.TEST_LATE_VOLUME==='1'&&fs.existsSync(d+'/selected'))?0:1);
if(a.includes('port'))console.log('127.0.0.1:57599');
if(a.includes('read-in-app')){process.stdout.write(process.env.TEST_IN_APP_CONFIG || 'IN_APP_ENABLED=false\\nIN_APP_CAMPAIGNS_ENABLED=false\\nCONTENT_PUBLIC_ORIGIN=\\nCONTENT_PORT=8082\\n');process.exit(0);}
if(a.includes('exec')){fs.writeFileSync(d+'/selected','yes');process.stdout.write(process.env.TEST_PASSWORD);}
`, { mode: 0o755 });
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const run = (...args) => exec('/bin/sh', [cli, ...args], { env, timeout: 10000 });
  return { dir, env, state, password, run };
}

test('first install selects a password before runtime, encodes it, and never echoes it', async t => {
  const { dir, state, password, run } = await fixture(t);
  const { stdout, stderr } = await run('up');
  assert(!stdout.includes(password)); assert(!stderr.includes(password));
  assert.equal(await readFile(join(state, 'secrets/postgres_password'), 'utf8'), password+'\n');
  const url = new URL((await readFile(join(state, 'secrets/database_url'), 'utf8')).trim());
  assert.equal(decodeURIComponent(url.password), password);
  assert.equal(url.hostname, 'postgres');
  assert.match(await readFile(join(state, 'compose.env'), 'utf8'), /NUDGEON_DATABASE_SETUP_REQUIRED=false/);
  await assert.rejects(access(join(state, 'database_setup_pending')));
  const calls = (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  const selected = calls.findIndex(a => a.includes('exec'));
  assert(selected > calls.findIndex(a => a.includes('up') && a.includes('gateway')));
  assert(selected < calls.findIndex(a => a.includes('up') && !a.includes('gateway')));
  await writeFile(join(dir, 'calls'), '');
  await run('up');
  assert(!(await readFile(join(dir, 'calls'), 'utf8')).includes('"exec"'));
  assert.equal(await readFile(join(state, 'secrets/postgres_password'), 'utf8'), password+'\n');
});
test('--defaults retains unattended generation; pending selection cannot be bypassed', async t => {
  const { dir, state, run } = await fixture(t);
  await run('up', '--defaults');
  assert.match(await readFile(join(state, 'secrets/postgres_password'), 'utf8'), /^[a-f0-9]{48}\n$/);
  assert(!(await readFile(join(dir, 'calls'), 'utf8')).includes('"exec"'));
  await writeFile(join(state, 'database_setup_pending'), '');
  await assert.rejects(run('up', '--defaults'), /웹 위자드/);
  await run('up');
  await assert.rejects(access(join(state, 'database_setup_pending')));
});
test('unknown flags, existing volumes, and simultaneous runs fail without replacing credentials', async t => {
  const { env, state, run } = await fixture(t);
  await assert.rejects(run('up', '--unknown'), /알 수 없는 up 옵션/);
  await assert.rejects(access(state));
  env.TEST_EXISTING_VOLUME = '1';
  await assert.rejects(run('up'), /기존 nudgeon-safe 데이터 볼륨/);
  await assert.rejects(access(state));
  delete env.TEST_EXISTING_VOLUME;
  env.TEST_LATE_VOLUME = '1';
  await assert.rejects(run('up'), /기존 데이터 볼륨/);
  const previous = await readFile(join(state, 'secrets/postgres_password'), 'utf8');
  await mkdir(state+'.up.lock');
  await assert.rejects(run('up'), /다른 설치 명령/);
  assert.equal(await readFile(join(state, 'secrets/postgres_password'), 'utf8'), previous);
  await access(state+'.up.lock');
});


test('in-app selection persists and includes the content overlay on restart', async t => {
  const { env,dir,state,run } = await fixture(t);
  env.TEST_IN_APP_CONFIG = 'IN_APP_ENABLED=true\nIN_APP_CAMPAIGNS_ENABLED=true\nCONTENT_PUBLIC_ORIGIN=https://content.example.com\nCONTENT_PORT=18082\n';
  await run('up');
  assert.equal(await readFile(join(state,'in-app.env'),'utf8'),env.TEST_IN_APP_CONFIG);
  assert.match(await readFile(join(state,'compose.env'),'utf8'),/CONTENT_PORT=18082/);
  await writeFile(join(dir,'calls'),'');
  await run('up');
  assert.match(await readFile(join(dir,'calls'),'utf8'),/compose.in-app.yaml/);
  assert.match(await readFile(join(state,'compose.env'),'utf8'),/IN_APP_CAMPAIGNS_ENABLED=true/);
});
