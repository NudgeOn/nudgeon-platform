import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acknowledgedIDs,reconcile} from './reconcile.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const project=`nudgeon-projection-qa-${randomUUID().slice(0,8)}`;
const evidence=path.join(root,'.nudgeon',project);
const env={...process.env,PROJECTION_API_IMAGE:`${project}-api:local`,PROJECTION_WORKER_IMAGE:`${project}-worker:local`,GOCACHE:'/tmp/nudgeon-go-build-cache'};
const result={project,evidence,startedAt:new Date().toISOString(),pass:false,steps:{},images:{}};
await fs.mkdir(evidence,{recursive:true,mode:0o700});
const children=new Set();let interrupted=false,cleaning=false,composeStarted=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{interrupted=true;for(const c of children)c.kill('SIGTERM');});
async function run(command,args,extraEnv={},timeout=180000){
  if(interrupted&&!cleaning)throw new Error('interrupted');
  const c=spawn(command,args,{cwd:root,env:{...env,...extraEnv},stdio:['ignore','pipe','pipe']});
  children.add(c);const out=[],err=[];
  c.stdout.on('data',b=>out.push(b));c.stderr.on('data',b=>err.push(b));
  const timer=setTimeout(()=>c.kill('SIGTERM'),timeout);
  const code=await new Promise((resolve,reject)=>{c.once('error',reject);c.once('close',resolve);});
  clearTimeout(timer);children.delete(c);
  const stdout=Buffer.concat(out).toString(),stderr=Buffer.concat(err).toString();
  if(code!==0)throw Object.assign(new Error(`${command} exit ${code}: ${stdout.slice(-3000)} ${stderr.slice(-4000)}`),{stdout,stderr,exitCode:code});
  return stdout.trim()+(stderr ? '\n'+stderr.trim() : '');
}
const dc=(...args)=>run('docker',['compose','-p',project,'-f','tests/ops/projection/compose.yaml',...args]);
const save=(name,value)=>fs.writeFile(path.join(evidence,name),typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});
const sha=b=>createHash('sha256').update(b).digest('hex');
const sql=q=>dc('exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','nudgeon','-d','nudgeon','-Atc',q);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const api='http://127.0.0.1:19500',tid='11111111-1111-4111-8111-111111111111',aid='22222222-2222-4222-8222-222222222222';
const pgScope=`tenant_id='${tid}' AND app_id='${aid}'`;
const key='sk_dev_0000000000000000000000000000';
const event=()=>({insert_id:randomUUID(),external_id:'projection-canary',event:'projection_canary',client_ts:new Date().toISOString()});
const http=(url,options={})=>fetch(url,{signal:AbortSignal.timeout(6000),...options});
async function text(url){const r=await http(url);assert(r.ok,`HTTP ${r.status} ${url}`);return r.text();}
async function until(check,label,timeout=45000){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){
    if(interrupted&&!cleaning)throw new Error('interrupted');
    try{const v=await check();if(v)return v;}catch(e){last=e.message;}
    await sleep(500);
  }
  throw new Error(`timeout ${label}: ${last??''}`);
}
function metric(raw,name){const m=raw.match(new RegExp(`^${name} ([^\\n]+)$`,'m'));assert(m,`missing metric ${name}`);return Number(m[1]);}
async function sample(){
  const start=Date.now();
  const [a,w]=await Promise.all([text('http://127.0.0.1:19501/metrics'),text('http://127.0.0.1:19502/metrics')]);
  return {at:new Date().toISOString(),scrapeStartedAt:start,scrapeMs:Date.now()-start,admitted:metric(a,'nudgeon_api_receipts_committed_total'),projected:metric(w,'nudgeon_ingest_receipts_projected_total'),a,w};
}
async function track(batch,status=202){
  const r=await http(api+'/v1/track',{method:'POST',headers:{'content-type':'application/json','x-api-key':key},body:JSON.stringify({batch})});
  const body=await r.text();assert.equal(r.status,status,body);return JSON.parse(body);
}
async function ch(q){
  const r=await http('http://127.0.0.1:19504/?database=nudgeon',{method:'POST',headers:{authorization:'Basic '+Buffer.from('nudgeon:local-projection-only').toString('base64')},body:q+' FORMAT JSONEachRow'});
  const raw=await r.text();assert(r.ok,raw);return raw.trim().split('\n').filter(Boolean).map(JSON.parse);
}
async function sourceManifest(){
  const files=(await run('rg',['--files','apps/api','apps/worker','packages','db'])).split('\n')
    .filter(f=>!f.includes('/node_modules/')&&!f.includes('/dist/')&&!f.includes('/bin/')&&!f.endsWith('.log'));
  files.push('go.work','go.work.sum','pnpm-lock.yaml','pnpm-workspace.yaml','package.json','tsconfig.base.json','.dockerignore');
  const entries=[];
  for(const f of [...new Set(files)].sort())entries.push({path:f,sha256:sha(await fs.readFile(path.join(root,f)))});
  return {sha256:sha(JSON.stringify(entries)),entries};
}
try{
  result.containersBefore=(await run('docker',['ps','--format','{{.Names}}'])).split('\n').sort();
  const stats=await run('docker',['stats','--no-stream','--format','{{.MemUsage}}']);
  const bytes=v=>{const m=v.trim().match(/^([\d.]+)([KMGT]?i?B)$/);assert(m);return Number(m[1])*({B:1,KiB:1024,MiB:1024**2,GiB:1024**3,TiB:1024**4,kB:1000,MB:1000**2,GB:1000**3}[m[2]]);};
  const samples=stats.split('\n').map(x=>x.split('/').map(bytes));
  result.memoryPreflight={used:samples.reduce((a,[v])=>a+v,0),limit:Math.max(...samples.map(([,v])=>v))};
  assert(result.memoryPreflight.limit-result.memoryPreflight.used>2.9*1024**3,'insufficient Docker memory headroom');
  result.revision=await run('git',['rev-parse','HEAD']);result.dirty=Boolean(await run('git',['status','--porcelain']));
  const source=await sourceManifest();result.sourceSHA256=source.sha256;await save('source-manifest.json',source);
  for(const component of ['api','worker']){
    const tag=env[`PROJECTION_${component.toUpperCase()}_IMAGE`];
    console.log(`Building full ${component} image ${tag}`);
    const log=await run('docker',['build','--pull=false','--build-arg',`BUILD_REVISION=${result.revision}`,'--build-arg',`BUILD_SOURCE_SHA256=${source.sha256}`,'--build-arg',`BUILD_DIRTY=${result.dirty}`,'-f',`apps/${component}/Dockerfile`,'-t',tag,'.'],{},600000);
    await save(`${component}-build.log`,log);
    result.images[component]=JSON.parse(await run('docker',['image','inspect',tag,'--format','{{json .}}']));
    assert.equal(result.images[component].Config.Labels[`io.nudgeon.${component}.source-sha256`],source.sha256);
  }
  assert.equal((await sourceManifest()).sha256,source.sha256,'source changed during build');
  await run('go',['build','-trimpath','-o',path.join(evidence,'loadgen'),'./apps/worker/cmd/loadgen']);
  console.log('Full images built; starting private PG/Redis/CH/API/ingest/relay test stack.');
  composeStarted=true;
  await dc('up','-d','--pull','never','--wait','--wait-timeout','90');
  await until(async()=>(await http(api+'/readyz')).status===200,'API readiness');
  await until(async()=>(await http('http://127.0.0.1:19502/readyz')).status===200,'worker readiness');
  assert.equal((await http(api+'/metrics')).status,404,'metrics must not be exposed on public API listener');
  const initial=await sample();assert.equal(initial.admitted,0);assert.equal(initial.projected,0);
  assert(initial.a.includes(`source_sha256="${source.sha256}"`));assert(initial.w.includes(`source_sha256="${source.sha256}"`));
  for(const [service,component]of [['api','api'],['ingest','worker'],['scheduler','worker']]){
    assert.equal(await run('docker',['inspect',`${project}-${service}-1`,'--format','{{.Image}}']),result.images[component].Id);
  }
  const one=event(),two=event();
  const body=await track([one,one,two]);assert.equal(body.accepted,3);
  await Promise.all([track([one,two]),track([one])]);
  await until(async()=>(await sample()).projected===2,'duplicate-safe first projection');
  const duplicate=await sample();assert.equal(duplicate.admitted,2);assert.equal(metric(duplicate.a,'nudgeon_api_receipt_duplicates_total'),4);
  await save('duplicates-api.prom',duplicate.a);await save('duplicates-worker.prom',duplicate.w);
  result.steps.duplicates={submitted:6,unique:2,projected:2,duplicateEvents:4};

  // Actual PostgreSQL lock timeout: target only this disposable database.
  const blocker=sql('BEGIN; LOCK TABLE event_receipts IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(6); ROLLBACK;').then(()=>({ok:true}),error=>({error}));
  await until(async()=>Number(await sql("SELECT count(*) FROM pg_locks WHERE relation='event_receipts'::regclass AND mode='AccessExclusiveLock' AND granted"))===1,'fixture table lock');
  const retry=event();await track([retry],503);
  const failed=await sample();assert.equal(failed.admitted,2);assert.equal(failed.projected,2);
  const unlock=await blocker;if(unlock.error)throw unlock.error;
  await track([retry]);await until(async()=>(await sample()).projected===3,'PG failure recovery');
  result.steps.postgresTimeout={http:503,admittedBefore:2,admittedAfterFailure:failed.admitted,retryUnique:1};

  await dc('pause','clickhouse');
  const delayed=event();await track([delayed]);
  await until(async()=>{
    const s=await sample();
    return s.w.split('\n').some(line=>/^nudgeon_ingest_clickhouse_insert_seconds_count\{/.test(line)&&line.includes('outcome="error"')&&Number(line.split(' ').at(-1))>0);
  },'real CH insert failure',15000);
  const blocked=await sample();assert.equal(blocked.admitted,4);assert.equal(blocked.projected,3);
  assert.equal(await sql(`SELECT count(*) FROM event_receipts WHERE ${pgScope} AND projected_at IS NULL`),'1');
  await save('clickhouse-failure-api.prom',blocked.a);await save('clickhouse-failure-worker.prom',blocked.w);
  await dc('unpause','clickhouse');
  await until(async()=>(await sample()).projected===4,'CH recovery once',45000);
  await track([delayed]);assert.equal((await sample()).projected,4);
  result.steps.clickhouseFailure={http:202,admitted:4,projectedDuringFailure:3,pending:1,recoveredProjected:4};

  // Actual authenticated user-activity route, independent of health and scrape.
  const token=randomUUID(),member=randomUUID();
  await sql(`INSERT INTO members(id,tenant_id,email,name,role,status) VALUES ('${member}','${tid}','${member}@example.invalid','Synthetic QA','owner','active'); INSERT INTO sessions(tenant_id,member_id,token_hash,expires_at) VALUES ('${tid}','${member}','${sha(token)}',now()+interval '1 hour');`);
  const uid=await sql(`SELECT id FROM users WHERE ${pgScope} AND external_id='projection-canary'`);
  const canaryStart=Date.now();
  const activity=await http(`${api}/v1/apps/${aid}/users/${uid}`,{headers:{cookie:`nudgeon_session=${token}`}});
  assert.equal(activity.status,200);const activityBody=await activity.json();assert.equal(activityBody.events.length,4);
  await save('activity-canary.json',activityBody);
  result.steps.activityCanary={http:200,eventCount:4,queryMs:Date.now()-canaryStart};

  // Ten seconds is an accounting smoke test, NOT a qualified capacity tier.
  const runId=randomUUID();await save('synthetic-key.txt',key);
  const samplesDuring=[];let sampling=true,sampleError;
  const sampler=(async()=>{while(sampling){samplesDuring.push(await sample());await sleep(500);}})().catch(error=>{sampleError=error;});
  let loadLog,loadError;
  try { loadLog=await run(path.join(evidence,'loadgen'),['--url',api,'--key-file',path.join(evidence,'synthetic-key.txt'),'--run-id',runId,'--rate','100','--dur','10s','--concurrency','20','--max-p99','500ms','--output-dir',path.join(evidence,'load')]); }
  catch(error) { loadError=error;loadLog=String(error.stdout??'')+'\n'+String(error.stderr??error.message); }
  finally { sampling=false;await sampler; }
  if(sampleError)throw sampleError;
  await save('loadgen.log',loadLog);
  const load=JSON.parse(await fs.readFile(path.join(evidence,'load/summary.json'),'utf8'));result.steps.loadgen=load;
  // A throughput/latency failure must remain FAIL, but still collect database
  // reconciliation and stage histograms to diagnose the broken boundary.
  result.steps.loadExitCode=loadError?.exitCode??0;
  const acknowledged=acknowledgedIDs(runId,await fs.readFile(path.join(evidence,'load/events.bin')),1000);
  assert.equal(acknowledged.length,load.counters.accepted,'journal vs summary acknowledgements');
  assert.equal(load.counters.http_errors+load.counters.network_errors+load.counters.response_errors,0,'ambiguous HTTP outcomes need separate reconciliation');
  await save('window-samples.json',samplesDuring.map(({a,w,...s})=>s));
  const manifest=JSON.parse(await fs.readFile(path.join(evidence,'load/manifest.json'),'utf8'));
  const loadStart=Date.parse(manifest.started_at),loadEnd=loadStart+load.active_duration_ns/1e6;
  const inside=samplesDuring.filter(s=>s.scrapeStartedAt>=loadStart&&Date.parse(s.at)<=loadEnd);
  assert(inside.length>=3,'insufficient in-window samples');
  const a=inside[0],b=inside.at(-1),seconds=(Date.parse(b.at)-Date.parse(a.at))/1000;
  result.steps.sampledWindow={from:a.at,to:b.at,seconds,admitted:b.admitted-a.admitted,projected:b.projected-a.projected,admittedEPS:(b.admitted-a.admitted)/seconds,projectedEPS:(b.projected-a.projected)/seconds,maxScrapeMs:Math.max(...inside.map(s=>s.scrapeMs)),definition:'observed interval strictly within loadgen input; excludes warmup and drain; two scrapes are not an atomic snapshot'};
  const drainStart=Date.now();
  await until(async()=>(await sample()).projected===acknowledged.length+4,'projection drain',120000);
  result.steps.drainMs=Date.now()-drainStart;
  const ledger=JSON.parse(await sql(`SELECT json_build_object('unique',count(*),'projected',count(projected_at),'ids',array_agg(insert_id::text ORDER BY insert_id)) FROM event_receipts WHERE ${pgScope} AND properties->>'load_run_id'='${runId}'`));
  const rows=await ch(`SELECT toString(insert_id) AS id,count() AS n FROM events WHERE ${pgScope} AND JSONExtractString(properties,'load_run_id')='${runId}' GROUP BY insert_id ORDER BY insert_id`);
  assert.equal(ledger.unique,acknowledged.length);assert.equal(ledger.projected,acknowledged.length);assert.equal(rows.length,acknowledged.length);
  await save('load-ledger.json',ledger);await save('load-clickhouse.json',rows);
  reconcile(acknowledged,ledger.ids??[],rows);
  const final=await sample();assert.equal(final.admitted,acknowledged.length+4);assert.equal(final.projected,acknowledged.length+4);
  await save('final-api.prom',final.a);await save('final-worker.prom',final.w);
  result.steps.reconciliation={apiCommitted:final.admitted,workerProjected:final.projected,scheduled:1000,dropped:load.counters.dropped,acknowledged:acknowledged.length,loadPGUnique:ledger.unique,loadPGProjected:ledger.projected,loadCHPhysical:rows.length,exactIDSetMatch:true};
  console.log('HTTP / PG / CH / activity reconciliation passed; running actual DB regressions.');
  const testEnv={NUDGEON_RECEIPT_TEST_DATABASE_URL:'postgres://nudgeon:local-projection-only@127.0.0.1:19503/nudgeon',NUDGEON_RECEIPT_TEST_CLICKHOUSE_DSN:'http://nudgeon:local-projection-only@127.0.0.1:19504/nudgeon'};
  const apiTests=await run('pnpm',['--filter','@nudgeon/api','exec','vitest','run','src/ingestion/event-receipts.test.ts'],testEnv);
  await save('api-receipt-tests.log',apiTests);
  assert(apiTests.includes('7 passed')&&!apiTests.includes('skipped'),'actual API receipt suite must run without skips');
  result.steps.actualDBAPITests={pass:7,skipped:0};
  const goLog=await run('go',['test','-json','-race','-count=1','./apps/worker/internal/ingest'],testEnv);
  await save('go-receipt-tests.jsonl',goLog);
  const events=goLog.split('\n').filter(l=>l.startsWith('{')).map(JSON.parse);
  result.steps.actualDBGoTests={pass:events.filter(e=>e.Action==='pass'&&e.Test).length,skipped:events.filter(e=>e.Action==='skip'&&e.Test).map(e=>e.Test)};
  assert.equal(result.steps.actualDBGoTests.skipped.length,0);
  assert.equal((await sourceManifest()).sha256,source.sha256,'tested source changed');
  result.accountingPass=true;
  result.pass=load.outcome==='PASS'&&!loadError;
  if(!result.pass){result.error='Accounting passed; load capacity gate failed. See load summary; this is NOT a capacity PASS.';process.exitCode=1;}
}catch(error){result.error=error.message;process.exitCode=1;}
finally{
  cleaning=true;
  if(composeStarted)try{
    const state=JSON.parse(await run('docker',['inspect',`${project}-clickhouse-1`,'--format','{{json .State}}']));
    if(state.Paused)await dc('unpause','clickhouse');
    try{const last=await sample();await save('cleanup-api.prom',last.a);await save('cleanup-worker.prom',last.w);}catch{}
    await save('containers.log',await dc('logs','--no-color'));
    await dc('stop','-t','20');
    await save('shutdown-containers.log',await dc('logs','--no-color'));
    result.services=[];
    for(const service of ['api','ingest','scheduler','postgres','redis','clickhouse','gateway']){
      const s=JSON.parse(await run('docker',['inspect',`${project}-${service}-1`,'--format','{{json .State}}']));
      result.services.push({service,...s});
    }
    // Keep stopped containers, images, volumes and evidence, releasing only our
    // empty networks after disconnecting our own stopped containers.
    const nets=JSON.parse(await run('docker',['network','ls','--filter',`label=com.docker.compose.project=${project}`,'--format','json']).then(s=>'['+s.split('\n').join(',')+']'));
    for(const net of nets){
      const n=JSON.parse(await run('docker',['network','inspect',net.ID,'--format','{{json .}}']));
      for(const [id,c] of Object.entries(n.Containers??{})){assert(c.Name.startsWith(project+'-'));await run('docker',['network','disconnect',net.ID,id]);}
      await run('docker',['network','rm',net.ID]);
    }
    result.containersAfter=(await run('docker',['ps','--format','{{.Names}}'])).split('\n').sort();
    assert.deepEqual(result.containersAfter,result.containersBefore);
    assert(result.services.every(s=>s.Status==='exited'&&s.ExitCode===0&&!s.OOMKilled),'unclean shutdown; see saved service states and shutdown logs');
  }catch(error){result.cleanupError=error.message;result.pass=false;process.exitCode=1;}
  result.finishedAt=new Date().toISOString();
  await save('result.json',result);console.log(JSON.stringify({project,evidence,pass:result.pass,accountingPass:result.accountingPass,error:result.error?.slice(0,3000),cleanupError:result.cleanupError,steps:result.steps,sourceSHA256:result.sourceSHA256,images:Object.fromEntries(Object.entries(result.images).map(([k,v])=>[k,{Id:v.Id}]))},null,2));
}
