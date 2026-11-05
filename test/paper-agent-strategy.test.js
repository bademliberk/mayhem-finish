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
import { reserves, liquidityBudget, entryQuote, entryQuality } from '../src/paper-math.js';
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

test('timeout triggers on slots without changed accounts, stays mandatory, and never fabricates illiquid sale', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); s.engine.onSlot(22); assert.equal(pending(s), undefined);
    s.engine.onSlot(23); assert.equal(watch(s).reason, 'timeout'); assert.equal(pending(s).reason, 'timeout');
    s.engine.onAccount(mint, 23, account(0n)); s.snapshot(account(0n), 23);
    await s.engine.reconcile(pending(s)); assert.ok(position(s)); assert.equal(watch(s).reason, 'timeout');
    // Cancel/expiry does not lose intent; fresh funded state permits a later full exit.
    s.engine.cancel(pending(s).id, 100000, 'test'); s.engine.onAccount(mint, 24, account()); s.snapshot(account(), 24);
    assert.equal(pending(s).reason, 'timeout'); await s.engine.reconcile(pending(s)); assert.equal(position(s), undefined);
  } finally { s.close(); }
});

test('stale accounts cannot prevent timeout latch or authorize a quote', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); s.now(106000); s.engine.onSlot(23);
    assert.equal(watch(s).reason, 'timeout'); assert.equal(pending(s), undefined);
    s.engine.onAccount(mint, 23, account()); assert.equal(pending(s).reason, 'timeout');
  } finally { s.close(); }
});

test('graduated and drained holdings remain unresolved, never simulated as exited', async () => {
  const s = setup({ holdSlots: 3 }); try {
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

test('quiet liquid holding refreshes at the default timeout and exits without an account notification', async () => {
  const s = setup(); try {
    await buy(s); let calls = 0, slot = 20;
    s.rpc.accounts = async () => { calls++; return snapshotOf(account(), slot); };
    for (slot = 21; slot <= 100; slot++) { s.now(100000 + (slot - 20) * 400); s.engine.onSlot(slot); await s.engine.tick(); }
    assert.equal(calls, 2); assert.equal(position(s), undefined); assert.equal(watch(s).reason, 'timeout');
  } finally { s.close(); }
});

test('missing holding state is refreshed before a mandatory timeout quote', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); s.engine.states.delete(mint); s.engine.onSlot(23); s.snapshot(account(), 23);
    assert.equal(pending(s), undefined); assert.equal(watch(s).reason, 'timeout');
    await s.engine.tick(); assert.equal(position(s), undefined);
  } finally { s.close(); }
});

test('timeout refresh failures are rate limited and do not fabricate fills', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); let calls = 0; s.rpc.accounts = async () => { calls++; throw new Error('offline'); };
    s.now(106000); s.engine.onSlot(23); await s.engine.tick(); assert.equal(calls, 1);
    await s.engine.tick(); assert.equal(calls, 1); assert.ok(position(s)); assert.equal(pending(s), undefined);
    s.now(111001); s.engine.onSlot(24); await s.engine.tick(); assert.equal(calls, 2); assert.ok(position(s));
  } finally { s.close(); }
});

test('gap and shutdown abort stale-holding refreshes and ignore late results', async () => {
  for (const kind of ['gap', 'stop']) {
    const s = setup({ holdSlots: 3 }); try {
      await buy(s); const wait = deferred(); let signal;
      s.rpc.accounts = (_addresses, options) => { signal = options.signal; return wait.promise; };
      s.now(106000); s.engine.onSlot(23); const work = s.engine.tick();
      assert.ok(signal); const stop = kind === 'stop' ? s.engine.stop() : (s.engine.gap('test'), Promise.resolve());
      assert.equal(signal.aborted, true); wait.resolve(snapshotOf(account(), 23)); await work; await stop;
      assert.ok(position(s)); assert.equal(pending(s), undefined); assert.equal(s.engine.exitRefreshes.size, 0);
    } finally { s.close(); }
  }
});

test('quiet-holding refresh ignores a response after its own deadline', async () => {
  const s = setup({ holdSlots: 3 }); try {
    await buy(s); const wait = deferred(); s.rpc.accounts = () => wait.promise;
    s.now(106000); s.engine.onSlot(23); const work = s.engine.tick();
    s.now(111000); wait.resolve(snapshotOf(account(), 23)); await work;
    assert.equal(s.engine.states.get(mint).slot, 20); assert.ok(position(s)); assert.equal(pending(s), undefined);
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

test('agent reports preserve integer evidence and support missing new sample table in read-only legacy views', () => {
  const s = setup(); try {
    s.engine.agentTransaction(tx()); const report = s.engine.paper.report(100000);
    assert.equal(report.exposure.reservedLamports, '4810000'); assert.equal(report.recentAgentEvents[0].outcome, 'buy_pending');
    assert.equal(report.recentOrders[0].diagnostics.referenceRealSolLamports, '40000000');
    const readonly = Object.assign(Object.create(PaperStore.prototype), { store: s.store, cfg: config });
    s.store.db.exec('DROP TABLE paper_agent_events'); assert.deepEqual(readonly.report().recentAgentEvents, []);
  } finally { s.close(); }
});
