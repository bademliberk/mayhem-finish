import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { PaperStore, paperConfig } from '../src/paper-store.js';
import { PaperEngine } from '../src/paper-engine.js';
import { trialProfiles, trialPath, trialIdentity, bindTrial, preflightTrial } from '../src/paper-profiles.js';
import { entryQuality, reserves, meetsDrop } from '../src/paper-math.js';
import { paperPerformance } from '../src/paper-performance.js';
import { PUMP } from '../src/config.js';
import { PublicKey } from '@solana/web3.js';

const mint = '9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cfg = { firstCheck: 30, recheck: 30, horizon: 86400, paperMode: true };
function account(mc = 0.2, real = 1) {
  const b = Buffer.alloc(166); Buffer.from([23,183,248,55,96,216,172,96]).copy(b);
  b.writeBigUInt64LE(1000000000000n, 8); b.writeBigUInt64LE(BigInt(Math.round(mc * 1e9)), 16);
  b.writeBigUInt64LE(900000000000n, 24); b.writeBigUInt64LE(BigInt(Math.round(real * 1e9)), 32);
  b.writeBigUInt64LE(1000000000000n, 40); b[81] = 1;
  return { owner: PUMP, data: [b.toString('base64'), 'base64'] };
}
function setup(profile = 'liquidity20', options = {}) {
  const store = new Store(':memory:', cfg); store.addMint({ mint, timestamp: 100 });
  const rpc = { call: async () => ({ value: [{ slot: 15, err: null, confirmationStatus: 'confirmed' }] }),
    accounts: async () => ({ context: { slot: 15 }, value: [account()] }) };
  const engine = new PaperEngine(store, rpc, { ...paperConfig({}, profile), ...options }, { now: () => 100000, project: raw => raw });
  engine.attach({ add() {}, remove() {}, setPreprocessed() {}, covers: () => true });
  engine.add(mint); engine.onReady(); engine.onSlot(15);
  engine.onAccount(mint, 8, account(1)); engine.onAccount(mint, 11, account(1)); engine.onAccount(mint, 14, account(1));
  return { store, rpc, engine, signal: (mc = 0.2, real = 1) => ({ signature: 'sig', slot: 15, mint, state: reserves(account(mc, real)) }) };
}

test('profiles isolate intended changes and validate experimental configuration', () => {
  const base = paperConfig({}, 'baseline');
  assert.equal(base.maxWatches, 10); assert.equal(base.dropBps, 6000); assert.equal(base.windowSlots, 5);
  assert.equal(base.entryQualityEnabled, false);
  assert.equal(paperConfig({}, 'coverage20').maxWatches, 20);
  assert.equal(paperConfig({}, 'liquidity20').entryQualityEnabled, true);
  assert.equal(paperConfig({}, 'drop50').dropBps, 5000);
  const eight = paperConfig({}, 'window8');
  assert.equal(eight.windowSlots, 8); assert.equal(eight.projectionWindowSlots, 5); assert.equal(eight.signalValiditySlots, 5);
  assert.equal(paperConfig({ PAPER_MAX_WATCHES: '20' }, 'baseline').maxWatches, 10);
  for (const env of [{ PAPER_MAX_WATCHES: '21' }, { PAPER_MIN_LIQUIDITY_MULTIPLE: '1.5' }, { PAPER_MAX_ROUND_TRIP_LOSS_BPS: '-1' }]) assert.throws(() => paperConfig(env));
  assert.throws(() => paperConfig({}, 'unknown'));
  assert.equal(new Set(Object.keys(trialProfiles).map(p => trialPath(p))).size, 6);
  const exit = paperConfig({ MAX_TRADE_COUNT: '2' }, 'liquidity-exit100');
  assert.equal(exit.maxTrades, 100); assert.equal(exit.maxWatches, 20);
  assert.equal(exit.entryQualityEnabled, true);
  assert.equal(exit.liquidityExitEnabled, true); assert.equal(exit.liquidityExitMultiple, 2);
  const { profile, maxTrades, liquidityExitEnabled, liquidityExitMultiple, ...entrySettings } = exit;
  const { profile: previousProfile, maxTrades: previousCap, ...previousSettings } = paperConfig({}, 'liquidity20');
  assert.deepEqual(entrySettings, previousSettings);
  assert.throws(() => trialPath('../collector'));
  assert.throws(() => trialPath('baseline', 'data', 'data/baseline.sqlite'));
});

