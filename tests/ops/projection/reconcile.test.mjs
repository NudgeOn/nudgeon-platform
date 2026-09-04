import {test} from 'node:test';
import assert from 'node:assert/strict';
import {expectedIDs,acknowledgedIDs,reconcile} from './reconcile.mjs';

test('compares ID sets independently of database UUID ordering',()=>{
  const ids=expectedIDs('fixture',3);
  reconcile(ids,[ids[2],ids[0],ids[1]],ids.toReversed().map(id=>({id,n:'1'})));
});
test('rejects physical duplicates and wrong IDs even with the right total count',()=>{
  const ids=expectedIDs('fixture',3),rows=ids.map(id=>({id,n:'1'}));
  assert.throws(()=>reconcile(ids,ids,[{...rows[0],n:'2'},...rows.slice(1)]));
  assert.throws(()=>reconcile(ids,ids,[...rows.slice(1),{id:expectedIDs('other',1)[0],n:'1'}]));
  assert.throws(()=>reconcile(ids,[ids[0],ids[0],ids[2]],rows));
});
test('dropped arrivals do not become acknowledged IDs and corrupt journals fail',()=>{
  const journal=Buffer.alloc(34);
  journal[0]=2;journal.writeBigUInt64LE(0n,1);journal.writeBigUInt64LE(1n,9);
  journal[17]=3;journal.writeBigUInt64LE(1n,18);journal.writeBigUInt64LE(2n,26);
  assert.deepEqual(acknowledgedIDs('fixture',journal,3),expectedIDs('fixture',3).slice(0,1));
  assert.throws(()=>acknowledgedIDs('fixture',journal.subarray(1),3));
  assert.throws(()=>acknowledgedIDs('fixture',Buffer.concat([journal,journal]),3));
});
