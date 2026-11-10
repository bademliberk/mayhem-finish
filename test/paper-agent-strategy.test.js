import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'node:events';
import { PaperFeeds } from '../src/paper-feeds.js';
import { PUMP, MAYHEM } from '../src/config.js';
import { Store } from '../src/store.js';
import { PaperEngine } from '../src/paper-engine.js';
import { PaperStore, paperConfig } from '../src/paper-store.js';
import { reserves, liquidityBudget, entryQuote, entryQuality, terminalExitQuote, writeOffQuote, fullSaleGross } from '../src/paper-math.js';
import { trialIdentity, bindTrial, preflightTrial } from '../src/paper-profiles.js';

const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58();
const mint = key(1), mint2 = key(2), actor = key(3);
const config = paperConfig({}, 'agent-sell-liquidity');
const storeConfig = { firstCheck: 30, recheck: 30, horizon: 86400, paperMode: true };
// Synthetic account/event prefixes; no provider access or historical-fill claims.
function account(real = 40000000n, virtual = 140000000n, complete = false, realTokens = 800000000000n) {
  const b = Buffer.alloc(166); Buffer.from([23,183,248,55,96,216,172,96]).copy(b);
  b.writeBigUInt64LE(1000000000000n, 8); b.writeBigUInt64LE(virtual, 16);
  b.writeBigUInt64LE(realTokens, 24); b.writeBigUInt64LE(real, 32);
  b.writeBigUInt64LE(1000000000000n, 40); b[48] = Number(complete); b[81] = 1;
  return { owner: PUMP, data: [b.toString('base64'), 'base64'] };
}
function event(m = mint, state = reserves(account()), length = 129) {
  const b = Buffer.alloc(129); Buffer.from([189,219,127,211,78,230,97,238]).copy(b);
  new PublicKey(m).toBuffer().copy(b, 8); b.writeBigUInt64LE(10000000n, 40); b.writeBigUInt64LE(10000000000n, 48);
  new PublicKey(actor).toBuffer().copy(b, 57); b.writeBigInt64LE(1700000000n, 89);
  for (const [name, offset] of [['virtualSol',97], ['virtualTokens',105], ['realSol',113], ['realTokens',121]]) b.writeBigUInt64LE(state[name], offset);
  return `Program data: ${b.subarray(0, length).toString('base64')}`;
}
function tx(signature = 'sell-a', slot = 20, events = [event()]) {
  return { signature, slot, transaction: { signatures: [signature] }, meta: { err: null, logMessages: [
    `Program ${MAYHEM} invoke [1]`, `Program ${PUMP} invoke [2]`, ...events,
    `Program ${PUMP} success`, `Program ${MAYHEM} success`,
  ] } };
}
function setup(options = {}, path = ':memory:') {
  const store = new Store(path, storeConfig); store.addMint({ mint, timestamp: 100 }); store.addMint({ mint: mint2, timestamp: 100 });
  let now = 100000, snapshot = account(), snapshotSlot = 20, statusSlot = 20, covered = true;
  const rpc = { accounts: async () => ({ context: { slot: snapshotSlot }, value: [snapshot] }),
    call: async () => ({ value: [{ slot: statusSlot, err: null, confirmationStatus: 'confirmed' }] }) };
  const engine = new PaperEngine(store, rpc, { ...config, ...options }, { now: () => now, project: raw => raw });
  engine.attach({ add() {}, remove() {}, setPreprocessed() {}, covers: () => covered, start() {}, stop() {}, resync() {} });
  engine.add(mint); engine.add(mint2); engine.onReady(); engine.onSlot(20);
  engine.onAccount(mint, 20, account()); engine.onAccount(mint2, 20, account()); engine.coverage(mint); engine.coverage(mint2);
  return { store, rpc, engine, now: value => { now = value; }, covered: value => { covered = value; },
    snapshot: (value, slot = 20) => { snapshot = value; snapshotSlot = slot; }, status: slot => { statusSlot = slot; }, close: () => store.close() };
}
const pending = s => s.engine.paper.pending()[0];
const position = s => s.engine.paper.position(mint);
const watch = s => s.engine.paper.watch(mint);
const outcome = s => s.store.get('SELECT outcome FROM paper_agent_events ORDER BY id DESC LIMIT 1')?.outcome;
const canceled = (s, id) => s.store.get('SELECT error FROM paper_orders WHERE id=?', id).error;
async function buy(s) { s.engine.agentTransaction(tx()); const order = pending(s); assert.ok(order); await s.engine.reconcile(order); assert.ok(position(s)); return order; }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const snapshotOf = (value = account(), slot = 20) => ({ context: { slot }, value: [value] });

test('new profile validates independent assumptions without changing legacy identities', () => {
  assert.equal(config.strategy, 'agent-sell-liquidity'); assert.equal(config.swapFeeBps, 125); assert.equal(config.maxWatches, 20);
  assert.equal(config.maxExposureLamports, '50000000'); assert.equal(config.holdSlots, 80);
  assert.equal(paperConfig({ PAPER_SWAP_FEE_BPS: '150' }, 'agent-sell-liquidity').swapFeeBps, 150);
  assert.equal(paperConfig({}).swapFeeBps, 200); assert.equal(paperConfig({}).strategy, undefined);
  for (const env of [{ PAPER_AGENT_FRACTION_BPS: '10001' }, { PAPER_AGENT_HOLD_SLOTS: '0' },
    { PAPER_AGENT_MAX_SWAP_LAMPORTS: '1.5' }, { PAPER_AGENT_MIN_REAL_SOL_LAMPORTS: '-1' }, { PAPER_AGENT_MAX_EXPOSURE_LAMPORTS: 'Infinity' }]) {
    assert.throws(() => paperConfig(env, 'agent-sell-liquidity'));
  }
  assert.notEqual(trialIdentity(config), trialIdentity(paperConfig({ PAPER_AGENT_HOLD_SLOTS: '81' }, 'agent-sell-liquidity')));
});

test('agent watch capacity accepts up to 1000 without changing legacy identities or default trial identity', () => {
  const larger = paperConfig({ PAPER_AGENT_MAX_WATCHES: '1000' }, 'agent-sell-liquidity');
  assert.equal(larger.maxWatches, 1000);
  assert.equal(paperConfig({ PAPER_AGENT_MAX_WATCHES: '1' }, 'agent-sell-liquidity').maxWatches, 1);
  assert.equal(trialIdentity(paperConfig({ PAPER_AGENT_MAX_WATCHES: '20' }, 'agent-sell-liquidity')), trialIdentity(config));
  assert.notEqual(trialIdentity(larger), trialIdentity(config));
  for (const value of ['0', '1001', '1.5', 'Infinity', 'invalid']) {
    assert.throws(() => paperConfig({ PAPER_AGENT_MAX_WATCHES: value }, 'agent-sell-liquidity'), /PAPER_AGENT_MAX_WATCHES/);
  }
  for (const profile of [null, 'baseline', 'coverage20', 'liquidity20', 'drop50', 'window8', 'liquidity-exit100']) {
    assert.equal(trialIdentity(paperConfig({ PAPER_AGENT_MAX_WATCHES: '1000' }, profile)), trialIdentity(paperConfig({}, profile)));
  }
});

test('agent admission and restart retain 1000 watches and reject the next nonreplaceable mint offline', async () => {
  const store = new Store(':memory:', storeConfig);
  const cfg = paperConfig({ PAPER_AGENT_MAX_WATCHES: '1000' }, 'agent-sell-liquidity');
  const engine = new PaperEngine(store, {}, cfg, { now: () => 100000 });
  const subscribed = new Set();
  engine.attach({ add: mint => subscribed.add(mint), remove: mint => subscribed.delete(mint), start() {}, stop() {} });
  try {
    for (let i = 1; i <= 1001; i++) {
      const bytes = Buffer.alloc(32); bytes.writeUInt32LE(i);
      const candidate = new PublicKey(bytes).toBase58();
      store.addMint({ mint: candidate, timestamp: 100 }); engine.add(candidate);
    }
    assert.equal(engine.paper.active().length, 1000); assert.equal(subscribed.size, 1000);
    assert.equal(store.get("SELECT count FROM paper_counters WHERE name='enrollment_watch_cap'").count, 1);
    subscribed.clear(); engine.start();
    assert.equal(engine.paper.active().length, 1000); assert.equal(subscribed.size, 1000);
  } finally { await engine.stop(); store.close(); }
});

test('integer fraction truncates, applies cap, and explicit budgets retain exact fee-inclusive semantics', () => {
  const state = reserves(account());
  assert.equal(liquidityBudget(40246230n, config), 4829547n);
  assert.equal(liquidityBudget(10n ** 20n, config), 10000000n);
  const budget = liquidityBudget(state.realSol, config), quote = entryQuote(state, config, budget);
  assert.ok(BigInt(quote.swapCost) <= budget); assert.equal(BigInt(quote.cost), BigInt(quote.swapCost) + 10000n);
  assert.equal(entryQuality(state, config, budget).minimumRealSolLamports, (budget * 2n).toString());
  assert.deepEqual(entryQuote(state, config), entryQuote(state, config, BigInt(config.buyLamports)));
});

