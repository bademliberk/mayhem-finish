import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Collector, nowSeconds } from '../src/collector.js';
import { decodeCurve } from '../src/chain.js';
import { PUMP, MAYHEM } from '../src/config.js';
import { report } from '../src/report.js';

const mint='9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cfg={firstCheck:600,recheck:600,horizon:86400,activeAge:20,staleAge:1200,minCap:0.04,maxCap:0.5,minLiquidity:0.005,historyPages:1};
function curve(complete) {
  const b=Buffer.alloc(166);Buffer.from([23,183,248,55,96,216,172,96]).copy(b);
  b[48]=Number(complete);b[81]=1;
  return {owner:PUMP,data:[b.toString('base64'),'base64']};
}
const truncated=()=>({slot:1,blockTime:nowSeconds(),meta:{err:null,logMessages:['Log truncated']}});

test('completed zero-reserve curve has undefined price; incomplete zero reserves still fail',()=>{
  assert.equal(decodeCurve(curve(true)).complete,true);
  assert.equal(decodeCurve(curve(true)).marketCap,null);
  assert.throws(()=>decodeCurve(curve(false)),/Zero virtual/);
});
test('graduation bypasses quarantined trade decoding and stops scheduled RPC',async()=>{
  const s=new Store(':memory:',cfg);s.addMint({mint,timestamp:nowSeconds()-700});
  s.quarantine('bad',1,nowSeconds(),'truncated');
  let listings=0;
  const rpc={signatures:async()=>{listings++;return[{signature:'bad',slot:1,err:null}];},
    accounts:async()=>({context:{slot:2},value:[{owner:MAYHEM,data:['AA==','base64']},curve(true)]}),
    transaction:async()=>assert.fail('Do not decode graduated history')};
  const c=new Collector(s,rpc,cfg);await c.evaluate(s.get('SELECT * FROM mints'));
  assert.equal(listings,0);assert.equal(s.get('SELECT status FROM mints').status,'graduated');
  assert.equal(s.get('SELECT COUNT(*) n FROM graduations').n,1);
  assert.equal(s.get('SELECT COUNT(*) n FROM evaluations').n,0);
  assert.equal(s.get('SELECT slot FROM graduations').slot,2);
  s.run('UPDATE mints SET last_check_at=0,next_check=0');
  rpc.signatures=rpc.accounts=async()=>assert.fail('Graduation is terminal');
  await c.checkDue();s.close();
});
test('deadline terminates even when history is unavailable',async()=>{
  const s=new Store(':memory:',cfg);s.addMint({mint,timestamp:nowSeconds()-90000});
  const c=new Collector(s,{signatures:async()=>assert.fail('No RPC past deadline')},cfg);
  await c.evaluate(s.get('SELECT * FROM mints'));
  assert.equal(s.get('SELECT status FROM mints').status,'deadline');s.close();
});
test('truncation quarantines once, never requeues, and valid complete replay resolves it',async()=>{
  const s=new Store(':memory:',cfg);let calls=0;
  const c=new Collector(s,{transaction:async()=>{calls++;return truncated();}},cfg);
  s.enqueue('bad',1,100);await c.drain();
  assert.equal(s.get('SELECT COUNT(*) n FROM queue').n,0);
  assert.equal(s.get('SELECT attempts FROM quarantined_transactions').attempts,1);
  s.enqueue('bad',1,200);await c.drain();
  await assert.rejects(c.ingest('bad'),/Quarantined/);assert.equal(calls,1);
  s.apply('bad',1,[]);
  assert.equal(s.get('SELECT COUNT(*) n FROM quarantined_transactions').n,0);
  await c.ingest('bad');assert.equal(calls,1);s.close();
});
test('complete live replay winning an in-flight RPC race is not quarantined',async()=>{
  const s=new Store(':memory:',cfg);s.enqueue('race',1,100);
  const c=new Collector(s,{transaction:async()=>{s.apply('race',1,[]);return truncated();}},cfg);
  await c.drain();
  assert.equal(s.get('SELECT COUNT(*) n FROM processed').n,1);
  assert.equal(s.get('SELECT COUNT(*) n FROM quarantined_transactions').n,0);s.close();
});
test('missing transactions continue retrying without quarantine',async()=>{
  const s=new Store(':memory:',cfg);s.enqueue('missing',1,100);
  await new Collector(s,{transaction:async()=>null},cfg).drain();
  assert.equal(s.get('SELECT attempts FROM queue').attempts,1);
  assert.equal(s.get('SELECT COUNT(*) n FROM quarantined_transactions').n,0);s.close();
});
test('existing truncated retries migrate without losing unrelated queue or candidate rows',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mayhem-quarantine-')),path=join(dir,'test.sqlite');let s;
  try {
    s=new Store(path,cfg);s.addMint({mint,timestamp:100});
    s.evaluate(mint,700,1,'AA==',{marketCap:0.1,liquidity:0.01},{category:'candidate',age:100,passes:true},600);
    s.enqueue('bad',1,100);s.enqueue('pending',2,200);
    s.run("UPDATE queue SET attempts=119,last_error='Transaction logs truncated; history remains incomplete' WHERE signature='bad'");
    s.close();s=new Store(path,cfg);
    assert.equal(s.get('SELECT attempts FROM quarantined_transactions').attempts,119);
    assert.equal(s.get('SELECT signature FROM queue').signature,'pending');
    assert.equal(s.get('SELECT COUNT(*) n FROM candidates').n,1);
    s.close();s=new Store(path,cfg);
    assert.equal(s.get('SELECT COUNT(*) n FROM quarantined_transactions').n,1);
  } finally {s?.close();rmSync(dir,{recursive:true,force:true});}
});
test('quarantined history prevents clean-day averages and cannot become no_trades',async()=>{
  const s=new Store(':memory:',cfg);s.run("INSERT INTO metadata VALUES('monitoring_started_at','86400')");
  const id=s.coverage('session',86400,'test');s.run('UPDATE coverage SET ended_at=172800 WHERE id=?',id);
  s.quarantine('bad',1,100000,'truncated');
  assert.equal(report(s,172801).average,null);assert.equal(report(s,172801).quarantine.count,1);
  s.addMint({mint,timestamp:nowSeconds()-700});
  const b=curve(false);const bytes=Buffer.from(b.data[0],'base64');bytes.writeBigUInt64LE(1000n,8);b.data[0]=bytes.toString('base64');
  const c=new Collector(s,{signatures:async()=>[{signature:'bad',slot:1,err:null}],
    accounts:async()=>({context:{slot:2},value:[{owner:MAYHEM,data:['AA==','base64']},b]}),
    transaction:async()=>assert.fail('Must not refetch quarantine')},cfg);
  assert.equal((await c.evaluate(s.get('SELECT * FROM mints'))).category,'unqualified');
  assert.equal(s.get('SELECT COUNT(*) n FROM no_trades').n,0);s.close();
});
