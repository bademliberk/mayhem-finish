import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { PUMP } from '../src/config.js';
import { Store } from '../src/store.js';
import { PaperStore, paperConfig } from '../src/paper-store.js';
import { PaperEngine } from '../src/paper-engine.js';
import { fullSaleGross, liquidityRisk, reserves, exitQuote } from '../src/paper-math.js';
import { trialPath, bindTrial, preflightTrial } from '../src/paper-profiles.js';

const mint = '9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const storeConfig = { firstCheck: 30, recheck: 30, horizon: 86400, paperMode: true };
const config = paperConfig({}, 'liquidity-exit100');
const tokens = 50000000000n;
// Synthetic prefix-layout accounts, not historical captures.
function account(realSol = 1000000000n, virtualSol = 200000000n, complete = false) {
  const b = Buffer.alloc(166); Buffer.from([23,183,248,55,96,216,172,96]).copy(b);
  b.writeBigUInt64LE(1000000000000n, 8); b.writeBigUInt64LE(virtualSol, 16);
  b.writeBigUInt64LE(900000000000n, 24); b.writeBigUInt64LE(realSol, 32);
  b.writeBigUInt64LE(1000000000000n, 40); b[48] = Number(complete); b[81] = 1;
  return { owner: PUMP, data: [b.toString('base64'), 'base64'] };
}
const gross = fullSaleGross(reserves(account()), tokens);
function attach(engine) {
  engine.attach({ add() {}, remove() {}, setPreprocessed() {}, covers: () => true, start() {}, stop() {} });
}
function setup(options = {}, path = ':memory:') {
  const store = new Store(path, storeConfig);
  store.addMint({ mint, timestamp: 100 });
  let now = 100000, confirmed = account(), slot = 20;
  const rpc = { accounts: async () => ({ context: { slot }, value: [confirmed] }),
    call: async () => ({ value: [{ slot: 20, err: null, confirmationStatus: 'confirmed' }] }) };
  const engine = new PaperEngine(store, rpc, { ...config, ...options }, { now: () => now, project: raw => raw });
  attach(engine); engine.add(mint); engine.onReady(); engine.onSlot(20);
  const quote = { tokens: tokens.toString(), cost: '10010000' };
  engine.paper.request(mint, 'buy', 'dump', quote, null, now);
  engine.paper.fill(engine.paper.pending()[0], quote, now);
  engine.onAccount(mint, 19, account());
  return { store, rpc, engine, setNow: value => { now = value; },
    confirmed: (value, at = 20) => { confirmed = value; slot = at; }, close: () => store.close() };
}
const pending = s => s.engine.paper.pending()[0];
const watch = s => s.engine.paper.watch(mint);
const position = s => s.engine.paper.position(mint);
function profit(s) {
  s.engine.signal({ signature: 'profit', slot: 20, mint, state: reserves(account(1000000000n, 400000000n)) });
  assert.equal(pending(s).reason, 'profit');
}

test('full-position BigInt requirement is independent of feasibility, fees and safe-number limits', () => {
  const state = reserves(account()), position = { tokens_raw: tokens.toString() };
  assert.equal(gross, tokens * state.virtualSol / (state.virtualTokens + tokens));
  assert.equal(fullSaleGross({ ...state, realSol: 0n }, tokens), gross);
  const net = BigInt(exitQuote(state, position, config).net);
  assert.ok(2n * gross - 1n > 2n * net);
  for (const delta of [-1n, 0n, 1n]) {
    assert.equal(liquidityRisk({ ...state, realSol: 2n * gross + delta }, position, config), delta <= 0n);
  }
  assert.equal(liquidityRisk({ ...state, realSol: 2n * gross }, { tokens_raw: (tokens / 2n).toString() }, config), false);
  const huge = { ...state, virtualTokens: 10n ** 24n, virtualSol: 10n ** 23n };
  assert.equal(fullSaleGross(huge, 10n ** 24n), 5n * 10n ** 22n);
  assert.equal(liquidityRisk({ ...state, realSol: 0n }, position, paperConfig({}, 'liquidity20')), false);
  assert.equal(liquidityRisk({ ...state, complete: true }, position, config), false);
});

