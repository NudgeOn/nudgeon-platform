import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
const source = readFileSync(new URL('./public/setup-database.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/m, '').replace(/^export /gm, '');
const response = (json, status = 200) => ({ ok: status < 400, json: async () => json });
async function harness(fetch, token = 'link-token') {
  const nodes = new Map(); let blob;
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', disabled: false, hidden: false, textContent: '', type: 'password', listeners: {},
      addEventListener: function (event, fn) { this.listeners[event] = fn; }, setAttribute() {}, focus() {}, click() {}, remove() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({ document: { querySelector: node, createElement: node, body: { append() {} } },
    crypto: webcrypto, Blob, URL: { createObjectURL: value => { blob = value; return 'blob:fixture'; }, revokeObjectURL() {} },
    fetch, setTimeout() {}, getSetupToken: () => token, setSetupToken: value => { token = value; } });
  vm.runInContext(source, context); context.initDatabaseSetup();
  await new Promise(resolve => setImmediate(resolve));
  return { node, context, blob: () => blob, token: () => token, submit: () => node('#database-form').listeners.submit({ preventDefault() {} }) };
}

test('recommended password changes on regeneration and explicit download matches the selected value', async () => {
  const h = await harness(async () => response({ required: true, submitted: false }));
  const password = h.node('#database-password'); const first = password.value;
  assert.match(first, /^[a-f0-9]{48}$/); assert.equal(h.node('#database-token-label').hidden, true);
  h.node('#generate-database-password').listeners.click(); assert.notEqual(password.value, first);
  password.value = "Custom '$:@ password 한글"; password.listeners.input();
  h.node('#download-database-password').listeners.click();
  assert.equal(JSON.parse(await h.blob().text()).password, password.value);
  assert.equal(password.type, 'password');
});
test('a lost save response retries with the same request ID and password', async () => {
  const bodies = []; const h = await harness(async (_, options) => {
    if (!options?.method) return response({ required: true, submitted: false });
    bodies.push(JSON.parse(options.body)); if (bodies.length === 1) throw Error('response lost');
    return response({ submitted: true });
  });
  await h.submit(); assert.equal(h.node('#save-database-password').disabled, false);
  await h.submit(); assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(h.node('#save-database-password').disabled, true);
});
test('manually correcting a bad link token is used for both database setup and later ownership claim', async () => {
  const bodies = []; const h = await harness(async (_, options) => {
    if (!options?.method) return response({ required: true, submitted: false });
    bodies.push(JSON.parse(options.body)); return bodies.length === 1 ? response({ error: 'invalid_token' }, 403) : response({ submitted: true });
  }, 'bad-link-token');
  await h.submit(); assert.equal(h.node('#database-token-label').hidden, false);
  h.node('#database-token').value = 'corrected-token'; await h.submit();
  assert.equal(bodies[1].token, 'corrected-token'); assert.equal(h.token(), 'corrected-token');
  assert.equal(h.node('#database-token').value, '');
});
test('reload after submission never creates a different recommendation or exposes the saved password', async () => {
  const h = await harness(async () => response({ required: true, submitted: true }));
  assert.equal(h.node('#database-password').value, '');
  assert.equal(h.node('#generate-database-password').disabled, true);
  assert.equal(h.node('#download-database-password').disabled, true);
});

test('optional in-app settings are submitted with the password and frozen while saving', async () => {
  let body;
  const h = await harness(async (_,options) => {
    if (!options?.method) return response({required:true,submitted:false});
    body = JSON.parse(options.body); return response({submitted:true});
  });
  h.node('#in-app-enabled').checked = true;
  h.node('#in-app-enabled').listeners.input();
  assert.equal(h.node('#in-app-options').hidden,false);
  h.node('#content-origin').value = 'https://content.example.com';
  h.node('#content-port').value = '8082';
  h.node('#in-app-campaigns').checked = true;
  await h.submit();
  assert.deepEqual(body.in_app,{enabled:true,campaigns:true,origin:'https://content.example.com',port:8082});
  assert.equal(h.node('#in-app-enabled').disabled,true);
});
