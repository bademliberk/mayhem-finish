import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Collector, nowSeconds } from '../src/collector.js';
import { MAYHEM, PUMP } from '../src/config.js';
import { report } from '../src/report.js';
import { checkLoop } from '../src/worker.js';
import { execFileSync } from 'node:child_process';

const mint='9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cfg={firstCheck:30,recheck:30,horizon:86400,minCap:2,maxCap:5,minLiquidity:0.005,historyPages:1,trackingSeconds:30};
function setup({complete=false}={}) {
  const s=new Store(':memory:',cfg), now=nowSeconds();
  s.addMint({mint,timestamp:now-35});
  const b=Buffer.alloc(166);Buffer.from([23,183,248,55,96,216,172,96]).copy(b);
  b.writeBigUInt64LE(1000n,8);b.writeBigUInt64LE(3000000000n,16);b.writeBigUInt64LE(6000000n,32);b.writeBigUInt64LE(1000n,40);b[81]=1;b[48]=Number(complete);
  const rpc={
    signatures:async()=>assert.fail('Screening must not request signatures'),
    transaction:async()=>assert.fail('Screening must not fetch transactions'),
    accounts:async()=>({context:{slot:2},value:[{owner:MAYHEM,data:['AA==','base64']},{owner:PUMP,data:[b.toString('base64'),'base64']}]})};
  return{s,rpc,c:new Collector(s,rpc,cfg)};
}
test('financial qualification needs one account request and no trade history',async()=>{
  const{s,c,rpc}=setup();let calls=0;const accounts=rpc.accounts;
  rpc.accounts=async addresses=>{calls++;assert.equal(addresses.length,2);return accounts();};
  const result=await c.evaluate(s.get('SELECT * FROM mints'));
  assert.equal(calls,1);assert.equal(result.category,'candidate');assert.equal(result.age,null);
  const e=s.get('SELECT * FROM evaluations');
  assert.equal(e.history_scope,'not_checked');assert.equal(e.last_trade_at,null);assert.equal(e.trade_age_seconds,null);
  assert.equal(JSON.parse(e.screening_policy).version,'financial_only_v1');
  assert.equal(s.get('SELECT market_cap_sol FROM candidates').market_cap_sol,3);
  assert.equal(s.get('SELECT status FROM candidate_observations').status,'tracking');
  assert.equal(s.get('SELECT last_trade_at FROM mayhem_activity').last_trade_at,null);
  assert.equal(s.get('SELECT trading_span_seconds FROM activity_durations').trading_span_seconds,null);
  assert.equal(s.get('SELECT status FROM mints').status,'qualified');
  s.run('UPDATE mints SET last_check_at=0,next_check=0');rpc.accounts=async()=>assert.fail('Candidate must not be screened again');
  await c.checkDue();assert.equal(s.get('SELECT COUNT(*) n FROM evaluations').n,1);s.close();
});
test('cached recent, stale, future, absent or quarantined trades cannot change financial qualification',async()=>{
  for(const age of [null,0,5,60,61,1300,-100]) {
    const{s,c}=setup();
    if(age!=null) s.apply('cached',1,[{type:'trade',index:1,mint,timestamp:nowSeconds()-age,slot:1,buy:true,solAmount:'1',tokenAmount:'1'}]);
    s.quarantine('bad',1,nowSeconds(),'truncated');
    assert.equal((await c.evaluate(s.get('SELECT * FROM mints'))).category,'candidate');
    assert.equal(s.get('SELECT last_trade_at FROM evaluations').last_trade_at,null);
    for(const table of ['no_trades','long_inactive']) assert.equal(s.get(`SELECT COUNT(*) n FROM ${table}`).n,0);
    s.close();
  }
});
test('unqualified stores all failing reasons and stops RPC',async()=>{
  const{s,c,rpc}=setup();const accounts=rpc.accounts;
  rpc.accounts=async()=>{const snapshot=await accounts();const b=Buffer.from(snapshot.value[1].data[0],'base64');
    b.writeBigUInt64LE(1000000n,16);b.writeBigUInt64LE(5000000n,32);
    snapshot.value[1].data[0]=b.toString('base64');return snapshot;};
  assert.equal((await c.evaluate(s.get('SELECT * FROM mints'))).category,'unqualified');
  assert.deepEqual(JSON.parse(s.get('SELECT reasons_json FROM unqualified').reasons_json),['market_cap_below_min','liquidity_at_or_below_min']);
  s.run('UPDATE mints SET last_check_at=0,next_check=0');rpc.accounts=async()=>assert.fail('Unqualified result is terminal');
  await c.checkDue();assert.equal(report(s).unqualified.length,1);
  assert.equal(s.get('SELECT COUNT(*) n FROM candidate_observations').n,0);s.close();
});
test('malformed or unavailable account data defers without classifying',async()=>{
  for(const bad of [null,{}, {context:{slot:-1},value:[]},{context:{slot:2},value:[]},
    {context:{slot:2},value:[null,null]}]) {
    const{s,c,rpc}=setup();const previous=s.get('SELECT last_check_at FROM mints').last_check_at;
    rpc.accounts=async()=>bad;await c.checkDue();
    assert.equal(s.get('SELECT COUNT(*) n FROM evaluations').n,0);
    const row=s.get('SELECT * FROM mints');assert.equal(row.status,'monitoring');assert.equal(row.last_check_at,previous);
    assert.ok(row.next_check>=nowSeconds()+29);assert.ok(row.last_error);s.close();
  }
});
test('wrong-owner and non-Mayhem curves never qualify',async()=>{
  for(const field of ['state','curve','flag']) {
    const{s,c,rpc}=setup(),accounts=rpc.accounts;
    rpc.accounts=async()=>{const result=await accounts();
      if(field==='state') result.value[0].owner=PUMP;
      if(field==='curve') result.value[1].owner=MAYHEM;
      if(field==='flag') {const bytes=Buffer.from(result.value[1].data[0],'base64');bytes[81]=0;result.value[1].data[0]=bytes.toString('base64');}
      return result;};
    await assert.rejects(c.evaluate(s.get('SELECT * FROM mints')));
    assert.equal(s.get('SELECT COUNT(*) n FROM candidates').n,0);s.close();
  }
});
test('worker sleeps 1.5 seconds between non-overlapping DB checks',async()=>{
  let checks=0;const sleeps=[];
  await checkLoop({checkDue:async()=>{checks++;}},()=>checks===3,async ms=>{sleeps.push(ms);});
  assert.equal(checks,3);assert.deepEqual(sleeps,[1500,1500]);
});
test('DB worker waits 30 seconds since creation or deferred check',async()=>{
  const{s,c,rpc}=setup();s.run('UPDATE mints SET last_check_at=?,next_check=0',nowSeconds()-29);
  rpc.accounts=async()=>assert.fail('Not due');await c.checkDue();
  assert.equal(s.get('SELECT COUNT(*) n FROM evaluations').n,0);s.close();
});
test('legacy terminal categories remain terminal after policy activation',async()=>{
  for(const status of ['no_trades','long_inactive','unqualified','qualified']) {
    const{s,c,rpc}=setup();s.run('UPDATE mints SET status=?,next_check=0,last_check_at=0',status);
    s.activatePolicy();rpc.accounts=async()=>assert.fail('Do not reenroll legacy terminals');
    await c.checkDue();assert.equal(s.get('SELECT status FROM mints').status,status);s.close();
  }
});
test('graduation closes observation without candidate',async()=>{
  const{s,c}=setup({complete:true});await c.evaluate(s.get('SELECT * FROM mints'));
  assert.equal(s.get('SELECT status FROM mints').status,'graduated');assert.equal(s.get('SELECT COUNT(*) n FROM candidates').n,0);s.close();
});
test('deadline reached while awaiting account snapshot prevents qualification',async()=>{
  const{s,c,rpc}=setup();const row=s.get('SELECT * FROM mints'),accounts=rpc.accounts;
  rpc.accounts=async()=>{row.deadline=nowSeconds();return accounts();};
  assert.equal((await c.evaluate(row)).category,'deadline');
  assert.equal(s.get('SELECT COUNT(*) n FROM candidates').n,0);s.close();
});
test('failed checks retain last-check timestamp, retry after 30 seconds and record coverage',async()=>{
  const{s,rpc,c}=setup();const previous=s.get('SELECT last_check_at FROM mints').last_check_at;
  rpc.accounts=async()=>{throw new Error('unavailable');};await c.checkDue();
  const row=s.get('SELECT * FROM mints');assert.equal(row.last_check_at,previous);assert.equal(row.status,'monitoring');
  assert.ok(row.next_check>=nowSeconds()+29);assert.match(row.last_error,/unavailable/);
  assert.equal(s.get("SELECT COUNT(*) n FROM coverage WHERE kind='evaluation_failure'").n,1);s.close();
});
test('legacy database migrates last check and preserves saved candidate metrics and policy',()=>{
  const directory=mkdtempSync(join(tmpdir(),'mayhem-migrate-')),path=join(directory,'test.sqlite');let s;
  try {
    s=new Store(path,{...cfg,trackingSeconds:undefined});s.addMint({mint,timestamp:100});
    s.evaluate(mint,700,1,'AA==',{marketCap:0.1,liquidity:0.01},{category:'candidate',age:100,passes:true},600);
    s.run("UPDATE mints SET status='monitoring',next_check=760");
    s.db.exec('ALTER TABLE mints DROP COLUMN last_check_at');s.close();s=null;
    s=new Store(path,cfg);s.activatePolicy();
    const row=s.get('SELECT * FROM mints');assert.equal(row.last_check_at,700);assert.equal(row.status,'qualified');
    const candidate=s.get('SELECT * FROM candidates');assert.equal(candidate.market_cap_sol,0.1);assert.equal(candidate.screening_policy,'legacy');
    assert.equal(s.get('SELECT last_trade_at FROM evaluations').last_trade_at,600);
    assert.equal(s.get('SELECT status FROM candidate_observations').status,'not_tracked');
  } finally {s?.close();rmSync(directory,{recursive:true,force:true});}
});
test('inspect performs only one account RPC and reports financial-only screening',async()=>{
  const {s,rpc}=setup();const snapshot=await rpc.accounts();s.close();
  const dir=mkdtempSync(join(tmpdir(),'mayhem-inspect-'));
  const cli=new URL('../src/cli.js',import.meta.url).href;
  const script=`let calls=0; globalThis.fetch=async (_url,options)=>{
    const request=JSON.parse(options.body);
    if(request.method!=='getMultipleAccounts') throw new Error('Unexpected trade history request');
    calls++;return {ok:true,status:200,json:async()=>({result:${JSON.stringify(snapshot)}})};
  };process.argv=['node','cli','inspect','${mint}'];await import('${cli}');if(calls!==1)process.exitCode=1;`;
  try {
    const output=execFileSync(process.execPath,['--input-type=module','-e',script],{
      cwd:dir,encoding:'utf8',env:{...process.env,HELIUS_API_KEY:'test',DB_PATH:join(dir,'test.sqlite'),RPC_INTERVAL_MS:'1',MIN_MARKET_CAP_SOL:'2',MAX_MARKET_CAP_SOL:'5',MIN_LIQUIDITY_SOL:'0.005'},stdio:['ignore','pipe','pipe'],
    });
    const result=JSON.parse(output);assert.equal(result.tradeHistory,'not_checked');assert.equal(result.screening.category,'candidate');
    assert.equal(result.screening.age,null);assert.equal(result.lastMayhemTrade,undefined);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('coverage gap excludes otherwise full UTC day from mean',()=>{
  const s=new Store(':memory:',cfg);s.run("INSERT INTO metadata VALUES('monitoring_started_at','86400')");
  let id=s.coverage('session',86400,'test');s.run('UPDATE coverage SET ended_at=172800 WHERE id=?',id);
  id=s.coverage('websocket_gap',100000,'gap');s.run('UPDATE coverage SET ended_at=100001 WHERE id=?',id);
  assert.equal(report(s,172801).average,null);s.close();
});