test('confirmed sell uses event liquidity, not latest account reserves; no drop or MC gate', async () => {
  const s = setup();
  try {
    s.engine.onAccount(mint, 20, account(44000000n)); s.snapshot(account(44000000n));
    s.engine.agentTransaction(tx()); const order = pending(s), quote = JSON.parse(order.quote_json);
    assert.equal(quote.requestedBudgetLamports, '4800000'); assert.equal(order.signal_signature, 'sell-a');
    assert.equal(quote.referenceReserves.realSol, '40000000'); assert.equal(watch(s).preprocessed, 0);
    await s.engine.reconcile(order);
    const filled = JSON.parse(s.store.get('SELECT fill_json FROM paper_orders WHERE id=?', order.id).fill_json);
    assert.equal(filled.requestedBudgetLamports, '4800000'); assert.equal(filled.confirmedReserves.realSol, '44000000');
    assert.equal(position(s).entry_snapshot_slot, 20); assert.equal(position(s).timeout_slot, 100);
    assert.equal(s.engine.paper.exposure().reserved, 0n);
  } finally { s.close(); }
});

test('new strategy admits below legacy MC floor and above ceiling, but never unsupported accounts', () => {
  for (const virtual of [90000000n, 700000000n]) {
    const s = setup();
    try { s.engine.onAccount(mint, 20, account(40000000n, virtual));
      s.engine.agentTransaction(tx('a', 20, [event(mint, reserves(account(40000000n, virtual)))]));
      assert.ok(pending(s)); assert.equal(watch(s).status, 'watching');
    } finally { s.close(); }
  }
  const s = setup(); try {
    s.engine.onAccount(mint, 20, { owner: key(9), data: account().data }); s.engine.agentTransaction(tx());
    assert.equal(pending(s), undefined);
  } finally { s.close(); }
});

test('liquidity shrink cancels frozen budget rather than resizing; increase never enlarges it', async () => {
  for (const real of [39999999n, 9000000n, 50000000n]) {
    const s = setup(); try {
      s.engine.agentTransaction(tx()); const order = pending(s); s.snapshot(account(real));
      await s.engine.reconcile(order);
      if (real < 40000000n) { assert.equal(canceled(s, order.id), 'liquidity_budget_changed'); assert.equal(position(s), undefined); }
      else { assert.ok(position(s)); assert.equal(JSON.parse(s.store.get('SELECT fill_json FROM paper_orders').fill_json).requestedBudgetLamports, '4800000'); }
    } finally { s.close(); }
  }
});

test('quality and token slippage rechecked on confirmed snapshot', async () => {
  const s = setup(); try {
    s.engine.agentTransaction(tx()); const order = pending(s); s.snapshot(account(40000000n, 200000000n));
    await s.engine.reconcile(order); assert.equal(canceled(s, order.id), 'buy_slippage');
  } finally { s.close(); }
  const q = setup({ maxRoundTripLossBps: 0 }); try { q.engine.agentTransaction(tx()); assert.equal(outcome(q), 'entry_round_trip_loss'); assert.equal(pending(q), undefined); } finally { q.close(); }
});

test('freshness requires coverage, live heartbeat, current account and original signal window', () => {
  for (const alter of [s => s.covered(false), s => s.now(106000), s => s.engine.coverageSlots.delete(mint),
    s => s.engine.onSlot(25), s => { s.engine.coverageSlots.set(mint, 21); }, s => s.engine.gap('test')]) {
    const s = setup(); try { alter(s); s.engine.agentTransaction(tx()); assert.equal(pending(s), undefined); } finally { s.close(); }
  }
  const s = setup(); try { s.engine.onSlot(23); s.engine.agentTransaction(tx()); assert.ok(pending(s)); } finally { s.close(); }
});

test('minimum liquidity is inclusive and processed projection input cannot create agent entry', () => {
  for (const real of [9999999n, 10000000n]) {
    const s = setup(); try {
      s.engine.agentTransaction(tx('a', 20, [event(mint, reserves(account(real)))]));
      assert.equal(Boolean(pending(s)), real === 10000000n);
    } finally { s.close(); }
  }
  const s = setup(); try { s.engine.signal({ signature: 'user', slot: 20, mint, state: reserves(account()) });
    s.engine.enqueue({}); assert.equal(s.engine.queue.length, 0); assert.equal(pending(s), undefined);
  } finally { s.close(); }
});

test('last sell per mint is selected, multi-mint signature stays real, missing last reserves never falls back', () => {
  const s = setup(); try {
    s.engine.agentTransaction(tx('multi', 20, [event(), event(mint2), event(mint, reserves(account(30000000n)))]));
    assert.equal(s.engine.paper.pending().length, 2);
    const order = s.engine.paper.pending().find(o => o.mint === mint);
    assert.equal(order.signal_signature, 'multi'); assert.equal(JSON.parse(order.quote_json).requestedBudgetLamports, '3600000');
    assert.equal(JSON.parse(order.quote_json).eventIndex, 4);
  } finally { s.close(); }
  const q = setup(); try { q.engine.agentTransaction(tx('short', 20, [event(), event(mint, reserves(account()), 97)]));
    assert.equal(pending(q), undefined); assert.equal(outcome(q), 'missing_sell_reserves');
  } finally { q.close(); }
});

test('duplicates, older arrivals and pruned samples never create another entry', () => {
  const s = setup(); try {
    s.engine.agentTransaction(tx()); const first = pending(s);
    s.store.run('DELETE FROM paper_agent_events'); s.engine.agentTransaction(tx());
    assert.equal(pending(s).id, first.id); s.engine.agentTransaction(tx('older', 19)); assert.equal(pending(s).id, first.id);
    s.engine.cancel(first.id, 100000, 'test'); s.engine.agentTransaction(tx()); assert.equal(pending(s), undefined);
  } finally { s.close(); }
});

test('new sell supersedes immediately; different transactions in same slot invalidate pending entry', () => {
  const s = setup(); try {
    s.engine.agentTransaction(tx()); const first = pending(s); s.engine.onSlot(21); s.engine.agentTransaction(tx('new', 21));
    assert.equal(canceled(s, first.id), 'sell_superseded'); const second = pending(s);
    s.engine.agentTransaction(tx('other', 21)); assert.equal(canceled(s, second.id), 'ambiguous_sell_slot'); assert.equal(pending(s), undefined);
    s.engine.agentTransaction(tx('new', 21)); assert.equal(pending(s), undefined);
    s.engine.onSlot(22); s.engine.agentTransaction(tx('later', 22)); assert.ok(pending(s));
  } finally { s.close(); }
});

test('superseded RPC continuation cannot fill or damage newer pending order', async () => {
  const s = setup(); try {
    const wait = deferred(); s.rpc.accounts = () => wait.promise; s.engine.agentTransaction(tx()); const first = pending(s);
    const work = s.engine.reconcile(first); await Promise.resolve();
    s.engine.onSlot(21); s.engine.agentTransaction(tx('new', 21)); const newer = pending(s);
    wait.resolve(snapshotOf()); await work;
    assert.equal(position(s), undefined); assert.equal(pending(s).id, newer.id); assert.equal(canceled(s, first.id), 'sell_superseded');
  } finally { s.close(); }
});

test('same-slot account changes during snapshot wait invalidate that snapshot, then a fresh retry can fill', async () => {
  const s = setup(); try {
    const wait = deferred(); s.rpc.accounts = () => wait.promise; s.engine.agentTransaction(tx()); const order = pending(s);
    const work = s.engine.reconcile(order); await Promise.resolve(); s.engine.onAccount(mint, 20, account(41000000n));
    wait.resolve(snapshotOf()); await work; assert.equal(position(s), undefined); assert.ok(pending(s));
    s.rpc.accounts = async () => snapshotOf(account(41000000n)); await s.engine.reconcile(order); assert.ok(position(s));
  } finally { s.close(); }
});

test('trigger slot, confirmation, snapshot freshness and TTL remain enforced', async () => {
  for (const kind of ['slot', 'behind', 'failed', 'ttl', 'slot-expiry']) {
    const s = setup(); try {
      s.engine.agentTransaction(tx()); const order = pending(s);
      if (kind === 'slot') s.status(21);
      if (kind === 'behind') s.snapshot(account(), 19);
      if (kind === 'failed') s.rpc.call = async () => ({ value: [{ slot: 20, err: 'fail', confirmationStatus: 'confirmed' }] });
      if (kind === 'ttl') s.now(110000);
      if (kind === 'slot-expiry') s.engine.onSlot(25);
      await s.engine.reconcile(order); assert.equal(position(s), undefined);
      if (kind === 'behind') assert.ok(pending(s)); else assert.equal(pending(s), undefined);
    } finally { s.close(); }
  }
});

test('stop and gap cancel pending buys even during an outstanding RPC', async () => {
  for (const kind of ['gap', 'stop']) {
    const s = setup(); try {
      const wait = deferred(); s.rpc.accounts = () => wait.promise; s.engine.agentTransaction(tx()); const order = pending(s);
      const work = s.engine.reconcile(order); await Promise.resolve();
      const stop = kind === 'stop' ? s.engine.stop() : (s.engine.gap('test'), Promise.resolve());
      wait.resolve(snapshotOf()); await work; await stop; assert.equal(position(s), undefined); assert.equal(pending(s), undefined);
    } finally { s.close(); }
  }
});

