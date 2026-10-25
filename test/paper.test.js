import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { PaperStore, paperConfig } from '../src/paper-store.js';
import { PaperEngine } from '../src/paper-engine.js';
import { PaperFeeds } from '../src/paper-feeds.js';
import { buyBudget, buyTokens, sell, entryQuote, exitQuote, profitable, meetsDrop, reserves } from '../src/paper-math.js';
import { PUMP } from '../src/config.js';
import { PublicKey } from '@solana/web3.js';

const mint='9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cfg={firstCheck:30,recheck:30,horizon:86400,minCap:2,maxCap:5,minLiquidity:0.005,trackingSeconds:30,paperMode:true};
const pc=paperConfig({});
function account(mc=0.2,liquidity=1,complete=false) {
  const b=Buffer.alloc(166);Buffer.from([23,183,248,55,96,216,172,96]).copy(b);
  b.writeBigUInt64LE(1000000000000n,8);b.writeBigUInt64LE(BigInt(Math.round(mc*1e9)),16);
  b.writeBigUInt64LE(900000000000n,24);b.writeBigUInt64LE(BigInt(Math.round(liquidity*1e9)),32);
  b.writeBigUInt64LE(1000000000000n,40);b[48]=Number(complete);b[81]=1;
  return {owner:PUMP,data:[b.toString('base64'),'base64']};
}
function candidate(store,key=mint) {
  store.addMint({mint:key,timestamp:100});
  store.evaluate(key,130,1,'AA==',{marketCap:3,liquidity:0.1},{category:'candidate',age:null,passes:true},null);
}
function setup(options={}) {
  const store=new Store(':memory:',cfg);candidate(store);
  let now=100000;
  const rpc={call:async()=>({value:[{slot:15,err:null,confirmationStatus:'confirmed'}]}),
    accounts:async()=>({context:{slot:15},value:[account()]})};
  const engine=new PaperEngine(store,rpc,{...pc,...options},{now:()=>now,project:raw=>raw});
  const removed=[],added=[];
  engine.attach({add:(...args)=>added.push(args),remove:key=>removed.push(key),start:()=>{},stop:async()=>{},resync:()=>{},
    setPreprocessed:()=>{},covers:()=>true});
  engine.add(mint);engine.onReady();engine.onSlot(15);
  engine.onAccount(mint,11,account(1));engine.onAccount(mint,14,account(1));
  return {store,rpc,engine,removed,added,setNow:n=>{now=n;},close:()=>store.close(),
    signal:(signature='sig',slot=15,mc=0.2)=>({signature,slot,mint,state:reserves(account(mc))})};
}
test('paper defaults are fixed strategy with validated configurable cap and cost assumptions',()=>{
  assert.equal(pc.maxTrades,25);assert.equal(pc.buyLamports,'10000000');assert.equal(pc.windowSlots,5);
  assert.equal(pc.dropBps,6000);assert.equal(pc.mode,'paper');
  assert.equal(pc.maxWatches,10);
  assert.equal(pc.rotationIdleMs,60000);assert.equal(pc.idleMs,10000);
  assert.equal(paperConfig({PAPER_MAX_WATCHES:'3'}).maxWatches,3);
  for(const value of ['0','11','1000','2.5','NaN']) assert.throws(()=>paperConfig({PAPER_MAX_WATCHES:value}));
  for(const value of ['0','-1','NaN','2.5']) assert.throws(()=>paperConfig({MAX_TRADE_COUNT:value}));
  assert.equal(paperConfig({PAPER_ENTRIES_ENABLED:'false'}).entriesEnabled,false);
});
test('ten concurrent watches reject the eleventh until a watch becomes terminal',()=>{
  const s=setup();
  const keys=Array.from({length:10},(_,i)=>new PublicKey(Buffer.alloc(32,i+1)).toBase58());
  for(const key of keys) {candidate(s.store,key);s.engine.add(key);}
  assert.equal(s.engine.paper.active().length,10);assert.equal(s.added.length,10);
  assert.equal(s.engine.paper.watch(keys[9]),undefined);
  s.engine.onAccount(mint,16,account(0.1));
  s.engine.add(keys[9]);assert.equal(s.engine.paper.active().length,10);
  assert.ok(s.engine.paper.watch(keys[9]));s.close();
});
test('restart caps saved watches, prioritizes positions and preserves historical records',()=>{
  const s=setup({maxWatches:30});
  s.engine.signal(s.signal());s.engine.paper.fill(s.engine.paper.pending()[0],{tokens:'100',cost:'1000'},100001);
  const keys=Array.from({length:12},(_,i)=>new PublicKey(Buffer.alloc(32,i+1)).toBase58());
  for(const [i,key] of keys.entries()) {candidate(s.store,key);s.engine.paper.enroll(key,200000+i);}
  s.engine.cfg.maxWatches=10;s.added.length=0;s.engine.start();
  const expected=[mint,...keys.slice(3)].sort();
  assert.deepEqual(s.added.map(args=>args[0]).sort(),expected);
  assert.equal(s.engine.paper.active().length,10);
  assert.equal(s.store.get('SELECT count(*) n FROM paper_watches').n,13);
  for(const key of keys.slice(0,3)) {
    assert.equal(s.engine.paper.watch(key).reason,'subscription_cap');
    assert.equal(s.engine.paper.watch(key).status,'stopped');
    assert.equal(s.engine.paper.watch(key).preprocessed,0);
  }
  assert.ok(s.engine.paper.position(mint));assert.equal(s.engine.paper.capacity().successfulBuys,1);
  s.added.length=0;s.engine.start();
  assert.deepEqual(s.added.map(args=>args[0]).sort(),expected);
  assert.equal(s.store.get("SELECT count FROM paper_counters WHERE name='restart_subscription_cap'").count,3);
  s.close();
});
test('startup refuses excess held positions before subscribing or canceling pending orders',()=>{
  const s=setup();s.engine.signal(s.signal());
  s.engine.paper.fill(s.engine.paper.pending()[0],{tokens:'100',cost:'1000'},100001);
  const second=new PublicKey(Buffer.alloc(32,2)).toBase58();candidate(s.store,second);s.engine.add(second);
  s.engine.paper.request(second,'buy','dump',{tokens:'100',cost:'1000'},null,100002);
  s.engine.paper.fill(s.engine.paper.pending()[0],{tokens:'100',cost:'1000'},100003);
  s.engine.paper.request(mint,'sell','profit',{net:'1500'},null,100004);
  s.engine.cfg.maxWatches=1;s.added.length=0;
  assert.throws(()=>s.engine.start(),/manual reconciliation required/);
  assert.equal(s.added.length,0);assert.equal(s.engine.paper.pending().length,1);
  assert.equal(s.engine.paper.active().length,2);assert.ok(s.engine.paper.position(second));s.close();
});
test('graduated blocked positions remain recorded without consuming a restart subscription',()=>{
  const s=setup();s.engine.signal(s.signal());
  s.engine.paper.fill(s.engine.paper.pending()[0],{tokens:'100',cost:'1000'},100001);
  s.engine.onAccount(mint,16,account(1,1,true));
  const second=new PublicKey(Buffer.alloc(32,2)).toBase58();candidate(s.store,second);s.engine.add(second);
  s.engine.cfg.maxWatches=1;s.added.length=0;s.engine.start();
  assert.deepEqual(s.added.map(args=>args[0]),[second]);
  assert.ok(s.engine.paper.position(mint));assert.equal(s.engine.paper.watch(mint).reason,'graduated_no_amm_exit');s.close();
});
test('stale signal diagnostics separate causes without weakening entry guards',()=>{
  for(const [cause,change,slot] of [
    ['slot_behind',s=>{},13],['slot_ahead',s=>{},18],
    ['slot_heartbeat_stale',s=>{s.engine.slotAt=0;},15],
    ['reserve_stale',s=>{s.engine.states.get(mint).at=0;},15],
    ['already_applied',s=>{s.engine.onAccount(mint,15,account(1));},15],
  ]) {
    const s=setup();change(s);s.engine.signal(s.signal('diagnostic',slot));
    assert.equal(s.engine.paper.pending().length,0);
    assert.equal(s.store.get('SELECT count FROM paper_counters WHERE name=?',`stale:${cause}`).count,1);
    const signal=s.store.get("SELECT * FROM paper_signals WHERE signature='diagnostic'");
    assert.equal(signal.outcome,'stale_or_already_executed');
    assert.ok(JSON.parse(signal.detail).causes.includes(cause));s.close();
  }
});
test('subscription error samples retain only allowed method and numeric code',()=>{
  const s=setup();
  for(let i=0;i<110;i++) s.engine.paper.rejection('subscription_error',{
    method:'accountSubscribe',code:-32005,message:'secret-key',url:'https://secret-key',
  },100000+i);
  const rows=s.store.all('SELECT detail FROM paper_rejections');assert.equal(rows.length,100);
  assert.equal(JSON.parse(rows[0].detail).code,-32005);
  assert.equal(JSON.parse(rows[0].detail).method,'accountSubscribe');
  assert.ok(!JSON.stringify(rows).includes('secret-key'));s.close();
});
test('new discovery rotates an idle watch at 60 seconds and removes it before subscribing',()=>{
  const s=setup({maxWatches:1});
  const second=new PublicKey(Buffer.alloc(32,2)).toBase58();candidate(s.store,second);
  s.setNow(159999);s.engine.add(second);assert.equal(s.engine.paper.watch(second),undefined);
  const operations=[];s.engine.feeds.remove=key=>operations.push(['remove',key]);
  s.engine.feeds.add=key=>operations.push(['add',key]);
  s.setNow(160000);s.engine.add(second);
  assert.deepEqual(operations,[['remove',mint],['add',second]]);
  assert.equal(s.engine.paper.watch(mint).reason,'idle_rotation');
  assert.equal(s.engine.paper.watch(mint).preprocessed,0);assert.equal(s.engine.states.has(mint),false);
  assert.equal(s.engine.paper.active().length,1);assert.equal(s.store.get('SELECT count(*) n FROM paper_watches').n,2);
  operations.length=0;s.engine.start();assert.deepEqual(operations,[['add',second]]);s.close();
});
test('rotation protects held and pending watches and does not evict for ineligible enrollment',()=>{
  for(const mode of ['held','pending','disabled','trade-cap','duplicate','unknown']) {
    const s=setup({maxWatches:1});
    const second=new PublicKey(Buffer.alloc(32,2)).toBase58();candidate(s.store,second);
    if(mode==='held'||mode==='pending') {
      s.engine.signal(s.signal());
      if(mode==='held') s.engine.paper.fill(s.engine.paper.pending()[0],{tokens:'100',cost:'1000'},100001);
    }
    if(mode==='disabled') s.engine.cfg.entriesEnabled=false;
    if(mode==='trade-cap') s.engine.cfg.maxTrades=0;
    s.setNow(160000);
    s.engine.add(mode==='duplicate'?mint:mode==='unknown'?new PublicKey(Buffer.alloc(32,3)).toBase58():second);
    assert.notEqual(s.engine.paper.watch(mint).reason,'idle_rotation');
    assert.equal(s.engine.paper.watch(second),undefined);assert.equal(s.removed.length,0);s.close();
  }
});
test('rotation chooses the oldest idle watch and uses enrollment when never sampled',()=>{
  const s=setup({maxWatches:2});
  const second=new PublicKey(Buffer.alloc(32,2)).toBase58(),third=new PublicKey(Buffer.alloc(32,3)).toBase58();
  candidate(s.store,second);s.engine.paper.enroll(second,90000);candidate(s.store,third);
  s.setNow(160000);s.engine.add(third);
  assert.equal(s.engine.paper.watch(second).reason,'idle_rotation');
  assert.equal(s.engine.paper.watch(mint).status,'watching');assert.equal(s.engine.paper.active().length,2);s.close();
});
test('prior-slot fallback requires warm-up, excludes same-slot peaks and remains confirmation-gated',async()=>{
  for(const mode of ['valid','same-slot-peak','warmup','failed-trigger']) {
    const s=setup();
    if(mode==='same-slot-peak') {
      const row=s.engine.states.get(mint);row.history=row.history.map(h=>({...h,state:reserves(account(.3))}));
    }
    s.engine.onAccount(mint,15,account(mode==='same-slot-peak'?10:.2));
    if(mode==='warmup') s.engine.coverage(mint);
    const signal={...s.signal(),base:{slot:14,at:100000,model:'isolated_prior_slot'}};
    s.engine.signal(signal);
    const eligible=mode==='valid'||mode==='failed-trigger';
    assert.equal(s.engine.paper.pending().length,eligible?1:0);
    if(eligible) {
      assert.deepEqual(JSON.parse(s.engine.paper.pending()[0].quote_json).projectionBase,signal.base);
      if(mode==='failed-trigger') s.rpc.call=async()=>({value:[{slot:15,err:{failed:true},confirmationStatus:'confirmed'}]});
      await s.engine.tick();assert.equal(Boolean(s.engine.paper.position(mint)),mode==='valid');
    }
    s.close();
  }
});
test('same-slot fallback rejects missing, stale, future and invalid projection bases',()=>{
  for(const base of [undefined,{slot:15,at:100000,model:'isolated_prior_slot'},
    {slot:14,at:94999,model:'isolated_prior_slot'},{slot:14,at:100001,model:'isolated_prior_slot'},
    {slot:10,at:100000,model:'isolated_prior_slot'},{slot:14,at:100000,model:'latest_prior_slot'}]) {
    const s=setup();s.engine.onAccount(mint,15,account(.2));
    s.engine.signal({...s.signal(),base});assert.equal(s.engine.paper.pending().length,0);s.close();
  }
  const s=setup();s.engine.onAccount(mint,16,account(.2));
  s.engine.signal({...s.signal(),base:{slot:14,at:100000,model:'isolated_prior_slot'}});
  assert.equal(s.engine.paper.pending().length,0);s.close();
});
test('BigInt buy budgets include swap fee, own impact, reserve caps and network cost',()=>{
  const state=reserves(account()),budget=10000000n;
  const buy=buyBudget(state,budget,200);
  assert.ok(buy.cost<=budget);assert.ok(buyTokens(state,buy.tokens+1n,200).cost>budget);
  assert.equal(buy.state.realSol,state.realSol+buy.gross);
  assert.ok(buy.state.virtualSol>state.virtualSol);assert.ok(buy.state.virtualTokens<state.virtualTokens);
  const quote=entryQuote(state,pc);assert.equal(BigInt(quote.cost),buy.cost+10000n);
  const exit=exitQuote(buy.state,{tokens_raw:buy.tokens.toString()},pc);
  assert.ok(BigInt(exit.net)<BigInt(quote.cost));
  assert.throws(()=>sell({...state,realSol:0n},1000000000n,200),/liquidity/);
  assert.throws(()=>buyTokens({...state,realTokens:1n},2n,200),/tokens/);
});
test('drop uses rational price and profit is strict after all modeled costs',()=>{
  const high=reserves(account(1));
  assert.equal(meetsDrop(reserves(account(0.4)),high,pc),true);
  assert.equal(meetsDrop(reserves(account(0.400001)),high,pc),false);
  assert.equal(profitable({net:'130'},{entry_cost_lamports:'100'},pc),false);
  assert.equal(profitable({net:'131'},{entry_cost_lamports:'100'},pc),true);
});
test('prediction reserves capacity but cannot create a position before trigger reconciliation',async()=>{
  const s=setup();s.engine.signal(s.signal());
  assert.equal(s.engine.paper.capacity().pendingBuys,1);assert.equal(s.engine.paper.position(mint),undefined);
  await s.engine.tick();
  assert.equal(s.engine.paper.capacity().successfulBuys,1);assert.ok(s.engine.paper.position(mint));
  assert.equal(s.store.get('SELECT status FROM candidate_observations').status,'paper_watch');
  s.engine.signal(s.signal());assert.equal(s.engine.paper.capacity().successfulBuys,1);s.close();
});
test('five-slot window excludes old peak and exact MC bounds are not eligible',()=>{
  for(const mc of [0.1,0.5,0.41]) {
    const s=setup();s.engine.signal(s.signal('sig',15,mc));assert.equal(s.engine.paper.pending().length,0);s.close();
  }
  const s=setup();s.engine.onSlot(16);s.engine.onAccount(mint,15,account(0.3));
  // Remove the newer high; a peak at slot 11 is outside [12,16].
  s.engine.states.get(mint).history=s.engine.states.get(mint).history.filter(h=>h.slot!==14);
  s.engine.signal(s.signal('sig',16,0.2));assert.equal(s.engine.paper.pending().length,0);s.close();
});
test('recovered coverage restarts entry warm-up regardless of baseline ordering',()=>{
  for(const baselineFirst of [true,false]) {
    const s=setup();s.engine.gap('preprocessed_disconnected');
    s.engine.onSlot(20);
    if(baselineFirst) s.engine.onAccount(mint,16,account(1));
    s.engine.coverage(mint);
    if(!baselineFirst) s.engine.onAccount(mint,16,account(1));
    s.engine.onReady();
    assert.equal(s.engine.states.get(mint).since,20);
    s.engine.signal(s.signal('too-early',20));
    assert.equal(s.engine.paper.pending().length,0);
    s.engine.onAccount(mint,23,account(1));s.engine.onSlot(24);
    s.engine.signal(s.signal('warmed-up',24));
    assert.equal(s.engine.paper.pending().length,1);s.close();
  }
});
test('restored filter coverage blocks entry until its new five-slot window completes',async()=>{
  const s=setup();s.rpc.wsUrl='wss://example.test/?api-key=test';
  const feeds=new PaperFeeds(s.store,s.rpc,{
    onCoverage:key=>s.engine.coverage(key),setTimer:()=>1,clearTimer:()=>{},
  });
  s.engine.attach(feeds);
  const curve=s.engine.paper.watch(mint).curve_address;
  feeds.add(mint,curve,true);
  const conn=(curves,request)=>({curves,key:curves.join(','),request,acked:false,socket:{terminate(){}}});
  feeds.preprocessed.conn=conn([curve,'other-curve'],1);
  s.engine.onSlot(20);feeds.notifyCoverage();
  const removal=conn(['other-curve'],2);feeds.preprocessed.next=removal;
  s.engine.onSlot(22);
  feeds.preprocessedMessage(removal,Buffer.from(JSON.stringify({id:2,result:2})),false);
  s.engine.onAccount(mint,23,account(1));s.engine.onSlot(24);
  const restored=conn([curve,'other-curve'],3);feeds.preprocessed.next=restored;
  feeds.preprocessedMessage(restored,Buffer.from(JSON.stringify({id:3,result:3})),false);
  assert.equal(s.engine.states.get(mint).since,24);
  s.engine.signal(s.signal('restored-too-early',24));assert.equal(s.engine.paper.pending().length,0);
  s.engine.onAccount(mint,26,account(1));s.engine.onSlot(27);
  s.engine.signal(s.signal('still-warming',27));assert.equal(s.engine.paper.pending().length,0);
  s.engine.onSlot(28);s.engine.signal(s.signal('warmed-up',28));
  assert.equal(s.engine.paper.pending().length,1);
  await feeds.stop();s.close();
});
test('coverage acknowledged before the first slot waits for a fresh five-slot window',()=>{
  for(const baselineTiming of ['before-ack','after-ack','after-slot']) {
    const s=setup();s.engine.gap('preprocessed_disconnected');
    if(baselineTiming==='before-ack') s.engine.onAccount(mint,16,account(1));
    s.engine.coverage(mint);s.engine.onReady();
    if(baselineTiming==='after-ack') s.engine.onAccount(mint,16,account(1));
    assert.equal(s.engine.coverageSlots.get(mint),Infinity);
    if(baselineTiming!=='after-slot') assert.equal(s.engine.states.get(mint).since,Infinity);
    s.engine.signal(s.signal('before-slot',20));
    assert.equal(s.engine.paper.pending().length,0);
    s.engine.onSlot(20);
    if(baselineTiming==='after-slot') s.engine.onAccount(mint,16,account(1));
    assert.equal(s.engine.coverageSlots.get(mint),20);
    assert.equal(s.engine.states.get(mint).since,20);
    s.engine.signal(s.signal('first-slot',20));
    assert.equal(s.engine.paper.pending().length,0);
    s.engine.onAccount(mint,22,account(1));s.engine.onSlot(23);
    s.engine.signal(s.signal('still-warming',23));
    assert.equal(s.engine.paper.pending().length,0);
    s.engine.onSlot(24);s.engine.signal(s.signal('warmed-up',24));
    assert.equal(s.engine.paper.pending().length,1);s.close();
  }
});
test('failed first preprocessed connection restores quiet engine reserves before recovery',async()=>{
  const s=setup();let refreshes=0;
  s.rpc.wsUrl='wss://example.test/?api-key=test';
  s.rpc.accounts=async()=>{refreshes++;return {context:{slot:16},value:[account(1)]};};
  const feeds=new PaperFeeds(s.store,s.rpc,{
    onGap:reason=>s.engine.gap(reason),onAccount:(...args)=>s.engine.onAccount(...args),
    onCoverage:key=>s.engine.coverage(key),onReady:()=>s.engine.onReady(),
    setTimer:()=>1,clearTimer:()=>{},
  });
  s.engine.attach(feeds);
  feeds.add(mint,s.engine.paper.watch(mint).curve_address,true);
  feeds.standard.socket={terminate(){}};feeds.standard.acked=true;
  feeds.watches.get(mint).subscription=21;
  const conn={socket:{terminate(){}},curves:feeds.curves()};feeds.preprocessed.next=conn;
  feeds.connFailed(conn,'preprocessed_disconnected');
  assert.equal(s.engine.states.size,0);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(refreshes,1);assert.equal(s.engine.states.size,1);
  feeds.connFailed(null,'preprocessed_connect_failed');
  assert.equal(refreshes,1);
  s.engine.onSlot(20);
  feeds.preprocessed.conn={...conn};feeds.notifyCoverage();feeds.checkReady();
  assert.equal(s.engine.ready,true);assert.equal(s.engine.states.get(mint).since,20);
  s.engine.signal(s.signal('too-early',20));assert.equal(s.engine.paper.pending().length,0);
  await feeds.stop();s.close();
});
test('failed, unknown, expired and changed-slot triggers never fill',async()=>{
  for(const status of [null,{slot:15,err:{error:1},confirmationStatus:'confirmed'},
    {slot:16,err:null,confirmationStatus:'confirmed'},{slot:15,err:null,confirmationStatus:'processed'}]) {
    const s=setup();s.rpc.call=async()=>({value:[status]});s.engine.signal(s.signal());await s.engine.tick();
    assert.equal(s.engine.paper.position(mint),undefined);
    s.setNow(111000);await s.engine.tick();assert.equal(s.engine.paper.capacity().pendingBuys,0);s.close();
  }
});
test('entry rechecks actual later range, slippage and drop instead of filling predicted prices',async()=>{
  const s=setup();s.rpc.accounts=async()=>({context:{slot:15},value:[account(0.6)]});
  s.engine.signal(s.signal());await s.engine.tick();
  assert.equal(s.engine.paper.position(mint),undefined);
  assert.equal(s.store.get('SELECT error FROM paper_orders').error,'entry_condition_changed');s.close();
});
test('25-entry cap is atomic, persists after restart and pending reservations release',()=>{
  const dir=mkdtempSync(join(tmpdir(),'paper-cap-')),path=join(dir,'db.sqlite');let store;
  try {
    // Isolate cumulative trade accounting from the production concurrent-watch limit.
    store=new Store(path,cfg);let paper=new PaperStore(store,{...pc,maxWatches:26});
    const keys=Array.from({length:26},(_,i)=>new PublicKey(Buffer.alloc(32,i+1)).toBase58());
    for(const key of keys) {candidate(store,key);paper.enroll(key,1000);}
    for(const key of keys.slice(0,25)) assert.ok(paper.request(key,'buy','dump',{tokens:'1',cost:'100'},null,1000));
    assert.equal(paper.request(keys[25],'buy','dump',{},null,1000),null);
    const first=paper.pending()[0];paper.cancel(first.id,1001,'test');
    assert.ok(paper.request(keys[25],'buy','dump',{tokens:'1',cost:'100'},null,1001));
    for(const order of paper.pending()) paper.fill(order,{tokens:'1',cost:'100'},1002);
    assert.equal(paper.capacity().successfulBuys,25);store.close();
    store=new Store(path,cfg);paper=new PaperStore(store,pc);assert.equal(paper.capacity().remaining,0);
    const held=keys[1];assert.ok(paper.request(held,'sell','floor',{net:'90'},null,1003));
    paper.fill(paper.pending()[0],{net:'90'},1004);
    assert.equal(paper.capacity().successfulBuys,25);assert.equal(paper.position(held),undefined);
    assert.equal(paper.request(held,'buy','dump',{},null,1005),null);
  } finally {store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('floor stops empty watch and attempts exit even when entries disabled or exhausted',async()=>{
  const empty=setup();empty.engine.onAccount(mint,15,account(0.1));
  assert.equal(empty.engine.paper.watch(mint).status,'stopped');assert.ok(empty.removed.includes(mint));empty.close();
  const s=setup({maxTrades:1});s.engine.signal(s.signal());await s.engine.tick();
  s.engine.cfg.entriesEnabled=false;s.engine.onAccount(mint,16,account(0.1));
  s.rpc.accounts=async()=>({context:{slot:16},value:[account(0.1)]});await s.engine.tick();
  assert.equal(s.engine.paper.position(mint),undefined);
  assert.equal(s.store.get('SELECT reason FROM paper_orders WHERE side=\'sell\'').reason,'floor');s.close();
});
test('insufficient floor liquidity and graduation preserve position as blocked, never fake a fill',async()=>{
  const s=setup();s.engine.signal(s.signal());await s.engine.tick();
  s.engine.onAccount(mint,16,account(0.1,0));
  assert.equal(s.engine.paper.watch(mint).status,'exit_blocked');assert.ok(s.engine.paper.position(mint));
  s.engine.onAccount(mint,17,account(0.1,0,true));
  assert.equal(s.engine.paper.watch(mint).reason,'graduated_no_amm_exit');assert.ok(s.engine.paper.position(mint));s.close();
});
test('feed gaps cancel pending entry and require fresh five-slot history',()=>{
  const s=setup();s.engine.signal(s.signal());s.engine.gap('test');
  assert.equal(s.engine.paper.pending().length,0);assert.equal(s.engine.states.size,0);
  s.engine.onReady();s.engine.onAccount(mint,14,account(1));s.engine.signal(s.signal('new'));
  assert.equal(s.engine.paper.pending().length,0);s.close();
});
test('stale and same-slot already-applied projections cannot buy',()=>{
  const s=setup();s.engine.signal(s.signal('same',14));assert.equal(s.engine.paper.pending().length,0);
  s.setNow(106000);s.engine.signal(s.signal('stale'));assert.equal(s.engine.paper.pending().length,0);s.close();
});
test('profit exit uses predicted trigger then rechecks later net proceeds',async()=>{
  const s=setup();s.engine.signal(s.signal());await s.engine.tick();
  s.engine.onAccount(mint,15,account(0.2));s.engine.onSlot(16);
  s.rpc.call=async()=>({value:[{slot:16,err:null,confirmationStatus:'confirmed'}]});
  s.rpc.accounts=async()=>({context:{slot:16},value:[account(0.4)]});
  s.engine.signal(s.signal('profit',16,0.4));
  assert.equal(s.engine.paper.pending()[0].reason,'profit');await s.engine.tick();
  assert.equal(s.engine.paper.position(mint),undefined);
  assert.ok(BigInt(s.engine.paper.report().realizedPnlLamports)>0n);s.close();
});
test('rebound disappearing before reconciliation cancels profit exit without losing position',async()=>{
  const s=setup();s.engine.signal(s.signal());await s.engine.tick();
  s.engine.onAccount(mint,15,account(0.2));s.engine.onSlot(16);
  s.rpc.call=async()=>({value:[{slot:16,err:null,confirmationStatus:'confirmed'}]});
  s.rpc.accounts=async()=>({context:{slot:16},value:[account(0.2)]});
  s.engine.signal(s.signal('profit',16,0.4));await s.engine.tick();
  assert.ok(s.engine.paper.position(mint));assert.equal(s.store.get("SELECT error FROM paper_orders WHERE side='sell'").error,'profit_disappeared');s.close();
});
test('expired signal slots release pending capacity even before wall-clock timeout',async()=>{
  const s=setup();s.engine.signal(s.signal());s.engine.onSlot(20);await s.engine.tick();
  assert.equal(s.engine.paper.pending().length,0);assert.equal(s.engine.paper.capacity().remaining,25);s.close();
});
test('restart resumes only enrolled watches and cancels pending reservations',()=>{
  const s=setup();s.engine.signal(s.signal());s.engine.start();
  assert.equal(s.engine.paper.pending().length,0);assert.equal(s.added.length,2);
  assert.equal(s.engine.paper.watch(mint).status,'watching');s.close();
});
test('overflow invalidates entry state and does not grow queue without bound',()=>{
  const s=setup({queueLimit:1});s.engine.enqueue(Buffer.alloc(1));s.engine.enqueue(Buffer.alloc(1));
  assert.equal(s.engine.queue.length,0);assert.equal(s.engine.ready,false);s.close();
});

test('invalid account resynchronization clears all history and cancels pending orders',()=>{
  const s=setup();s.engine.signal(s.signal());s.engine.onAccount(mint,15,null);
  assert.equal(s.engine.ready,false);assert.equal(s.engine.states.size,0);
  assert.equal(s.engine.paper.pending().length,0);s.close();
});
test('terminal watch removes cached reserve history',()=>{
  const s=setup();s.engine.onAccount(mint,15,account(0.1));
  assert.equal(s.engine.states.has(mint),false);s.close();
});
test('creation enrollment does not require candidate screening and survives restart handoff',()=>{
  const store=new Store(':memory:',cfg);
  const engine=new PaperEngine(store,{},pc);
  const added=[];
  engine.attach({add:(...args)=>added.push(args),start:()=>{}});
  store.apply('creation',1,[{type:'create',mint,timestamp:100}]);
  assert.equal(store.get('SELECT COUNT(*) n FROM candidates').n,0);
  engine.start();
  assert.equal(engine.paper.watch(mint).status,'watching');
  assert.equal(added.length,1);assert.equal(added[0][2],false);
  store.onDiscovery=()=>engine.discover();
  store.apply('creation',1,[{type:'create',mint,timestamp:100}]);
  assert.equal(added.length,1);
  const second=new PublicKey(Buffer.alloc(32,4)).toBase58();
  store.apply('creation2',2,[{type:'create',mint:second,timestamp:101}]);
  assert.equal(added.length,2);assert.equal(engine.paper.watch(second).status,'watching');
  store.close();
  const monitor=new Store(':memory:',{...cfg,paperMode:false});
  monitor.apply('creation',1,[{type:'create',mint,timestamp:100}]);
  assert.equal(monitor.get('SELECT COUNT(*) n FROM paper_discoveries').n,0);monitor.close();
});
test('strict 2 SOL activation, 10 second idle boundary, unchanged notifications and resume',async()=>{
  const s=setup();
  s.engine.membership(mint,false);
  s.engine.onAccount(mint,15,account(2));assert.equal(s.engine.paper.watch(mint).preprocessed,0);
  s.engine.onAccount(mint,16,account(1.99));assert.equal(s.engine.paper.watch(mint).preprocessed,1);
  s.setNow(109999);await s.engine.tick();assert.equal(s.engine.paper.watch(mint).preprocessed,1);
  s.engine.onAccount(mint,17,account(1.99)); // identical bytes do not reset idle
  s.setNow(110000);await s.engine.tick();assert.equal(s.engine.paper.watch(mint).preprocessed,0);
  assert.equal(s.removed.length,0);assert.ok(s.engine.states.has(mint));
  s.engine.gap('test');s.engine.onReady();s.engine.onAccount(mint,18,account(1.99));
  assert.equal(s.engine.paper.watch(mint).preprocessed,0); // unchanged reconnect baseline
  s.engine.onAccount(mint,19,account(1.98));assert.equal(s.engine.paper.watch(mint).preprocessed,1);
  s.engine.coverage(mint);assert.equal(s.engine.states.get(mint).since,Infinity);
  s.engine.onSlot(19);assert.equal(s.engine.states.get(mint).since,19);
  s.close();
});
test('idle cancels pending entry; unacknowledged membership cannot signal',async()=>{
  const s=setup();s.engine.signal(s.signal());assert.equal(s.engine.paper.pending().length,1);
  s.setNow(110000);await s.engine.tick();
  assert.equal(s.store.get('SELECT error FROM paper_orders').error,'preprocessed_idle');
  s.close();
  const a=setup();a.engine.feeds.covers=()=>false;a.engine.signal(a.signal());
  assert.equal(a.engine.paper.pending().length,0);a.close();
});
test('held positions keep preprocessed coverage through inactivity and restart',async()=>{
  const s=setup();s.engine.signal(s.signal());await s.engine.tick();
  s.setNow(200000);await s.engine.tick();assert.equal(s.engine.paper.watch(mint).preprocessed,1);
  s.engine.start();assert.equal(s.added.at(-1)[2],true);s.close();
});
test('legacy candidate-parent migration preserves populated paper records and child references',()=>{
  const s=setup();s.engine.signal(s.signal());
  const order=s.engine.paper.pending()[0];s.engine.paper.fill(order,{tokens:'100',cost:'1000'},100001);
  const orders=s.store.all('SELECT * FROM paper_orders'),positions=s.store.all('SELECT * FROM paper_positions');
  s.store.db.exec(`PRAGMA foreign_keys=OFF;
    CREATE TABLE old_watches (mint TEXT PRIMARY KEY REFERENCES candidates(mint),curve_address TEXT NOT NULL,
      enrolled_at_ms INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'watching',reason TEXT,last_slot INTEGER,last_cap REAL);
    INSERT INTO old_watches SELECT mint,curve_address,enrolled_at_ms,status,reason,last_slot,last_cap FROM paper_watches;
    DROP TABLE paper_watches; ALTER TABLE old_watches RENAME TO paper_watches; PRAGMA foreign_keys=ON;`);
  const paper=new PaperStore(s.store,pc);
  assert.deepEqual(s.store.all('SELECT * FROM paper_orders'),orders);
  assert.deepEqual(s.store.all('SELECT * FROM paper_positions'),positions);
  assert.deepEqual(s.store.all('PRAGMA foreign_key_check'),[]);
  assert.equal(s.store.get('PRAGMA integrity_check').integrity_check,'ok');
  const second=new PublicKey(Buffer.alloc(32,5)).toBase58();s.store.addMint({mint:second,timestamp:100});
  assert.equal(paper.enroll(second,100002),true);s.close();
});
test('stop while reconciliation awaits RPC ignores response and makes no paper fill',async()=>{
  const s=setup();let resolve;s.rpc.call=()=>new Promise(r=>{resolve=r;});s.engine.signal(s.signal());
  const ticking=s.engine.tick();await s.engine.stop();resolve({value:[{slot:15,err:null,confirmationStatus:'confirmed'}]});
  await ticking;assert.equal(s.engine.paper.position(mint),undefined);s.close();
});
