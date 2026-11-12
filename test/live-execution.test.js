import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PUMP, MAYHEM } from '../src/config.js';
import { Store } from '../src/store.js';
import { PaperEngine } from '../src/paper-engine.js';
import { paperConfig, liveConfig } from '../src/paper-store.js';
import { reserves } from '../src/paper-math.js';
import { trialIdentity, livePath } from '../src/paper-profiles.js';
import { safeOrderDiagnostics } from '../src/paper-diagnostics.js';
import { LiveExecutor, liveSettings, ownerDelta } from '../src/live-executor.js';

// Synthetic accounts, events and a fake executor only: no wallet, provider or network access.
const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58();
const mint = key(1), mint2 = key(2), actor = key(3);
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const sig = n => bs58.encode(Buffer.alloc(64, n));
const RENT = 2039280n;
const limits = { minWalletLamports: '0', maxLossLamports: '100000000', perTradeReserveLamports: '3000000', exitSlippageBps: 2000 };
const liveCfg = (overrides = {}, mode = 'live') => ({ ...paperConfig({}, 'agent-sell-liquidity'), mode, live: limits, ...overrides });
const storeConfig = { firstCheck: 30, recheck: 30, horizon: 86400, paperMode: true };

function account(real = 40000000n, virtual = 140000000n, complete = false, realTokens = 800000000000n) {
  const b = Buffer.alloc(166); Buffer.from([23,183,248,55,96,216,172,96]).copy(b);
  b.writeBigUInt64LE(1000000000000n, 8); b.writeBigUInt64LE(virtual, 16);
  b.writeBigUInt64LE(realTokens, 24); b.writeBigUInt64LE(real, 32);
  b.writeBigUInt64LE(1000000000000n, 40); b[48] = Number(complete); b[81] = 1;
  return { owner: PUMP, data: [b.toString('base64'), 'base64'] };
}
function event(m = mint, state = reserves(account())) {
  const b = Buffer.alloc(129); Buffer.from([189,219,127,211,78,230,97,238]).copy(b);
  new PublicKey(m).toBuffer().copy(b, 8); b.writeBigUInt64LE(10000000n, 40); b.writeBigUInt64LE(10000000000n, 48);
  new PublicKey(actor).toBuffer().copy(b, 57); b.writeBigInt64LE(1700000000n, 89);
  for (const [name, offset] of [['virtualSol',97], ['virtualTokens',105], ['realSol',113], ['realTokens',121]]) b.writeBigUInt64LE(state[name], offset);
  return `Program data: ${b.toString('base64')}`;
}
function tx(signature = 'sell-a', slot = 20, m = mint) {
  return { signature, slot, transaction: { signatures: [signature] }, meta: { err: null, logMessages: [
    `Program ${MAYHEM} invoke [1]`, `Program ${PUMP} invoke [2]`, event(m), `Program ${PUMP} success`, `Program ${MAYHEM} success`,
  ] } };
}

function fakeExecutor() {
  let n = 0;
  const ex = {
    calls: [], balanceValue: 1000000000n, held: new Set(), tokens: 0n, height: 100,
    submitResult: null, resolveResult: () => ({ status: 'unknown' }),
    async balance() { return ex.balanceValue; },
    async heldMints() { return ex.held; },
    async tokenBalance(m, program) { ex.calls.push(['tokenBalance', m, program]); return ex.tokens; },
    async mintTokenProgram() { return TOKEN_PROGRAM; },
    async blockHeight() { return ex.height; },
    overhead: 0n,
    maxOverheadLamports() { return ex.overhead; },
    async prepareBuy(m, lamports, slippage, confirmed) {
      ex.calls.push(['prepareBuy', m, lamports, Boolean(confirmed)]);
      return { mint: m, signature: sig(++n), wire: 'w', lastValidBlockHeight: 150, tokenProgram: TOKEN_PROGRAM, lamports };
    },
    async prepareSell(m, tokens, min, close, slippage, mode) {
      ex.calls.push(['prepareSell', m, tokens, min, close, slippage, mode]);
      const burned = mode === 'capped' && ex.burnOnCapped ? ex.burnOnCapped : 0n;
      return { mint: m, signature: sig(++n), wire: 'w', lastValidBlockHeight: 150, tokenProgram: TOKEN_PROGRAM, tokens,
        soldTokens: (tokens - burned).toString(), burnedTokens: burned.toString() };
    },
    async submit(prepared) { ex.calls.push(['submit', prepared.signature]); return ex.submitResult(prepared); },
    async resolve(signature) { ex.calls.push(['resolve', signature]); return ex.resolveResult(signature); },
  };
  return ex;
}
// A confirmed curve buy: SOL leaves the wallet (swap + fees + new token-account rent), tokens arrive.
const bought = (spent = 4810000n, tokens = 100000000n) => p => ({ signature: p.signature, status: 'ok', slot: 21,
  lamports: -(spent + RENT), ataLamports: RENT, tokens, postTokens: tokens, fee: 5000n, err: null });
const sold = (proceeds, tokens) => p => ({ signature: p.signature, status: 'ok', slot: 30,
  lamports: proceeds + RENT, ataLamports: -RENT, tokens: -tokens, postTokens: 0n, fee: 5000n, err: null });

function setup({ cfg = liveCfg(), path = ':memory:', ex = fakeExecutor() } = {}) {
  const store = new Store(path, storeConfig); store.addMint({ mint, timestamp: 100 }); store.addMint({ mint: mint2, timestamp: 100 });
  let now = 100000;
  const rpc = { accounts: async () => ({ context: { slot: 20 }, value: [account()] }),
    call: async () => ({ value: [{ slot: 20, err: null, confirmationStatus: 'confirmed' }] }) };
  const logs = [];
  const engine = new PaperEngine(store, rpc, cfg, { now: () => now, project: raw => raw, executor: ex, log: line => logs.push(JSON.parse(line)) });
  engine.attach({ add() {}, remove() {}, setPreprocessed() {}, covers: () => true, start() {}, stop() {}, resync() {} });
  engine.add(mint); engine.add(mint2); engine.onReady(); engine.onSlot(20);
  engine.onAccount(mint, 20, account()); engine.onAccount(mint2, 20, account()); engine.coverage(mint); engine.coverage(mint2);
  return { store, rpc, engine, ex, logs, now: value => { now = value; }, close: () => store.close() };
}
const pending = s => s.engine.paper.pending()[0];
const position = (s, m = mint) => s.engine.paper.position(m);
const order = (s, id) => s.store.get('SELECT * FROM paper_orders WHERE id=?', id);
const diag = (s, id) => JSON.parse(order(s, id).diagnostics_json);
async function entry(s, m = mint) {
  s.engine.agentTransaction(tx(`sell-${m}`, 20, m));
  const row = s.engine.paper.pending().find(o => o.mint === m); assert.ok(row, 'buy requested');
  await s.engine.reconcile(row);
  return row;
}