test('legacy serialized configuration and sorted trial identities stay byte-exact', () => {
  // SHA-256 snapshots of the pre-liquidity-exit configurations, including ordinary paper mode.
  const snapshots = [
    [null, '78b51d8da2da351b10ecfb158c801d80aee0f6b9a4697e40747685d117138502', 'da575bd944a7b972acb93c7e9973e738dd952d581d498e7259899113540d3a9e'],
    ['baseline', 'ba7d692d34ce3c7ff86d39c6b2baabe7724b3e2e49b13a964d534ff78c52baf9', 'b7bb3e5b4a56e5bbc2b376736ea39d8efe0010f25297dd6bd961a09a9f508a4e'],
    ['coverage20', '5d867f087762693b02e079adad1b6511f0bcb1db7e6a505db75a9a23f5173c3f', '8abb4cd854e525d478ece0737bd5c71b689e1383741793b824ca18cee2488db4'],
    ['liquidity20', '580d1d92248d1ca9b7cac83a2a3889a5357ed220aa7082eb17ac0cf3d8825eb4', '337d1755769d8c373ea5b53c10051772cd1496e29feba1d11618865bb3749d6a'],
    ['drop50', 'fd64ce0d775a869b9d9f34ee5fc0e90758f89cce75f565a49b621b78e55a867a', 'ff2ad40621fb0af1ea7ba144eef485b4cc2d8c3bb1f80d760a197088e3b5be2b'],
    ['window8', '4e6be5f85ee2225a93de678ef42d579fda10b6b0a821b405cd24eb40223afc10', 'c81bf2cd89afcca6608e7aa2daf74ad7268173ec638b7c8b706bd6f8bdb098b8'],
  ];
  const hash = value => createHash('sha256').update(value).digest('hex');
  for (const [profile, serialized, identity] of snapshots) {
    const config = paperConfig({}, profile);
    assert.equal(hash(JSON.stringify(config)), serialized, profile);
    assert.equal(hash(trialIdentity(config)), identity, profile);
    assert.equal(Object.hasOwn(config, 'liquidityExitEnabled'), false);
    assert.equal(Object.hasOwn(config, 'liquidityExitMultiple'), false);
    assert.equal(config.version, 'creation_staged_v2');
  }
});

