import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reconstruct } from './reconstruct.mjs';
const manifest={schema_version:1,run_id:'fixture',workload:'M2',batch_size:1,tenant_count:1,rate_rps:3,expected:4,started_at:'2026-09-18T00:00:00.999999999Z'};
function record(kind,seq,count=1) {const b=Buffer.alloc(17);b[0]=kind;b.writeBigUInt64LE(BigInt(seq),1);b.writeBigUInt64LE(BigInt(count),9);return b;}
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'nudgeon-failure-export-test-'));
 await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
 await writeFile(join(root,'summary.json'),JSON.stringify({run_id:'fixture',outcome:'FAIL',counters:{http_errors:1,network_errors:1,response_errors:0,dropped:2}}));
 await writeFile(join(root,'events.bin'),Buffer.concat([record(1,0),record(4,0),record(1,1),record(5,1),record(3,2,2)]));
 return root;
}
function run(root,out,limit=10000) {return spawnSync(process.execPath,['tests/ops/loadgen-failures/export.mjs',root,out,String(limit)],{encoding:'utf8'});}

test('nanosecond timestamps survive fractional schedule offsets and second rollover',()=>{
 assert.equal(reconstruct(manifest,1).batch[0].client_ts,'2026-09-18T00:00:01.333333332Z');
 assert.equal(reconstruct(manifest,3).batch[0].client_ts,'2026-09-18T00:00:01.999999999Z');
 assert.throws(()=>reconstruct({...manifest,tenant_count:2},0));
 assert.throws(()=>reconstruct({...manifest,workload:'unknown'},0));
});
test('bounded export reports truncation, excludes drops and leaves source unchanged',async()=>{
 const root=await fixture(),out=join(root,'output');
 const before=await readFile(join(root,'events.bin'));
 const result=run(root,out,1);assert.equal(result.status,0,result.stderr);
 const summary=JSON.parse(await readFile(join(out,'result.json'),'utf8'));
 assert.equal(summary.requests_sent,0);assert.equal(summary.truncated,true);
 assert.equal(summary.failed_requests,2);assert.equal(summary.exported_requests,1);assert.equal(summary.dropped_requests_not_exported,2);
 assert.deepEqual(await readFile(join(root,'events.bin')),before);
 assert.notEqual(run(root,out).status,0);
});
test('truncated journals never produce a valid final result',async()=>{
 const root=await fixture(),out=join(root,'output');
 const bytes=await readFile(join(root,'events.bin'));await writeFile(join(root,'events.bin'),bytes.subarray(0,bytes.length-1));
 assert.notEqual(run(root,out).status,0);
 await assert.rejects(access(join(out,'result.json')));
});
test('final summary failure accounting must match the journal',async()=>{
 const root=await fixture(),out=join(root,'output');
 await writeFile(join(root,'summary.json'),JSON.stringify({run_id:'fixture',outcome:'FAIL',counters:{http_errors:0,network_errors:0,response_errors:0,dropped:2}}));
 assert.notEqual(run(root,out).status,0);
 await assert.rejects(access(join(out,'result.json')));
});