test('account equality latches before order creation, sizes the entire position and never churns pending orders', () => {
  const s = setup();
  try {
    s.engine.onAccount(mint, 20, account(2n * gross + 1n));
    assert.equal(watch(s).reason, null); assert.equal(pending(s), undefined);
    const request = s.engine.paper.request.bind(s.engine.paper);
    s.engine.paper.request = (...args) => {
      assert.equal(watch(s).reason, 'liquidity_risk'); assert.equal(watch(s).status, 'exit_blocked');
      return request(...args);
    };
    s.engine.onAccount(mint, 20, account(2n * gross));
    const order = pending(s);
    assert.equal(order.reason, 'liquidity_risk'); assert.equal(order.signal_signature, null);
    assert.equal(JSON.parse(order.quote_json).tokens, tokens.toString());
    for (let i = 0; i < 5; i++) s.engine.onAccount(mint, 20, account(2n * gross - BigInt(i)));
    s.engine.onAccount(mint, 20, account()); // Rebound does not rescind intent or reset TTL.
    assert.deepEqual(pending(s), order);
    assert.equal(s.store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").n, 1);
  } finally { s.close(); }
});

test('already illiquid and zero-net positions latch but never receive fabricated fills or partial exits', async () => {
  for (const real of [0n, gross - 1n]) {
    const s = setup();
    try {
      s.engine.onAccount(mint, 20, account(real)); s.confirmed(account(real));
      await s.engine.tick();
      assert.equal(watch(s).reason, 'liquidity_risk'); assert.ok(position(s)); assert.equal(pending(s), undefined);
      assert.equal(s.store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").n, 0);
      s.engine.onAccount(mint, 20, account(gross)); s.confirmed(account(gross));
      await s.engine.tick();
      assert.equal(position(s), undefined);
      const sold = s.store.get("SELECT fill_json FROM paper_orders WHERE side='sell'");
      assert.equal(JSON.parse(sold.fill_json).gross, gross.toString());
      assert.equal(JSON.parse(sold.fill_json).tokens, tokens.toString());
    } finally { s.close(); }
  }
  const s = setup({ networkFeeLamports: '10000000' });
  try {
    s.engine.onAccount(mint, 20, account(2n * gross)); await s.engine.tick();
    assert.ok(position(s)); assert.equal(pending(s), undefined); assert.equal(watch(s).reason, 'liquidity_risk');
    assert.throws(() => exitQuote(reserves(account()), position(s), { ...config, networkFeeLamports: '10000000' }), /fees/);
  } finally { s.close(); }
});

test('liquidity replaces profit once; floor overrides liquidity and remains mandatory after rebound', async () => {
  const s = setup();
  try {
    profit(s); const profitOrder = pending(s);
    s.engine.onAccount(mint, 20, account(2n * gross)); const risk = pending(s);
    assert.equal(s.store.get('SELECT error FROM paper_orders WHERE id=?', profitOrder.id).error, 'liquidity_risk_override');
    assert.equal(risk.reason, 'liquidity_risk');
    s.engine.onAccount(mint, 20, account());
    assert.equal(pending(s).id, risk.id);
    s.engine.requestExit(mint, reserves(account(1000000000n, 400000000n)), 'profit', { signature: 'ignored', slot: 20 });
    assert.equal(pending(s).id, risk.id);
    s.engine.onAccount(mint, 20, account(1000000000n, 100000000n));
    const floor = pending(s); assert.equal(floor.reason, 'floor'); assert.equal(watch(s).reason, 'floor');
    assert.equal(s.store.get('SELECT error FROM paper_orders WHERE id=?', risk.id).error, 'floor_override');
    s.engine.onAccount(mint, 20, account()); assert.equal(pending(s).id, floor.id);
    await s.engine.reconcile(floor);
    assert.equal(position(s), undefined); assert.equal(watch(s).reason, 'floor');
  } finally { s.close(); }
});

test('confirmed profit reconciliation rechecks risk before feasibility and latches even a drained snapshot', async () => {
  for (const real of [0n, 2n * gross]) {
    const s = setup();
    try {
      profit(s); const order = pending(s); s.confirmed(account(real));
      await s.engine.reconcile(order);
      assert.equal(watch(s).reason, 'liquidity_risk'); assert.ok(position(s));
      assert.equal(s.store.get('SELECT error FROM paper_orders WHERE id=?', order.id).error, 'liquidity_risk_override');
      if (real === 0n) assert.equal(pending(s), undefined);
      else {
        assert.equal(pending(s).reason, 'liquidity_risk'); assert.equal(pending(s).signal_signature, null);
        await s.engine.reconcile(pending(s)); assert.equal(position(s), undefined);
      }
    } finally { s.close(); }
  }
});

test('a confirmed risk override cannot fill from a snapshot older than its observed trigger', async () => {
  const s = setup();
  try {
    profit(s); s.confirmed(account(2n * gross), 25);
    await s.engine.reconcile(pending(s));
    const order = pending(s);
    assert.equal(order.reason, 'liquidity_risk');
    assert.equal(JSON.parse(order.quote_json).observationSlot, 25);
    s.confirmed(account(), 24); // Newer than streamed slot 19, but older than the actual trigger.
    await s.engine.reconcile(order);
    assert.ok(position(s)); assert.equal(pending(s).id, order.id);
    s.confirmed(account(), 25); await s.engine.reconcile(order);
    assert.equal(position(s), undefined);
  } finally { s.close(); }
});

test('a drained confirmed trigger replaces older liquid cached reserves before retry', async () => {
  const s = setup();
  try {
    profit(s); s.confirmed(account(0n), 25);
    await s.engine.reconcile(pending(s));
    assert.equal(s.engine.states.get(mint).slot, 25);
    assert.equal(s.engine.states.get(mint).state.realSol, 0n);
    assert.equal(watch(s).last_slot, 25);
    s.engine.onAccount(mint, 24, account()); // Older liquid state cannot revive exit availability.
    await s.engine.tick();
    assert.equal(pending(s), undefined); assert.ok(position(s));
    s.engine.onAccount(mint, 26, account()); s.confirmed(account(), 26);
    await s.engine.tick(); assert.equal(position(s), undefined);
  } finally { s.close(); }
});

test('confirmed floor overrides risk before a quote, even when full liquidity is unavailable', async () => {
  const s = setup();
  try {
    s.engine.onAccount(mint, 20, account(2n * gross)); const risk = pending(s);
    s.confirmed(account(0n, 100000000n)); await s.engine.reconcile(risk);
    assert.equal(watch(s).reason, 'floor'); assert.equal(pending(s), undefined); assert.ok(position(s));
    assert.equal(s.store.get('SELECT error FROM paper_orders WHERE id=?', risk.id).error, 'floor_override');
    s.engine.onAccount(mint, 20, account()); assert.equal(pending(s).reason, 'floor');
  } finally { s.close(); }
});

test('unconfirmed, failed and changed-slot profit triggers cannot latch projected liquidity risk', async () => {
  for (const status of [null, { slot: 20, err: null, confirmationStatus: 'processed' },
    { slot: 20, err: { failed: true }, confirmationStatus: 'confirmed' },
    { slot: 21, err: null, confirmationStatus: 'confirmed' }]) {
    const s = setup();
    try {
      profit(s); s.rpc.call = async () => ({ value: [status] });
      s.rpc.accounts = () => assert.fail('invalid trigger must not request confirmed reserves');
      await s.engine.reconcile(pending(s));
      assert.equal(watch(s).reason, null); assert.ok(position(s));
    } finally { s.close(); }
  }
});

test('risk exits can realize losses after a rebound and use a truthful confirmed-state model', async () => {
  const s = setup({ maxTrades: 1 });
  try {
    s.engine.cfg.entriesEnabled = false;
    assert.equal(s.engine.paper.capacity().remaining, 0);
    s.engine.onAccount(mint, 20, account(2n * gross));
    s.engine.onAccount(mint, 20, account());
    s.rpc.call = () => assert.fail('account-triggered exit has no signature to confirm');
    await s.engine.tick();
    assert.equal(position(s), undefined);
    const result = s.store.get("SELECT * FROM paper_orders WHERE side='sell'");
    assert.equal(result.reason, 'liquidity_risk');
    assert.equal(JSON.parse(result.fill_json).model, 'hypothetical_fill_confirmed_state');
    assert.ok(BigInt(s.store.get('SELECT pnl_lamports FROM paper_positions').pnl_lamports) < 0n);
  } finally { s.close(); }
});

test('expiry, slippage, invalid accounts and gaps preserve intent and require fresh observations to retry', async () => {
  for (const mode of ['expiry', 'slippage', 'invalid', 'gap']) {
    const s = setup();
    try {
      s.engine.onAccount(mint, 20, account(2n * gross)); const order = pending(s);
      if (mode === 'expiry') { s.setNow(110000); await s.engine.reconcile(order); }
      if (mode === 'slippage') { s.confirmed(account(2n * gross, 150000000n)); await s.engine.reconcile(order); s.setNow(106000); }
      if (mode === 'invalid') s.engine.onAccount(mint, 20, { ...account(), owner: 'wrong' });
      if (mode === 'gap') s.engine.gap('test');
      assert.equal(pending(s), undefined); assert.equal(watch(s).reason, 'liquidity_risk'); assert.ok(position(s));
      await s.engine.tick(); assert.equal(pending(s), undefined);
      s.engine.onAccount(mint, 21, account()); s.confirmed(account(), 21);
      assert.equal(pending(s).reason, 'liquidity_risk');
      await s.engine.tick(); assert.equal(position(s), undefined);
    } finally { s.close(); }
  }
});

test('signals cannot turn a mandatory exit back into profit; projected-only risk does not latch', () => {
  const s = setup();
  try {
    s.engine.signal({ signature: 'projected-risk', slot: 20, mint, state: reserves(account(2n * gross)) });
    assert.equal(watch(s).reason, null); assert.equal(pending(s), undefined);
    s.engine.onAccount(mint, 19, account(2n * gross));
    s.engine.paper.cancel(pending(s).id, 100000, 'test');
    s.engine.signal({ signature: 'rebound', slot: 20, mint, state: reserves(account(1000000000n, 400000000n)) });
    assert.equal(pending(s).reason, 'liquidity_risk');
    assert.equal(s.store.get("SELECT outcome FROM paper_signals WHERE signature='rebound'").outcome, 'mandatory_exit_pending');
  } finally { s.close(); }
});

test('old profiles do not opt in to liquidity exits', () => {
  for (const profile of [null, 'baseline', 'coverage20', 'liquidity20', 'drop50', 'window8']) {
    const s = setup({ ...paperConfig({}, profile), liquidityExitEnabled: undefined, liquidityExitMultiple: undefined });
    try {
      s.engine.onAccount(mint, 20, account(0n));
      assert.equal(watch(s).reason, null); assert.equal(watch(s).status, 'holding'); assert.equal(pending(s), undefined);
    } finally { s.close(); }
  }
});

test('fresh-state request checks reject stale, missing and detached account observations', () => {
  const s = setup();
  try {
    const row = s.engine.states.get(mint);
    s.engine.requestExit(mint, reserves(account(2n * gross)), 'liquidity_risk', null);
    assert.equal(watch(s).reason, null);
    row.state = reserves(account(2n * gross)); s.setNow(105001);
    s.engine.requestExit(mint, row.state, 'liquidity_risk', null);
    assert.equal(watch(s).reason, null); assert.equal(pending(s), undefined);
    s.engine.states.delete(mint); s.setNow(100000);
    s.engine.requestExit(mint, row.state, 'liquidity_risk', null);
    assert.equal(watch(s).reason, null);
  } finally { s.close(); }
});

test('confirmed account, context, deadline, generation and full-liquidity checks prevent fake fills', async () => {
  for (const mode of ['old-slot', 'invalid-owner', 'invalid-data', 'wrong-encoding', 'malformed-base64', 'empty-liquidity', 'expired', 'gap', 'invalidated', 'newer-observation']) {
    const s = setup();
    try {
      s.engine.onAccount(mint, 20, account(2n * gross)); const order = pending(s);
      let release; s.rpc.accounts = () => new Promise(resolve => { release = resolve; });
      const reconciling = s.engine.reconcile(order);
      let value = account(), slot = 20;
      if (mode === 'old-slot') slot = 19;
      if (mode === 'invalid-owner') value.owner = 'wrong';
      if (mode === 'invalid-data') value.data = ['AA==', 'base64'];
      if (mode === 'wrong-encoding') value.data[1] = 'base58';
      if (mode === 'malformed-base64') value.data[0] += '!';
      if (mode === 'empty-liquidity') value = account(0n);
      if (mode === 'expired') s.setNow(110000);
      if (mode === 'gap') s.engine.gap('during-confirmation');
      if (mode === 'invalidated') s.engine.onAccount(mint, 20, null);
      if (mode === 'newer-observation') s.engine.onAccount(mint, 21, account());
      release({ context: { slot }, value: [value] }); await reconciling;
      assert.ok(position(s), mode); assert.equal(watch(s).reason, 'liquidity_risk');
      assert.equal(s.store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='sell' AND status='filled'").n, 0);
    } finally { s.close(); }
  }
});

test('graduation blocks both observed and reconciliation-only liquidity exits without an AMM fill', async () => {
  for (const mode of ['account', 'confirmed']) {
    const s = setup();
    try {
      s.engine.onAccount(mint, 20, account(2n * gross));
      if (mode === 'account') s.engine.onAccount(mint, 20, account(2n * gross, 200000000n, true));
      else { s.confirmed(account(2n * gross, 200000000n, true)); await s.engine.reconcile(pending(s)); }
      assert.equal(watch(s).reason, 'graduated_no_amm_exit'); assert.equal(pending(s), undefined); assert.ok(position(s));
      s.engine.onAccount(mint, 21, account()); await s.engine.tick();
      assert.equal(pending(s), undefined); assert.ok(position(s));
    } finally { s.close(); }
  }
});

test('disk restart retains mandatory intent, cancels unknown pending fills and waits for fresh state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'liquidity-restart-')), path = trialPath('liquidity-exit100', dir);
  let store;
  try {
    const s = setup({}, path); store = s.store;
    s.engine.onAccount(mint, 20, account(2n * gross)); const id = pending(s).id;
    store.close(); store = new Store(path, storeConfig);
    const engine = new PaperEngine(store, s.rpc, config, { now: () => 100001, project: raw => raw });
    attach(engine); engine.start();
    assert.equal(engine.paper.watch(mint).reason, 'liquidity_risk');
    assert.equal(store.get('SELECT error FROM paper_orders WHERE id=?', id).error, 'restart_unreconciled');
    await engine.tick(); assert.equal(engine.paper.pending().length, 0);
    engine.onAccount(mint, 21, account()); s.confirmed(account(), 21);
    assert.equal(engine.paper.pending()[0].reason, 'liquidity_risk');
    await engine.tick(); assert.equal(engine.paper.position(mint), undefined);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('100-buy profile retains twenty-watch exposure, reserves the last buy atomically and resumes its own DB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'liquidity-cap-')), path = trialPath('liquidity-exit100', dir);
  let store;
  try {
    store = new Store(path, storeConfig); let paper = new PaperStore(store, config); bindTrial(store, config);
    for (let i = 1; i <= 99; i++) {
      const key = new PublicKey(Buffer.alloc(32, i)).toBase58(); store.addMint({ mint: key, timestamp: 100 });
      assert.equal(paper.enroll(key, 100000), true);
      paper.request(key, 'buy', 'dump', {}, null, 100000);
      paper.fill(paper.pending()[0], { tokens: '100', cost: '1000' }, 100001);
      paper.request(key, 'sell', 'profit', {}, null, 100002);
      paper.fill(paper.pending()[0], { net: '1400' }, 100003);
      assert.ok(paper.active().length <= 20);
    }
    const keys = [100, 101].map(i => new PublicKey(Buffer.alloc(32, i)).toBase58());
    for (const key of keys) { store.addMint({ mint: key, timestamp: 100 }); assert.equal(paper.enroll(key, 100004), true); }
    assert.ok(paper.request(keys[0], 'buy', 'dump', {}, null, 100004));
    assert.equal(paper.request(keys[1], 'buy', 'dump', {}, null, 100004), null);
    assert.equal(paper.capacity().remaining, 0);
    paper.cancel(paper.pending()[0].id, 100005, 'test');
    assert.ok(paper.request(keys[1], 'buy', 'dump', {}, null, 100006));
    paper.fill(paper.pending()[0], { tokens: '100', cost: '1000' }, 100007);
    assert.equal(paper.capacity().successfulBuys, 100); store.close();
    preflightTrial(path, config);
    assert.throws(() => preflightTrial(path, paperConfig({}, 'liquidity20')), /not this trial/);
    assert.throws(() => preflightTrial(path, { ...config, liquidityExitMultiple: 3 }), /not this trial/);
    assert.notEqual(path, trialPath('liquidity20', dir));
    store = new Store(path, storeConfig); paper = new PaperStore(store, config); bindTrial(store, config);
    assert.equal(paper.capacity().remaining, 0); assert.equal(paper.capacity().successfulBuys, 100);
    assert.equal(paper.request(keys[0], 'buy', 'dump', {}, null, 100008), null);
    assert.ok(paper.request(keys[1], 'sell', 'liquidity_risk', {}, null, 100008));
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
