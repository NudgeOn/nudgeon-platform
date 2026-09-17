import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { randomUUID,createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const name=`nudgeon-redis-recovery-${randomUUID().slice(0,8)}`;
const evidence=path.join(root,'.nudgeon',name);
await fs.mkdir(evidence,{recursive:true,mode:0o700});
const result={scope:'isolated local Redis 7 TLS/auth/reconnect; not managed service certification',name,startedAt:new Date().toISOString(),pass:false,checks:{}};
const children=new Set();let created=false,interrupted=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{interrupted=true;for(const child of children)child.kill('SIGTERM');});
async function command(bin,args,timeout=30000){
 const child=spawn(bin,args,{cwd:root,stdio:['ignore','pipe','pipe']});children.add(child);
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();
 const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
 try{const code=await new Promise((done,reject)=>{child.once('close',done);child.once('error',reject);});if(code!==0)throw new Error(`${bin} command failed`);return output.trim();}
 finally{clearTimeout(timer);children.delete(child);}
}
async function probe(url,trust,negative){
 const env={...process.env,REDIS_FIXTURE_URL:url,NEGATIVE_CASE:negative || '',NODE_TLS_REJECT_UNAUTHORIZED:'1'};
 delete env.NODE_EXTRA_CA_CERTS;
 if(trust)env.NODE_EXTRA_CA_CERTS=path.join(evidence,'ca.crt');
 const child=fork(path.join(root,'tests/ops/redis-recovery/client.cjs'),[],{env,silent:true});children.add(child);
 child.stdout.resume();child.stderr.resume();let message;
 child.on('message',m=>message=m);
 const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
 try{
  const code=await new Promise((done,reject)=>{child.once('exit',done);child.once('error',reject);});
  assert.equal(code,0,'probe process must close cleanly');assert.equal(message?.pass,true,'connection assertion');
  assert.equal(message.event,negative?'connection_rejected':'tls_reconnected');
 }finally{clearTimeout(timer);children.delete(child);}
}
try{
 result.containersBefore=(await command('docker',['ps','--format','{{.Names}}'])).split('\n').filter(Boolean).sort();
 result.revision=await command('git',['rev-parse','HEAD']);
 result.sourceSHA256=createHash('sha256').update(await fs.readFile(path.join(root,'apps/api/src/infra/redis.ts'))).digest('hex');
 await command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=NudgeOn Redis fixture CA','-keyout',path.join(evidence,'ca.key'),'-out',path.join(evidence,'ca.crt')]);
 await command('openssl',['req','-newkey','rsa:2048','-nodes','-subj','/CN=127.0.0.1','-keyout',path.join(evidence,'server.key'),'-out',path.join(evidence,'server.csr')]);
 await fs.writeFile(path.join(evidence,'server.ext'),'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
 await command('openssl',['x509','-req','-in',path.join(evidence,'server.csr'),'-CA',path.join(evidence,'ca.crt'),'-CAkey',path.join(evidence,'ca.key'),'-CAcreateserial','-days','1','-extfile',path.join(evidence,'server.ext'),'-out',path.join(evidence,'server.crt')]);
 await fs.writeFile(path.join(evidence,'redis.conf'),'port 0\ntls-port 6379\ntls-cert-file /fixture/server.crt\ntls-key-file /fixture/server.key\ntls-ca-cert-file /fixture/ca.crt\ntls-auth-clients no\nrequirepass synthetic-redis-fixture\nsave ""\nappendonly no\n',{mode:0o600});
 created=true;
 await command('docker',['run','-d','--name',name,'--memory','64m','--cpus','0.5','--publish','127.0.0.1::6379','--mount',`type=bind,source=${evidence},target=/fixture,readonly`,'--entrypoint','sh','redis:7','-c','mkdir /tmp/redis-fixture && cp /fixture/server.key /fixture/server.crt /fixture/ca.crt /tmp/redis-fixture/ && sed \'s#/fixture/#/tmp/redis-fixture/#g\' /fixture/redis.conf > /tmp/redis-fixture/redis.conf && chmod 700 /tmp/redis-fixture && chmod 600 /tmp/redis-fixture/server.key /tmp/redis-fixture/redis.conf && chown -R redis:redis /tmp/redis-fixture && exec docker-entrypoint.sh redis-server /tmp/redis-fixture/redis.conf']);
 const mapping=await command('docker',['port',name,'6379/tcp']);assert.match(mapping,/^127\.0\.0\.1:\d+$/);
 const port=mapping.split(':')[1];
 const deadline=Date.now()+15000;
 while(true){
  if(interrupted)throw new Error('interrupted');
  try{assert.equal(await command('docker',['exec',name,'redis-cli','--tls','--cacert','/fixture/ca.crt','-h','127.0.0.1','-a','synthetic-redis-fixture','PING'],2000),'PONG');break;}
  catch{if(Date.now()>deadline)throw new Error('Redis startup timeout');await new Promise(done=>setTimeout(done,100));}
 }
 const url=`rediss://:synthetic-redis-fixture@127.0.0.1:${port}`;
 await probe(url,true,'');result.checks.sameClientReconnectsWithTLS=true;
 await probe(url,false,'untrusted');result.checks.untrustedCARejected=true;
 await probe(url.replace('@127.0.0.1:','@localhost:'),true,'hostname');result.checks.wrongHostnameRejected=true;
 await probe(url.replace('synthetic-redis-fixture','wrong-password'),true,'password');result.checks.wrongPasswordRejected=true;
 result.imageId=await command('docker',['image','inspect','redis:7','--format','{{.Id}}']);
 result.pass=true;
}catch(error){result.error=error.message;}
finally{
 for(const child of children)child.kill('SIGKILL');
 if(created){try{const state=JSON.parse(await command('docker',['inspect',name,'--format','{{json .State}}']));result.oomKilled=state.OOMKilled;if(state.OOMKilled)result.pass=false;await command('docker',['rm','-f','-v',name]);}catch{result.pass=false;result.cleanupFailed=true;}}
 try{result.containersAfter=(await command('docker',['ps','--format','{{.Names}}'])).split('\n').filter(Boolean).sort();result.unrelatedContainersUnchanged=JSON.stringify(result.containersBefore)===JSON.stringify(result.containersAfter);if(!result.unrelatedContainersUnchanged)result.pass=false;}
 catch{result.pass=false;result.inventoryFailed=true;}
 if(interrupted)result.pass=false;
 for(const f of ['ca.key','server.key','redis.conf'])await fs.rm(path.join(evidence,f),{force:true});
 result.finishedAt=new Date().toISOString();
 await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2),{mode:0o600});
 console.log(JSON.stringify({pass:result.pass,checks:result.checks,error:result.error,evidence}));process.exitCode=result.pass?0:1;
}