test('trial identity survives restart and refuses changed config or existing history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-trials-'));
  const path = join(dir, 'baseline.sqlite'), pc = paperConfig({}, 'baseline');
  let s;
  try {
    preflightTrial(path, pc);
    s = new Store(path, cfg); new PaperStore(s, pc); bindTrial(s, pc); s.close();
    preflightTrial(path, pc);
    assert.throws(() => preflightTrial(path, { ...pc, dropBps: 5000 }), /not this trial/);
    s = new Store(path, cfg); new PaperStore(s, pc); bindTrial(s, { ...pc });
    assert.throws(() => bindTrial(s, { ...pc, dropBps: 5000 }), /configuration changed/);
    assert.equal(JSON.parse(s.get("SELECT value FROM metadata WHERE key='paper_trial_config'").value).dropBps, 6000);
    s.close(); s = new Store(':memory:', cfg); new PaperStore(s, pc); s.addMint({ mint, timestamp: 100 });
    assert.throws(() => bindTrial(s, pc), /existing run/);
  } finally { s?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('trial preflight refuses legacy data before migrations or writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-legacy-')), path = join(dir, 'baseline.sqlite');
  try {
    const s = new Store(path, cfg); s.addMint({ mint, timestamp: 100 }); s.close();
    assert.throws(() => preflightTrial(path, paperConfig({}, 'baseline')), /not this trial/);
    assert.throws(() => execFileSync(process.execPath, ['src/cli.js', 'paper-trial', 'baseline'], {
      env: { ...process.env, PAPER_TRIAL_DIR: dir }, stdio: 'pipe', timeout: 3000,
    }), error => error.status === 1 && error.stderr.toString().includes('not this trial'));
    const original = new Store(path, cfg);
    assert.equal(original.get('SELECT COUNT(*) n FROM mints').n, 1);
    assert.equal(original.get("SELECT 1 FROM metadata WHERE key='paper_trial_config'"), undefined);
    original.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('entry quality models post-buy round trip without mutating reserves', () => {
  const pc = paperConfig({}, 'liquidity20'), state = reserves(account(0.2, 0.02)), before = { ...state };
  const q = entryQuality(state, pc);
  assert.deepEqual(state, before); assert.equal(q.rejection, null); assert.equal(q.fullExitSupported, true);
  assert.ok(BigInt(q.roundTripNetLamports) < 10000000n);
  assert.ok(BigInt(q.residualRealSolLamports) >= state.realSol);
  assert.ok(q.buyImpactBps > 0);
  assert.equal(entryQuality(reserves(account(0.2, 0.019999999)), pc).rejection, 'entry_real_liquidity');
  assert.equal(entryQuality(state, { ...pc, maxRoundTripLossBps: q.roundTripLossBps }).rejection, null);
  assert.equal(entryQuality(state, { ...pc, maxRoundTripLossBps: q.roundTripLossBps - 1 }).rejection, 'entry_round_trip_loss');
  assert.equal(entryQuality(state, { ...pc, networkFeeLamports: '10000000' }).rejection, 'entry_exit_unavailable');
});

test('guarded entry rejects thin liquidity but baseline only records quality', () => {
  for (const profile of ['baseline', 'liquidity20']) {
    const { store, engine, signal } = setup(profile);
    try {
      engine.signal(signal(0.2, 0.0001));
      if (profile === 'baseline') {
        assert.equal(engine.paper.pending().length, 1);
        assert.equal(JSON.parse(engine.paper.pending()[0].quote_json).entryQuality.rejection, 'entry_real_liquidity');
      } else {
        assert.equal(engine.paper.pending().length, 0);
        assert.equal(store.get('SELECT outcome FROM paper_signals').outcome, 'entry_real_liquidity');
      }
    } finally { store.close(); }
  }
});

test('confirmed fill rechecks liquidity independently of the predicted quote', async () => {
  const { store, engine, rpc, signal } = setup();
  try {
    engine.signal(signal()); assert.equal(engine.paper.pending().length, 1);
    rpc.accounts = async () => ({ context: { slot: 15 }, value: [account(0.2, 0.0001)] });
    await engine.reconcile(engine.paper.pending()[0]);
    assert.equal(store.get('SELECT error FROM paper_orders').error, 'entry_real_liquidity');
    assert.equal(store.get('SELECT COUNT(*) n FROM paper_positions').n, 0);
  } finally { store.close(); }
});

test('50 percent threshold is inclusive and does not loosen MC boundaries', () => {
  const reference = { virtualSol: 100n, virtualTokens: 100n };
  assert.equal(meetsDrop({ virtualSol: 50n, virtualTokens: 100n }, reference, paperConfig({}, 'drop50')), true);
  assert.equal(meetsDrop({ virtualSol: 51n, virtualTokens: 100n }, reference, paperConfig({}, 'drop50')), false);
  assert.equal(meetsDrop({ virtualSol: 50n, virtualTokens: 100n }, reference, paperConfig({}, 'baseline')), false);
  for (const mc of [0.1, 0.5]) {
    const { store, engine, signal } = setup('drop50');
    try { engine.signal(signal(mc)); assert.equal(store.get('SELECT outcome FROM paper_signals').outcome, 'outside_buy_range'); }
    finally { store.close(); }
  }
});

test('drop50 admits a qualifying 50-percent signal that baseline rejects', () => {
  for (const profile of ['baseline', 'drop50']) {
    const { store, engine, signal } = setup(profile);
    try {
      engine.states.get(mint).history = [{ slot: 11, at: 100000, state: reserves(account(0.8)) }];
      engine.signal(signal(0.4));
      assert.equal(engine.paper.pending().length, profile === 'drop50' ? 1 : 0);
    } finally { store.close(); }
  }
});

test('eight-slot entry lookback retains older peaks without extending signal expiry', async () => {
  for (const profile of ['liquidity20', 'window8']) {
    const { store, engine, signal } = setup(profile);
    try {
      engine.states.get(mint).history = [
        { slot: 8, at: 100000, state: reserves(account(1)) },
        { slot: 14, at: 100000, state: reserves(account(0.4)) },
      ];
      engine.signal(signal(0.2));
      assert.equal(engine.paper.pending().length, profile === 'window8' ? 1 : 0);
      if (profile === 'window8') {
        engine.onSlot(20); await engine.reconcile(engine.paper.pending()[0]);
        assert.equal(store.get('SELECT error FROM paper_orders').error, 'signal_expired');
      }
    } finally { store.close(); }
  }
});

test('eight-slot profile requires its full warm-up window', () => {
  const { store, engine, signal } = setup('window8');
  try {
    engine.states.get(mint).since = 9;
    engine.signal(signal());
    assert.equal(engine.paper.pending().length, 0);
    assert.equal(store.get('SELECT outcome FROM paper_signals').outcome, 'insufficient_window_history');
  } finally { store.close(); }
});

test('coverage trial admits twenty watches and never a twenty-first active watch', () => {
  const { store, engine } = setup('coverage20');
  try {
    for (let i = 1; i <= 20; i++) {
      const key = new PublicKey(Buffer.alloc(32, i)).toBase58();
      store.addMint({ mint: key, timestamp: 100 }); engine.add(key);
    }
    assert.equal(engine.paper.active().length, 20);
    assert.equal(store.get("SELECT count FROM paper_counters WHERE name='enrollment_watch_cap'").count, 1);
  } finally { store.close(); }
});

test('performance separates closed results, realized drawdown and unresolved loss scenario', () => {
  const s = new Store(':memory:', cfg); new PaperStore(s, paperConfig({}));
  try {
    const positions = [
      { status: 'closed', closed_at_ms: 1, exit_order_id: 1, pnl_lamports: '100' },
      { status: 'closed', closed_at_ms: 2, exit_order_id: 2, pnl_lamports: '-150' },
      { status: 'closed', closed_at_ms: 3, exit_order_id: 3, pnl_lamports: '0' },
      { status: 'open', entry_cost_lamports: '200' },
    ];
    const p = paperPerformance(s, positions);
    assert.equal(p.closedOnlyWinRate, 1 / 3); assert.equal(p.breakevens, 1);
    assert.equal(p.realizedMaxDrawdownLamports, '150'); assert.equal(p.zeroRecoveryScenarioPnlLamports, '-250');
    assert.equal(p.realizedExpectancyLamportsPerClosedTrade, '-16');
    assert.equal(p.estimatedCreditsPerFilledBuy, null);
    assert.equal(paperPerformance(s, []).closedOnlyWinRate, null);
    s.usage('rpc', 'getMultipleAccounts', 10);
    s.usage('websocket', 'received_bytes', 100000);
    s.usage('preprocessed', 'transactions', 20);
    s.usage('rpc_queue', 'canceled', 100);
    s.usage('recovery', 'partial_creations_new', 100);
    assert.equal(paperPerformance(s, []).estimatedCredits, 14);
  } finally { s.close(); }
});

test('comparison is read-only and uses saved config instead of current environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-comparison-'));
  try {
    const pc = paperConfig({}, 'baseline'), path = trialPath('baseline', dir);
    const s = new Store(path, cfg); new PaperStore(s, pc); bindTrial(s, pc); s.close();
    const output = execFileSync(process.execPath, ['src/paper-trial-report.js', 'baseline', 'drop50'], {
      encoding: 'utf8', env: { ...process.env, PAPER_TRIAL_DIR: dir, PAPER_MAX_WATCHES: '20' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { reports } = JSON.parse(output);
    assert.equal(reports[0].available, true); assert.equal(reports[0].assumptions.maxWatches, 10);
    assert.equal(reports[1].available, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