test('live diagnostics keep the signature, stage and token program needed to resolve after a crash', () => {
  const value = safeOrderDiagnostics({ stage: 'live_unknown', liveSignature: sig(1), liveTokenProgram: TOKEN_PROGRAM,
    liveSubmittedAtMs: 5, liveLastValidBlockHeight: 150, liveStatus: 'unknown', liveError: 'curve_complete', liveErrorCode: -32002 });
  assert.deepEqual(value, { stage: 'live_unknown', liveSignature: sig(1), liveTokenProgram: TOKEN_PROGRAM, liveSubmittedAtMs: 5,
    liveLastValidBlockHeight: 150, liveStatus: 'unknown', liveError: 'curve_complete', liveErrorCode: -32002 });
  // Arbitrary text, URLs or payloads are still dropped.
  assert.deepEqual(safeOrderDiagnostics({ liveSignature: 'https://x/?api-key=secret', liveError: 'Error: api-key=abc', liveStatus: 'weird' }), {});
});

test('live and dry-run trials have their own identities and databases; risk limits are not identity', () => {
  const paper = paperConfig({}, 'agent-sell-liquidity'), live = liveConfig({}), dry = liveConfig({ LIVE_DRY_RUN: 'true' });
  assert.equal(live.mode, 'live'); assert.equal(dry.mode, 'live_dry_run');
  assert.notEqual(trialIdentity(live), trialIdentity(paper)); assert.notEqual(trialIdentity(live), trialIdentity(dry));
  assert.equal(trialIdentity(liveConfig({ LIVE_MAX_LOSS_SOL: '5' })), trialIdentity(live));
  assert.throws(() => liveConfig({ LIVE_DRY_RUN: 'yes' }), /LIVE_DRY_RUN/);
  assert.throws(() => liveSettings({ LIVE_DRY_RUN: 'yes' }), /LIVE_DRY_RUN/);
  assert.notEqual(livePath(true), livePath(false));
  assert.throws(() => new PaperEngine(new Store(':memory:', storeConfig), {}, live, {}), /executor/);
  assert.throws(() => new PaperEngine(new Store(':memory:', storeConfig), {}, paper, { executor: fakeExecutor() }), /executor/);
});

test('a confirmed live buy is recorded from chain deltas, excluding refundable rent, even past the modeled exposure cap', async () => {
  // The cap admits the modeled reservation (budget + modeled fee) but not the real cost: a confirmed fill must still be recorded.
  const s = setup({ cfg: liveCfg({ maxExposureLamports: '4810000' }) });
  try {
    s.ex.submitResult = bought(4900000n);
    const row = await entry(s);
    const [, , budget, usedSnapshot] = s.ex.calls.find(c => c[0] === 'prepareBuy');
    assert.equal(budget, 4800000n); assert.equal(usedSnapshot, true, 'reuses the confirmed snapshot instead of a second curve read');
    assert.equal(order(s, row.id).status, 'filled');
    assert.equal(position(s).entry_cost_lamports, '4900000'); assert.equal(position(s).tokens_raw, '100000000');
    assert.equal(position(s).timeout_slot, 21 + 80);
    const fill = JSON.parse(order(s, row.id).fill_json);
    assert.equal(fill.tokenProgram, TOKEN_PROGRAM); assert.equal(fill.signature, sig(1));
    assert.equal(s.engine.submitted.size, 0);
    assert.equal(s.logs.find(l => l.event === 'live_fill').side, 'buy');
  } finally { s.close(); }
});

test('an unknown buy survives a restart, is never canceled by gaps or stops, and settles from chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-'));
  const path = join(dir, 'live.sqlite');
  try {
    const s = setup({ path });
    s.ex.submitResult = p => ({ signature: p.signature, status: 'unknown', lastValidBlockHeight: 150 });
    const row = await entry(s);
    assert.equal(order(s, row.id).status, 'pending'); assert.equal(diag(s, row.id).stage, 'live_unknown');
    assert.equal(diag(s, row.id).liveSignature, sig(1)); assert.equal(diag(s, row.id).liveTokenProgram, TOKEN_PROGRAM);
    s.engine.gap('test'); await s.engine.stop();
    assert.equal(order(s, row.id).status, 'pending', 'gap and stop must not cancel a possibly-landed transaction');
    s.close();

    const ex = fakeExecutor();
    const store = new Store(path, storeConfig);
    const engine = new PaperEngine(store, {}, liveCfg(), { now: () => 101000, project: raw => raw, executor: ex, log: () => {} });
    engine.attach({ add() {}, remove() {}, setPreprocessed() {}, covers: () => true, start() {}, stop() {}, resync() {} });
    try {
      engine.start();
      assert.equal(store.get('SELECT status FROM paper_orders WHERE id=?', row.id).status, 'pending');
      assert.ok(engine.submitted.has(row.id));
      ex.resolveResult = signature => ({ ...bought()({ signature }) });
      await engine.tick();
      assert.equal(store.get('SELECT status FROM paper_orders WHERE id=?', row.id).status, 'filled');
      assert.equal(JSON.parse(store.get('SELECT fill_json FROM paper_orders WHERE id=?', row.id).fill_json).tokenProgram, TOKEN_PROGRAM);
      assert.ok(engine.paper.position(mint));
    } finally { await engine.stop(); store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unseen submission is canceled only once its blockhash can no longer land', async () => {
  const s = setup();
  try {
    s.ex.submitResult = p => ({ signature: p.signature, status: 'unknown' });
    const row = await entry(s);
    s.ex.height = 150; await s.engine.tick();
    assert.equal(order(s, row.id).status, 'pending', 'still valid at lastValidBlockHeight');
    s.ex.height = 151; s.now(103000); await s.engine.tick();
    assert.equal(order(s, row.id).status, 'canceled'); assert.equal(order(s, row.id).error, 'live_expired_unseen');
    assert.equal(s.engine.submitted.size, 0); assert.equal(position(s), undefined);
  } finally { s.close(); }
});

test('a fill that cannot be recorded stays submitted, halts entries and is recorded on a later tick', async () => {
  const s = setup();
  try {
    s.ex.submitResult = bought();
    const fill = s.engine.paper.fill.bind(s.engine.paper);
    s.engine.paper.fill = () => false;
    const row = await entry(s);
    assert.equal(order(s, row.id).status, 'pending'); assert.ok(s.engine.submitted.has(row.id));
    assert.equal(s.engine.liveHalted, 'record_failed');
    s.engine.paper.fill = fill; s.ex.resolveResult = signature => bought()({ signature });
    await s.engine.tick();
    assert.equal(order(s, row.id).status, 'filled'); assert.ok(position(s));
  } finally { s.close(); }
});

test('live buys respect the worst-case loss budget, in-flight buys and foreign wallet holdings', async () => {
  const s = setup({ cfg: liveCfg({ live: { ...limits, maxLossLamports: '4000000' } }) });
  try {
    const row = await entry(s);
    assert.equal(order(s, row.id).error, 'live_loss_budget');
    assert.equal(s.ex.calls.some(c => c[0] === 'submit'), false);
  } finally { s.close(); }
  const t = setup();
  try {
    t.ex.held = new Set([mint]);
    await t.engine.liveStartupChecks();
    t.engine.agentTransaction(tx('foreign', 20));
    assert.equal(pending(t), undefined, 'no order is requested for a mint the wallet already holds');
    assert.equal(t.store.get('SELECT outcome FROM paper_agent_events WHERE signature=?', 'foreign').outcome, 'live_foreign_holding');
    assert.equal(t.ex.calls.some(c => c[0] === 'submit'), false);
  } finally { t.close(); }
});

