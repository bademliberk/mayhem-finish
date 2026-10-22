import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Collector, nowSeconds } from '../src/collector.js';
import { MAYHEM, PUMP } from '../src/config.js';
import { report } from '../src/report.js';
import { PublicKey } from '@solana/web3.js';
import { checkLoop } from '../src/worker.js';

const mint='9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cfg={firstCheck:600,recheck:600,horizon:86400,activeAge:20,staleAge:1200,minCap:0.04,maxCap:0.5,minLiquidity:0.005,historyPages:1};
function setup({complete=false}={}) {
  const s=new Store(':memory:',cfg), now=nowSeconds();
  s.addMint({mint,timestamp:now-700});
  s.apply('last',1,[{type:'trade',index:1,mint,timestamp:now-100,slot:1,buy:true,solAmount:'1',tokenAmount:'1'}]);
  const b=Buffer.alloc(166);Buffer.from([23,183,248,55,96,216,172,96]).copy(b);
  b.writeBigUInt64LE(1000n,8);b.writeBigUInt64LE(10000000n,16);b.writeBigUInt64LE(6000000n,32);b.writeBigUInt64LE(5000n,40);b[81]=1;b[48]=Number(complete);
  const rpc={signatures:async()=>[{signature:'last',slot:1,blockTime:now-100,err:null}],accounts:async()=>({context:{slot:2},value:[{owner:MAYHEM,data:['AA==','base64']},{owner:PUMP,data:[b.toString('base64'),'base64']}]})};
  return{s,rpc,c:new Collector(s,rpc,cfg)};
}
test('qualification stops RPC and closes activity observation at final check',async()=>{
  const{s,c,rpc}=setup();const result=await c.evaluate(s.get('SELECT * FROM mints'));
  assert.equal(result.category,'candidate');assert.equal(s.get('SELECT COUNT(*) n FROM candidates').n,1);
  assert.equal(s.get('SELECT status FROM mints').status,'qualified');
  assert.equal(s.get('SELECT history_complete FROM mayhem_activity').history_complete,0);
  assert.equal(s.get('SELECT history_scope FROM evaluations').history_scope,'latest_20_transactions');
  assert.equal(s.get('SELECT initial_state_base64 FROM mints').initial_state_base64,'AA==');
  const ended=s.get('SELECT observation_ended_at FROM mayhem_activity').observation_ended_at;
  s.apply('resume',3,[{type:'trade',index:1,mint,timestamp:ended+1,slot:3,buy:false,solAmount:'1',tokenAmount:'1'}]);
  assert.equal(s.get('SELECT trade_count FROM mayhem_activity').trade_count,1);
  assert.equal(s.get('SELECT status FROM mints').status,'qualified');
  s.run('UPDATE mints SET next_check=0');
  rpc.signatures=rpc.accounts=async()=>assert.fail('Qualified mint must not make scheduled RPC');
  await c.checkDue();
  assert.equal(s.get('SELECT COUNT(*) n FROM evaluations').n,1);
  assert.equal(s.get('SELECT end_reason FROM mayhem_activity').end_reason,'candidate');
  s.close();
});
test('only active mint schedules next check 600 seconds after evaluation',async()=>{
  const{s,c}=setup();s.run('UPDATE mayhem_trades SET traded_at=?',nowSeconds()-5);s.refreshActivity(mint);
  const before=nowSeconds();const result=await c.evaluate(s.get('SELECT * FROM mints'));
  assert.equal(result.category,'active');
  const row=s.get('SELECT * FROM mints');assert.equal(row.status,'monitoring');
  assert.ok(row.next_check>=before+600 && row.next_check<=nowSeconds()+600);
  assert.equal(row.next_check,row.last_check_at+600);
  assert.ok(row.last_check_at>=before);
  assert.equal(row.created_at,s.get('SELECT created_at FROM mayhem_activity').created_at);
  assert.equal(s.get('SELECT COUNT(*) n FROM candidates').n,0);s.close();
});
test('no trades is stored in its own table and never rechecked after a later trade',async()=>{
  const{s,c,rpc}=setup();s.run('DELETE FROM mayhem_trades');s.refreshActivity(mint);
  await c.evaluate(s.get('SELECT * FROM mints'));
  assert.equal(s.get('SELECT status FROM mints').status,'no_trades');
  assert.equal(s.get('SELECT COUNT(*) n FROM no_trades').n,1);
  s.apply('later',3,[{type:'trade',index:1,mint,timestamp:nowSeconds(),slot:3,buy:true,solAmount:'1',tokenAmount:'1'}]);
  s.run('UPDATE mints SET last_check_at=0,next_check=0');
  rpc.signatures=rpc.accounts=async()=>assert.fail('No-trades result is terminal');
  await c.checkDue();assert.equal(report(s).noTrades.length,1);s.close();
});
test('latest twenty excludes older cached trades and never fetches a twenty-first transaction',async()=>{
  const{s,c,rpc}=setup();const requests=[],fetched=[];
  const entries=Array.from({length:20},(_,i)=>({signature:`touch-${i}`,slot:30-i,err:null}));
  rpc.signatures=async(address,options)=>{
    requests.push(options);
    // Even an oversized provider result must not expand the search window.
    return options.limit===1 ? entries.slice(0,1) : [...entries,{signature:'last',slot:1,err:null}];
  };
  rpc.transaction=async signature=>{fetched.push(signature);return{slot:30,blockTime:nowSeconds(),meta:{err:null,logMessages:[]}};};
  await c.evaluate(s.get('SELECT * FROM mints'));
  assert.deepEqual(requests,[{limit:20},{limit:1}]);
  assert.deepEqual(fetched,entries.map(entry=>entry.signature));
  assert.equal(s.get('SELECT status FROM mints').status,'no_trades');
  assert.equal(s.get('SELECT last_trade_at FROM evaluations').last_trade_at,null);
  assert.notEqual(s.get('SELECT last_trade_at FROM mayhem_activity').last_trade_at,null);
  assert.equal(report(s).noTrades[0].reason,'no_mayhem_trade_in_last_20_transactions');
  assert.equal(report(s).evaluationHistoryScopes[0].history_scope,'latest_20_transactions');
  s.close();
});
test('recent search skips failed entries and stops at first verified cached trade',async()=>{
  const{s,c,rpc}=setup();const fetched=[];
  rpc.signatures=async()=>[
    {signature:'failed',slot:4,err:{InstructionError:[0,'error']}},
    {signature:'touch',slot:3,err:null},
    {signature:'last',slot:1,err:null},
    {signature:'older',slot:0,err:null},
  ];
  rpc.transaction=async signature=>{fetched.push(signature);return{slot:3,blockTime:nowSeconds(),meta:{err:null,logMessages:[]}};};
  const result=await c.recentTrade(s.get('SELECT * FROM mints'));
  assert.deepEqual(fetched,['touch']);
  assert.equal(result.lastTrade,s.get('SELECT traded_at FROM mayhem_trades').traded_at);
  assert.equal(result.head,'failed');s.close();
});
test('newest uncached bot trade is decoded and stops older transaction fetching',async()=>{
  const{s,c,rpc}=setup();const fetched=[];
  const timestamp=nowSeconds()-60,b=Buffer.alloc(97);
  Buffer.from([189,219,127,211,78,230,97,238]).copy(b);
  new PublicKey(mint).toBuffer().copy(b,8);
  b.writeBigUInt64LE(10n,40);b.writeBigUInt64LE(20n,48);b[56]=1;
  new PublicKey(mint).toBuffer().copy(b,57);b.writeBigInt64LE(BigInt(timestamp),89);
  const entries=[{signature:'fresh',slot:4,err:null},{signature:'older',slot:3,err:null}];
  rpc.signatures=async(address,{limit})=>entries.slice(0,limit);
  rpc.transaction=async signature=>{fetched.push(signature);return{slot:4,blockTime:timestamp,meta:{err:null,logMessages:[
    `Program ${MAYHEM} invoke [1]`,`Program ${PUMP} invoke [2]`,
    `Program data: ${b.toString('base64')}`,`Program ${PUMP} success`,`Program ${MAYHEM} success`,
  ]}};};
  const result=await c.evaluate(s.get('SELECT * FROM mints'));
  assert.equal(result.category,'candidate');assert.deepEqual(fetched,['fresh']);
  assert.equal(s.get('SELECT last_trade_at FROM evaluations').last_trade_at,timestamp);s.close();
});
test('empty or shorter successful history can produce no_trades without pagination',async()=>{
  for(const count of [0,3]) {
    const{s,c,rpc}=setup();const limits=[];
    const entries=Array.from({length:count},(_,i)=>({signature:`short-${i}`,slot:3-i,err:null}));
    rpc.signatures=async(address,{limit})=>{limits.push(limit);return entries.slice(0,limit);};
    rpc.transaction=async()=>({slot:3,blockTime:nowSeconds(),meta:{err:null,logMessages:[]}});
    await c.evaluate(s.get('SELECT * FROM mints'));
    assert.equal(s.get('SELECT status FROM mints').status,'no_trades');
    assert.deepEqual(limits,[20,1]);s.close();
  }
});
test('unavailable, malformed and truncated transactions defer rather than write no_trades',async()=>{
  for(const tx of [null,{slot:2},{slot:2,meta:{}},
    {slot:2,blockTime:nowSeconds(),meta:{err:null}},
    {slot:2,blockTime:nowSeconds(),meta:{err:null,logMessages:['Log truncated']}}]) {
    const{s,c,rpc}=setup();const previous=s.get('SELECT last_check_at FROM mints').last_check_at;
    rpc.signatures=async()=>[{signature:'unknown',slot:2,err:null}];
    rpc.transaction=async()=>tx;
    await c.checkDue();
    assert.equal(s.get('SELECT COUNT(*) n FROM no_trades').n,0);
    assert.equal(s.get('SELECT COUNT(*) n FROM evaluations').n,0);
    assert.equal(s.get('SELECT status FROM mints').status,'monitoring');
    assert.equal(s.get('SELECT last_check_at FROM mints').last_check_at,previous);
    assert.equal(s.get("SELECT COUNT(*) n FROM processed WHERE signature='unknown'").n,0);
    s.close();
  }
});
test('malformed signature history and RPC errors never become no_trades',async()=>{
  for(const entries of [null,{},[{}],[{signature:'unknown',slot:2}],
    [{signature:'a',slot:1,err:null},{signature:'b',slot:2,err:null}]]) {
    const{s,c,rpc}=setup();rpc.signatures=async()=>entries;
    await assert.rejects(c.evaluate(s.get('SELECT * FROM mints')),/Malformed signature history/);
    assert.equal(s.get('SELECT COUNT(*) n FROM no_trades').n,0);s.close();
  }
  const{s,c,rpc}=setup();rpc.signatures=async()=>{throw new Error('RPC unavailable');};
  await c.checkDue();
  assert.equal(s.get('SELECT status FROM mints').status,'monitoring');
  assert.equal(s.get('SELECT COUNT(*) n FROM no_trades').n,0);s.close();
});
test('unqualified stores all failing reasons and stops RPC',async()=>{
  const{s,c,rpc}=setup();const accounts=rpc.accounts;
  rpc.accounts=async()=>{const snapshot=await accounts();const b=Buffer.from(snapshot.value[1].data[0],'base64');
    b.writeBigUInt64LE(1000000n,16);b.writeBigUInt64LE(5000000n,32);
    snapshot.value[1].data[0]=b.toString('base64');return snapshot;};
  const result=await c.evaluate(s.get('SELECT * FROM mints'));
  assert.equal(result.category,'unqualified');
  assert.deepEqual(JSON.parse(s.get('SELECT reasons_json FROM unqualified').reasons_json),['market_cap_below_min','liquidity_at_or_below_min']);
  assert.equal(s.get('SELECT status FROM mints').status,'unqualified');
  s.run('UPDATE mints SET last_check_at=0,next_check=0');
  rpc.signatures=rpc.accounts=async()=>assert.fail('Unqualified result is terminal');
  await c.checkDue();assert.equal(report(s).unqualified.length,1);s.close();
});
test('worker sleeps 1.5 seconds between non-overlapping DB checks',async()=>{
  let checks=0;const sleeps=[];
  await checkLoop({checkDue:async()=>{checks++;}},()=>checks===3,async ms=>{sleeps.push(ms);});
  assert.equal(checks,3);assert.deepEqual(sleeps,[1500,1500]);
});
test('DB worker respects last-check age even if next_check is stale',async()=>{
  const{s,c,rpc}=setup();
  s.run('UPDATE mints SET last_check_at=?,next_check=0',nowSeconds()-599);
  rpc.signatures=async()=>assert.fail('Not yet ten minutes since last check');
  await c.checkDue();assert.equal(s.get('SELECT COUNT(*) n FROM evaluations').n,0);s.close();
});
test('long-inactive mints stop polling permanently, including after recovery',async()=>{
  const{s,c,rpc}=setup();const old=nowSeconds()-1300;
  s.run('UPDATE mints SET created_at=?',old-10);
  s.run('UPDATE mayhem_activity SET created_at=?',old-10);
  s.run('UPDATE mayhem_trades SET traded_at=?',old);s.refreshActivity(mint);
  const result=await c.evaluate(s.get('SELECT * FROM mints'));
  assert.equal(result.category,'long_inactive');assert.equal(s.get('SELECT status FROM mints').status,'long_inactive');
  s.apply('resumed',3,[{type:'trade',index:1,mint,timestamp:nowSeconds(),slot:3,buy:true,solAmount:'1',tokenAmount:'1'}]);
  s.run('UPDATE mints SET last_check_at=0,next_check=0');
  rpc.signatures=rpc.accounts=async()=>assert.fail('Long-inactive mint must not poll');
  await c.checkDue();assert.equal(s.get('SELECT COUNT(*) n FROM evaluations').n,1);
  assert.equal(s.get('SELECT status FROM mints').status,'long_inactive');s.close();
});
test('creation baseline does not invent a trade',()=>{
  const s=new Store(':memory:',cfg);s.addMint({mint,timestamp:100});
  const a=s.get('SELECT * FROM mayhem_activity');
  assert.equal(a.first_trade_at,100);assert.equal(a.observed_first_trade_at,null);
  assert.equal(a.last_trade_at,null);assert.equal(a.trade_count,0);s.close();
});
test('graduation closes observation without candidate',async()=>{
  const{s,c}=setup({complete:true});await c.evaluate(s.get('SELECT * FROM mints'));
  assert.equal(s.get('SELECT status FROM mints').status,'graduated');assert.equal(s.get('SELECT COUNT(*) n FROM candidates').n,0);s.close();
});
test('history race defers classification',async()=>{
  const{s,rpc,c}=setup();let calls=0;
  rpc.signatures=async()=>[{signature:++calls===1?'last':'new',slot:1,blockTime:nowSeconds()-100,err:null}];
  await assert.rejects(c.evaluate(s.get('SELECT * FROM mints')),/changed during evaluation/);
  assert.equal(s.get('SELECT COUNT(*) n FROM candidates').n,0);s.close();
});
test('failed checks remain scheduled and invalidate coverage',async()=>{
  const{s,rpc,c}=setup();const previous=s.get('SELECT last_check_at FROM mints').last_check_at;
  rpc.accounts=async()=>{throw new Error('unavailable');};await c.checkDue();
  assert.equal(s.get('SELECT last_check_at FROM mints').last_check_at,previous);
  assert.equal(s.get('SELECT status FROM mints').status,'monitoring');assert.match(s.get('SELECT last_error FROM mints').last_error,/unavailable/);
  assert.equal(s.get("SELECT COUNT(*) n FROM coverage WHERE kind='evaluation_failure'").n,1);s.close();
});
test('legacy database migrates last check and keeps saved candidates out of polling after restart',()=>{
  const directory=mkdtempSync(join(tmpdir(),'mayhem-migrate-'));
  const path=join(directory,'test.sqlite');
  let s;
  try {
    s=new Store(path,cfg);s.addMint({mint,timestamp:100});
    const curve={marketCap:0.1,liquidity:0.01,complete:false};
    s.evaluate(mint,700,1,'AA==',curve,{category:'candidate',age:100,passes:true},600);
    s.run("UPDATE mints SET status='monitoring',next_check=760");
    s.db.exec('ALTER TABLE mints DROP COLUMN last_check_at');s.close();s=null;
    s=new Store(path,cfg);
    const row=s.get('SELECT * FROM mints');
    assert.equal(row.last_check_at,700);assert.equal(row.next_check,1300);assert.equal(row.status,'qualified');
    assert.equal(row.created_at,100);
  } finally { s?.close();rmSync(directory,{recursive:true,force:true}); }
});
test('coverage gap excludes otherwise full UTC day from mean',()=>{
  const s=new Store(':memory:',cfg);s.run("INSERT INTO metadata VALUES('monitoring_started_at','86400')");
  let id=s.coverage('session',86400,'test');s.run('UPDATE coverage SET ended_at=172800 WHERE id=?',id);
  id=s.coverage('websocket_gap',100000,'gap');s.run('UPDATE coverage SET ended_at=100001 WHERE id=?',id);
  assert.equal(report(s,172801).average,null);s.close();
});