test('exposure reserves network fees atomically; cancellation releases, pending sells do not', async () => {
  const s = setup({ maxExposureLamports: '9619999' }); try {
    s.engine.agentTransaction(tx('multi', 20, [event(), event(mint2)]));
    assert.equal(s.engine.paper.pending().length, 1); assert.equal(s.engine.paper.exposure().reserved, 4810000n);
    const order = pending(s); await s.engine.reconcile(order); assert.ok(position(s));
    const actual = BigInt(position(s).entry_cost_lamports); assert.equal(s.engine.paper.exposure().open, actual);
    s.engine.paper.request(mint, 'sell', 'profit', { net: '100' }, null, 100000);
    assert.equal(s.engine.paper.exposure().total, actual);
    s.engine.cancel(pending(s).id, 100000, 'test'); assert.equal(s.engine.paper.exposure().total, actual);
  } finally { s.close(); }
  const q = setup({ maxExposureLamports: '4809999' }); try { q.engine.agentTransaction(tx()); assert.equal(pending(q), undefined); assert.equal(outcome(q), 'exposure_cap'); } finally { q.close(); }
  const r = setup(); try { r.engine.agentTransaction(tx()); r.engine.cancel(pending(r).id, 100000, 'test'); assert.equal(r.engine.paper.exposure().total, 0n); } finally { r.close(); }
});

test('store rechecks exposure atomically at fill', () => {
  const s = setup({ maxExposureLamports: '4810000' }); try {
    s.engine.agentTransaction(tx()); const order = pending(s);
    s.engine.paper.fill(order, { tokens: '1', cost: '4810001', slot: 20 }, 100000);
    assert.equal(canceled(s, order.id), 'exposure_cap'); assert.equal(position(s), undefined);
  } finally { s.close(); }
});

test('profit exits are driven by accounts without preprocessed trades', async () => {
  const s = setup(); try {
    await buy(s); const richer = account(100000000n, 240000000n);
    s.engine.onAccount(mint, 21, richer); s.snapshot(richer, 21);
    const sell = pending(s); assert.equal(sell.reason, 'profit'); assert.equal(sell.signal_signature, null);
    await s.engine.reconcile(sell); assert.equal(position(s), undefined);
  } finally { s.close(); }
});

test('v2 compatibility: timeout stays mandatory without fabricating an illiquid sale', async () => {
  const s = setup({ version: 'agent_sell_liquidity_v2_event_only', holdSlots: 3 }); try {
    await buy(s); s.engine.onSlot(22); assert.equal(pending(s), undefined);
    s.engine.onSlot(23); assert.equal(watch(s).reason, 'timeout'); assert.equal(pending(s).reason, 'timeout');
    s.engine.onAccount(mint, 23, account(0n)); s.snapshot(account(0n), 23);
    await s.engine.reconcile(pending(s)); assert.ok(position(s)); assert.equal(watch(s).reason, 'timeout');
    // Cancel/expiry does not lose intent; fresh funded state permits a later full exit.
    assert.equal(pending(s), undefined); s.engine.onAccount(mint, 24, account()); s.snapshot(account(), 24);
    assert.equal(pending(s).reason, 'timeout'); await s.engine.reconcile(pending(s)); assert.equal(position(s), undefined);
  } finally { s.close(); }
});

test('v2 compatibility: stale accounts latch timeout and wait for a fresh quote', async () => {
  const s = setup({ version: 'agent_sell_liquidity_v2_event_only', holdSlots: 3 }); try {
    await buy(s); s.now(106000); s.engine.onSlot(23);
    assert.equal(watch(s).reason, 'timeout'); assert.equal(pending(s), undefined);
    s.engine.onAccount(mint, 23, account()); assert.equal(pending(s).reason, 'timeout');
  } finally { s.close(); }
});

test('v2 compatibility: graduated and drained holdings remain unresolved', async () => {
  const s = setup({ version: 'agent_sell_liquidity_v2_event_only', holdSlots: 3 }); try {
    await buy(s); s.engine.onAccount(mint, 21, account(0n)); assert.equal(watch(s).reason, 'liquidity_risk'); assert.equal(pending(s), undefined);
    s.engine.onSlot(23); assert.equal(watch(s).reason, 'timeout'); assert.equal(pending(s), undefined);
    s.engine.onAccount(mint, 24, account(0n, 140000000n, true)); assert.equal(watch(s).reason, 'graduated_no_amm_exit'); assert.ok(position(s));
    s.engine.onSlot(25); assert.equal(watch(s).reason, 'graduated_no_amm_exit');
  } finally { s.close(); }
});

test('restart preserves cursor, cancels unknown orders and restores expired timeout holdings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-paper-')), path = join(dir, 'trial.sqlite');
  let s;
  try {
    const empty = new Store(path, storeConfig);
    new PaperStore(empty, { ...config, holdSlots: 3 }); bindTrial(empty, { ...config, holdSlots: 3 }); empty.close();
    s = setup({ holdSlots: 3 }, path); await buy(s);
    s.engine.agentTransaction(tx('other-mint', 20, [event(mint2)])); assert.ok(pending(s));
    s.close(); s = null; preflightTrial(path, { ...config, holdSlots: 3 });
    s = setup({ holdSlots: 3 }, path); s.engine.start(); assert.equal(pending(s), undefined); assert.ok(position(s));
    s.engine.agentTransaction(tx('other-mint', 20, [event(mint2)])); assert.equal(pending(s), undefined);
    s.engine.onSlot(23); assert.equal(watch(s).reason, 'timeout'); assert.equal(position(s).timeout_slot, 23);
  } finally { s?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('mocked confirmed websocket flows through discovery, coverage, decoder, engine and persisted fill', async () => {
  class Socket extends EventEmitter {
    constructor(kind) { super(); this.kind = kind; this.readyState = 0; this.sent = []; }
    open() { this.readyState = 1; this.emit('open'); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    message(value) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
    terminate() { this.readyState = 3; }
    ping() { this.emit('pong'); }
  }
  const store = new Store(':memory:', storeConfig), sockets = [], timers = new Map(); let sequence = 0;
  const rpc = { wsUrl: 'wss://offline.invalid', accounts: async () => snapshotOf(),
    call: async () => ({ value: [{ slot: 20, err: null, confirmationStatus: 'confirmed' }] }) };
  store.addMint({ mint, timestamp: 100 });
  const engine = new PaperEngine(store, rpc, config, { now: () => 100000 });
  const feeds = new PaperFeeds(store, rpc, { agentMode: true, now: () => 100000,
    socketFactory: (_url, kind) => { const socket = new Socket(kind); sockets.push(socket); return socket; },
    setTimer: fn => { timers.set(++sequence, fn); return sequence; }, clearTimer: id => timers.delete(id),
    onAccount: (...args) => engine.onAccount(...args), onAgentTransaction: raw => engine.agentTransaction(raw),
    onSlot: slot => engine.onSlot(slot), onCoverage: m => engine.coverage(m),
    onReady: () => engine.onReady(), onGap: reason => engine.gap(reason),
  });
  engine.attach(feeds);
  try {
    engine.start(); const standard = sockets.find(s => s.kind === 'standard'), agent = sockets.find(s => s.kind === 'agent');
    standard.open(); agent.open();
    for (const request of standard.sent.filter(r => r.method.endsWith('Subscribe'))) {
      standard.message({ id: request.id, result: request.method === 'slotSubscribe' ? 9 : 10 });
    }
    standard.message({ method: 'slotNotification', params: { subscription: 9, result: { slot: 20 } } });
    agent.message({ id: agent.sent[0].id, result: 11 });
    await new Promise(resolve => setImmediate(resolve));
    const raw = tx(); raw.transaction.message = { accountKeys: [] };
    agent.message({ method: 'transactionNotification', params: { subscription: 11, result: {
      signature: raw.signature, slot: raw.slot, transaction: { transaction: raw.transaction, meta: raw.meta },
    } } });
    assert.equal(engine.paper.pending()[0].reason, 'agent_sell'); await engine.tick();
    assert.ok(engine.paper.position(mint)); assert.deepEqual(sockets.map(s => s.kind), ['standard', 'agent']);
  } finally { await engine.stop(); assert.equal(timers.size, 0); store.close(); }
});

test('confirmed entry retains its newer account watermark before evaluating holding risk', async () => {
  const s = setup(); try {
    s.engine.onAccount(mint, 20, account(6000000n)); s.engine.onSlot(21); s.status(21); s.snapshot(account(), 21);
    s.engine.agentTransaction(tx('later', 21)); await s.engine.reconcile(pending(s)); assert.ok(position(s));
    assert.equal(s.engine.states.get(mint).slot, 21); assert.equal(watch(s).last_slot, 21);
    assert.equal(s.engine.states.get(mint).state.realSol, 40000000n);
    s.engine.onSlot(22); assert.equal(watch(s).reason, null); assert.equal(pending(s), undefined);
    s.engine.onAccount(mint, 20, account(0n)); assert.equal(s.engine.states.get(mint).slot, 21); assert.equal(watch(s).reason, null);
  } finally { s.close(); }
});

test('v2 compatibility: quiet timeout holdings wait for accounts without RPC polling', async () => {
  const s = setup({ version: 'agent_sell_liquidity_v2_event_only' }); try {
    await buy(s); let calls = 0, slot = 20;
    s.rpc.accounts = async () => { calls++; return snapshotOf(account(), slot); };
    for (slot = 21; slot <= 120; slot++) {
      s.now(100000 + (slot - 20) * 400); s.engine.onSlot(slot); await s.engine.tick();
    }
    assert.equal(calls, 0); assert.ok(position(s)); assert.equal(watch(s).reason, 'timeout');
    assert.equal(pending(s), undefined);
    s.engine.onAccount(mint, slot, account()); await s.engine.tick();
    assert.equal(calls, 1); assert.equal(position(s), undefined);
    assert.equal(s.engine.exitAttempts.has(mint), false);
  } finally { s.close(); }
});

test('v2 compatibility: missing and illiquid holdings remain unresolved without account reads', async () => {
  for (const missing of [true, false]) {
    const s = setup({ version: 'agent_sell_liquidity_v2_event_only', holdSlots: 3 }); try {
      await buy(s);
      if (missing) s.engine.states.delete(mint);
      else s.engine.onAccount(mint, 20, account(0n));
      let calls = 0; s.rpc.accounts = async () => { calls++; throw new Error('No fallback reads allowed'); };
      for (let i = 0; i < 100; i++) {
        s.now(106000 + i * 60000); s.engine.onSlot(23 + i); await s.engine.tick();
      }
      assert.equal(calls, 0); assert.ok(position(s)); assert.equal(watch(s).reason, 'timeout');
      assert.equal(pending(s), undefined);
    } finally { s.close(); }
  }
});

test('v2 compatibility: failed mandatory confirmations wait for new events without polling', async () => {
  for (const result of ['failure', 'missing', 'invalid', 'behind', 'drained', 'slippage']) {
    const s = setup({ version: 'agent_sell_liquidity_v2_event_only', holdSlots: 3 }); try {
      await buy(s); let calls = 0;
      s.rpc.accounts = async () => {
        calls++;
        if (result === 'failure') throw new Error('offline');
        return snapshotOf(result === 'missing' ? null : result === 'invalid' ? {} :
          result === 'drained' ? account(0n) : result === 'slippage' ? account(40000000n, 100000000n) : account(),
          result === 'behind' ? 19 : 23);
      };
      s.engine.onSlot(23); await s.engine.tick(); assert.equal(calls, 1, result);
      assert.equal(pending(s), undefined); const orders = s.store.get('SELECT COUNT(*) n FROM paper_orders').n;
      for (const now of [100100, 101000, 110000, 400000, 1000000]) {
        s.now(now); s.engine.onSlot(23); await s.engine.tick(); assert.equal(calls, 1, result);
        assert.equal(s.store.get('SELECT COUNT(*) n FROM paper_orders').n, orders);
      }
      s.rpc.accounts = async () => { calls++; return snapshotOf(account(), 24); };
      s.engine.onSlot(24); s.engine.onAccount(mint, 24, account()); await s.engine.tick();
      assert.equal(calls, 2, result); assert.equal(position(s), undefined);
    } finally { s.close(); }
  }
});

test('confirmation snapshots cannot authorize a second mandatory exit attempt', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); let calls = 0;
    s.rpc.accounts = async () => { calls++; throw new Error('offline'); };
    s.engine.onSlot(23); await s.engine.tick(); assert.equal(calls, 1);
    s.engine.onAccount(mint, 24, account(), 'rpc'); await s.engine.tick();
    assert.equal(calls, 1); assert.equal(pending(s), undefined);
    s.engine.onAccount(mint, 24, account()); s.engine.onAccount(mint, 24, account(45000000n));
    await s.engine.tick(); assert.equal(calls, 2);
    // The second live event retains its own authorization rather than being consumed by the older quote.
    await s.engine.tick(); assert.equal(calls, 3);
    await s.engine.tick(); assert.equal(calls, 3);
  } finally { s.close(); }
});