test('startup closes an open position the wallet no longer holds at zero recovery and keeps going', async () => {
  const s = setup();
  try {
    s.ex.submitResult = bought();
    await entry(s);
    const cost = BigInt(position(s).entry_cost_lamports);
    s.ex.held = new Set();
    await s.engine.liveStartupChecks();
    assert.equal(position(s), undefined, 'closed');
    const closed = s.store.get('SELECT * FROM paper_positions WHERE mint=?', mint);
    assert.equal(closed.status, 'closed'); assert.equal(closed.exit_net_lamports, '0'); assert.equal(BigInt(closed.pnl_lamports), -cost);
    assert.equal(s.store.get('SELECT reason FROM paper_orders WHERE id=?', closed.exit_order_id).reason, 'external_exit');
    assert.equal(s.engine.paper.watch(mint).reason, 'external_exit');
    assert.equal(s.engine.liveHalted, null, 'no halt');
    assert.ok(s.logs.some(l => l.event === 'live_external_exit' && l.reason === 'missing_at_startup'));
  } finally { s.close(); }
});

test('mandatory live exits sell only the trial balance with a bounded minimum and back off after failures', async () => {
  const s = setup();
  try {
    s.ex.submitResult = bought();
    await entry(s);
    s.ex.tokens = 150000000n; // wallet also holds 0.5x of tokens this trial did not buy
    s.ex.submitResult = p => ({ signature: p.signature, status: 'failed', err: { InstructionError: [2, { Custom: 6003 }] } });
    assert.equal(s.engine.liveExit(mint, 'timeout', 'stale_observation', {}), false);
    await Promise.all([...s.engine.reconciliations.values()].map(a => a.promise));
    const call = s.ex.calls.find(c => c[0] === 'prepareSell');
    assert.deepEqual(call.slice(2), [100000000n, null, false, 2000, 'full'], 'own tokens only, fresh-quote minimum, keep the account open, full sale first');
    const failed = s.store.get("SELECT * FROM paper_orders WHERE side='sell' ORDER BY id DESC LIMIT 1");
    assert.equal(failed.error, 'live_failed'); assert.equal(JSON.parse(failed.diagnostics_json).failure.customCode, 6003);
    const sells = () => s.ex.calls.filter(c => c[0] === 'prepareSell');
    // The first failed full sale is retried at once, as a capped sale + burn.
    s.engine.liveExit(mint, 'timeout', 'stale_observation', {});
    await Promise.all([...s.engine.reconciliations.values()].map(a => a.promise));
    assert.equal(sells().length, 2, 'immediate retry after the first failure');
    assert.equal(sells()[1][6], 'capped', 'retry sells what the curve can pay');
    // A second failure backs off.
    s.engine.liveExit(mint, 'timeout', 'stale_observation', {});
    assert.equal(sells().length, 2, 'no retry inside the backoff window after a second failure');
    s.now(105000); s.ex.tokens = 100000000n; s.ex.submitResult = sold(6000000n, 100000000n);
    s.engine.liveExit(mint, 'timeout', 'stale_observation', {});
    await Promise.all([...s.engine.reconciliations.values()].map(a => a.promise));
    assert.equal(sells().length, 3);
    assert.equal(position(s), undefined);
    const closed = s.store.get('SELECT * FROM paper_positions WHERE mint=?', mint);
    assert.equal(closed.exit_net_lamports, '6000000'); assert.equal(closed.pnl_lamports, (6000000n - 4810000n).toString());
  } finally { s.close(); }
});

test('a sell with no wallet tokens closes the position at zero recovery, unsubscribes, and keeps trading', async () => {
  const s = setup();
  try {
    s.ex.submitResult = bought();
    await entry(s);
    const cost = BigInt(position(s).entry_cost_lamports);
    const removed = []; s.engine.feeds.remove = m => removed.push(m);
    s.ex.tokens = 0n;
    s.engine.liveExit(mint, 'timeout', 'stale_observation', {});
    await Promise.all([...s.engine.reconciliations.values()].map(a => a.promise));
    assert.equal(position(s), undefined, 'position closed');
    const closed = s.store.get('SELECT * FROM paper_positions WHERE mint=?', mint);
    assert.equal(closed.exit_net_lamports, '0'); assert.equal(BigInt(closed.pnl_lamports), -cost, 'full cost counted as a loss');
    assert.equal(s.engine.paper.watch(mint).status, 'closed'); assert.equal(s.engine.paper.watch(mint).reason, 'external_exit');
    assert.deepEqual(removed, [mint], 'unsubscribed');
    assert.equal(s.engine.liveHalted, null, 'no halt');
    assert.equal(s.ex.calls.filter(c => c[0] === 'submit').length, 1, 'only the buy was submitted');
    // Trading continues: the other mint can still be bought.
    s.engine.onAccount(mint2, 20, account()); s.engine.coverage(mint2);
    s.engine.agentTransaction(tx('next', 20, mint2));
    assert.ok(s.engine.paper.pending().some(o => o.mint === mint2 && o.side === 'buy'), 'new buy requested');
    s.ex.held = new Set();
    await s.engine.liveStartupChecks();
  } finally { s.close(); }
});

test('graduated live holdings are reported for manual sale, never written off', async () => {
  const s = setup();
  try {
    s.ex.submitResult = bought();
    await entry(s);
    s.engine.onAccount(mint, 25, account(40000000n, 140000000n, true));
    assert.ok(position(s)); assert.equal(s.engine.paper.watch(mint).reason, 'graduated_live_unsellable');
    assert.equal(s.logs.find(l => l.event === 'live_manual_action').reason, 'graduated_held_tokens');
  } finally { s.close(); }
});

test('dry run simulates buys, records passing ones at the modeled quote and never submits anything', async () => {
  const s = setup({ cfg: liveCfg({}, 'live_dry_run') });
  try {
    s.ex.submitResult = p => ({ signature: p.signature, status: 'simulated', simulationError: null, unitsConsumed: 71234 });
    const row = await entry(s);
    assert.equal(order(s, row.id).status, 'filled');
    const fill = JSON.parse(order(s, row.id).fill_json);
    assert.equal(fill.dryRun.simulatedBuy, true); assert.equal(fill.model, 'hypothetical_fill_after_confirmed_trigger');
    assert.equal(s.engine.submitted.size, 0);
    // A failing simulation cancels with a fixed failure code.
    s.ex.submitResult = p => ({ signature: p.signature, status: 'simulated', simulationError: { InstructionError: [3, { Custom: 6002 }] } });
    const second = await entry(s, mint2);
    assert.equal(order(s, second.id).error, 'live_simulation_failed');
    assert.equal(position(s, mint2), undefined);
    assert.equal(s.logs.filter(l => l.event === 'live_dry_run').map(l => l.ok).join(), 'true,false');
  } finally { s.close(); }
});

