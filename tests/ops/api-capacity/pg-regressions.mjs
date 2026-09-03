import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Test-only rerun: no API/worker and no repeated performance selection.
// The pinned API image supplies Node for the fixed gateway, not application code.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const project=`nudgeon-api-key-pg-${randomUUID().slice(0,8)}`, evidence=path.join(root,'.nudgeon',project);
const env={...process.env,PROJECTION_API_IMAGE:'nudgeon-api-capacity-9f3c557a-api:local',PROJECTION_WORKER_IMAGE:'sha256:d647831a9823235a5ab12088443c66c685b980184febedb4a100b431fe7e21fc'};
const result={project,evidence,startedAt:new Date().toISOString(),pass:false};let started=false;
await fs.mkdir(evidence,{recursive:true,mode:0o700});
async function run(cmd,args,extra={}){
  const c=spawn(cmd,args,{cwd:root,env:{...env,...extra},stdio:['ignore','pipe','pipe']}),out=[],err=[];
  c.stdout.on('data',b=>out.push(b));c.stderr.on('data',b=>err.push(b));
  const timer=setTimeout(()=>c.kill('SIGTERM'),120000);
  const code=await new Promise((resolve,reject)=>{c.once('error',reject);c.once('close',resolve);});clearTimeout(timer);
  const log=Buffer.concat(out).toString()+'\n'+Buffer.concat(err).toString();
  if(code!==0)throw Object.assign(new Error(`${cmd} exit ${code}`),{log});return log.trim();
}
const dc=(...args)=>run('docker',['compose','-p',project,'-f','tests/ops/projection/compose.yaml',...args]);
const save=(name,v)=>fs.writeFile(path.join(evidence,name),typeof v==='string'?v:JSON.stringify(v,null,2),{mode:0o600});
try{
  result.before=(await run('docker',['ps','--format','{{.Names}}'])).split('\n').sort();
  const files=['apps/api/src/auth/api-key-usage.ts','apps/api/src/auth/api-key.service.ts','apps/api/src/auth/api-key-usage.integration.test.ts','apps/api/src/ingestion/event-receipts.ts','apps/api/src/ingestion/event-receipts.test.ts','db/postgres/schema.sql'];
  result.inputs=[];for(const f of files)result.inputs.push({path:f,sha256:createHash('sha256').update(await fs.readFile(path.join(root,f))).digest('hex')});
  started=true;await dc('up','-d','--no-deps','--pull','never','--wait','--wait-timeout','60','postgres','gateway');
  let log;
  try{log=await run('pnpm',['--filter','@nudgeon/api','exec','vitest','run','src/auth/api-key-usage.integration.test.ts','src/ingestion/event-receipts.test.ts'],{NUDGEON_RECEIPT_TEST_DATABASE_URL:'postgres://nudgeon:local-projection-only@127.0.0.1:19503/nudgeon'});}
  catch(e){await save('tests.log',e.log??e.message);throw e;}
  await save('tests.log',log);assert(log.includes('11 passed')&&!log.includes('skipped'),'all 11 actual PG tests must pass without skips');
  result.tests={passed:11,skipped:0};result.pass=true;
}catch(e){result.error=e.message;process.exitCode=1;}
finally{
  if(started)try{
    await dc('stop','-t','20','gateway','postgres');await save('containers.log',await dc('logs','--no-color'));result.services=[];
    for(const service of ['gateway','postgres'])result.services.push({service,...JSON.parse(await run('docker',['inspect',`${project}-${service}-1`,'--format','{{json .State}}']))});
    const nets=(await run('docker',['network','ls','--filter',`label=com.docker.compose.project=${project}`,'--format','{{.ID}}'])).split('\n').filter(Boolean);
    for(const id of nets){
      const n=JSON.parse(await run('docker',['network','inspect',id,'--format','{{json .}}']));
      for(const [cid,c]of Object.entries(n.Containers??{})){assert(c.Name.startsWith(project+'-'));await run('docker',['network','disconnect',id,cid]);}
      await run('docker',['network','rm',id]);
    }
    result.after=(await run('docker',['ps','--format','{{.Names}}'])).split('\n').sort();assert.deepEqual(result.after,result.before);
    assert(result.services.every(s=>s.Status==='exited'&&s.ExitCode===0&&!s.OOMKilled),'unclean shutdown');
  }catch(e){result.cleanupError=e.message;result.pass=false;process.exitCode=1;}
  result.finishedAt=new Date().toISOString();await save('result.json',result);console.log(JSON.stringify(result,null,2));
}
