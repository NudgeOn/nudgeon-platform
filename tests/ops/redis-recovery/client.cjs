const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const req = createRequire(path.join(root, 'apps/api/package.json'));
req('ts-node').register({transpileOnly:true, project:path.join(root,'apps/api/tsconfig.json')});
const {createRedisClient} = req(path.join(root,'apps/api/src/infra/redis.ts'));
const client = createRedisClient({redisUrl:process.env.REDIS_FIXTURE_URL});
let failureCode;
client.on('error',error=>{
 if(!failureCode) failureCode=error.code || (error.message?.startsWith('WRONGPASS') ? 'WRONGPASS' : undefined);
});
let killer;
const timer=setTimeout(()=>{client.disconnect();killer?.disconnect();process.exit(2);},15000);
(async()=>{
 try {
  if(process.env.NEGATIVE_CASE) {
   try {await client.ping();process.send({pass:false,event:'unexpected_connection'});}
   catch {
    const allowed={untrusted:['SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'],hostname:['ERR_TLS_CERT_ALTNAME_INVALID'],password:['WRONGPASS']};
    const pass=allowed[process.env.NEGATIVE_CASE]?.includes(failureCode)===true;
    process.send({pass,event:'connection_rejected',failureCode:pass?failureCode:'unexpected_failure_class'});
   }
  } else {
   if(await client.ping()!=='PONG' || (!client.connector.stream.encrypted || !client.connector.stream.authorized)) throw new Error();
   const before=await client.call('CLIENT','ID');
   killer=createRedisClient({redisUrl:process.env.REDIS_FIXTURE_URL});killer.on('error',()=>{});
   await killer.ping();
   const closed=new Promise(resolve=>client.once('close',resolve));
   await killer.call('CLIENT','KILL','ID',String(before));
   await closed;
   if(await client.ping()!=='PONG' || (!client.connector.stream.encrypted || !client.connector.stream.authorized)) throw new Error();
   const after=await client.call('CLIENT','ID');
   if(String(before)===String(after))throw new Error();
   process.send({pass:true,event:'tls_reconnected',clientIdChanged:true});
  }
 } catch {process.send({pass:false,event:'probe_failed'});}
 finally {clearTimeout(timer);client.disconnect();killer?.disconnect();process.disconnect();}
})();