test('v2 compatibility: subscription baseline authorizes one attempt without polling', async () => {
  const s = setup({ version: 'agent_sell_liquidity_v2_event_only', holdSlots: 3 }); let feeds;
  try {
    await buy(s); s.engine.gap('test'); s.engine.onReady(); s.engine.onSlot(23);
    let calls = 0, source;
    s.rpc.accounts = async () => { calls++; throw new Error('offline'); };
    await s.engine.tick(); assert.equal(calls, 0);
    feeds = new PaperFeeds(s.store, { accounts: async () => snapshotOf(account(), 24) }, {
      agentMode: true, now: () => 100000, socketFactory: () => { throw new Error('No sockets allowed'); },
      onAccount: (...args) => { source = args[3]; s.engine.onAccount(...args); },
    });
    feeds.add(mint, watch(s).curve_address);
    const subscribed = feeds.watches.get(mint); subscribed.subscription = 1;
    feeds.snapshot(subscribed);
    await new Promise(resolve => setImmediate(resolve));
    await Promise.all([...feeds.tasks]); assert.equal(source, 'baseline');
    await s.engine.tick(); assert.equal(calls, 1);
    for (const now of [100100, 101000, 110000, 1000000]) {
      s.now(now); s.engine.onSlot(24); await s.engine.tick(); assert.equal(calls, 1);
    }
    assert.ok(position(s)); assert.equal(watch(s).reason, 'timeout');
  } finally { await feeds?.stop(); s.close(); }
});

test('gap and shutdown abort event-driven exit confirmations and ignore late results', async () => {
  for (const kind of ['gap', 'stop']) {
    const s = setup({ holdSlots: 3 }); try {
      await buy(s); const wait = deferred(); let signal;
      s.rpc.accounts = (_addresses, options) => { signal = options.signal; return wait.promise; };
      s.engine.onSlot(23); const work = s.engine.tick(); assert.ok(signal);
      const stop = kind === 'stop' ? s.engine.stop() : (s.engine.gap('test'), Promise.resolve());
      assert.equal(signal.aborted, true); wait.resolve(snapshotOf(account(), 23)); await work; await stop;
      assert.ok(position(s)); assert.equal(pending(s), undefined);
    } finally { s.close(); }
  }
});

test('v2 compatibility: invalid observations cancel in-flight confirmations without closing holdings', async () => {
  const s = setup({ version: 'agent_sell_liquidity_v2_event_only', holdSlots: 3 }); try {
    await buy(s); const wait = deferred(); s.rpc.accounts = () => wait.promise;
    s.engine.onSlot(23); const work = s.engine.tick();
    s.engine.onAccount(mint, 23, null); wait.resolve(snapshotOf(account(), 23)); await work;
    assert.ok(position(s)); assert.equal(watch(s).account_error, 'missing_account');
    assert.equal(s.engine.states.has(mint), false); assert.equal(pending(s), undefined);
  } finally { s.close(); }
});

test('event-driven confirmation still enforces its order deadline', async () => {
  const s = setup({ holdSlots: 3, orderTtlMs: 1000 }); try {
    await buy(s); const wait = deferred(); let calls = 0;
    s.rpc.accounts = () => { calls++; return wait.promise; };
    s.engine.onSlot(23); const order = pending(s), work = s.engine.tick();
    s.now(101000); wait.resolve(snapshotOf(account(), 23)); await work;
    assert.ok(position(s)); assert.equal(canceled(s, order.id), 'signal_expired');
    await s.engine.tick(); assert.equal(calls, 1); assert.equal(pending(s), undefined);
  } finally { s.close(); }
});

test('timeout promotes queued and in-flight risk exits without aborting or replacing their authorization', async () => {
  for (const started of [false, true]) {
    const s = setup({ holdSlots: 3 }); try {
      await buy(s); s.engine.onAccount(mint, 21, account(6000000n)); const order = pending(s), wait = deferred();
      assert.equal(order.reason, 'liquidity_risk'); let signal;
      s.rpc.accounts = (_addresses, options) => { signal = options.signal; return wait.promise; };
      let work = started ? s.engine.reconcile(order) : null;
      s.engine.onSlot(23); assert.equal(pending(s).id, order.id); assert.equal(pending(s).reason, 'timeout');
      assert.equal(pending(s).expires_at_ms, order.expires_at_ms);
      if (!started) work = s.engine.reconcile(order);
      assert.equal(signal.aborted, false);
      wait.resolve(snapshotOf(account(6000000n), 23)); await work;
      assert.equal(position(s), undefined); assert.equal(watch(s).reason, 'timeout');
      assert.equal(s.store.get('SELECT reason FROM paper_orders WHERE id=?', order.id).reason, 'timeout');
    } finally { s.close(); }
  }
});

test('v2 compatibility: mandatory slippage preserves a newer account authorization', async () => {
  const s = setup({ version: 'agent_sell_liquidity_v2_event_only', holdSlots: 3 }); try {
    await buy(s); s.engine.onSlot(23); const first = pending(s);
    const revision = JSON.parse(first.quote_json).exitObservationRevision;
    s.engine.onAccount(mint, 24, account(40000000n, 100000000n));
    const newer = s.engine.states.get(mint).exitRevision; assert.notEqual(revision, newer);
    let calls = 0; s.rpc.accounts = async () => { calls++; return snapshotOf(account(40000000n, 100000000n), 24); };
    await s.engine.reconcile(first); assert.equal(canceled(s, first.id), 'sell_slippage');
    assert.equal(s.engine.exitAttempts.get(mint).revision, revision); assert.ok(position(s));
    await s.engine.tick(); assert.equal(calls, 2); assert.equal(position(s), undefined);
    const second = s.store.get("SELECT quote_json FROM paper_orders WHERE side='sell' ORDER BY id DESC LIMIT 1");
    assert.equal(JSON.parse(second.quote_json).exitObservationRevision, newer);
  } finally { s.close(); }
});

