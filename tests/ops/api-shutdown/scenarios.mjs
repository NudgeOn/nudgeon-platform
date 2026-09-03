import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';

export async function scenarios({root, project, run, dc, state, api, key, wait, result, saveLog}) {
  const {Pool} = createRequire(`${root}/apps/api/package.json`)('pg');
  const pg = new Pool({connectionString:'postgres://nudgeon:local-shutdown-only@127.0.0.1:19495/nudgeon',application_name:'shutdown-qa-controller',max:3,connectionTimeoutMillis:2000,query_timeout:3000});
  const tenant='11111111-1111-4111-8111-111111111111', appId='22222222-2222-4222-8222-222222222222';
  const accepted=[];
  result.cases=[];
  let lock, paused=false, offset=0;
  const body=id=>JSON.stringify({batch:[{insert_id:id,external_id:'shutdown-qa',event:'shutdown_test',client_ts:new Date().toISOString()}]});
  async function track(id=randomUUID()) {
    try {
      const res=await fetch(`${api}/v1/track`,{method:'POST',headers:{'content-type':'application/json','x-api-key':key},body:body(id),signal:AbortSignal.timeout(19000)});
      const payload=await res.json(); if(res.status===202) accepted.push(id);
      return {id,status:res.status,payload};
    } catch { return {id,status:0}; }
  }
  async function until(check,message,timeout=5000) {
    const end=Date.now()+timeout;
    while(Date.now()<end) {if(await check())return;await wait(25);}
    throw new Error(message);
  }
  async function ready() {
    await until(async()=>{try{return (await fetch(`${api}/readyz`,{signal:AbortSignal.timeout(3500)})).ok;}catch{return false;}},'restart not ready',15000);
  }
  async function beginLock(id) {
    lock=await pg.connect();
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))',[`event.receipt:${tenant}:${appId}:${id}`]);
  }
  async function releaseLock() {
    if(!lock)return;
    await lock.query('SELECT pg_advisory_unlock_all()');lock.release();lock=undefined;
  }
  async function blocked() {
    await until(async()=>Number((await pg.query("SELECT count(*) FROM pg_stat_activity WHERE application_name='shutdown-qa-api' AND wait_event='advisory'")).rows[0].count)>0,'actual request did not reach PG advisory lock');
  }
  async function rejectNew() {
    let readiness;
    await until(async()=>{try{readiness=await fetch(`${api}/readyz`,{signal:AbortSignal.timeout(1000)});return readiness.status===503;}catch{return false;}},'readiness did not become 503');
    assert.equal(readiness.headers.get('connection'),'close');
    assert.deepEqual(await readiness.json(),{ok:false,code:'shutting_down'});
    const rejected=await track(); assert.equal(rejected.status,503); assert.equal(rejected.payload.code,'shutting_down');
    assert.equal((await pg.query('SELECT 1 FROM event_receipts WHERE tenant_id=$1 AND insert_id=$2',[tenant,rejected.id])).rowCount,0);
    return {readyz:503,new_request:503,rejected_receipts:0};
  }
  async function signal(name='SIGTERM') {
    const start=Date.now();
    await run('docker',['kill',`--signal=${name}`,`${project}-api-1`]);
    return start;
  }
  async function stopped(name,start,exitCode) {
    result.expectedApiExitCode=exitCode;
    assert.equal(Number(await run('docker',['wait',`${project}-api-1`])),exitCode);
    const status=await state('api'), controlRoundtripMs=Date.now()-start;
    // Docker wait/inspect round-trip latency is NOT process shutdown time.
    // VM/host clock alignment is checked at startup; retain both measurements.
    const ms=Date.parse(status.FinishedAt)-start;
    assert.equal(status.OOMKilled,false); assert(ms>=0&&ms<15000,`${name} process exit exceeded 15s: ${ms}`);
    const all=await dc('logs','--no-color','api'), text=all.slice(offset);offset=all.length;
    await saveLog(`${name}.log`,text);
    const events=text.split('\n').flatMap(line=>{
      const start=line.indexOf('{"event":');if(start<0)return [];
      try{return [JSON.parse(line.slice(start).replace(/\u001b\[[0-9;]*m/g,''))];}catch{return [];}
    });
    const completion=events.find(e=>e.event==='shutdown_complete');
    assert(completion,`${name}: missing completion log`);
    assert.equal(completion.complete,exitCode===0);
    if(exitCode===0) {
      for(const client of ['postgres','redis','clickhouse'])assert(events.some(e=>e.event==='shutdown_client_closed'&&e.client===client&&e.complete));
      assert(!events.some(e=>e.event==='shutdown_deadline_exceeded'));
    }
    const remainingConnections=Number((await pg.query("SELECT count(*) FROM pg_stat_activity WHERE application_name='shutdown-qa-api'")).rows[0].count);
    if(exitCode===0)assert.equal(remainingConnections,0);
    const proof={name,pass:true,exit_code:exitCode,oom_killed:false,signal_dispatched_at:new Date(start).toISOString(),container_finished_at:status.FinishedAt,shutdown_ms:ms,control_roundtrip_ms:controlRoundtripMs,pg_sessions_at_process_exit:remainingConnections,events};
    result.cases.push(proof);console.log(JSON.stringify({case:name,exit_code:exitCode,shutdown_ms:ms}));
    return proof;
  }
  async function restart() {
    // Unpausing CH does not immediately refresh Docker's cached health status.
    // Wait for the dependency to recover before Compose applies depends_on.
    await until(async()=>(await state('clickhouse')).Health?.Status==='healthy','ClickHouse did not recover after fault',15000);
    await dc('start','api');result.expectedApiExitCode=0;await ready();
  }
  async function reconcile(ids) {
    const unique=[...new Set(ids)];
    const rows=await pg.query('SELECT insert_id,received_at::text,receipt_seq::text FROM event_receipts WHERE tenant_id=$1 AND app_id=$2 AND insert_id=ANY($3::uuid[]) ORDER BY insert_id',[tenant,appId,unique]);
    assert.equal(rows.rowCount,unique.length);
    const outbox=await pg.query('SELECT idempotency_key FROM journey_outbox WHERE tenant_id=$1 AND app_id=$2 AND idempotency_key=ANY($3::text[])',[tenant,appId,unique.map(id=>`event.ingest:${id}`)]);
    assert.equal(outbox.rowCount,unique.length);
    return rows.rows;
  }
  try {
    assert.equal((await pg.query('SELECT name FROM tenants WHERE id=$1',[tenant])).rows[0].name,'Dev Tenant');
    const clockBefore=Date.now();
    result.runtime=JSON.parse(await dc('exec','-T','api','node','-e',"console.log(JSON.stringify({node:process.version,now:Date.now(),nest:require('@nestjs/core/package.json').version,pg:require('pg/package.json').version,redis:require('ioredis/package.json').version,clickhouse:require('@clickhouse/client/package.json').version}))"));
    result.runtimeClockCheck={hostBefore:clockBefore,containerNow:result.runtime.now,hostAfter:Date.now()};
    assert(result.runtime.now>=clockBefore-100&&result.runtime.now<=result.runtimeClockCheck.hostAfter+100,'VM/host clocks not aligned for wall-clock shutdown measurement');
    // Controlled open-loop traffic; this is a shutdown regression, not capacity proof.
    const blockedId=randomUUID();await beginLock(blockedId);
    const held=track(blockedId);await blocked();
    const traffic=[];
    for(let i=0;i<40;i++){traffic.push(track());await wait(50);}
    const warm=await Promise.all(traffic);assert(warm.every(r=>r.status===202));
    const started=await signal();
    const rejected=await rejectNew();
    await wait(500);await releaseLock();
    assert.equal((await held).status,202);
    const loaded=await stopped('inflight_load',started,0);
    Object.assign(loaded,{warm_requests:40,offered_rps:20,load_duration_seconds:2,blocked_request_status:202,...rejected});
    const receiptBefore=await reconcile(accepted);

    await restart();
    for(const id of [...new Set(accepted)])assert.equal((await track(id)).status,202);
    assert.deepEqual(await reconcile(accepted),receiptBefore);
    result.same_id_retry_preserves_receipts=true;

    // Beyond the drain deadline: no 202 for the held transaction, nonzero exit.
    const timeoutId=randomUUID();await beginLock(timeoutId);
    const timedRequest=track(timeoutId);await blocked();
    const timeoutStart=await signal();await rejectNew();
    await run('docker',['kill','--signal=SIGINT',`${project}-api-1`]);
    await stopped('request_timeout',timeoutStart,1);
    assert.notEqual((await timedRequest).status,202);
    await releaseLock();
    await until(async()=>Number((await pg.query("SELECT count(*) FROM pg_stat_activity WHERE application_name='shutdown-qa-api'")).rows[0].count)===0,'PG did not reap disconnected transaction after releasing fixture lock');
    result.timed_out_pg_sessions_after_unlock=0;
    assert.equal((await pg.query('SELECT 1 FROM event_receipts WHERE tenant_id=$1 AND insert_id=$2',[tenant,timeoutId])).rowCount,0);
    await restart();assert.equal((await track(timeoutId)).status,202);
    await reconcile([timeoutId]);
    result.timed_out_request_retry_saved_once=true;

    // A paused local CH makes best-effort raw work remain pending after a 202.
    await dc('pause','clickhouse');paused=true;
    const rawId=randomUUID();assert.equal((await track(rawId)).status,202);
    const rawStart=await signal();
    const raw=await stopped('raw_timeout',rawStart,1);
    assert(raw.events.some(e=>e.event==='shutdown_background_drained'&&!e.complete&&e.background.raw_ingestions>0));
    await reconcile([rawId]);
    await dc('unpause','clickhouse');paused=false;
    await restart();

    // An unfinished header never enters middleware, but must not hold shutdown.
    const slowHeader=net.connect(19480,'127.0.0.1');slowHeader.on('error',()=>undefined);
    await new Promise(resolve=>slowHeader.once('connect',resolve));
    slowHeader.write('GET /readyz HTTP/1.1\r\nHost: localhost\r\n');
    const agent=new http.Agent({keepAlive:true});
    await new Promise((resolve,reject)=>http.get(`${api}/livez`,{agent},res=>{res.resume();res.on('end',resolve);}).on('error',reject));
    const idleStart=await signal('SIGINT');
    await stopped('idle_keepalive_partial_header',idleStart,0);
    slowHeader.destroy();agent.destroy();
    await reconcile(accepted);
    result.reconciliation={successful_responses:accepted.length,unique_accepted_events:new Set(accepted).size,receipt_and_outbox_match:true,scope:'PostgreSQL receipt/outbox only; no analytics or worker projection'};
  } finally {
    await releaseLock();
    if(paused)await dc('unpause','clickhouse');
    await pg.end();
  }
}
