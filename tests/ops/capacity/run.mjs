import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const project=`nudgeon-ops-qa-${randomUUID().slice(0,8)}`;
const evidence=path.join(root,'.nudgeon',project);
const image=`${project}:local`;
const base='http://127.0.0.1:19494';
const result={project,image,evidence,startedAt:new Date().toISOString(),pass:false,steps:{}};
await fs.mkdir(evidence,{recursive:true,mode:0o700});
const children=new Set();
let interrupted=false,cleaning=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{interrupted=true;for(const c of children)c.kill('SIGTERM');});
async function run(command,args,extraEnv={},timeoutMs=120000){
  if(interrupted&&!cleaning)throw new Error('test interrupted');
  const child=spawn(command,args,{cwd:root,env:{...process.env,...extraEnv},stdio:['ignore','pipe','pipe']});
  children.add(child);
  const out=[],err=[];
  child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));
  const timer=setTimeout(()=>child.kill('SIGTERM'),timeoutMs);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  clearTimeout(timer);children.delete(child);
  const stdout=Buffer.concat(out).toString(),stderr=Buffer.concat(err).toString();
  if(code!==0)throw new Error(`${command} (${code}): ${stdout.slice(-2000)} ${stderr.slice(-2000)}`);
  return stdout.trim();
}
const dc=(...args)=>run('docker',['compose','-p',project,'-f','tests/ops/capacity/compose.yaml',...args],{OPS_QA_IMAGE:image});
const sql=text=>dc('exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','nudgeon','-d','nudgeon','-Atc',text);
const redis=(...args)=>dc('exec','-T','redis','redis-cli',...args);
const save=(name,value)=>fs.writeFile(path.join(evidence,name),typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const http=route=>fetch(base+route,{signal:AbortSignal.timeout(5000)});
async function get(route){const r=await http(route);assert(r.ok,`HTTP ${r.status} ${route}`);return r.json();}
async function until(check,label,timeoutMs=45000){
  const end=Date.now()+timeoutMs;let last;
  while(Date.now()<end){
    if(interrupted&&!cleaning)throw new Error('test interrupted');
    try{const value=await check();if(value)return value;}catch(e){last=e.message;}
    await sleep(500);
  }
  throw new Error(`timeout: ${label}${last?` (${last})`:''}`);
}
async function metrics(){const r=await http('/monitor/metrics');assert(r.ok);return r.text();}
function metric(text,name){const match=text.match(new RegExp(`^${name} ([^\\n]+)$`,'m'));return match?Number(match[1]):undefined;}
async function notified(name,status,after){
  const notifications=await get('/notifications');
  return notifications.find(n=>Date.parse(n.received_at)>=after&&n.body.alerts?.some(a=>a.labels.alertname===name&&a.status===status));
}
async function sourceManifest(){
  const files=(await run('rg',['--files','apps/worker','packages/libqueue-go'])).split('\n')
    .filter(f=>/\.(go|mod|sum)$/.test(f));
  for(const f of ['go.work','go.work.sum']){try{await fs.access(path.join(root,f));files.push(f);}catch{}}
  const entries=[];
  for(const f of [...new Set(files)].sort())entries.push({path:f,sha256:sha(await fs.readFile(path.join(root,f)))});
  return {sha256:sha(JSON.stringify(entries)),entries};
}
let composeStarted=false;
try{
  result.containersBefore=(await run('docker',['ps','--format','{{.Names}}'])).split('\n').sort();
  result.cachedImages={};
  for(const tag of ['nudgeon-worker:latest','nudgeon-api:latest','postgres:16','redis:7','prom/prometheus:v3.5.0','prom/alertmanager:v0.28.1']){
    result.cachedImages[tag]=JSON.parse(await run('docker',['image','inspect',tag,'--format','{{json .Id}}']));
  }
  const source=await sourceManifest();
  result.sourceSHA256=source.sha256;result.sourceFiles=source.entries.length;
  await save('source-manifest.json',source);
  result.revision=await run('git',['rev-parse','HEAD']);
  result.dirty=(await run('git',['status','--porcelain'])).length>0;
  result.goVersion=await run('go',['version']);
  const unitOutput=await run('go',['test','-json','-race','-p','1','-count=1',
    './apps/worker/internal/ops','./apps/worker/internal/metrics','./apps/worker/internal/channel',
    './apps/worker/internal/message','./apps/worker/cmd/worker'],{GOCACHE:'/tmp/nudgeon-go-build-cache'});
  await save('go-tests.jsonl',unitOutput);
  const unitEvents=unitOutput.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  result.steps.goTests={passed:unitEvents.filter(e=>e.Test&&e.Action==='pass').length,
    skipped:unitEvents.filter(e=>e.Test&&e.Action==='skip').map(e=>e.Test),
    packagesPassed:unitEvents.filter(e=>!e.Test&&e.Action==='pass').length};
  assert.equal(result.steps.goTests.packagesPassed,5);
  const context=path.join(evidence,'build-context');
  await fs.mkdir(path.join(context,'licenses'),{recursive:true});
  for(const f of ['LICENSE','NOTICE','TRADEMARKS.md','THIRD_PARTY_NOTICES.md'])await fs.copyFile(path.join(root,f),path.join(context,'licenses',f));
  await fs.copyFile(path.join(root,'docs-public/LICENSING.md'),path.join(context,'licenses/LICENSING.md'));
  await run('go',['build','-trimpath','-buildvcs=false','-ldflags',`-s -w -X main.buildRevision=${result.revision} -X main.buildSourceSHA256=${source.sha256} -X main.buildDirty=${result.dirty}`,
    '-o',path.join(context,'nudgeon-worker'),'./apps/worker/cmd/worker'],{GOCACHE:'/tmp/nudgeon-go-build-cache',CGO_ENABLED:'0',GOOS:'linux',GOARCH:'arm64'});
  assert.equal((await sourceManifest()).sha256,source.sha256,'source changed while compiling');
  result.binarySHA256=sha(await fs.readFile(path.join(context,'nudgeon-worker')));
  await run('docker',['build','--network=none','--pull=false','--platform=linux/arm64',
    '--build-arg',`BUILD_REVISION=${result.revision}`,'--build-arg',`BUILD_SOURCE_SHA256=${source.sha256}`,
    '-f','tests/ops/capacity/Dockerfile','-t',image,context]);
  result.imageID=JSON.parse(await run('docker',['image','inspect',image,'--format','{{json .Id}}']));
  result.imageLabels=JSON.parse(await run('docker',['image','inspect',image,'--format','{{json .Config.Labels}}']));
  assert.equal(result.imageLabels['io.nudgeon.worker.source-sha256'],source.sha256);
  console.log(`Built unique worker image ${image} ${result.imageID}`);
  composeStarted=true;
  await dc('up','-d','--pull','never','--wait','--wait-timeout','60','postgres','redis','prometheus','alertmanager','gateway');
  assert.equal(await sql('SELECT count(*) FROM send_dlq'),'0');
  const marker='dlq_pending|'+JSON.stringify({failure_id:randomUUID(),message_id:'synthetic-ops',class:'retryable',attempts:5,at:new Date(Date.now()-60000).toISOString()});
  for(const key of ['send:idem:ops:push','send:message:idem:ops:message'])assert.equal(await redis('SET',key,marker),'OK');
  const firstAt=Date.now();
  await dc('up','-d','--pull','never','monitor');
  await until(async()=>(await http('/monitor/readyz')).status===200,'observer readiness');
  const initial=await metrics();await save('initial.prom',initial);
  for(const [name,value]of Object.entries({postgres_projection_pending_count:2,postgres_matching_pending_count:3,postgres_outbox_pending_count:2,pending_push_pending_observed_count:1,pending_message_pending_observed_count:1,redis_noeviction:1,redis_aof_enabled:1,redis_aof_last_write_ok:1})){
    assert.equal(metric(initial,'nudgeon_ops_'+name),value,name);
  }
  assert(initial.includes(`source_sha256="${source.sha256}"`),'running source identity mismatch');
  const monitorID=await dc('ps','-q','monitor');
  assert.equal(await run('docker',['inspect',monitorID,'--format','{{.Image}}']),result.imageID);
  const first=await until(()=>notified('NudgeOnDLQPendingStorage','firing',firstAt),'Redis-only pending webhook');
  result.steps.pendingWithPGZeroWebhookMs=Date.parse(first.received_at)-firstAt;
  assert(result.steps.pendingWithPGZeroWebhookMs<=30000);
  result.steps.initialCounts={projection:2,matching:3,outbox:2,pushPending:1,messagePending:1,pgDLQ:0};
  result.steps.pgHealthyConnections=Number(await sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='nudgeon-ops-monitor'"));
  assert.equal(result.steps.pgHealthyConnections,1);
  const rawBefore=await redis('GET','send:idem:ops:push');
  await dc('restart','monitor');
  await until(async()=>metric(await metrics(),'nudgeon_ops_pending_push_pending_observed_count')===1,'restart discovers pre-existing marker');
  assert.equal(await redis('GET','send:idem:ops:push'),rawBefore);
  assert.equal(await redis('PTTL','send:idem:ops:push'),'-1');
  result.steps.restartAndReadOnlyMarker='pass';
  const writeDenied=await redis('--user','ops_observer','--pass','local-observer-only','SET','send:idem:ops:denied','bad');
  assert(writeDenied.includes('NOPERM'));
  const privileges=await sql("SELECT has_table_privilege('ops_observer','event_receipts','SELECT'),has_table_privilege('ops_observer','event_receipts','INSERT'),has_table_privilege('ops_observer','journey_outbox','UPDATE')");
  assert.equal(privileges,'t|f|f');result.steps.readOnlyCredentials='pass';
  const sourceCode=await fs.readFile(path.join(root,'apps/worker/internal/ops/postgres.go'),'utf8');
  const backlogSQL=sourceCode.match(/const BacklogSQL = `([\s\S]+?)`/)[1];
  await save('backlog-explain.txt',await sql('EXPLAIN (ANALYZE,BUFFERS) '+backlogSQL));
  const failureAt=Date.now();
  const locker=sql('BEGIN; LOCK TABLE event_receipts IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(25); ROLLBACK;');
  // Attach immediately so interruption/failure cannot create an unhandled rejection.
  const lockResult=locker.then(()=>({ok:true}),error=>({error}));
  await until(async()=>metric(await metrics(),'nudgeon_ops_postgres_collector_success')===0,'PG statement timeout');
  const failed=await metrics();await save('postgres-timeout.prom',failed);
  assert.equal(metric(failed,'nudgeon_ops_postgres_projection_pending_count'),2);
  assert.equal(metric(failed,'nudgeon_ops_pending_collector_success'),1,'PG failure hid Redis observer');
  assert.equal((await http('/monitor/readyz')).status,503);
  const elapsed=metric(failed,'nudgeon_ops_postgres_collector_duration_seconds');
  assert(elapsed>=1.8&&elapsed<3.5,`PG timeout ${elapsed}`);
  result.steps.pgQueryTimeoutSeconds=elapsed;
  const observerConnections=Number(await sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='nudgeon-ops-monitor'"));
  assert(observerConnections<=1);result.steps.pgConnections=observerConnections;
  await until(()=>notified('NudgeOnOpsCollectorFailure','firing',failureAt),'PG failure webhook');
  const lock=await lockResult;if(lock.error)throw lock.error;
  await until(async()=>(await http('/monitor/readyz')).status===200,'PG observer recovery');
  await until(()=>notified('NudgeOnOpsCollectorFailure','resolved',failureAt),'PG failure resolved webhook');
  result.steps.pgFailureRetainsDataAndRecovers='pass';
  console.log('PG timeout/read-only/restart checks passed; checking Redis failures and observer outage.');
  const redisFailureAt=Date.now();
  assert.equal(await redis('ACL','SETUSER','ops_observer','-getrange'),'OK');
  await until(async()=>metric(await metrics(),'nudgeon_ops_pending_collector_success')===0,'Redis permission error');
  const redisFailed=await metrics();await save('redis-failure.prom',redisFailed);
  assert.equal(metric(redisFailed,'nudgeon_ops_pending_push_pending_observed_count'),1);
  assert.equal(metric(redisFailed,'nudgeon_ops_redis_collector_success'),1);
  await until(()=>notified('NudgeOnOpsCollectorFailure','firing',redisFailureAt),'Redis read failure webhook');
  await redis('SET','send:idem:ops:push','dlq_pending|broken');
  await redis('ACL','SETUSER','ops_observer','+getrange');
  const previousErrors=metric(redisFailed,'nudgeon_ops_pending_collector_errors_total');
  await until(async()=>metric(await metrics(),'nudgeon_ops_pending_collector_errors_total')>previousErrors+1,'malformed marker rejected');
  assert.equal((await http('/monitor/readyz')).status,503);
  await redis('SET','send:idem:ops:push',marker);
  await until(async()=>(await http('/monitor/readyz')).status===200,'Redis observer recovery');
  result.steps.redisReadFailureAndMalformedMarker='pass';
  // Exercise the complete-pass call budget against a real larger keyspace.
  await redis('EVAL',"for i=1,80000 do redis.call('SET','ops-scan-fixture:'..i,'x') end return 80000",'0');
  await until(async()=>metric(await metrics(),'nudgeon_ops_pending_collector_success')===0,'real scan call budget');
  const overBudget=await metrics();await save('scan-budget.prom',overBudget);
  assert.equal(metric(overBudget,'nudgeon_ops_pending_push_pending_observed_count'),1);
  await redis('EVAL',"for i=1,80000 do redis.call('DEL','ops-scan-fixture:'..i) end return 80000",'0');
  await until(async()=>(await http('/monitor/readyz')).status===200,'scan budget recovery');
  result.steps.largeScanUnknownNotZero='pass';
  const stoppedAt=Date.now();
  await dc('stop','-t','10','monitor');
  await until(()=>notified('NudgeOnOpsMonitorDown','firing',stoppedAt),'observer outage webhook');
  const restartAt=Date.now();
  await dc('start','monitor');
  await until(async()=>(await http('/monitor/readyz')).status===200,'observer restarted');
  await until(async()=>{
    const expression=`nudgeon_ops_pending_collector_last_success_timestamp_seconds >= ${restartAt/1000}`;
    const q=await get(`/prometheus/api/v1/query?query=${encodeURIComponent(expression)}`);
    return q.status==='success'&&q.data.result.length===1;
  },'Prometheus consumed fresh post-restart data');
  assert(!(await notified('NudgeOnDLQPendingStorage','resolved',stoppedAt)),'brief observer outage incorrectly resolved pending');
  result.steps.monitorDownWebhook='pass';
  result.steps.pendingAlertSurvivesBriefOutage='pass';
  // Fixture-only terminal transitions, not a claim that real delivery recovered.
  const clearAt=Date.now();
  for(const key of ['send:idem:ops:push','send:message:idem:ops:message'])await redis('SET',key,'failed|retryable_exhausted','EX','604800');
  await sql("UPDATE event_receipts SET projected_at=now(),matched_at=now() WHERE tenant_id='00000000-0000-4000-8000-000000000001'; UPDATE journey_outbox SET published_at=now() WHERE tenant_id='00000000-0000-4000-8000-000000000001';");
  await until(async()=>{const m=await metrics();return metric(m,'nudgeon_ops_pending_push_pending_observed_count')===0&&metric(m,'nudgeon_ops_pending_message_pending_observed_count')===0&&metric(m,'nudgeon_ops_postgres_projection_pending_count')===0&&metric(m,'nudgeon_ops_postgres_matching_pending_count')===0&&metric(m,'nudgeon_ops_postgres_outbox_pending_count')===0;},'complete empty snapshots');
  await until(()=>notified('NudgeOnDLQPendingStorage','resolved',clearAt),'pending resolved webhook',90000);
  await save('final.prom',await metrics());await save('notifications.json',await get('/notifications'));
  result.steps.fixtureClearResolved='pass';
  result.pass=true;
}catch(error){result.error=error.message;process.exitCode=1;}
finally{
  cleaning=true;
  if(composeStarted){
    try{await save('notifications.json',await get('/notifications'));await save('last-observation.prom',await metrics());}catch{}
    try{await save('containers.log',await dc('logs','--no-color'));}catch{}
    try{
      await dc('stop','-t','10');
      const raw=await dc('ps','-a','--format','json');
      result.testContainers=JSON.parse(raw.startsWith('[')?raw:`[${raw.split('\n').filter(Boolean).join(',')}]`);
      if(result.pass)assert.equal(result.testContainers.length,6);
      assert(result.testContainers.every(c=>c.State==='exited'),'test container still running');
      if(result.pass)assert(result.testContainers.every(c=>c.ExitCode===0),'test container shutdown failed');
      const ids=result.testContainers.map(c=>c.ID);
      if(ids.length){
        const oom=await run('docker',['inspect',...ids,'--format','{{.State.OOMKilled}}']);
        assert(oom.split('\n').every(x=>x==='false'),'test OOM');
      }
      result.releasedNetworks=[];
      for(const name of [`${project}_default`,`${project}_host-access`]){
        const found=(await run('docker',['network','ls','--filter',`name=^${name}$`,'--format','{{.Name}}'])).split('\n');
        if(!found.includes(name))continue;
        const network=JSON.parse(await run('docker',['network','inspect',name] ))[0];
        assert.equal(network.Labels['com.docker.compose.project'],project);
        assert.equal(Object.keys(network.Containers??{}).length,0,'test network still has active endpoints');
        await run('docker',['network','rm',name]);result.releasedNetworks.push(name);
      }
    }catch(error){result.cleanupError=error.message;result.pass=false;process.exitCode=1;}
  }
  try{
    result.containersAfter=(await run('docker',['ps','--format','{{.Names}}'])).split('\n').sort();
    assert.deepEqual(result.containersAfter,result.containersBefore,'existing container set changed');
    for(const [tag,id]of Object.entries(result.cachedImages??{}))assert.equal(JSON.parse(await run('docker',['image','inspect',tag,'--format','{{json .Id}}'])),id,'existing image tag changed');
  }catch(error){result.preservationError=error.message;result.pass=false;process.exitCode=1;}
  result.finishedAt=new Date().toISOString();
  await save('result.json',result);
  console.log(JSON.stringify({...result,testContainers:result.testContainers?.map(c=>({name:c.Name,state:c.State,exitCode:c.ExitCode}))},null,2));
}
