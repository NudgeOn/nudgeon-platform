// Offline only: no HTTP client, key input or automatic resend.
import { createReadStream } from 'node:fs';
import { readFile, open, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { reconstruct } from './reconstruct.mjs';

const [source, output, limitArg = '10000'] = process.argv.slice(2);
const limit = Number(limitArg);
if (!source || !output || !Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('Usage: node export.mjs SOURCE_RUN NEW_OUTPUT_DIR [limit 1..100000]');
const manifest = JSON.parse(await readFile(resolve(source,'manifest.json'),'utf8'));
const summary = JSON.parse(await readFile(resolve(source,'summary.json'),'utf8'));
if (summary.run_id !== manifest.run_id || !['PASS','FAIL','ABORTED'].includes(summary.outcome)) throw new Error('Final matching summary required');
reconstruct(manifest,0); // validate before creating output
await mkdir(output,{mode:0o700});
const file = await open(resolve(output,'failed-requests.jsonl'),'wx',0o600);
const hash = createHash('sha256');
let remainder = Buffer.alloc(0), exported = 0, failed = 0, dropped = 0;
const counts = {http_error:0,network_error:0,response_error:0};
try {
  for await (const chunk of createReadStream(resolve(source,'events.bin'))) {
    hash.update(chunk);
    const bytes = Buffer.concat([remainder,chunk]);
    let offset = 0;
    for (; offset + 17 <= bytes.length; offset += 17) {
      const kind=bytes[offset], seqBig=bytes.readBigUInt64LE(offset+1), countBig=bytes.readBigUInt64LE(offset+9);
      if (seqBig>BigInt(Number.MAX_SAFE_INTEGER) || countBig>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe journal integer');
      const seq=Number(seqBig),count=Number(countBig);
      if (![1,2,3,4,5,6].includes(kind) || count<1 || seq<0 || seq+count>manifest.expected || (kind!==3 && count!==1)) throw new Error('Invalid journal record');
      if (kind===3) {dropped+=count;continue;}
      if (kind<4) continue;
      const reason = ({4:'http_error',5:'network_error',6:'response_error'})[kind];
      counts[reason]++;failed++;
      if (exported>=limit) continue;
      const payload = reconstruct(manifest,seq);
      await file.write(`${JSON.stringify({request_sequence:seq, reason, original_acceptance:'unknown; reconcile before retry', tenant_id:manifest.tenant_ids?.[seq%(manifest.tenant_count??1)]??null, payload})}\n`);
      exported++;
    }
    remainder=bytes.subarray(offset);
  }
  if (remainder.length) throw new Error('Truncated journal');
  const c=summary.counters;
  if (failed!==c.http_errors+c.network_errors+c.response_errors || dropped!==c.dropped) throw new Error('Journal failure totals do not match summary');
  await file.sync();
} finally {await file.close();}
const result={schema_version:1,status:'REVIEW_REQUIRED_NO_SEND',source_run_id:manifest.run_id,source_outcome:summary.outcome,
  journal_sha256:hash.digest('hex'),failed_requests:failed,exported_requests:exported,truncated:exported<failed,
  dropped_requests_not_exported:dropped,counts,credentials_included:false,requests_sent:0,
  notes:'Payload fields and insert IDs reconstructed; original acceptance may be unknown. Verify target/key ownership and idempotency before any retry. Dropped arrivals remain a separate workload.'};
await writeFile(resolve(output,'result.json'),`${JSON.stringify(result,null,2)}\n`,{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));
