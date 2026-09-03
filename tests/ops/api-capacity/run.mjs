import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {acknowledgedIDs,reconcile} from '../projection/reconcile.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {Pool}=createRequire(path.join(root,'apps/api/package.json'))('pg');
const project=`nudgeon-api-capacity-${randomUUID().slice(0,8)}`, evidence=path.join(root,'.nudgeon',project);
// Reuse ONLY the unchanged worker from this recorded local build, after checking
// every worker/shared Go/schema input below. A fresh full API image is built.
const workerEvidence=path.join(root,'.nudgeon/nudgeon-projection-qa-42d33634');
const env={...process.env,PROJECTION_API_IMAGE:process.env.API_CAPACITY_EXISTING_IMAGE??`${project}-api:local`,PROJECTION_WORKER_IMAGE:'sha256:d647831a9823235a5ab12088443c66c685b980184febedb4a100b431fe7e21fc',API_KEY_USAGE_COALESCE_ENABLED:'false',GOCACHE:'/tmp/nudgeon-go-build-cache'};
const result={project,evidence,startedAt:new Date().toISOString(),pass:false,rounds:[],locks:[],host:{cpus:os.cpus().length,load:os.loadavg()}};
await fs.mkdir(evidence,{recursive:true,mode:0o700});
const children=new Set();let interrupted=false,cleaning=false,started=false,pg;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{interrupted=true;for(const c of children)c.kill('SIGTERM');});
async function run(command,args,extraEnv={},timeout=180000){
  if(interrupted&&!cleaning)throw new Error('interrupted');
  const c=spawn(command,args,{cwd:root,env:{...env,...extraEnv},stdio:['ignore','pipe','pipe']});children.add(c);
  const out=[],err=[];c.stdout.on('data',b=>out.push(b));c.stderr.on('data',b=>err.push(b));
  const timer=setTimeout(()=>c.kill('SIGTERM'),timeout);
  const code=await new Promise((resolve,reject)=>{c.once('error',reject);c.once('close',resolve);});
  clearTimeout(timer);children.delete(c);
  const stdout=Buffer.concat(out).toString(),stderr=Buffer.concat(err).toString();
  if(code!==0)throw Object.assign(new Error(`${command} exit ${code}: ${stdout.slice(-2000)} ${stderr.slice(-3000)}`),{stdout,stderr,exitCode:code});
  return stdout.trim()+(stderr?'\n'+stderr.trim():'');
}
const dc=(...args)=>run('docker',['compose','-p',project,'-f','tests/ops/projection/compose.yaml','-f','tests/ops/api-capacity/compose.yaml',...args]);
const save=(name,value)=>fs.writeFile(path.join(evidence,name),typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});
const sha=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const api='http://127.0.0.1:19500',tid='11111111-1111-4111-8111-111111111111',aid='22222222-2222-4222-8222-222222222222';
const scope=`tenant_id='${tid}' AND app_id='${aid}'`;
const http=(url,options={})=>fetch(url,{signal:AbortSignal.timeout(6000),...options});
async function until(check,label,timeout=30000){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){
    if(interrupted&&!cleaning)throw new Error('interrupted');
    try{const v=await check();if(v)return v;}catch(e){last=e.message;}
    await sleep(100);
  }throw new Error(`timeout ${label}: ${last??''}`);
}
async function metrics(port){const r=await http(`http://127.0.0.1:${port}/metrics`);assert(r.ok);return r.text();}
function metric(raw,name){const m=raw.match(new RegExp(`^${name} ([^\\n]+)$`,'m'));assert(m,`missing metric ${name}`);return Number(m[1]);}
async function newKey(){
  const id=randomUUID(),raw='sk_'+randomUUID().replaceAll('-','');
  await pg.query(`INSERT INTO api_keys(id,tenant_id,app_id,kind,scope,prefix,key_hash) VALUES($1,$2,$3,'server','full',$4,$5)`,[id,tid,aid,raw.slice(0,11),sha(raw)]);
  return {id,raw};
}
async function track(key,insertID,runID){
  const r=await http(api+'/v1/track',{method:'POST',headers:{'content-type':'application/json','x-api-key':key.raw},body:JSON.stringify({batch:[{insert_id:insertID,anon_id:randomUUID(),event:'api_capacity_qa',client_ts:new Date().toISOString(),properties:{load_run_id:runID}}]})});
  const body=await r.text();assert.equal(r.status,202,body);assert.equal(JSON.parse(body).accepted,1);
}
async function stats(){
  // Normalized SQL text is used only for fixed categories, never exported as labels.
  const {rows}=await pg.query(`SELECT CASE WHEN query ILIKE 'UPDATE api_keys SET last_used_at%' THEN 'key_usage' WHEN query LIKE 'SELECT id, tenant_id, app_id, kind, scope, status, grace_expires_at%' THEN 'key_auth' WHEN query='COMMIT' THEN 'commit' ELSE 'other' END AS kind, sum(calls)::float8 AS calls,sum(rows)::float8 AS rows,sum(total_exec_time)::float8 AS exec_ms,sum(wal_bytes)::float8 AS wal_bytes FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) GROUP BY 1`);
  return Object.fromEntries(rows.map(({kind,...v})=>[kind,v]));
}
function delta(before,after){return Object.fromEntries(Object.entries(after).map(([k,v])=>[k,Object.fromEntries(Object.entries(v).map(([f,n])=>[f,n-(before[k]?.[f]??0)]))]));}
async function waits(){
  return (await pg.query(`SELECT CASE WHEN query ILIKE 'UPDATE api_keys SET last_used_at%' THEN 'key_usage' WHEN query='COMMIT' THEN 'commit' ELSE 'other' END AS kind,coalesce(wait_event_type,'CPU_or_runnable') AS type,coalesce(wait_event,'none') AS event,count(*)::int AS n FROM pg_stat_activity WHERE application_name='api-capacity' AND state='active' GROUP BY 1,2,3`)).rows;
}
async function reconcileRun(runID,ids,prefix){
  let ledger;
  const start=Date.now();
  await until(async()=>{
    ledger=(await pg.query(`SELECT count(*)::int AS unique,count(projected_at)::int AS projected,coalesce(array_agg(insert_id::text),'{}') AS ids FROM event_receipts WHERE tenant_id=$1 AND app_id=$2 AND properties->>'load_run_id'=$3`,[tid,aid,runID])).rows[0];
    return ledger.unique===ids.length&&ledger.projected===ids.length;
  },'exact receipt projection',120000);
  const r=await http('http://127.0.0.1:19504/?database=nudgeon',{method:'POST',headers:{authorization:'Basic '+Buffer.from('nudgeon:local-projection-only').toString('base64')},body:`SELECT toString(insert_id) AS id,count() AS n FROM events WHERE ${scope} AND JSONExtractString(properties,'load_run_id')='${runID}' GROUP BY insert_id FORMAT JSONEachRow`});
  const raw=await r.text();assert(r.ok,raw);const rows=raw.trim().split('\n').filter(Boolean).map(JSON.parse);
  reconcile(ids,ledger.ids,rows);await save(`${prefix}-ledger.json`,ledger);await save(`${prefix}-clickhouse.json`,rows);
  return {acknowledged:ids.length,pgUnique:ledger.unique,pgProjected:ledger.projected,chPhysical:rows.reduce((n,r)=>n+Number(r.n),0),exactIDSetMatch:true,drainCheckMs:Date.now()-start};
}
async function switchMode(enabled){
  env.API_KEY_USAGE_COALESCE_ENABLED=String(enabled);
  await dc('up','-d','--no-deps','--force-recreate','--pull','never','api');
  await until(async()=>(await http(api+'/readyz')).status===200,'API readiness');
  assert.equal(await run('docker',['inspect',`${project}-api-1`,'--format','{{.Image}}']),result.apiImage);
}
async function lockLane(enabled){
  await switchMode(enabled);
  const key=await newKey(),runID=randomUUID(),ids=Array.from({length:20},()=>randomUUID());
  const blocker=await pg.connect();let completed=0,requests,locked;
  try{
    await blocker.query('BEGIN');await blocker.query(`SELECT id FROM api_keys WHERE tenant_id=$1 AND app_id=$2 AND id=$3 FOR UPDATE`,[tid,aid,key.id]);
    // Attach error handlers immediately, and always release the fixture lock.
    requests=Promise.all(ids.map(id=>track(key,id,runID).then(()=>{completed++;}).catch(error=>({error:error.message}))));
    if(enabled)await until(async()=>completed===20,'receipts proceed while metadata row locked',2000);
    else await until(async()=>{
      const w=await waits();return w.filter(r=>r.kind==='key_usage'&&r.type==='Lock').reduce((n,r)=>n+r.n,0)>=5;
    },'legacy metadata lock contention',2000);
    locked={enabled,completedBeforeUnlock:completed,waits:await waits(),apiMetrics:await metrics(19501)};
    if(enabled)assert.equal(locked.waits.filter(r=>r.kind==='key_usage'&&r.type==='Lock').reduce((n,r)=>n+r.n,0),1);
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  const responses=await requests;assert(responses.every(r=>!r?.error),JSON.stringify(responses));
  await save(`lock-${enabled}-api.prom`,locked.apiMetrics);delete locked.apiMetrics;
  locked.reconciliation=await reconcileRun(runID,ids,`lock-${enabled}`);
  result.locks.push(locked);console.log(`Lock lane ${enabled}: ${locked.completedBeforeUnlock}/20 completed before unlock.`);
}
async function loadRound(enabled,index){
  await switchMode(enabled);const key=await newKey(),runID=randomUUID(),prefix=`round-${index}-${enabled}`;
  await save(`${prefix}-synthetic-key.txt`,key.raw);
  const before=await stats(),samples=[];let sampling=true,sampleError;
  const sampler=(async()=>{while(sampling){samples.push({at:new Date().toISOString(),waits:await waits(),api:await metrics(19501)});await sleep(200);}})().catch(e=>{sampleError=e.message;});
  let error,log;
  try{log=await run(path.join(evidence,'loadgen'),['--url',api,'--key-file',path.join(evidence,`${prefix}-synthetic-key.txt`),'--run-id',runID,'--rate','100','--dur','10s','--concurrency','20','--max-p99','500ms','--output-dir',path.join(evidence,prefix)]);}
  catch(e){error=e;log=String(e.stdout??'')+'\n'+String(e.stderr??e.message);}
  finally{sampling=false;await sampler;}
  await save(`${prefix}-loadgen.log`,log);assert(!sampleError,sampleError);
  const load=JSON.parse(await fs.readFile(path.join(evidence,prefix,'summary.json'),'utf8'));
  const round={index,enabled,load,loadExitCode:error?.exitCode??0};result.rounds.push(round);
  const ids=acknowledgedIDs(runID,await fs.readFile(path.join(evidence,prefix,'events.bin')),1000);
  assert.equal(ids.length,load.counters.accepted);
  assert.equal(load.counters.http_errors+load.counters.network_errors+load.counters.response_errors,0,'ambiguous outcomes need separate reconciliation');
  round.reconciliation=await reconcileRun(runID,ids,prefix);
  await until(async()=>metric(await metrics(19501),'nudgeon_api_key_usage_pending')===0,'metadata drain');
  const a=await metrics(19501),w=await metrics(19502),after=await stats();
  round.sql=delta(before,after);round.hostLoad=os.loadavg();
  assert.equal(round.sql.key_auth.calls,load.counters.started,'one actual auth SELECT per started request');
  assert.equal(round.sql.key_usage.rows,enabled?1:load.counters.started,'actual last_used_at row updates');
  assert.equal(metric(a,'nudgeon_api_receipts_committed_total'),ids.length);
  await save(`${prefix}-api.prom`,a);await save(`${prefix}-worker.prom`,w);await save(`${prefix}-samples.json`,samples);await save(`${prefix}-sql.json`,{before,after,delta:round.sql});
  console.log(`Round ${index} enabled=${enabled}: ${load.outcome}, accepted=${ids.length}, p99=${load.latency.end_to_end.p99_ns/1e6}ms, key writes=${round.sql.key_usage.rows}`);
}
async function sourceManifest(){
  const files=(await run('rg',['--files','apps/api','apps/worker','packages','db'])).split('\n').filter(f=>!f.includes('/node_modules/')&&!f.includes('/dist/')&&!f.includes('/bin/')&&!f.endsWith('.log'));
  files.push('go.work','go.work.sum','pnpm-lock.yaml','pnpm-workspace.yaml','package.json','tsconfig.base.json','.dockerignore');
  const entries=[];for(const f of [...new Set(files)].sort())entries.push({path:f,sha256:sha(await fs.readFile(path.join(root,f)))});
  return {sha256:sha(JSON.stringify(entries)),entries};
}
try{
  result.containersBefore=(await run('docker',['ps','--format','{{.Names}}'])).split('\n').sort();
  const mem=(await run('docker',['stats','--no-stream','--format','{{.MemUsage}}'])).split('\n');
  const bytes=s=>{const m=s.trim().match(/^([\d.]+)([KMGT]?i?B)$/);assert(m);return Number(m[1])*({B:1,KiB:1024,MiB:1024**2,GiB:1024**3,TiB:1024**4,kB:1000,MB:1e6,GB:1e9}[m[2]]);};
  const v=mem.map(s=>s.split('/').map(bytes));result.memoryPreflight={used:v.reduce((n,[x])=>n+x,0),limit:Math.max(...v.map(([,x])=>x))};
  assert(result.memoryPreflight.limit-result.memoryPreflight.used>2.9*1024**3,'insufficient Docker memory');
  const disk=await fs.statfs(root);result.freeDiskBytes=disk.bavail*disk.bsize;assert(result.freeDiskBytes>10*1024**3,'insufficient disk');
  result.revision=await run('git',['rev-parse','HEAD']);result.dirty=Boolean(await run('git',['status','--porcelain']));
  const source=await sourceManifest();result.sourceSHA256=source.sha256;await save('source-manifest.json',source);
  const old=JSON.parse(await fs.readFile(path.join(workerEvidence,'source-manifest.json'),'utf8'));
  const workerInputs=m=>m.entries.filter(e=>e.path.startsWith('apps/worker/')||e.path.startsWith('db/')||e.path.endsWith('.go')||e.path.endsWith('/go.mod')||e.path.endsWith('/go.sum')||['go.work','go.work.sum','.dockerignore'].includes(e.path));
  assert.deepEqual(workerInputs(source),workerInputs(old),'worker/shared Go/schema inputs changed; build and pin a fresh worker first');
  result.workerImage=await run('docker',['image','inspect',env.PROJECTION_WORKER_IMAGE,'--format','{{.Id}}']);result.workerSourceSHA256=old.sha256;
  await save('worker-reuse-manifest.json',{priorEvidence:workerEvidence,priorSourceSHA256:old.sha256,matchedInputs:workerInputs(source)});
  if(!process.env.API_CAPACITY_EXISTING_IMAGE){
    console.log(`Building full API image ${env.PROJECTION_API_IMAGE}`);
    await save('api-build.log',await run('docker',['build','--pull=false','--build-arg',`BUILD_REVISION=${result.revision}`,'--build-arg',`BUILD_SOURCE_SHA256=${source.sha256}`,'-f','apps/api/Dockerfile','-t',env.PROJECTION_API_IMAGE,'.'],{},600000));
  }else result.reusedAPIImage=process.env.API_CAPACITY_EXISTING_IMAGE;
  result.apiImage=await run('docker',['image','inspect',env.PROJECTION_API_IMAGE,'--format','{{.Id}}']);
  assert.equal(await run('docker',['image','inspect',result.apiImage,'--format','{{index .Config.Labels "io.nudgeon.api.source-sha256"}}']),source.sha256);
  await run('go',['build','-trimpath','-o',path.join(evidence,'loadgen'),'./apps/worker/cmd/loadgen']);
  started=true;console.log('Starting isolated local fixture.');await dc('up','-d','--pull','never','--wait','--wait-timeout','90');
  pg=new Pool({connectionString:'postgres://nudgeon:local-projection-only@127.0.0.1:19503/nudgeon',max:3,statement_timeout:5000});
  await pg.query('CREATE EXTENSION pg_stat_statements');
  await until(async()=>(await http('http://127.0.0.1:19502/readyz')).status===200,'worker readiness');
  await lockLane(false);await lockLane(true);
  // Two observations per mode, ABBA order. These short calibration tests are not G1.
  for(const [i,enabled]of [false,true,true,false].entries())await loadRound(enabled,i+1);
  result.accountingPass=true;
  result.capacityPass=result.rounds.filter(r=>r.enabled).every(r=>r.load.outcome==='PASS'&&r.loadExitCode===0);
  let testLog;
  try{testLog=await run('pnpm',['--filter','@nudgeon/api','exec','vitest','run','src/auth/api-key-usage.integration.test.ts','src/ingestion/event-receipts.test.ts'],{NUDGEON_RECEIPT_TEST_DATABASE_URL:'postgres://nudgeon:local-projection-only@127.0.0.1:19503/nudgeon'});}
  catch(e){await save('actual-pg-tests.log',String(e.stdout??'')+'\n'+String(e.stderr??e.message));throw e;}
  await save('actual-pg-tests.log',testLog);assert(!testLog.includes('skipped'),'DB suites must not skip');
  assert.equal((await sourceManifest()).sha256,source.sha256,'tested source changed');
  result.correctnessPass=true;
  result.pass=result.capacityPass;
  if(!result.pass){result.error='Correctness passed; optimized short load gate failed. No capacity qualification.';process.exitCode=1;}
}catch(e){result.error=e.message;process.exitCode=1;}
finally{
  cleaning=true;if(pg)await pg.end();
  if(started)try{
    await save('containers.log',await dc('logs','--no-color'));await dc('stop','-t','20');
    await save('shutdown-containers.log',await dc('logs','--no-color'));result.services=[];
    for(const service of ['api','ingest','scheduler','postgres','redis','clickhouse','gateway'])result.services.push({service,...JSON.parse(await run('docker',['inspect',`${project}-${service}-1`,'--format','{{json .State}}']))});
    const nets=(await run('docker',['network','ls','--filter',`label=com.docker.compose.project=${project}`,'--format','{{.ID}}'])).split('\n').filter(Boolean);
    for(const id of nets){
      const n=JSON.parse(await run('docker',['network','inspect',id,'--format','{{json .}}']));
      for(const [cid,c]of Object.entries(n.Containers??{})){assert(c.Name.startsWith(project+'-'));await run('docker',['network','disconnect',id,cid]);}
      await run('docker',['network','rm',id]);
    }
    result.containersAfter=(await run('docker',['ps','--format','{{.Names}}'])).split('\n').sort();assert.deepEqual(result.containersAfter,result.containersBefore);
    assert(result.services.every(s=>s.Status==='exited'&&s.ExitCode===0&&!s.OOMKilled),'unclean fixture shutdown');
  }catch(e){result.cleanupError=e.message;result.pass=false;process.exitCode=1;}
  result.finishedAt=new Date().toISOString();await save('result.json',result);
  console.log(JSON.stringify({project,evidence,pass:result.pass,correctnessPass:result.correctnessPass,capacityPass:result.capacityPass,error:result.error,cleanupError:result.cleanupError},null,2));
}
