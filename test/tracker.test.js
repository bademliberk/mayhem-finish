import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { CandidateTracker } from '../src/tracker.js';
import { Observations } from '../src/observations.js';
import { PUMP } from '../src/config.js';
import { report } from '../src/report.js';
import { Collector, nowSeconds } from '../src/collector.js';
import { Rpc } from '../src/rpc.js';
import { MAYHEM, addresses } from '../src/config.js';

const mint = '9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cfg = { firstCheck:30,recheck:30,horizon:86400,activeAge:5,staleAge:60,minCap:2,maxCap:5,minLiquidity:0.005,trackingSeconds:30 };
function account(cap = 3, liquidity = 0.01, complete = false) {
  const b = Buffer.alloc(166);
  Buffer.from([23,183,248,55,96,216,172,96]).copy(b);
  b.writeBigUInt64LE(1000n,8); b.writeBigUInt64LE(BigInt(Math.round(cap*1e9)),16);
  b.writeBigUInt64LE(BigInt(Math.round(liquidity*1e9)),32); b.writeBigUInt64LE(1000n,40);
  b[81] = 1; b[48] = Number(complete);
  return { owner:PUMP, data:[b.toString('base64'),'base64'] };
}
class Socket extends EventEmitter {
  readyState = 0;
  sent = [];
  open() { this.readyState = 1; this.emit('open'); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  message(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  terminate() { this.readyState = 3; this.emit('close'); }
  ping() { this.emit('pong'); }
  ack(id = this.sent.find(m => m.method === 'accountSubscribe').id, subscription = 7) {
    this.message({ id, result:subscription });
  }
  update(slot, cap, liquidity = 0.01, complete = false, subscription = 7) {
    this.message({ method:'accountNotification', params:{ subscription, result:{ context:{slot}, value:account(cap,liquidity,complete) } } });
  }
}
function setup({ snapshot = async () => ({ context:{slot:1}, value:[account()] }), candidate = true } = {}) {
  const store = new Store(':memory:', cfg);
  let now = 100000, seq = 0;
  const timers = new Map(), sockets = [];
  store.addMint({ mint, timestamp:60 });
  if (candidate) store.evaluate(mint,100,1,'AA==',{marketCap:3,liquidity:0.01},
    { category:'candidate',age:10,passes:true,detectedAtMs:now },90);
  let calls = 0;
  const tracker = new CandidateTracker(store, { wsUrl:'wss://unused.test', accounts:async (...args) => { calls++; return snapshot(...args); } }, {
    now:() => now,
    socketFactory:() => { const s = new Socket(); sockets.push(s); return s; },
    setTimer:(fn, delay) => { const id = ++seq; timers.set(id,{fn,at:now+delay}); return id; },
    clearTimer:id => timers.delete(id),
  });
  return {store,tracker,sockets,timers,observations:new Observations(store),calls:() => calls,
    setNow:value => { now = value; },
    advance:value => { now = value; for (const [id,timer] of [...timers]) if (timer.at<=now) { timers.delete(id); timer.fn(); } },
    close:async () => { await tracker.stop(); store.close(); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('only qualified candidates subscribe; ack precedes one snapshot, notifications need no RPC', async () => {
  const s = setup();
  assert.equal(s.sockets.length,0);
  s.tracker.add(mint);
  const socket = s.sockets[0]; socket.open();
  assert.equal(s.calls(),0);
  assert.equal(socket.sent[0].method,'accountSubscribe');
  assert.equal(socket.sent[0].params[0],s.store.get('SELECT curve_address FROM mints').curve_address);
  socket.ack(); await settle();
  assert.equal(s.calls(),1);
  s.setNow(105000); socket.update(2,6,0.02);
  s.setNow(110000); socket.update(3,4);
  s.advance(130000);
  const row = s.observations.summaries()[0];
  assert.equal(row.status,'completed'); assert.equal(row.sample_count,3);
  assert.equal(row.entry_market_cap_sol,3); assert.equal(row.peak_market_cap_sol,6);
  assert.equal(row.min_market_cap_sol,3); assert.equal(row.final_market_cap_sol,4);
  assert.equal(row.liquidity_at_peak_sol,0.02); assert.equal(row.peak_change_pct,100);
  assert.equal(row.time_to_peak_ms,5000); assert.equal(row.ended_at_ms,130000);
  assert.ok(socket.sent.some(m => m.method === 'accountUnsubscribe'));
  assert.equal(s.calls(),1); assert.equal(s.timers.size,0);
  assert.ok(report(s.store).usage.websocketBytes > 0);
  await s.close();
});

test('noncandidates never open a socket', async () => {
  const s = setup({candidate:false}); s.tracker.add(mint);
  assert.equal(s.sockets.length,0); assert.equal(s.calls(),0); await s.close();
});

test('late snapshot cannot overwrite newer notifications; same-slot reversals are retained', async () => {
  let resolve;
  const s = setup({snapshot:() => new Promise(r => {resolve=r;})});
  s.tracker.add(mint); const socket=s.sockets[0]; socket.open(); socket.ack();
  socket.update(3,4); socket.update(3,4); socket.update(3,6); socket.update(3,4);
  socket.update(2,9);
  resolve({context:{slot:3},value:[account(8)]}); await settle();
  const row=s.observations.summaries()[0];
  assert.equal(row.sample_count,3); assert.equal(row.peak_market_cap_sol,6); assert.equal(row.final_market_cap_sol,4);
  s.setNow(130000); socket.update(4,10);
  assert.equal(s.observations.summaries()[0].peak_market_cap_sol,6);
  await s.close();
});

test('disconnect/reconnect keeps original deadline and marks incomplete without repeated baseline RPC', async () => {
  const s=setup(); s.tracker.add(mint); const socket=s.sockets[0]; socket.open(); socket.ack(); await settle();
  s.setNow(110000); socket.terminate(); s.advance(111000);
  const next=s.sockets[1]; next.open(); next.ack(undefined,8); next.update(3,5,0.01,false,8);
  s.advance(130000);
  assert.equal(s.calls(),1);
  const row=s.observations.summaries()[0]; assert.equal(row.status,'incomplete'); assert.equal(row.deadline_ms,130000);
  assert.equal(row.interrupted,1); await s.close();
});

test('missing ack expires incomplete with null metrics and no RPC', async () => {
  const s=setup(); s.tracker.add(mint); s.sockets[0].open(); s.advance(130000);
  const row=s.observations.summaries()[0];
  assert.equal(row.status,'incomplete'); assert.equal(row.peak_market_cap_sol,null); assert.equal(row.peak_change_pct,null);
  assert.equal(s.calls(),0); await s.close();
});

test('late initial RPC result is ignored and stop waits for pending task', async () => {
  let resolve;
  const s=setup({snapshot:() => new Promise(r => {resolve=r;})});
  s.tracker.add(mint); s.sockets[0].open(); s.sockets[0].ack(); s.advance(130000);
  const stopping=s.tracker.stop(); resolve({context:{slot:1},value:[account(9)]}); await stopping;
  assert.equal(s.observations.summaries()[0].sample_count,0); await s.close();
});

test('graduation stops tracking without inventing cap or entering AMM', async () => {
  const s=setup(); s.tracker.add(mint); const socket=s.sockets[0]; socket.open(); socket.ack(); await settle();
  s.setNow(110000); socket.update(2,0,0,true);
  const row=s.observations.summaries()[0]; assert.equal(row.status,'graduated'); assert.equal(row.sample_count,1);
  assert.equal(row.final_market_cap_sol,3); assert.equal(s.tracker.windows.size,0); await s.close();
});

test('malformed notification is a data gap, not a flat successful observation', async () => {
  const s=setup(); s.tracker.add(mint); const socket=s.sockets[0]; socket.open(); socket.ack(); await settle();
  socket.message({method:'accountNotification',params:{subscription:7,result:{context:{slot:2},value:null}}});
  s.advance(130000); assert.equal(s.observations.get(mint).status,'incomplete'); await s.close();
});

test('expired restart window is incomplete and never opens socket', async () => {
  const s=setup(); s.setNow(150000); s.tracker.recover();
  assert.equal(s.sockets.length,0); const row=s.observations.get(mint);
  assert.equal(row.status,'incomplete'); assert.equal(row.ended_at_ms,130000); await s.close();
});

test('restart with time remaining subscribes only for original remaining window', async () => {
  const s=setup(); s.setNow(120000); s.tracker.recover();
  const socket=s.sockets[0]; socket.open(); socket.ack(); await settle(); s.advance(130000);
  const row=s.observations.get(mint); assert.equal(row.status,'incomplete'); assert.equal(row.deadline_ms,130000); await s.close();
});

test('collector immediately hands a persisted candidate to tracker and active rechecks use 30 seconds', async () => {
  const store=new Store(':memory:',cfg), now=nowSeconds();
  store.addMint({mint,timestamp:now-35});
  store.apply('trade',1,[{type:'trade',index:1,mint,timestamp:now-10,slot:1,buy:true,solAmount:'1',tokenAmount:'1'}]);
  const rpc={signatures:async()=>[{signature:'trade',slot:1,err:null}],accounts:async()=>({context:{slot:2},value:[{owner:MAYHEM,data:['AA==','base64']},account()]})};
  let called=0;
  const collector=new Collector(store,rpc,cfg,value=>{
    assert.equal(value,mint); called++;
    const row=store.get('SELECT * FROM candidate_observations');
    assert.equal(row.status,'tracking'); assert.equal(row.deadline_ms-row.started_at_ms,30000);
    assert.equal(store.get('SELECT market_cap_sol FROM candidates').market_cap_sol,3);
  });
  assert.equal(store.get('SELECT next_check FROM mints').next_check,now-5);
  await collector.evaluate(store.get('SELECT * FROM mints')); assert.equal(called,1);
  store.close();
  const active=new Store(':memory:',cfg); active.addMint({mint,timestamp:now-35});
  active.apply('trade',1,[{type:'trade',index:1,mint,timestamp:now,slot:1,buy:true,solAmount:'1',tokenAmount:'1'}]);
  await new Collector(active,rpc,cfg,()=>assert.fail('Active mint must not subscribe')).evaluate(active.get('SELECT * FROM mints'));
  const row=active.get('SELECT * FROM mints'); assert.equal(row.status,'monitoring'); assert.equal(row.next_check-row.last_check_at,30);
  active.close();
});

test('multiple candidates share a socket and expired pending subscription is unsubscribed on late ack', async () => {
  const s=setup(), other=PUMP;
  s.store.addMint({mint:other,timestamp:60});
  s.store.evaluate(other,100,1,'AA==',{marketCap:3,liquidity:0.01},{category:'candidate',age:10,passes:true,detectedAtMs:110000},90);
  s.tracker.add(mint); s.tracker.add(other); assert.equal(s.sockets.length,1);
  const socket=s.sockets[0]; socket.open();
  const request=socket.sent.find(m=>m.params[0]===addresses(mint).curve);
  s.advance(130000); socket.ack(request.id,99);
  assert.ok(socket.sent.some(m=>m.method==='accountUnsubscribe' && m.params[0]===99));
  assert.equal(s.calls(),0); assert.equal(s.tracker.windows.size,1); await s.close();
});

test('pending baseline at deadline marks even a sampled window incomplete', async () => {
  let resolve;
  const s=setup({snapshot:()=>new Promise(r=>{resolve=r;})});
  s.tracker.add(mint); const socket=s.sockets[0]; socket.open(); socket.ack(); socket.update(3,4);
  s.advance(130000); assert.equal(s.observations.get(mint).status,'incomplete');
  resolve({context:{slot:2},value:[account()]}); await s.close();
});

test('RPC skips baseline queued past its deadline without network or usage', async () => {
  const rpc=new Rpc({key:'test',rpcInterval:0},{usage:()=>assert.fail('Expired baseline must not count usage')});
  await assert.rejects(rpc.accounts(['unused'],{deadlineMs:Date.now()-1}),/deadline reached/);
});

test('mixed policies expose separate counts and suppress pooled averages', async () => {
  const s=setup(); s.store.run("UPDATE evaluations SET screening_policy='legacy'");
  s.store.addMint({mint:PUMP,timestamp:60});
  s.store.evaluate(PUMP,100,1,'AA==',{marketCap:3,liquidity:0.01},{category:'candidate',age:10,passes:true},90);
  const result=report(s.store); assert.equal(result.averageSuppressedForMixedPolicies,true); assert.equal(result.average,null);
  assert.equal(result.screeningPolicies.length,2); await s.close();
});

test('policy activation advances normal pending checks but preserves errors and terminal candidates', async () => {
  const s=setup({candidate:false}); s.store.run('UPDATE mints SET next_check=660');
  s.store.activatePolicy(100); assert.equal(s.store.get('SELECT next_check FROM mints').next_check,90);
  s.store.run("DELETE FROM metadata WHERE key='screening_policy'");
  s.store.run("UPDATE mints SET next_check=700,last_error='retry'"); s.store.activatePolicy(101);
  assert.equal(s.store.get('SELECT next_check FROM mints').next_check,700); await s.close();
});
