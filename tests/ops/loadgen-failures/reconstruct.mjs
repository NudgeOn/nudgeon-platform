import { createHash } from 'node:crypto';
const urlNamespace = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const validName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export function uuidV5(namespace, value) {
  const bytes = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function id(run, kind, sequence) {
  return uuidV5(uuidV5(urlNamespace, `nudgeon-loadgen:v1:${run}`), `${kind}:${sequence}`);
}
function timestamp(start, sequence, rate) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(start);
  if (!match) throw new Error('Unsupported source timestamp');
  const baseMs = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(baseMs)) throw new Error('Invalid source timestamp');
  const ns = BigInt(baseMs) * 1000000n + BigInt((match[2] ?? '').padEnd(9, '0')) + BigInt(sequence) * 1000000000n / BigInt(rate);
  const seconds = ns / 1000000000n;
  const fraction = (ns % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${new Date(Number(seconds * 1000n)).toISOString().slice(0, 19)}${fraction ? '.' + fraction : ''}Z`;
}
export function reconstruct(manifest, requestSequence) {
  const profile = manifest.workload === 'all_new_identity_single_event' ? 'M2' : manifest.workload;
  const batchSize = manifest.batch_size ?? 1;
  const tenantIDs = manifest.tenant_ids ?? [];
  const tenantCount = manifest.tenant_count ?? 1;
  if (manifest.schema_version !== 1 || !validName.test(manifest.run_id) || !['M2','M0','M1','M4','seed'].includes(profile) ||
      !Number.isSafeInteger(manifest.rate_rps) || manifest.rate_rps < 1 || manifest.rate_rps > 1000000000 ||
      !Number.isSafeInteger(manifest.expected) || manifest.expected < 1 || !Number.isSafeInteger(requestSequence) || requestSequence < 0 || requestSequence >= manifest.expected ||
      batchSize !== (profile === 'M4' ? 10 : 1) || !Number.isInteger(tenantCount) || tenantCount < 1 || tenantCount > 100 || (tenantIDs.length !== tenantCount && (tenantCount > 1 || tenantIDs.length > 0))) {
    throw new Error('Unsupported or inconsistent manifest');
  }
  const tenant = tenantIDs.length ? tenantIDs[requestSequence % tenantCount] : null;
  if (tenant && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)) throw new Error('Invalid tenant ID');
  let identityRun = manifest.run_id, identitySequence = requestSequence;
  if (profile !== 'M2') {
    if (!validName.test(manifest.identity_seed) || !Number.isInteger(manifest.identity_count) || manifest.identity_count < 1 || manifest.identity_count > 1000000) throw new Error('Invalid identity pool');
    const localSequence = Math.floor(requestSequence / tenantCount);
    identityRun = `identity-pool:${manifest.identity_seed}`;
    identitySequence = localSequence % manifest.identity_count;
    if (profile === 'M1' && localSequence % 100 === 99) { identityRun = manifest.run_id; identitySequence = localSequence; }
    if (tenant) identityRun += `:tenant:${tenant}`;
  }
  const clientTime = timestamp(manifest.started_at, requestSequence, manifest.rate_rps);
  const batch = Array.from({length: batchSize}, (_, i) => {
    const sequence = requestSequence * batchSize + i;
    if (!Number.isSafeInteger(sequence)) throw new Error('Event sequence overflow');
    let properties = profile === 'M2' ? {n: sequence % 1000, load_run_id: manifest.run_id, load_sequence: sequence} :
      {load_run_id: manifest.run_id, load_sequence: sequence, load_request_sequence: requestSequence, load_workload: profile, padding: ''};
    if (profile !== 'M2') {
      if (tenant) properties.load_tenant_id = tenant;
      const padding = 1024 - Buffer.byteLength(JSON.stringify(properties));
      if (padding < 0) throw new Error('Properties size overflow');
      properties.padding = 'x'.repeat(padding);
    }
    return {insert_id: id(manifest.run_id, 'event', sequence), anon_id: id(identityRun, 'anon', identitySequence),
      event: profile === 'M2' ? 'load_event' : `load_event_${String(sequence % 10).padStart(2, '0')}`, properties, client_ts: clientTime};
  });
  return {batch, device: {device_id: id(identityRun, 'device', identitySequence), platform: 'android'}};
}
