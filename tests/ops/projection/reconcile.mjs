import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

function uuid5(namespace, name) {
  const hash=createHash('sha1').update(Buffer.from(namespace.replaceAll('-',''),'hex')).update(name).digest().subarray(0,16);
  hash[6]=(hash[6]&15)|80;hash[8]=(hash[8]&63)|128;
  const s=hash.toString('hex');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
export function expectedIDs(runId,count){
  const namespace=uuid5('6ba7b811-9dad-11d1-80b4-00c04fd430c8',`nudgeon-loadgen:v1:${runId}`);
  return Array.from({length:count},(_,i)=>uuid5(namespace,`event:${i}`));
}
export function acknowledgedIDs(runId,journal,expected){
  assert.equal(journal.length%17,0,'truncated generator journal');
  const sequences=new Set();
  for(let offset=0;offset<journal.length;offset+=17){
    const kind=journal[offset],seq=Number(journal.readBigUInt64LE(offset+1)),count=Number(journal.readBigUInt64LE(offset+9));
    assert(kind>=1&&kind<=6&&Number.isSafeInteger(seq)&&Number.isSafeInteger(count)&&count>0&&seq>=0&&seq+count<=expected,'invalid journal record');
    if(kind!==2)continue;
    for(let i=seq;i<seq+count;i++){assert(!sequences.has(i),'duplicate acknowledgement record');sequences.add(i);}
  }
  const all=expectedIDs(runId,expected);
  return [...sequences].map(i=>all[i]);
}
export function reconcile(expected,pgIDs,chRows){
  assert(chRows.every(r=>Number(r.n)===1),'physical duplicate rows observed; do not hide using FINAL or uniq');
  const canonical=ids=>ids.map(id=>id.toLowerCase()).sort();
  for(const [kind,ids] of [['expected',expected],['postgres',pgIDs],['clickhouse',chRows.map(r=>r.id)]]){
    assert.equal(new Set(ids).size,expected.length,`${kind} unique count`);
    assert.equal(ids.length,expected.length,`${kind} total count`);
    assert.deepEqual(canonical(ids),canonical(expected),`${kind} event ID set mismatch`);
  }
}