test('v2 compatibility: coverage cannot invalidate a post-gap baseline-authorized exit', async () => {
  const s = setup({ version: 'agent_sell_liquidity_v2_event_only', holdSlots: 3 }); try {
    await buy(s); s.engine.gap('reconnect'); s.engine.onSlot(23);
    s.engine.onAccount(mint, 24, account(), 'baseline'); const order = pending(s), wait = deferred();
    assert.ok(order); s.rpc.accounts = () => wait.promise;
    const work = s.engine.reconcile(order), before = s.engine.states.get(mint).since;
    s.engine.onSlot(25); s.engine.coverage(mint);
    assert.notEqual(s.engine.states.get(mint).since, before);
    wait.resolve(snapshotOf(account(), 25)); await work;
    assert.equal(position(s), undefined); assert.equal(watch(s).reason, 'timeout');
  } finally { s.close(); }
});

test('orders expiring before their first RPC cannot be recreated from the same account event', async () => {
  const s = setup({ holdSlots: 3, orderTtlMs: 1000, maxStateAgeMs: 60000 }); try {
    await buy(s); let calls = 0;
    s.rpc.accounts = async () => { calls++; return snapshotOf(account(), 24); };
    s.engine.onSlot(23); const order = pending(s), count = s.store.get('SELECT COUNT(*) n FROM paper_orders').n;
    for (const now of [101000, 102000, 110000, 150000]) {
      s.now(now); s.engine.onSlot(23); await s.engine.tick();
      assert.equal(calls, 0); assert.equal(pending(s), undefined);
      assert.equal(s.store.get('SELECT COUNT(*) n FROM paper_orders').n, count);
    }
    assert.equal(canceled(s, order.id), 'signal_expired');
    s.engine.onAccount(mint, 24, account()); assert.equal(pending(s).expires_at_ms, 151000);
    await s.engine.tick(); assert.equal(calls, 1); assert.equal(position(s), undefined);
  } finally { s.close(); }
});

test('v2 compatibility: an illiquid exit observation is evaluated only once', async () => {
  const s = setup({ version: 'agent_sell_liquidity_v2_event_only', holdSlots: 3 }); try {
    await buy(s); let failures = 0; const count = s.engine.paper.count.bind(s.engine.paper);
    s.engine.paper.count = name => { if (name === 'exit_insufficient_liquidity') failures++; return count(name); };
    s.engine.onAccount(mint, 21, account(0n)); assert.equal(failures, 1);
    for (let i = 0; i < 20; i++) { s.engine.onSlot(23); await s.engine.tick(); }
    assert.equal(failures, 1); assert.equal(watch(s).reason, 'timeout');
    s.engine.onAccount(mint, 24, account(0n)); await s.engine.tick(); assert.equal(failures, 2);
    assert.ok(position(s)); assert.equal(pending(s), undefined);
  } finally { s.close(); }
});

test('a strictly newer confirmed snapshot survives intervening notifications for a mandatory exit', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); s.engine.onSlot(23); const order = pending(s), wait = deferred();
    s.rpc.accounts = () => wait.promise; const work = s.engine.reconcile(order);
    s.engine.onAccount(mint, 24, account()); wait.resolve(snapshotOf(account(), 25)); await work;
    assert.equal(position(s), undefined); assert.equal(watch(s).reason, 'timeout');
  } finally { s.close(); }
});

test('confirmed snapshot itself enforces the entry signal horizon despite a lagging slot feed', async () => {
  for (const slot of [24, 25]) {
    const s = setup(); try {
      s.engine.agentTransaction(tx()); const order = pending(s); s.engine.onSlot(24); s.snapshot(account(), slot);
      await s.engine.reconcile(order);
      if (slot === 24) assert.equal(position(s).entry_snapshot_slot, 24);
      else { assert.equal(position(s), undefined); assert.equal(canceled(s, order.id), 'signal_expired'); }
    } finally { s.close(); }
  }
});

test('inventory-exhausting agent buys fail quality at both admission and confirmed fill', async () => {
  const thin = account(40000000n, 140000000n, false, 10000000000n), state = reserves(thin);
  const quality = entryQuality(state, config, liquidityBudget(state.realSol, config));
  assert.equal(quality.fullExitSupported, false); assert.equal(quality.rejection, 'entry_inventory_exhaustion');
  const s = setup(); try {
    s.engine.agentTransaction(tx('thin', 20, [event(mint, state)]));
    assert.equal(pending(s), undefined); assert.equal(outcome(s), 'entry_inventory_exhaustion');
  } finally { s.close(); }
  const q = setup(); try {
    q.engine.agentTransaction(tx()); const order = pending(q); q.snapshot(thin);
    await q.engine.reconcile(order); assert.equal(canceled(q, order.id), 'entry_inventory_exhaustion'); assert.equal(position(q), undefined);
  } finally { q.close(); }
});

const lastExit = s => s.store.get("SELECT * FROM paper_orders WHERE mint=? AND side='sell' ORDER BY id DESC LIMIT 1", mint);
function assertTerminal(s, original, expectedOutcome) {
  const closed = s.store.get('SELECT * FROM paper_positions WHERE mint=?', mint), order = lastExit(s);
  const quote = JSON.parse(order.fill_json);
  assert.equal(position(s), undefined); assert.equal(closed.status, 'closed');
  assert.equal(closed.tokens_raw, original.tokens_raw); assert.equal(closed.entry_cost_lamports, original.entry_cost_lamports);
  assert.equal(closed.entry_order_id, original.entry_order_id); assert.equal(quote.entryOrderId, original.entry_order_id);
  assert.equal(quote.originalTokens, original.tokens_raw); assert.equal(quote.tokens, original.tokens_raw);
  assert.equal(BigInt(quote.soldTokens) + BigInt(quote.burnedTokens), BigInt(original.tokens_raw));
  assert.equal(quote.remainingTokens, '0'); assert.equal(quote.accountClosed, true);
  assert.equal(quote.terminalOutcome, expectedOutcome);
  assert.equal(order.status, expectedOutcome === 'write_off' ? 'written_off' : 'filled');
  assert.equal(quote.networkFee, s.engine.cfg.networkFeeLamports);
  assert.equal(BigInt(quote.net), BigInt(quote.gross) - BigInt(quote.swapFee) - BigInt(quote.networkFee));
  assert.equal(closed.exit_net_lamports, quote.net);
  assert.equal(BigInt(closed.pnl_lamports), BigInt(quote.net) - BigInt(original.entry_cost_lamports));
  assert.equal(watch(s).status, 'closed'); assert.equal(s.engine.paper.exposure().total, 0n);
  assert.equal(s.engine.states.has(mint), false); assert.equal(s.engine.coverageSlots.has(mint), false);
  assert.equal(s.engine.exitAttempts.has(mint), false); assert.equal(pending(s), undefined);
  return { closed, order, quote };
}
async function restartEngine(s, at = 200000) {
  const previous = s.engine; await previous.stop();
  let now = at;
  s.engine = new PaperEngine(s.store, s.rpc, previous.cfg, { now: () => now, project: raw => raw });
  s.engine.attach(previous.feeds); s.now = value => { now = value; };
  s.engine.start();
}

test('v3 mandatory exits recover full or partial liquidity and preserve original entry history', async () => {
  for (const real of [1000000n, 6000000n, 40000000n]) {
    const s = setup({ holdSlots: 3 }); try {
      await buy(s); const original = { ...position(s) };
      const entry = s.store.get('SELECT * FROM paper_orders WHERE id=?', original.entry_order_id);
      let removed = 0, calls = 0;
      s.engine.feeds.remove = m => { if (m === mint) removed++; };
      s.rpc.accounts = async () => { calls++; return snapshotOf(account(real), 23); };
      s.engine.onAccount(mint, 21, account(real)); s.engine.onSlot(23);
      const requested = pending(s); assert.ok(requested); assert.equal(calls, 0);
      await s.engine.tick();
      const result = assertTerminal(s, original, real === 1000000n ? 'partial_sale' : 'full_sale');
      assert.equal(calls, 1); assert.equal(removed, 1);
      assert.equal(result.quote.model, 'hypothetical_terminal_liquidation');
      assert.equal(result.quote.reserveEvidence.realSol, real.toString());
      assert.ok(BigInt(result.quote.gross) <= real);
      if (real === 1000000n) {
        assert.ok(BigInt(result.quote.burnedTokens) > 0n);
        assert.ok(fullSaleGross(reserves(account(real)), BigInt(result.quote.soldTokens) + 1n) > real);
      } else assert.equal(result.quote.burnedTokens, '0');
      assert.deepEqual(s.store.get('SELECT * FROM paper_orders WHERE id=?', original.entry_order_id), entry);
      await s.engine.reconcile(requested); await s.engine.tick();
      assert.equal(calls, 1); assert.equal(removed, 1);
    } finally { s.close(); }
  }
});

test('v3 mandatory confirmation accepts reduced recovery but profit keeps profitability and slippage guards', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); const original = { ...position(s) };
    s.engine.onSlot(23); const requested = pending(s), prediction = JSON.parse(requested.quote_json);
    s.snapshot(account(500000n), 23); await s.engine.reconcile(requested);
    const { quote } = assertTerminal(s, original, 'partial_sale');
    assert.ok(BigInt(quote.net) * 10000n < BigInt(prediction.net) * BigInt(10000 - config.sellSlippageBps));
    assert.equal(quote.reserveEvidence.realSol, '500000');
  } finally { s.close(); }
  for (const virtual of [140000000n, 200000000n]) {
    const p = setup(); try {
      await buy(p); p.engine.onAccount(mint, 21, account(100000000n, 240000000n));
      const order = pending(p); assert.equal(order.reason, 'profit');
      p.snapshot(account(100000000n, virtual), 21); await p.engine.reconcile(order);
      assert.equal(canceled(p, order.id), virtual === 140000000n ? 'profit_disappeared' : 'sell_slippage');
      assert.ok(position(p)); assert.equal(lastExit(p).fill_json, null);
    } finally { p.close(); }
  }
});

