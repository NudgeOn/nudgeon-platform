import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {scenarios} from './scenarios.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = process.argv.includes('--baseline');
const project = `nudgeon-api-shutdown-${randomUUID().slice(0, 8)}`;
const evidence = path.join(root, '.nudgeon', project);
await fs.mkdir(evidence, {recursive:true, mode:0o700});
const dist = path.join(evidence, 'dist');
await fs.cp(path.join(root, 'apps/api/dist'), dist, {recursive:true, errorOnExist:true});
const env = {...process.env, SHUTDOWN_API_DIST:dist, SHUTDOWN_QA_PROBE:String(baseline)};
const result = {project, baseline, startedAt:new Date().toISOString(), pass:false};
let interrupted=false, cleaning=false;
const children=new Set();
for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{interrupted=true;for(const child of children)child.kill('SIGTERM');});
async function run(command,args) {
  if(interrupted && !cleaning) throw new Error('interrupted');
  const child=spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
  children.add(child);
  const chunks=[];
  child.stdout.on('data',d=>chunks.push(d)); child.stderr.on('data',d=>chunks.push(d));
  const timer=setTimeout(()=>child.kill('SIGTERM'),150000);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  clearTimeout(timer); children.delete(child);
  const out=Buffer.concat(chunks).toString().trim();
  if(code!==0) throw new Error(`${command} exit ${code}: ${out}`);
  return out;
}
const dc=(...args)=>run('docker',['compose','-p',project,'-f','tests/ops/api-shutdown/compose.yaml',...args]);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const state=async service=>JSON.parse(await run('docker',['inspect',`${project}-${service}-1`,'--format','{{json .State}}']));
const key='sk_dev_0000000000000000000000000000';
const api='http://127.0.0.1:19480';
const saveLog=async(name,text)=>fs.writeFile(path.join(evidence,name),text,{mode:0o600});
async function fingerprint(directory) {
  const entries=[];
  async function visit(folder) {
    for(const entry of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file=path.join(folder,entry.name);
      if(entry.isDirectory())await visit(file);
      else if(entry.isFile())entries.push([path.relative(directory,file),createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
    }
  }
  await visit(directory);
  return {files:entries.length,sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex')};
}
try {
  result.baseCommit=await run('git',['rev-parse','HEAD']);
  result.branch=await run('git',['branch','--show-current']);
  result.dist=await fingerprint(dist);
  result.source=await fingerprint(path.join(root,'apps/api/src'));
  result.lockfileSha256=createHash('sha256').update(await fs.readFile(path.join(root,'pnpm-lock.yaml'))).digest('hex');
  result.containersBefore=(await run('docker',['ps','--format','{{.Names}}'])).split('\n').sort();
  // Reserve room for the bounded 2.16 GiB test stack before creating anything.
  const memory=await run('docker',['stats','--no-stream','--format','{{.MemUsage}}']);
  const bytes=value=>{const match=value.trim().match(/^([\d.]+)([KMGT]?i?B)$/);assert(match,`unrecognized Docker memory: ${value}`);return Number(match[1])*({B:1,KiB:1024,MiB:1024**2,GiB:1024**3,TiB:1024**4,kB:1000,MB:1000**2,GB:1000**3}[match[2]]??NaN);};
  const samples=memory.split('\n').map(line=>line.split('/').map(bytes));
  const used=samples.reduce((sum,[amount])=>sum+amount,0), limit=Math.max(...samples.map(([,amount])=>amount));
  assert(limit-used>2.6*1024**3,'insufficient Docker memory headroom for isolated test');
  result.memoryPreflight={usedBytes:Math.round(used),reportedLimitBytes:Math.round(limit),requiredHeadroomGiB:2.6};
  await dc('up','-d','--pull','never','--wait','--wait-timeout','90');
  let ready=false;
  for(let i=0;i<60;i++) {
    try { const res=await fetch(`${api}/readyz`,{signal:AbortSignal.timeout(4000)}); if(res.ok){ready=true;break;} } catch {}
    await wait(500);
  }
  assert(ready,'API never ready');
  if(!baseline) {
    await scenarios({root,project,run,dc,state,api,key,wait,result,saveLog});
    const receiptTests=await run('env',['NUDGEON_RECEIPT_TEST_DATABASE_URL=postgres://nudgeon:local-shutdown-only@127.0.0.1:19495/nudgeon','pnpm','--filter','@nudgeon/api','exec','vitest','run','src/ingestion/event-receipts.test.ts']);
    await saveLog('receipt-tests.log',receiptTests);
    assert(receiptTests.includes('7 passed')&&!receiptTests.includes('skipped'),'actual PG receipt regressions must pass without skips');
    result.actualPostgresReceiptTests={passed:7,skipped:0};
  } else {
  const id=randomUUID();
  const response=await fetch(`${api}/v1/track`,{method:'POST',headers:{'content-type':'application/json','x-api-key':key},body:JSON.stringify({batch:[{insert_id:id,external_id:'shutdown-qa',event:'shutdown_test',client_ts:new Date().toISOString()}]}),signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,202,await response.text());
  const start=Date.now();
  await dc('stop','-t','20','api');
  result.shutdownMs=Date.now()-start;
  result.apiState=await state('api');
  const log=await dc('logs','--no-color','api');
  await fs.writeFile(path.join(evidence,'api.log'),log,{mode:0o600});
  result.apiLogSha256=createHash('sha256').update(log).digest('hex');
  if(baseline) {
    assert.equal(result.apiState.ExitCode,137);
    assert.equal(result.apiState.OOMKilled,false);
    for(const event of ['http_close_end','infra_hook_end','self_signal_SIGTERM','still_alive']) assert(log.includes(event),event);
    assert(!log.includes('"qa_probe":"pg_end"'));
    result.expectedFailureReproduced=true;
  }
  }
  result.pass=true;
} catch(error) {result.error=error.message;process.exitCode=1;}
finally {
  cleaning=true;
  try {
    // Also recover a paused fixture after user interruption inside a scenario.
    if((await state('clickhouse')).Paused)await dc('unpause','clickhouse');
    await fs.writeFile(path.join(evidence,'containers.log'),await dc('logs','--no-color'),{mode:0o600});
    await dc('stop','-t','20');
    result.services=await Promise.all(['api','postgres','redis','clickhouse','gateway'].map(async service=>({service,...await state(service)})));
    result.containersAfter=(await run('docker',['ps','--format','{{.Names}}'])).split('\n').sort();
    assert.deepEqual(result.containersBefore,result.containersAfter);
    assert(result.services.every(s=>s.Status==='exited' && s.ExitCode===(s.service==='api' ? (baseline ? 137 : result.expectedApiExitCode??0) : 0)));
  } catch(error) {result.cleanupError=error.message;result.pass=false;process.exitCode=1;}
  result.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2),{mode:0o600});
  console.log(JSON.stringify(result,null,2));
}
