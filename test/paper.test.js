import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { PaperStore, paperConfig } from '../src/paper-store.js';
import { PaperEngine } from '../src/paper-engine.js';
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
  engine.attach({add:(...args)=>added.push(args),remove:key=>removed.push(key),start:()=>{},stop:async()=>{},resync:()=>{}});
  engine.add(mint);engine.onReady();engine.onSlot(15);
  engine.onAccount(mint,11,account(1));engine.onAccount(mint,14,account(1));
  return {store,rpc,engine,removed,added,setNow:n=>{now=n;},close:()=>store.close(),
    signal:(signature='sig',slot=15,mc=0.2)=>({signature,slot,mint,state:reserves(account(mc))})};
}
test('paper defaults are fixed strategy with validated configurable cap and cost assumptions',()=>{
  assert.equal(pc.maxTrades,25);assert.equal(pc.buyLamports,'10000000');assert.equal(pc.windowSlots,5);
  assert.equal(pc.dropBps,6000);assert.equal(pc.mode,'paper');
  for(const value of ['0','-1','NaN','2.5']) assert.throws(()=>paperConfig({MAX_TRADE_COUNT:value}));
  assert.equal(paperConfig({PAPER_ENTRIES_ENABLED:'false'}).entriesEnabled,false);
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
    store=new Store(path,cfg);let paper=new PaperStore(store,pc);
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
test('stop while reconciliation awaits RPC ignores response and makes no paper fill',async()=>{
  const s=setup();let resolve;s.rpc.call=()=>new Promise(r=>{resolve=r;});s.engine.signal(s.signal());
  const ticking=s.engine.tick();await s.engine.stop();resolve({value:[{slot:15,err:null,confirmationStatus:'confirmed'}]});
  await ticking;assert.equal(s.engine.paper.position(mint),undefined);s.close();
});