test('ownerDelta reports wallet, token-account rent and token changes for the owner only', () => {
  const owner = key(9), other = key(8);
  const delta = ownerDelta({ transaction: { message: { accountKeys: [{ pubkey: owner }, { pubkey: key(7) }, { pubkey: other }] } },
    meta: { err: null, fee: 5000, preBalances: [100000000, 0, 5], postBalances: [93000000, 2039280, 5],
      preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, owner, mint, uiTokenAmount: { amount: '777' } },
        { accountIndex: 2, owner: other, mint, uiTokenAmount: { amount: '5' } }] } }, owner, mint);
  assert.equal(delta.lamports, -7000000n); assert.equal(delta.ataLamports, 2039280n); assert.equal(delta.tokens, 777n);
});

test('the executor reports an explicit Sender refusal as rejected and dry-run simulation as simulated', async () => {
  const settings = { ...liveSettings({}), senderUrl: 'http://sender.test' };
  const responses = [];
  const fetchFn = async (url, init) => { responses.push(JSON.parse(init.body).method); return { json: async () => responses.at(-1) === 'sendTransaction'
    ? { error: { code: -32602, message: 'invalid tip' } } : { result: { value: { err: null, unitsConsumed: 9 } } } }; };
  const ex = new LiveExecutor({ wallet: Keypair.generate(), apiKey: 'k', settings, fetchFn, connection: {}, sdk: {} });
  ex.senderUrl = 'http://sender.test/fast';
  assert.equal((await ex.submit({ signature: sig(1), wire: 'AA==', mint })).status, 'rejected');
  ex.settings = { ...settings, dryRun: true };
  const sim = await ex.submit({ signature: sig(2), wire: 'AA==', mint });
  assert.equal(sim.status, 'simulated'); assert.equal(sim.unitsConsumed, 9);
  assert.deepEqual(responses, ['sendTransaction', 'simulateTransaction']);
});

test('startup tolerates a wallet/database mismatch while a submission is still being resolved from chain', async () => {
  const s = setup();
  try {
    s.ex.submitResult = bought();
    await entry(s);
    s.ex.tokens = 100000000n;
    s.ex.submitResult = p => ({ signature: p.signature, status: 'unknown' });
    s.engine.liveExit(mint, 'timeout', 'stale_observation', {});
    await Promise.all([...s.engine.reconciliations.values()].map(a => a.promise));
    // The sell landed before a crash: the wallet no longer holds the tokens, but the database has not seen it yet.
    s.ex.held = new Set();
    await s.engine.liveStartupChecks();
    s.ex.resolveResult = signature => sold(6000000n, 100000000n)({ signature });
    await s.engine.tick();
    assert.equal(position(s), undefined);
  } finally { s.close(); }
});

test('the first sale sells everything; after a failure the retry sells the payable part and burns the rest', async () => {
  const s = setup();
  try {
    s.ex.submitResult = bought();
    await entry(s);
    s.ex.tokens = 100000000n;
    const sell = { id: 0, side: 'sell', mint, reason: 'timeout' };
    await s.engine.liveBuild(sell, { terminalOutcome: 'partial_sale', soldTokens: '40000000', net: '1' });
    assert.deepEqual(s.ex.calls.at(-1).slice(2, 7), [100000000n, null, true, 2000, 'full'], 'first attempt: whole position');
    s.engine.liveExitFailed(mint, 'live_failed');
    await s.engine.liveBuild(sell, { net: '1' });
    assert.deepEqual(s.ex.calls.at(-1).slice(2, 7), [100000000n, null, true, 2000, 'capped'], 'retry: capped sale + burn, account closed');
    // A capped sale that burned the rest closes the position and is logged as a sale + burn.
    s.ex.burnOnCapped = 60000000n;
    s.ex.submitResult = p => sold(3000000n, 100000000n)(p);
    s.engine.liveExitFailures.get(mint).until = 0;
    s.engine.liveExit(mint, 'timeout', 'stale_observation', {});
    await Promise.all([...s.engine.reconciliations.values()].map(a => a.promise));
    assert.equal(position(s), undefined);
    const burnLog = s.logs.find(l => l.event === 'live_sell_and_burn');
    assert.deepEqual([burnLog.soldTokens, burnLog.burnedTokens], ['40000000', '60000000']);
    const fill = JSON.parse(s.store.get("SELECT fill_json FROM paper_orders WHERE side='sell' AND status='filled'").fill_json);
    assert.equal(fill.burnedTokens, '60000000');
  } finally { s.close(); }
});

test('leftover tokens a sale could not move are still reported as residual', async () => {
  const s = setup();
  try {
    s.ex.submitResult = bought();
    await entry(s);
    s.ex.tokens = 100000000n;
    s.ex.submitResult = p => ({ ...sold(3000000n, 40000000n)(p), postTokens: 60000000n });
    s.engine.liveExit(mint, 'timeout', 'stale_observation', {});
    await Promise.all([...s.engine.reconciliations.values()].map(a => a.promise));
    assert.equal(position(s), undefined);
    assert.equal(s.logs.find(l => l.reason === 'residual_tokens_after_exit').tokens, '60000000');
  } finally { s.close(); }
});