test('v3 zero and fee-dust reserves burn everything without confirmation RPC or fabricated sell fills', async () => {
  for (const real of [0n, 1n]) {
    const s = setup(); try {
      await buy(s); const original = { ...position(s) }; let calls = 0;
      s.rpc.accounts = async () => { calls++; throw new Error('Unexpected RPC'); };
      s.engine.onAccount(mint, 21, account(real));
      const { quote } = assertTerminal(s, original, 'write_off');
      assert.equal(quote.soldTokens, '0'); assert.equal(quote.burnedTokens, original.tokens_raw);
      assert.equal(quote.gross, '0'); assert.equal(quote.swapFee, '0'); assert.equal(quote.net, '-10000');
      assert.equal(quote.writeOffReason, real === 0n ? 'insufficient_real_liquidity' : 'fees_exceed_output');
      for (let i = 0; i < 5; i++) { s.engine.onSlot(21 + i); await s.engine.tick(); s.engine.onAccount(mint, 21 + i, account()); }
      assert.equal(calls, 0); assert.equal(s.store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").n, 1);
    } finally { s.close(); }
  }
});

test('v3 stale or missing timeout state writes off with exact losses and immediate exposure release', async () => {
  for (const missing of [false, true]) {
    const s = setup({ holdSlots: 3 }); try {
      await buy(s); const original = { ...position(s) }; let calls = 0;
      const saved = watch(s).fingerprint; assert.ok(saved);
      s.rpc.accounts = async () => { calls++; throw new Error('No fallback account reads'); };
      if (missing) s.engine.states.delete(mint);
      else { s.now(106000); s.covered(false); } // Old reserves without live coverage are unknown, not unchanged.
      s.engine.onSlot(23); await s.engine.tick();
      const { quote, closed } = assertTerminal(s, original, 'write_off');
      assert.equal(quote.writeOffReason, missing ? 'missing_observation' : 'stale_observation');
      assert.equal(quote.gross, '0'); assert.equal(quote.net, '-10000');
      assert.equal(BigInt(closed.pnl_lamports), -10000n - BigInt(original.entry_cost_lamports));
      assert.equal(calls, 0); assert.equal(watch(s).fingerprint, saved);
      assert.equal(watch(s).reason, 'timeout');
    } finally { s.close(); }
  }
});

test('v3 ordinary holdings without mandatory intent are not closed for stale, missing or invalid accounts', async () => {
  for (const kind of ['stale', 'missing', 'invalid']) {
    const s = setup(); try {
      await buy(s); const original = { ...position(s) }; let calls = 0;
      s.rpc.accounts = async () => { calls++; throw new Error('No RPC'); };
      if (kind === 'missing') s.engine.states.delete(mint);
      if (kind === 'invalid') s.engine.onAccount(mint, 21, null);
      s.now(106000); s.engine.onSlot(21); await s.engine.tick();
      assert.deepEqual({ ...position(s) }, original); assert.equal(watch(s).reason, null);
      assert.equal(lastExit(s), undefined); assert.equal(calls, 0);
    } finally { s.close(); }
  }
});

test('v3 graduation closes from live, confirmed and restored evidence without inventing AMM proceeds', async () => {
  for (const source of ['live', 'confirmed', 'restored']) {
    const s = setup({ holdSlots: 3 }); try {
      await buy(s); const original = { ...position(s) }; let calls = 0;
      s.rpc.accounts = async () => { calls++; return snapshotOf(account(0n, 140000000n, true), 23); };
      if (source === 'live') s.engine.onAccount(mint, 21, account(0n, 140000000n, true));
      else if (source === 'confirmed') { s.engine.onSlot(23); await s.engine.tick(); }
      else {
        s.store.run("UPDATE paper_watches SET status='exit_blocked',reason='graduated_no_amm_exit' WHERE mint=?", mint);
        await restartEngine(s);
      }
      const { quote } = assertTerminal(s, original, 'write_off');
      assert.equal(quote.writeOffReason, 'graduated_no_amm_exit'); assert.equal(quote.gross, '0');
      assert.equal(calls, source === 'confirmed' ? 1 : 0);
      assert.equal(s.engine.startupExitGrace.has(mint), false);
    } finally { s.close(); }
  }
});

test('v3 invalid observation aborts in-flight confirmation and late results cannot overwrite write-off', async () => {
  for (const value of [null, {}, { owner: key(9), data: account().data }]) {
    const s = setup({ holdSlots: 3 }); try {
      await buy(s); const original = { ...position(s) }, wait = deferred(); let signal, calls = 0;
      s.rpc.accounts = (_addresses, options) => { signal = options.signal; calls++; return wait.promise; };
      s.engine.onSlot(23); const order = pending(s), work = s.engine.tick();
      s.engine.onAccount(mint, 23, value); assert.equal(signal.aborted, true);
      const settled = assertTerminal(s, original, 'write_off');
      assert.equal(canceled(s, order.id), 'invalid_account');
      wait.resolve(snapshotOf(account(), 24)); await work; await s.engine.tick();
      assert.deepEqual(assertTerminal(s, original, 'write_off'), settled);
      assert.equal(calls, 1); assert.equal(s.store.get("SELECT COUNT(*) n FROM paper_orders WHERE status='written_off'").n, 1);
    } finally { s.close(); }
  }
});

test('v3 cache aging does not abort an in-flight confirmation within its existing TTL', async () => {
  const s = setup({ holdSlots: 3, maxStateAgeMs: 1000, orderTtlMs: 10000 }); try {
    await buy(s); const original = { ...position(s) }, wait = deferred(); let signal;
    s.rpc.accounts = (_addresses, options) => { signal = options.signal; return wait.promise; };
    s.engine.onSlot(23); const order = pending(s), work = s.engine.tick();
    s.now(105000); s.engine.onSlot(24); await s.engine.tick();
    assert.equal(signal.aborted, false); assert.ok(position(s)); assert.equal(pending(s).id, order.id);
    wait.resolve(snapshotOf(account(), 24)); await work;
    assertTerminal(s, original, 'full_sale');
  } finally { s.close(); }
});

test('v3 restored mandatory intent gives initial baseline one TTL grace, then writes off without RPC', async () => {
  for (const baseline of [false, true]) {
    const s = setup({ holdSlots: 3, orderTtlMs: 1000 }); try {
      await buy(s); const original = { ...position(s) }; s.engine.onSlot(23);
      const oldOrder = pending(s); let calls = 0;
      s.rpc.accounts = async () => { calls++; return snapshotOf(account(), 24); };
      await restartEngine(s);
      assert.equal(pending(s), undefined); assert.ok(position(s));
      assert.equal(s.engine.states.has(mint), false); assert.equal(s.engine.startupExitGrace.get(mint), 201000);
      s.now(200999); await s.engine.tick(); assert.ok(position(s)); assert.equal(calls, 0);
      if (baseline) {
        s.engine.onAccount(mint, 24, account(), 'baseline');
        assert.ok(pending(s)); assert.equal(s.engine.startupExitGrace.has(mint), false);
        await s.engine.tick(); assertTerminal(s, original, 'full_sale'); assert.equal(calls, 1);
      } else {
        s.now(201000); await s.engine.tick();
        const { quote } = assertTerminal(s, original, 'write_off');
        assert.equal(quote.writeOffReason, 'missing_observation'); assert.equal(calls, 0);
      }
      assert.notEqual(lastExit(s).id, oldOrder.id);
    } finally { s.close(); }
  }
});

test('v3 restored ordinary holdings survive empty cache and elapsed startup grace until timeout', async () => {
  const s = setup({ holdSlots: 3, orderTtlMs: 1000 }); try {
    await buy(s); const original = { ...position(s) }; let calls = 0;
    s.rpc.accounts = async () => { calls++; throw new Error('No initial polling'); };
    await restartEngine(s); await s.engine.tick();
    s.now(202000); s.engine.onSlot(22); await s.engine.tick();
    assert.deepEqual({ ...position(s) }, original); assert.equal(watch(s).reason, null); assert.equal(lastExit(s), undefined);
    s.engine.onSlot(23); await s.engine.tick();
    assertTerminal(s, original, 'write_off'); assert.equal(calls, 0);
  } finally { s.close(); }
});

test('v3 gapped expired mandatory intent writes off without an additional RPC', async () => {
  const s = setup({ holdSlots: 3, orderTtlMs: 1000 }); try {
    await buy(s); const original = { ...position(s) }, wait = deferred(); let calls = 0, signal;
    s.rpc.accounts = (_addresses, options) => { calls++; signal = options.signal; return wait.promise; };
    s.engine.onSlot(23); const work = s.engine.tick(), order = pending(s);
    s.engine.gap('test'); assert.equal(signal.aborted, true);
    s.now(102000); wait.resolve(snapshotOf(account(), 24)); await work; await s.engine.tick();
    // Disconnected: the gap alone is not evidence of zero recovery.
    assert.ok(position(s)); assert.equal(canceled(s, order.id), 'feed_gap');
    s.engine.onReady(); s.now(102999); await s.engine.tick(); assert.ok(position(s));
    // No reconnection baseline within one order TTL of recovery: explicit write-off.
    s.now(103001); await s.engine.tick();
    assertTerminal(s, original, 'write_off'); assert.equal(canceled(s, order.id), 'feed_gap');
    for (let i = 0; i < 5; i++) await s.engine.tick();
    assert.equal(calls, 1);
  } finally { s.close(); }
});

test('v3 failed, missing, invalid, behind and drained confirmations never create fallback polling', async () => {
  for (const result of ['failure', 'missing', 'invalid', 'behind', 'drained']) {
    const s = setup({ holdSlots: 3 }); try {
      await buy(s); const original = { ...position(s) }; let calls = 0;
      s.rpc.accounts = async () => {
        calls++; if (result === 'failure') throw new Error('offline');
        return snapshotOf(result === 'missing' ? null : result === 'invalid' ? {} :
          result === 'drained' ? account(0n) : account(), result === 'behind' ? 19 : 23);
      };
      s.engine.onSlot(23); await s.engine.tick(); assert.equal(calls, 1);
      s.now(111000); await s.engine.tick();
      assertTerminal(s, original, 'write_off');
      for (let i = 0; i < 5; i++) await s.engine.tick();
      assert.equal(calls, 1);
    } finally { s.close(); }
  }
});

test('v3 terminal settlement remains exactly once across ticks, duplicate fills and disk restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-once-')), path = join(dir, 'trial.sqlite');
  let s = setup({ holdSlots: 3 }, path);
  try {
    await buy(s); const original = { ...position(s) }; s.engine.onAccount(mint, 21, account(0n));
    const settled = assertTerminal(s, original, 'write_off');
    const count = s.store.get('SELECT COUNT(*) n FROM paper_orders').n;
    assert.equal(s.engine.paper.writeOff(mint, 'timeout', settled.quote, 101000), false);
    s.engine.paper.fill(settled.order, settled.quote, 101000); await s.engine.tick();
    await s.engine.stop(); s.close();
    const store = new Store(path, storeConfig); let calls = 0;
    const rpc = { accounts: async () => { calls++; throw new Error('No restart polling'); } };
    const engine = new PaperEngine(store, rpc, { ...config, holdSlots: 3 }, { now: () => 300000 });
    engine.attach({ add() {}, remove() {}, start() {}, stop() {} });
    s = { store, rpc, engine, close: () => store.close() };
    engine.start(); await engine.tick();
    assert.deepEqual(assertTerminal(s, original, 'write_off'), settled);
    assert.equal(store.get('SELECT COUNT(*) n FROM paper_orders').n, count); assert.equal(calls, 0);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('v3 reports distinguish partial/full modeled fills from write-offs and include all realized losses', async () => {
  for (const real of [0n, 1000000n, 40000000n]) {
    const s = setup({ holdSlots: 3 }); try {
      await buy(s); const original = { ...position(s) };
      s.engine.onAccount(mint, 21, account(real)); s.engine.onSlot(23); s.snapshot(account(real), 23); await s.engine.tick();
      const outcome = real === 0n ? 'write_off' : real === 1000000n ? 'partial_sale' : 'full_sale';
      const { closed, quote } = assertTerminal(s, original, outcome), report = s.engine.paper.report(101000);
      const performance = report.performance;
      assert.equal(performance.closedTrades, 1); assert.equal(performance.losses, 1); assert.equal(performance.wins, 0);
      assert.equal(performance.writeOffs, real === 0n ? 1 : 0);
      assert.equal(performance.partialLiquidations, real === 1000000n ? 1 : 0);
      assert.equal(performance.modeledSellFills, real === 0n ? 0 : 1);
      assert.equal(performance.unresolvedPositions, 0); assert.equal(performance.unresolvedCostLamports, '0');
      assert.equal(report.realizedPnlLamports, closed.pnl_lamports);
      assert.equal(performance.zeroRecoveryScenarioPnlLamports, closed.pnl_lamports);
      assert.equal(performance.realizedMaxDrawdownLamports, (-BigInt(closed.pnl_lamports)).toString());
      assert.equal(performance.terminalSettlements[0].outcome, outcome);
      assert.equal(performance.terminalSettlements[0].netLamports, quote.net);
      assert.equal(performance.terminalSettlements[0].burnedTokens, quote.burnedTokens);
      assert.equal(report.orders.find(row => row.side === 'sell').status, real === 0n ? 'written_off' : 'filled');
    } finally { s.close(); }
  }
});

test('v3 store rejects invalid terminal evidence atomically and rolls back write-off order creation', async () => {
  const s = setup(); try {
    await buy(s); const original = { ...position(s) }, quote = writeOffQuote(original, config, 'missing_observation');
    const before = s.store.all('SELECT * FROM paper_orders ORDER BY id'), beforeWatch = watch(s);
    for (const patch of [{ soldTokens: '1' }, { burnedTokens: '0' }, { remainingTokens: '1' },
      { accountClosed: false }, { originalTokens: '1' }, { net: '0' }, { networkFee: '0' },
      { gross: '1', net: '-9999' }, { swapFee: '1', net: '-10001' }]) {
      assert.throws(() => s.engine.paper.writeOff(mint, 'timeout', { ...quote, ...patch }, 101000), /Invalid terminal settlement/);
      assert.deepEqual(s.store.all('SELECT * FROM paper_orders ORDER BY id'), before);
      assert.deepEqual({ ...position(s) }, original); assert.deepEqual(watch(s), beforeWatch);
    }
    assert.equal(s.engine.paper.writeOff(mint, 'timeout', { ...quote, entryOrderId: -1 }, 101000), false);
    const sale = terminalExitQuote(reserves(account()), original, config);
    s.engine.paper.request(mint, 'sell', 'timeout', sale, null, 101000); const order = pending(s);
    for (const patch of [{ entryOrderId: -1 }, { terminalOutcome: 'unknown' }, { burnedTokens: '1' }, { soldTokens: '-1' }]) {
      assert.throws(() => s.engine.paper.fill(order, { ...sale, ...patch }, 101000), /Invalid terminal settlement/);
      assert.deepEqual(pending(s), order); assert.deepEqual({ ...position(s) }, original);
    }
    assert.equal(s.engine.paper.writeOff(mint, 'timeout', quote, 101000), false);
    s.engine.cancel(order.id, 101000, 'test'); s.engine.paper.fill(order, sale, 101001);
    assert.deepEqual({ ...position(s) }, original); assert.equal(canceled(s, order.id), 'test');
  } finally { s.close(); }
});

test('v3 a positive partial sale remains filled when its network fee makes recovery negative', async () => {
  const s = setup(); try {
    await buy(s); const original = { ...position(s) };
    s.engine.onAccount(mint, 21, account(1000n)); s.snapshot(account(1000n), 21);
    await s.engine.tick(); const { quote, closed } = assertTerminal(s, original, 'partial_sale');
    assert.equal(quote.gross, '1000'); assert.equal(quote.swapFee, '13'); assert.equal(quote.net, '-9013');
    assert.equal(quote.writeOffReason, null); assert.ok(BigInt(quote.soldTokens) > 0n);
    assert.equal(BigInt(closed.pnl_lamports), -9013n - BigInt(original.entry_cost_lamports));
  } finally { s.close(); }
});

test('v3 restored baseline authorization survives transaction coverage changes during confirmation', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); const original = { ...position(s) }; s.engine.onSlot(23); await restartEngine(s);
    s.engine.onAccount(mint, 24, account(), 'baseline'); const order = pending(s), wait = deferred();
    s.rpc.accounts = () => wait.promise; const work = s.engine.reconcile(order);
    const since = s.engine.states.get(mint).since;
    s.engine.onSlot(25); s.engine.coverage(mint);
    assert.notEqual(s.engine.states.get(mint).since, since);
    wait.resolve(snapshotOf(account(), 25)); await work;
    assertTerminal(s, original, 'full_sale');
  } finally { s.close(); }
});