test('only one live buy runs at a time, and exit backoff stops new sell orders being created', async () => {
  const s = setup();
  try {
    s.engine.liveBuying.add(999);
    const row = await entry(s);
    assert.equal(order(s, row.id).error, 'live_buy_in_flight');
    assert.equal(s.ex.calls.some(c => c[0] === 'prepareBuy'), false);
  } finally { s.close(); }
  const t = setup();
  try {
    t.ex.submitResult = bought();
    await entry(t);
    t.engine.liveExitFailed(mint, 'live_failed');
    const before = t.store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").n;
    t.engine.latchExit(mint, 'timeout');
    t.engine.requestExit(mint, t.engine.states.get(mint).state, 'timeout', null);
    assert.equal(t.store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").n, before);
  } finally { t.close(); }
});

test('the executor refuses to sign with a stale blockhash', () => {
  const ex = new LiveExecutor({ wallet: Keypair.generate(), apiKey: 'k', settings: liveSettings({}), connection: {}, sdk: {} });
  assert.throws(() => ex.compile([], 100000), /blockhash_unavailable/);
  ex.blockhash = { blockhash: bs58.encode(Buffer.alloc(32, 4)), lastValidBlockHeight: 10, at: Date.now() - 60000 };
  assert.throws(() => ex.compile([], 100000), /blockhash_unavailable/);
  ex.blockhash.at = Date.now();
  assert.equal(ex.compile([], 100000).lastValidBlockHeight, 10);
});

// ---- Real pump-sdk instructions, offline: accounts encoded with the SDK's own coder, no network. ----
import { createRequire } from 'node:module';
import { VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
const require = createRequire(import.meta.url);
const BN = require('bn.js');
const { PUMP_SDK } = require('@pump-fun/pump-sdk');

async function sdkExecutor(settingsEnv = {}, rpcResults = {}) {
  const rand = () => Keypair.generate().publicKey;
  const curveData = await PUMP_SDK.offlinePumpProgram.coder.accounts.encode('bondingCurve', {
    virtualTokenReserves: new BN('1000000000000'), virtualQuoteReserves: new BN('30040000000'),
    realTokenReserves: new BN('800000000000'), realQuoteReserves: new BN('40000000'), tokenTotalSupply: new BN('1000000000000000'),
    complete: false, creator: rand(), isMayhemMode: true, isCashbackCoin: false, quoteMint: PublicKey.default, creatorFeeBps: new BN(0),
    canEditCreatorFee: false, isHolderReward: false });
  const global = { initialized: true, authority: rand(), feeRecipient: rand(), initialVirtualTokenReserves: new BN(0),
    initialVirtualSolReserves: new BN(0), initialRealTokenReserves: new BN(0), tokenTotalSupply: new BN('1000000000000000'),
    feeBasisPoints: new BN(95), withdrawAuthority: rand(), enableMigrate: true, poolMigrationFee: new BN(0),
    creatorFeeBasisPoints: new BN(30), feeRecipients: Array.from({ length: 7 }, rand), setCreatorAuthority: rand(),
    adminSetCreatorAuthority: rand(), createV2Enabled: true, whitelistPda: rand(), reservedFeeRecipient: rand(), mayhemModeEnabled: true,
    reservedFeeRecipients: Array.from({ length: 7 }, rand), isCashbackEnabled: false, buybackFeeRecipients: Array.from({ length: 8 }, rand),
    buybackBasisPoints: new BN(0), initialVirtualQuoteReserves: new BN(0), whitelistedQuoteMints: [PublicKey.default],
    creatorFeeConfigurable: false, maxConfigurableCreatorFeeBps: new BN(0), holderRewardClaimAuthority: rand(), isHolderRewardEnabled: false };
  const mintData = Buffer.alloc(82); mintData.writeBigUInt64LE(1000000000000000n, 36);
  const connection = { async getAccountInfo(key) {
    return key.toBase58() === mint ? { data: mintData, owner: new PublicKey(TOKEN_PROGRAM), lamports: 1, executable: false }
      : { data: curveData, owner: new PublicKey(PUMP), lamports: 1, executable: false };
  } };
  const methods = [];
  const fetchFn = async (url, init) => {
    const { method } = JSON.parse(init.body); methods.push(method);
    const result = rpcResults[method];
    return { json: async () => result instanceof Error ? { error: { code: -1 } } : { result } };
  };
  const ex = new LiveExecutor({ wallet: Keypair.generate(), apiKey: 'k', settings: liveSettings(settingsEnv), fetchFn, connection, sdk: {} });
  ex.fees = { global, feeConfig: null };
  ex.blockhash = { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 500, at: Date.now() };
  return { ex, methods, curveData };
}
function decoded(prepared) {
  const tx = VersionedTransaction.deserialize(Buffer.from(prepared.wire, 'base64'));
  const keys = tx.message.staticAccountKeys.map(k => k.toBase58());
  const ixs = tx.message.compiledInstructions.map(ix => ({ program: keys[ix.programIdIndex], data: Buffer.from(ix.data) }));
  const budget = ixs.filter(ix => ix.program === ComputeBudgetProgram.programId.toBase58());
  const price = budget.find(ix => ix.data[0] === 3).data.readBigUInt64LE(1);
  const limit = budget.find(ix => ix.data[0] === 2).data.readUInt32LE(1);
  const pump = ixs.filter(ix => ix.program === PUMP).map(ix => PUMP_SDK.offlinePumpProgram.coder.instruction.decode(ix.data));
  return { tx, price, limit, pump, programs: ixs.map(ix => ix.program) };
}

test('a real SDK buy caps swap SOL at the budget and takes slippage in tokens, with a dynamic priority price', async () => {
  const { ex, methods } = await sdkExecutor({}, { getPriorityFeeEstimate: { priorityFeeEstimate: 123456 } });
  await ex.refreshPriority();
  const prepared = await ex.prepareBuy(mint, 4800000n, 500);
  const { tx, price, limit, pump } = decoded(prepared);
  assert.equal(tx.signatures.length, 1); assert.equal(bs58.encode(tx.signatures[0]), prepared.signature);
  assert.equal(pump.length, 1); assert.equal(pump[0].name, 'buy');
  assert.equal(pump[0].data.maxSolCost.toString(), '4800000', 'max SOL cost is the budget itself, no slippage added');
  const full = BigInt(require('@pump-fun/pump-sdk').getBuyTokenAmountFromSolAmount({ global: ex.fees.global, feeConfig: null,
    mintSupply: new BN('1000000000000000'), bondingCurve: PUMP_SDK.decodeBondingCurve({ data: (await ex.curve(mint)).curveInfo.data }),
    amount: new BN(4800000), quoteMint: new PublicKey('So11111111111111111111111111111111111111112') }).toString());
  assert.equal(BigInt(pump[0].data.amount.toString()), full * 9500n / 10000n);
  assert.equal(price, 123456n); assert.equal(limit, 150000); assert.equal(prepared.microLamports, 123456);
  assert.equal(prepared.overheadLamports, 5000n + 5000n + 18519n);
  assert.deepEqual(methods, ['getPriorityFeeEstimate']);
});

test('priority price is clamped, falls back on estimate failure, and a fixed price skips the estimate', async () => {
  const high = await sdkExecutor({}, { getPriorityFeeEstimate: { priorityFeeEstimate: 9e9 } });
  await high.ex.refreshPriority();
  assert.equal(decoded(await high.ex.prepareBuy(mint, 4800000n, 500)).price, 2000000n);
  high.ex.priority.at = Date.now() - 61000;
  assert.equal(decoded(await high.ex.prepareBuy(mint, 4800000n, 500)).price, 10000n, 'stale estimate falls back to the floor');
  const failing = await sdkExecutor({}, { getPriorityFeeEstimate: new Error('x') });
  await assert.rejects(failing.ex.refreshPriority());
  assert.equal(decoded(await failing.ex.prepareBuy(mint, 4800000n, 500)).price, 10000n, 'floor when no estimate was ever seen');
  assert.deepEqual(high.methods, ['getPriorityFeeEstimate'], 'building a transaction makes no fee-estimate call');
  const fixed = await sdkExecutor({ AS_PRIORITY_MICROLAMPORTS: '777' });
  await fixed.ex.refreshPriority();
  assert.equal(decoded(await fixed.ex.prepareBuy(mint, 4800000n, 500)).price, 777n);
  assert.deepEqual(fixed.methods, []);
  assert.equal(fixed.ex.maxOverheadLamports('sell'), 5000n + 5000n + BigInt(Math.ceil(90000 * 777 / 1e6)));
  assert.throws(() => liveSettings({ AS_PRIORITY_LEVEL: 'Extreme' }), /AS_PRIORITY_LEVEL/);
});

test('a real SDK sell uses a fresh-quote minimum for mandatory exits and closes the account only when asked', async () => {
  const { ex } = await sdkExecutor({ AS_PRIORITY_MICROLAMPORTS: '1000' });
  const mandatory = decoded(await ex.prepareSell(mint, 100000000n, null, true, 2000));
  assert.equal(mandatory.pump[0].name, 'sell');
  const c = await ex.curve(mint);
  const quoted = BigInt(require('@pump-fun/pump-sdk').getSellSolAmountFromTokenAmount({ global: ex.fees.global, feeConfig: null,
    mintSupply: new BN(c.mintSupply.toString()), bondingCurve: c.bc, amount: new BN(100000000) }).toString());
  assert.ok(quoted > 0n);
  assert.equal(BigInt(mandatory.pump[0].data.minSolOutput.toString()), quoted * 8000n / 10000n);
  assert.ok(mandatory.programs.includes(TOKEN_PROGRAM), 'close-account instruction present');
  const profit = decoded(await ex.prepareSell(mint, 100000000n, 3000000n, false));
  assert.equal(profit.pump[0].data.minSolOutput.toString(), '3000000');
  assert.equal(profit.programs.includes(TOKEN_PROGRAM), false, 'account kept open');
});

test('residual tokens after a live exit exclude the mint from entries immediately', async () => {
  const s = setup();
  try {
    s.ex.submitResult = bought();
    await entry(s);
    s.ex.tokens = 100000000n;
    s.ex.submitResult = p => ({ ...sold(3000000n, 40000000n)(p), postTokens: 60000000n });
    s.engine.liveExit(mint, 'timeout', 'stale_observation', {});
    await Promise.all([...s.engine.reconciliations.values()].map(a => a.promise));
    assert.ok(s.engine.liveForeign.has(mint));
    s.store.run("UPDATE paper_watches SET status='watching',reason=NULL WHERE mint=?", mint);
    s.engine.onAccount(mint, 21, account()); s.engine.coverage(mint); s.engine.onSlot(21);
    s.engine.agentTransaction(tx('again', 21));
    assert.equal(s.store.get('SELECT outcome FROM paper_agent_events WHERE signature=?', 'again')?.outcome, 'live_foreign_holding');
  } finally { s.close(); }
});

test('the loss budget includes worst-case transaction overhead for the buy and every exit', async () => {
  // Budget 4.8M; limit 5M: fits on its own, but not with 2 x 150k overhead (buy + its own exit).
  const s = setup({ cfg: liveCfg({ live: { ...limits, maxLossLamports: '5000000' } }) });
  try {
    s.ex.overhead = 150000n;
    const row = await entry(s);
    assert.equal(order(s, row.id).error, 'live_loss_budget');
  } finally { s.close(); }
});

test('a signature the cluster has seen is never expired by block height', async () => {
  const s = setup();
  try {
    s.ex.submitResult = p => ({ signature: p.signature, status: 'unknown' });
    const row = await entry(s);
    s.ex.resolveResult = () => ({ status: 'unknown', seen: true });
    s.ex.height = 1000; s.now(103000); await s.engine.tick();
    assert.equal(order(s, row.id).status, 'pending', 'processed but not yet confirmed: keep resolving');
    s.ex.resolveResult = signature => bought()({ signature });
    s.now(106000); await s.engine.tick();
    assert.equal(order(s, row.id).status, 'filled'); assert.ok(position(s));
  } finally { s.close(); }
});

test('fees of failed on-chain transactions count toward the persisted loss limit', async () => {
  // Limit = budget (4.8M) + 50k: room for the first two failures' fees, not a third buy after them.
  const s = setup({ cfg: liveCfg({ live: { ...limits, maxLossLamports: '4850000' } }) });
  try {
    s.ex.submitResult = p => ({ signature: p.signature, status: 'failed', slot: 21, lamports: -45000n, ataLamports: 0n,
      tokens: 0n, postTokens: 0n, fee: 45000n, err: { InstructionError: [3, { Custom: 6002 }] } });
    const row = await entry(s);
    assert.equal(order(s, row.id).error, 'live_failed');
    assert.equal(s.engine.liveRealizedLamports(), -45000n);
    assert.equal(s.engine.liveHalted, null);
    s.ex.submitResult = p => ({ signature: p.signature, status: 'failed', slot: 22, lamports: -20000n, ataLamports: 0n,
      tokens: 0n, postTokens: 0n, fee: 20000n, err: 'InsufficientFundsForFee' });
    const second = await entry(s, mint2);
    assert.equal(order(s, second.id).error, 'live_failed');
    assert.equal(s.engine.liveRealizedLamports(), -65000n);
    // A restarted engine reads the same persisted cost.
    assert.equal(BigInt(s.store.get("SELECT value FROM metadata WHERE key='live_failed_tx_cost_lamports'").value), 65000n);
    assert.equal(await s.engine.liveBuyBlocked({ id: -1, mint: key(5) }, 4800000n), 'live_loss_budget');
    assert.equal(await s.engine.liveBuyBlocked({ id: -1, mint: key(5) }, 4780000n), null);
  } finally { s.close(); }
});

test('a halt persists across restarts until explicitly resumed, and repeated exit failures halt entries', async () => {
  const s = setup();
  try {
    s.engine.liveHalt('wallet_floor');
    s.engine.liveHalted = null;
    await s.engine.liveStartupChecks();
    assert.equal(s.engine.liveHalted, 'wallet_floor', 'restored from the database');
    s.engine.liveHalted = null;
    await s.engine.liveStartupChecks({ resume: true });
    assert.equal(s.engine.liveHalted, null);
    assert.equal(s.store.get("SELECT value FROM metadata WHERE key='live_halted'"), undefined);
    for (let i = 0; i < 10; i++) s.engine.liveExitFailed(mint, 'live_failed');
    assert.equal(s.engine.liveHalted, 'exit_failing');
    assert.equal(s.logs.filter(l => l.event === 'live_manual_action' && l.reason === 'exit_failing').length, 1);
  } finally { s.close(); }
});

test('AS_PRIORITY_FEES_ENABLED=false prices at 1 microlamport, keeps the instruction and never estimates', async () => {
  const off = await sdkExecutor({ AS_PRIORITY_FEES_ENABLED: 'false' }, { getPriorityFeeEstimate: { priorityFeeEstimate: 500000 } });
  assert.equal(off.ex.settings.priorityFeesEnabled, false);
  await off.ex.refreshPriority();
  const tx = decoded(await off.ex.prepareBuy(mint, 4800000n, 500));
  assert.equal(tx.price, 1n, 'compute-unit price instruction present at 1 microlamport');
  assert.deepEqual(off.methods, [], 'no fee-estimate call');
  assert.equal(off.ex.maxOverheadLamports('buy'), 5000n + 5000n + 1n);
  assert.equal(liveSettings({}).priorityFeesEnabled, true);
  assert.equal(liveSettings({ AS_PRIORITY_FEES_ENABLED: '' }).priorityMicroLamports, null);
  assert.throws(() => liveSettings({ AS_PRIORITY_FEES_ENABLED: 'no' }), /AS_PRIORITY_FEES_ENABLED/);
  assert.throws(() => liveSettings({ AS_PRIORITY_FEES_ENABLED: 'false', AS_PRIORITY_MICROLAMPORTS: '5000' }), /cannot be set/);
});

test('a live stop-loss is a real full sale at a bounded fresh-quote minimum, never a modeled write-off', async () => {
  const s = setup({ cfg: liveCfg({ stopLossBps: 2000, liquidityExitMultiple: 0 }) });
  try {
    s.ex.submitResult = bought();
    await entry(s);
    s.ex.tokens = 100000000n;
    s.ex.submitResult = sold(3000000n, 100000000n);
    s.engine.onAccount(mint, 21, account(40000000n, 47000000n));
    assert.equal(s.engine.paper.watch(mint).reason, 'stop_loss');
    const sell = s.engine.paper.pending()[0];
    assert.equal(sell?.reason, 'stop_loss', 'a stop-loss sell order is requested');
    s.rpc.accounts = async () => ({ context: { slot: 21 }, value: [account(40000000n, 47000000n)] });
    await s.engine.reconcile(sell);
    const call = s.ex.calls.find(c => c[0] === 'prepareSell');
    assert.ok(call, 'a real sell was built');
    assert.deepEqual(call.slice(2, 6), [100000000n, null, true, 2000]);
    assert.equal(position(s), undefined);
    assert.equal(s.store.get("SELECT reason FROM paper_orders WHERE side='sell' ORDER BY id DESC LIMIT 1").reason, 'stop_loss');
  } finally { s.close(); }
});

test('LIVE_FORCE_SELL sends every exit, take-profit included, with a zero minimum', async () => {
  assert.equal(liveSettings({}).forceSell, false);
  assert.equal(liveSettings({ LIVE_FORCE_SELL: 'true' }).forceSell, true);
  assert.throws(() => liveSettings({ LIVE_FORCE_SELL: 'yes' }), /LIVE_FORCE_SELL/);
  const s = setup({ cfg: liveCfg({ live: { ...limits, forceSell: true } }) });
  try {
    s.ex.submitResult = bought();
    await entry(s);
    s.ex.tokens = 100000000n;
    for (const reason of ['profit', 'timeout', 'stop_loss']) {
      await s.engine.liveBuild({ id: 0, side: 'sell', mint, reason }, { net: '9000000' });
      assert.equal(s.ex.calls.at(-1)[3], 0n, `${reason}: zero minimum`);
    }
  } finally { s.close(); }
  const t = setup();
  try {
    t.ex.submitResult = bought();
    await entry(t);
    t.ex.tokens = 100000000n;
    await t.engine.liveBuild({ id: 0, side: 'sell', mint, reason: 'profit' }, { net: '9000000' });
    assert.equal(t.ex.calls.at(-1)[3], 8550000n, 'default: profit keeps the modeled minimum less 5%');
    await t.engine.liveBuild({ id: 0, side: 'sell', mint, reason: 'timeout' }, { net: '0' });
    assert.equal(t.ex.calls.at(-1)[3], null, 'default: forced exits use a fresh quote less LIVE_EXIT_SLIPPAGE_BPS');
  } finally { t.close(); }
});

test('fast entry sends from the sell event reserves without the status recheck or curve refetch', async () => {
  const s = setup({ cfg: liveCfg({ fastEntry: true }) });
  try {
    let statusCalls = 0, accountCalls = 0;
    s.rpc.call = async () => { statusCalls++; return { value: [{ slot: 20, err: null, confirmationStatus: 'confirmed' }] }; };
    s.rpc.accounts = async () => { accountCalls++; return { context: { slot: 20 }, value: [account()] }; };
    s.ex.submitResult = bought();
    const row = await entry(s);
    assert.equal(statusCalls, 0, 'no getSignatureStatuses'); assert.equal(accountCalls, 0, 'no curve refetch');
    const build = s.ex.calls.find(c => c[0] === 'prepareBuy');
    assert.equal(build[3], true, 'built from a curve account rebuilt from the event');
    assert.equal(order(s, row.id).status, 'filled'); assert.ok(position(s));
  } finally { s.close(); }
});

test('up to LIVE_MAX_BUYS_IN_FLIGHT buys run at once, and pending budgets count against the loss limit', async () => {
  const s = setup({ cfg: liveCfg({ live: { ...limits, maxBuysInFlight: 2 } }) });
  try {
    s.engine.liveBuying.add(999);
    s.store.run("INSERT INTO paper_orders (mint,side,status,created_at_ms,expires_at_ms,reason,quote_json,assumptions_json) VALUES(?,'buy','pending',1,1,'agent_sell',?,?)",
      mint2, JSON.stringify({ requestedBudgetLamports: '4800000' }), JSON.stringify({ networkFeeLamports: '10000' }));
    const other = Number(s.store.get('SELECT MAX(id) id FROM paper_orders').id);
    s.engine.liveBuying.clear(); s.engine.liveBuying.add(other);
    assert.equal(await s.engine.liveBuyBlocked({ id: -1, mint: key(5) }, 4800000n), null, 'second buy allowed');
    s.engine.liveBuying.add(1000);
    assert.equal(await s.engine.liveBuyBlocked({ id: -1, mint: key(5) }, 4800000n), 'live_buy_in_flight', 'third refused');
    s.engine.liveBuying.delete(1000);
    s.engine.cfg = { ...s.engine.cfg, live: { ...s.engine.cfg.live, maxLossLamports: '9000000' } };
    assert.equal(await s.engine.liveBuyBlocked({ id: -1, mint: key(5) }, 4800000n), 'live_loss_budget', 'in-flight budget counted');
  } finally { s.close(); }
});

test('LIVE_CHECK_BALANCE_PER_BUY=false uses the cached balance and refuses when it is missing', async () => {
  const s = setup({ cfg: liveCfg({ live: { ...limits, checkBalancePerBuy: false } }) });
  try {
    let rpc = 0; s.ex.balance = async () => { rpc++; return 1000000000n; };
    s.ex.balanceCached = () => null;
    assert.equal(await s.engine.liveBuyBlocked({ id: -1, mint: key(5) }, 4800000n), 'live_balance_unavailable');
    s.ex.balanceCached = () => 1000000000n;
    assert.equal(await s.engine.liveBuyBlocked({ id: -1, mint: key(5) }, 4800000n), null);
    assert.equal(rpc, 0, 'no balance RPC per buy');
  } finally { s.close(); }
});

test('the entry market-cap band rejects signals outside it', async () => {
  const cfgIn = paperConfig({ PAPER_AGENT_MIN_ENTRY_MC_SOL: '0.02', PAPER_AGENT_MAX_ENTRY_MC_SOL: '1' }, 'agent-sell-liquidity');
  assert.equal(cfgIn.minEntryMcSol, 0.02); assert.equal(cfgIn.maxEntryMcSol, 1);
  assert.equal(paperConfig({}, 'agent-sell-liquidity').minEntryMcSol, undefined);
  assert.throws(() => paperConfig({ PAPER_AGENT_MIN_ENTRY_MC_SOL: '2', PAPER_AGENT_MAX_ENTRY_MC_SOL: '1' }, 'agent-sell-liquidity'));
  assert.throws(() => paperConfig({ PAPER_AGENT_FEED_COMMITMENT: 'finalized' }, 'agent-sell-liquidity'), /PAPER_AGENT_FEED_COMMITMENT/);
  assert.equal(paperConfig({ PAPER_AGENT_FEED_COMMITMENT: 'processed' }, 'agent-sell-liquidity').feedCommitment, 'processed');
  // The fixture curve's market cap is ~0.29 SOL (virtual 140M lamports / 800B tokens of 1e15 supply... see below).
  const mc = (await import('../src/paper-math.js')).cap(reserves(account()));
  for (const [lo, hi, entered] of [[mc / 2, mc * 2, true], [mc * 2, mc * 4, false], [mc / 4, mc / 2, false]]) {
    const s = setup({ cfg: liveCfg({ minEntryMcSol: lo, maxEntryMcSol: hi }) });
    try {
      s.engine.agentTransaction(tx(`band-${lo}`, 20));
      const outcome = s.store.get('SELECT outcome FROM paper_agent_events WHERE signature=?', `band-${lo}`).outcome;
      assert.equal(Boolean(pending(s)), entered, `${lo}-${hi}: ${outcome}`);
      if (!entered) assert.match(outcome, /^mcap_(below|above)_band$/);
    } finally { s.close(); }
  }
});

test('the agent feed subscribes at the configured commitment', async () => {
  const { agentParams } = await import('../src/paper-agent-feed.js');
  assert.equal(agentParams(['c'])[1].commitment, 'confirmed');
  assert.equal(agentParams(['c'], 'processed')[1].commitment, 'processed');
});

test('HELIUS_WS_HOST=beta moves only the trading feeds to the beta host', async () => {
  const { Rpc } = await import('../src/rpc.js');
  const main = new Rpc({ key: 'k', rpcInterval: 150 }, null), beta = new Rpc({ key: 'k', rpcInterval: 150, wsHost: 'beta' }, null);
  assert.equal(main.tradingWsUrl, main.wsUrl);
  assert.match(beta.tradingWsUrl, /^wss:\/\/beta\.helius-rpc\.com\/\?api-key=k$/);
  assert.match(beta.wsUrl, /^wss:\/\/mainnet\.helius-rpc\.com\//, 'discovery stays on mainnet');
  const urls = [];
  const { PaperFeeds } = await import('../src/paper-feeds.js');
  const feeds = new PaperFeeds({ usage() {} }, beta, { agentMode: true, socketFactory: url => { urls.push(url); throw new Error('offline'); },
    setTimer: () => 0, clearTimer: () => {} });
  feeds.add(mint, key(9), false); feeds.start();
  assert.ok(urls.length && urls.every(u => u.startsWith('wss://beta.helius-rpc.com/')), urls.join(','));
  feeds.stop();
});

test('sells on a drained curve are capped at what its real SOL can pay, avoiding the on-chain Overflow (6024)', async () => {
  const { payableTokens } = await import('../src/live-executor.js');
  const BNx = require('bn.js');
  // Reserves similar to the failing live case: tiny real SOL behind a large virtual curve.
  const bc = { virtualQuoteReserves: new BNx('30000000000'), virtualTokenReserves: new BNx('1073000000000000'), realQuoteReserves: new BNx('800000') };
  const want = 620070963844n, got = payableTokens(bc, want);
  assert.ok(got > 0n && got < want, `capped: ${got}`);
  const gross = t => t * 30000000000n / (1073000000000000n + t);
  assert.ok(gross(got) <= 800000n * 99n / 100n, 'sale fits within 99% of real SOL');
  assert.ok(gross(got * 101n / 100n) > 800000n * 99n / 100n, 'a 1% larger amount would not fit');
  assert.equal(payableTokens({ ...bc, realQuoteReserves: new BNx('40000000') }, want), want, 'a healthy curve sells everything');
  // Through the real SDK builder: the sell instruction carries the capped amount and keeps the account open.
  const { ex } = await sdkExecutor({ AS_PRIORITY_MICROLAMPORTS: '1000' });
  ex.curve = async () => ({ mintKey: new PublicKey(mint), curveInfo: { data: Buffer.alloc(0) }, mintSupply: 1000000000000000n,
    tokenProgram: new PublicKey(TOKEN_PROGRAM), bc: { ...(await (async () => { const c = PUMP_SDK.decodeBondingCurve({ data: (await sdkExecutor()).curveData }); return c; })()),
      virtualQuoteReserves: new BNx('30000000000'), virtualTokenReserves: new BNx('1073000000000000'), realQuoteReserves: new BNx('800000') } });
  const built = await ex.sellInstructions(mint, want, 0n, true, 2000, 'capped');
  const sellIx = built.instructions.find(i => i.programId.toBase58() === PUMP);
  const amount = Buffer.from(sellIx.data).readBigUInt64LE(8);
  assert.ok(amount === got, `instruction amount ${amount} = capped ${got}`);
  const tokenIxs = built.instructions.filter(i => i.programId.toBase58() === TOKEN_PROGRAM);
  assert.deepEqual(tokenIxs.map(i => i.data[0]), [15, 9], 'BurnChecked then CloseAccount');
  assert.equal(Buffer.from(tokenIxs[0].data).readBigUInt64LE(1), want - got, 'burns exactly the unsellable rest');
  assert.equal(built.burnedTokens, want - got); assert.equal(built.soldTokens, got);
  // 'full' sells the whole amount (the first attempt) and closes the account.
  const full = await ex.sellInstructions(mint, want, 0n, true, 2000, 'full');
  assert.equal(Buffer.from(full.instructions.find(i => i.programId.toBase58() === PUMP).data).readBigUInt64LE(8), want);
  assert.equal(full.burnedTokens, 0n);
  // A balance this trial does not fully own (close=false) is never burned.
  const kept = await ex.sellInstructions(mint, want, 0n, false, 2000, 'capped');
  assert.equal(kept.burnedTokens, 0n); assert.equal(kept.instructions.some(i => i.programId.toBase58() === TOKEN_PROGRAM), false);
  ex.curve = async () => ({ mintKey: new PublicKey(mint), curveInfo: { data: Buffer.alloc(0) }, mintSupply: 1n, tokenProgram: new PublicKey(TOKEN_PROGRAM),
    bc: { virtualQuoteReserves: new BNx('30000000000'), virtualTokenReserves: new BNx('1073000000000000'), realQuoteReserves: new BNx('0') } });
  // A fully drained curve: nothing to sell, so the capped retry only burns and closes.
  const drained = await ex.sellInstructions(mint, want, 0n, true, 2000, 'capped');
  assert.equal(drained.instructions.some(i => i.programId.toBase58() === PUMP), false, 'no sell instruction');
  assert.deepEqual(drained.instructions.map(i => i.data[0]), [15, 9]);
  assert.equal(drained.burnedTokens, want);
  await assert.rejects(ex.sellInstructions(mint, want, 0n, false, 2000, 'capped'), /curve_drained/);
});