test('v3 same-slot observation races reject the old confirmation and require a new event authorization', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); const original = { ...position(s) }; s.engine.onSlot(23);
    const oldOrder = pending(s), wait = deferred(); let calls = 0;
    s.rpc.accounts = () => { calls++; return wait.promise; };
    const work = s.engine.reconcile(oldOrder);
    s.engine.onAccount(mint, 23, account(1000000n));
    wait.resolve(snapshotOf(account(), 23)); await work;
    assert.ok(position(s)); assert.equal(canceled(s, oldOrder.id), 'awaiting_account_update');
    assert.equal(lastExit(s).fill_json, null);
    s.rpc.accounts = async () => { calls++; return snapshotOf(account(1000000n), 24); };
    await s.engine.tick(); assertTerminal(s, original, 'partial_sale'); assert.equal(calls, 2);
    await s.engine.tick(); assert.equal(calls, 2);
  } finally { s.close(); }
});

test('v3 settlement rejects inconsistent outcome, original quantity and negative fee evidence', async () => {
  const s = setup(); try {
    await buy(s); const original = { ...position(s) }, sale = terminalExitQuote(reserves(account()), original, config);
    s.engine.paper.request(mint, 'sell', 'timeout', sale, null, 101000); const order = pending(s);
    const partial = terminalExitQuote(reserves(account(1000000n)), original, config);
    const invalidQuotes = [
      { ...sale, tokens: '1' },
      { ...sale, terminalOutcome: 'partial_sale' },
      { ...partial, terminalOutcome: 'full_sale' },
      { ...sale, soldTokens: '0', burnedTokens: original.tokens_raw },
      { ...sale, gross: '-1', net: (-1n - BigInt(sale.swapFee) - BigInt(sale.networkFee)).toString() },
      { ...sale, swapFee: '-1', net: (BigInt(sale.gross) + 1n - BigInt(sale.networkFee)).toString() },
    ];
    for (const invalid of invalidQuotes) {
      assert.throws(() => s.engine.paper.fill(order, invalid, 101000), /Invalid terminal settlement/,
        `accepted inconsistent evidence: ${JSON.stringify(invalid)}`);
      assert.deepEqual(pending(s), order); assert.deepEqual({ ...position(s) }, original);
    }
  } finally { s.close(); }
});

test('v3 write-off rolls back its inserted order and accounting when closing the position fails', async () => {
  const s = setup(); try {
    await buy(s); const original = { ...position(s) }, quote = writeOffQuote(original, config, 'missing_observation');
    const before = s.store.all('SELECT * FROM paper_orders ORDER BY id'), beforeWatch = watch(s);
    s.store.db.exec(`CREATE TRIGGER reject_terminal_close BEFORE UPDATE OF status ON paper_positions
      WHEN NEW.status='closed' BEGIN SELECT RAISE(ABORT,'test_close_failure'); END`);
    assert.throws(() => s.engine.paper.writeOff(mint, 'timeout', quote, 101000), /test_close_failure/);
    assert.deepEqual(s.store.all('SELECT * FROM paper_orders ORDER BY id'), before);
    assert.deepEqual({ ...position(s) }, original); assert.deepEqual(watch(s), beforeWatch);
    assert.equal(s.engine.paper.exposure().total, BigInt(original.entry_cost_lamports));
    s.store.db.exec('DROP TRIGGER reject_terminal_close');
    assert.equal(s.engine.paper.writeOff(mint, 'timeout', quote, 101001), true);
    assert.equal(position(s), undefined); assert.equal(lastExit(s).status, 'written_off');
  } finally { s.close(); }
});

test('agent reports preserve integer evidence and support missing new sample table in read-only legacy views', () => {
  const s = setup(); try {
    s.engine.agentTransaction(tx()); const report = s.engine.paper.report(100000);
    assert.equal(report.exposure.reservedLamports, '4810000'); assert.equal(report.recentAgentEvents[0].outcome, 'buy_pending');
    assert.equal(report.recentOrders[0].diagnostics.referenceRealSolLamports, '40000000');
    const readonly = Object.assign(Object.create(PaperStore.prototype), { store: s.store, cfg: config });
    s.store.db.exec('DROP TABLE paper_agent_events'); assert.deepEqual(readonly.report().recentAgentEvents, []);
  } finally { s.close(); }
});

test('v3 transient feed gap does not write off held positions before the reconnection baseline', async () => {
  // Timeout latched before the gap, and timeout first reached after the gap.
  for (const latchedFirst of [true, false]) {
    const s = setup({ holdSlots: 3 }); try {
      await buy(s); const original = { ...position(s) };
      s.rpc.accounts = async () => snapshotOf(account(), 24);
      if (latchedFirst) { s.engine.onSlot(23); s.engine.cancel(pending(s).id, 100000, 'test'); assert.equal(watch(s).reason, 'timeout'); }
      s.engine.gap('test'); await s.engine.tick(); assert.ok(position(s));
      s.engine.onReady(); s.engine.onSlot(24); await s.engine.tick();
      assert.ok(position(s)); assert.equal(watch(s).reason, 'timeout');
      // The reconnection baseline arrives and the exit sells against real reserves instead of writing off.
      s.engine.onAccount(mint, 24, account(), 'baseline'); await s.engine.tick();
      const { quote } = assertTerminal(s, original, 'full_sale');
      assert.ok(BigInt(quote.gross) > 0n);
    } finally { s.close(); }
  }
});

test('v3 quiet but covered curve exits at unchanged reserves instead of a stale write-off', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); const original = { ...position(s) }; let calls = 0;
    s.rpc.accounts = async () => { calls++; return snapshotOf(account(), 23); };
    // No trades for 6s, but the subscription and slot heartbeat are live.
    s.now(106000); s.engine.onSlot(23); await s.engine.tick();
    const { quote } = assertTerminal(s, original, 'full_sale');
    assert.ok(BigInt(quote.gross) > 0n); assert.equal(calls, 1);
  } finally { s.close(); }
});

test('v3 quiet covered curve gets one confirmation attempt, then writes off without polling', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); const original = { ...position(s) }; let calls = 0;
    s.rpc.accounts = async () => { calls++; throw new Error('unavailable'); };
    s.now(106000); s.engine.onSlot(23); await s.engine.tick();
    assert.equal(calls, 1); assert.ok(position(s));
    s.engine.onSlot(24); await s.engine.tick();
    const { quote } = assertTerminal(s, original, 'write_off');
    assert.equal(quote.writeOffReason, 'stale_observation'); assert.equal(calls, 1);
  } finally { s.close(); }
});

test('blank paper environment values use defaults instead of zero', () => {
  const blank = { PAPER_SWAP_FEE_BPS: '', PAPER_NETWORK_FEE_LAMPORTS: '', PAPER_SELL_SLIPPAGE_BPS: ' ', PAPER_AGENT_PROFIT_BPS: '\t' };
  assert.equal(trialIdentity(paperConfig(blank, 'agent-sell-liquidity')), trialIdentity(config));
  assert.equal(trialIdentity(paperConfig(blank)), trialIdentity(paperConfig({})));
  assert.equal(paperConfig({ PAPER_SWAP_FEE_BPS: '0' }).swapFeeBps, 0);
});

test('v3 account data during a transaction-feed-only gap does not end the hold before feeds are ready', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); let calls = 0;
    s.rpc.accounts = async () => { calls++; throw new Error('unavailable'); };
    // Agent feed drops; the standard socket stays up and delivers a re-baseline, then the curve goes quiet.
    s.engine.gap('agent_transaction_failed'); s.covered(false);
    s.engine.onAccount(mint, 21, account(), 'baseline');
    s.now(106000); s.engine.onSlot(23); await s.engine.tick();
    assert.ok(position(s)); assert.equal(watch(s).reason, 'timeout'); assert.equal(calls, 0);
  } finally { s.close(); }
});

test('a slot jump restarts signal windows without a gap, resync or canceled orders', async () => {
  const s = setup(); try {
    let resyncs = 0, jumps = 0; s.engine.feeds.resync = () => { resyncs++; };
    const count = s.engine.paper.count.bind(s.engine.paper);
    s.engine.paper.count = name => { if (name === 'slot_discontinuity') jumps++; return count(name); };
    await buy(s); s.engine.onAccount(mint, 20, account());
    s.engine.paper.request(mint, 'sell', 'profit', { net: '1' }, null, 100000);
    const order = pending(s); assert.ok(order);
    s.engine.onSlot(40);
    assert.equal(resyncs, 0); assert.equal(s.engine.ready, true); assert.equal(s.engine.slot, 40);
    assert.equal(pending(s)?.id, order.id); assert.ok(s.engine.states.has(mint));
    // A sell signal from before the jump cannot create an entry across it.
    assert.equal(s.engine.coverageSlots.get(mint2), 40);
    s.engine.agentTransaction(tx('pre-jump', 30, [event(mint2)])); assert.equal(s.engine.paper.pending().filter(o => o.mint === mint2).length, 0);
    assert.equal(jumps, 1);
  } finally { s.close(); }
});

test('PAPER_AGENT_SKIP_CAPPED skips entries whose budget reaches the swap cap and keeps uncapped ones', () => {
  const skip = paperConfig({ PAPER_AGENT_SKIP_CAPPED: 'true' }, 'agent-sell-liquidity');
  assert.equal(skip.skipCappedEntries, true);
  // Off by default and when explicitly false/blank: identity unchanged for existing trials.
  for (const value of [undefined, '', 'false', '0']) {
    assert.equal(trialIdentity(paperConfig(value === undefined ? {} : { PAPER_AGENT_SKIP_CAPPED: value }, 'agent-sell-liquidity')), trialIdentity(config));
  }
  assert.throws(() => paperConfig({ PAPER_AGENT_SKIP_CAPPED: 'yes' }, 'agent-sell-liquidity'), /PAPER_AGENT_SKIP_CAPPED/);
  assert.notEqual(trialIdentity(skip), trialIdentity(config));
  // 12% of real SOL vs 0.01 SOL cap: 0.0833.. SOL is the boundary.
  const capped = 83333334n, uncapped = 83333333n;
  for (const [real, enabled, entered] of [[40000000n, true, true], [uncapped, true, true], [capped, true, false],
    [200000000n, true, false], [200000000n, false, true]]) {
    const s = setup(enabled ? { skipCappedEntries: true } : {}); try {
      // Real curves keep virtual SOL above real SOL (30 SOL virtual offset).
      const curve = account(real, real + 30000000000n);
      s.engine.onAccount(mint, 20, curve);
      s.engine.agentTransaction(tx(`t-${real}-${enabled}`, 20, [event(mint, reserves(curve))]));
      assert.equal(Boolean(pending(s)), entered, `${real} ${enabled}`);
      const recorded = s.store.get('SELECT outcome FROM paper_agent_events WHERE signature=?', `t-${real}-${enabled}`)?.outcome;
      assert.equal(recorded, entered ? 'buy_pending' : 'capped_budget_skipped');
      if (entered) assert.ok(BigInt(JSON.parse(pending(s).quote_json).requestedBudgetLamports) <= 10000000n);
    } finally { s.close(); }
  }
});
