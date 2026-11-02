import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { Store } from '../src/store.js';
import { PaperEngine } from '../src/paper-engine.js';
import { paperConfig } from '../src/paper-store.js';
import { reserves } from '../src/paper-math.js';
import { Rpc } from '../src/rpc.js';
import { PUMP } from '../src/config.js';

const mint = '9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const second = new PublicKey(Buffer.alloc(32, 2)).toBase58();
function account(mc = 0.2, kind = 'valid') {
  const bytes = Buffer.alloc(166); Buffer.from([23,183,248,55,96,216,172,96]).copy(bytes);
  bytes.writeBigUInt64LE(1000000000000n, 8); bytes.writeBigUInt64LE(BigInt(Math.round(mc * 1e9)), 16);
  bytes.writeBigUInt64LE(900000000000n, 24); bytes.writeBigUInt64LE(1000000000n, 32);
  bytes.writeBigUInt64LE(1000000000000n, 40); bytes[81] = kind === 'not_mayhem' ? 0 : 1;
  if (kind === 'unsupported_quote') bytes[83] = 1;
  if (kind === 'invalid_flags') bytes[81] = 2;
  if (kind === 'complete') bytes[48] = 1;
  return { owner: PUMP, data: [bytes.toString('base64'), 'base64'] };
}
const status = (slot = 15, confirmationStatus = 'confirmed', err = null) => ({ value: [{ slot, err, confirmationStatus }] });
function setup({ now = 100000, rpc, cfg = {} } = {}) {
  const store = new Store(':memory:', { firstCheck: 30, recheck: 30, horizon: 86400, paperMode: true });
  rpc ??= { call: async () => status(), accounts: async () => ({ context: { slot: 15 }, value: [account()] }) };
  const engine = new PaperEngine(store, rpc, { ...paperConfig({}), ...cfg }, { now: () => now, project: raw => raw });
  const removed = [];
  engine.attach({ add() {}, remove: key => removed.push(key), setPreprocessed() {}, covers: () => true,
    start() {}, stop() {}, resync() {} });
  const add = (key, start = 11, end = 14) => {
    store.addMint({ mint: key, timestamp: 100 }); engine.add(key);
    engine.onAccount(key, start, account(1)); engine.onAccount(key, end, account(1));
  };
  engine.onReady(); engine.onSlot(15); add(mint);
  const signal = (key = mint, slot = 15, side = 'sell') => {
    engine.signal({ signature: `${key}-${slot}`, slot, side, mint: key, state: reserves(account()) });
    return engine.paper.pending().find(order => order.mint === key);
  };
  return { engine, store, rpc, removed, add, signal, setNow: value => { now = value; },
    order: id => store.get('SELECT * FROM paper_orders WHERE id=?', id),
    diagnostic: id => JSON.parse(store.get('SELECT diagnostics_json FROM paper_orders WHERE id=?', id).diagnostics_json),
    close: async () => { await engine.stop(); store.close(); } };
}
function waiting() {
  let signal, release;
  const call = (...args) => {
    signal = args.at(-1).signal;
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new Error('mock abort with private-provider-detail'));
      signal.addEventListener('abort', aborted, { once: true });
      release = value => { signal.removeEventListener('abort', aborted); resolve(value); };
    });
  };
  return { call, get signal() { return signal; }, release: value => release(value) };
}
const unavailable = s => s.store.get("SELECT count FROM paper_counters WHERE name='reconciliation_unavailable'")?.count ?? 0;

test('slot expiry aborts a stuck real Rpc queue worker and another pending order proceeds', async () => {
  const rpc = new Rpc({ key: 'mock-only', rpcInterval: 0 }, null), calls = [];
  // Mock the transport, not call/drain: even a transport ignoring its signal must release the real queue.
  rpc.execute = job => {
    calls.push([job.method, job.params]);
    if (job.method === 'getSignatureStatuses' && job.params[0][0] === `${mint}-15`) return new Promise(() => {});
    if (job.method === 'getSignatureStatuses') return Promise.resolve(status(20));
    return Promise.resolve({ context: { slot: 20 }, value: [account()] });
  };
  const s = setup({ now: Date.now(), rpc });
  try {
    const first = s.signal(); s.engine.onSlot(19); s.add(second, 16, 19); const next = s.signal(second, 20);
    const ticking = s.engine.tick(); assert.equal(calls.length, 1);
    s.engine.onSlot(20);
    assert.equal(s.order(first.id).error, 'signal_expired');
    assert.equal(s.diagnostic(first.id).expiryCause, 'slot');
    assert.equal(s.diagnostic(first.id).lastStage, 'status_pending');
    await ticking;
    assert.equal(s.order(next.id).status, 'filled');
    assert.deepEqual(calls.map(([method]) => method), ['getSignatureStatuses', 'getSignatureStatuses', 'getMultipleAccounts']);
    assert.equal(unavailable(s), 0); assert.equal(s.engine.reconciliations.size, 0);
  } finally { await s.close(); rpc.stop(); }
});

test('a stuck confirmed-account transport releases the real Rpc queue on cancellation', async () => {
  const rpc = new Rpc({ key: 'mock-only', rpcInterval: 0 }, null);
  let accountStarted;
  const started = new Promise(resolve => { accountStarted = resolve; });
  rpc.execute = job => {
    if (job.method === 'getSignatureStatuses') return Promise.resolve(status());
    if (job.method === 'getMultipleAccounts') { accountStarted(); return new Promise(() => {}); }
    return Promise.resolve('queue-released');
  };
  const s = setup({ now: Date.now(), rpc });
  try {
    const order = s.signal(), work = s.engine.reconcile(order); await started;
    const queued = rpc.call('mockNextOperation'); s.engine.onSlot(20);
    await work; assert.equal(await queued, 'queue-released');
    assert.equal(s.diagnostic(order.id).lastStage, 'account_pending');
    assert.equal(s.diagnostic(order.id).expiryCause, 'slot'); assert.equal(unavailable(s), 0);
  } finally { await s.close(); rpc.stop(); }
});

test('slot expiry during snapshot wait aborts, preserves confirmation evidence and forbids a late fill', async () => {
  const s = setup(), wait = waiting(); s.rpc.accounts = wait.call;
  try {
    const order = s.signal(), work = s.engine.reconcile(order); await Promise.resolve();
    assert.ok(wait.signal); s.setNow(100150); s.engine.onSlot(20);
    assert.equal(wait.signal.aborted, true); await work;
    wait.release({ context: { slot: 15 }, value: [account()] }); await Promise.resolve();
    const diagnostic = s.diagnostic(order.id);
    assert.equal(diagnostic.stage, 'canceled'); assert.equal(diagnostic.lastStage, 'account_pending');
    assert.equal(diagnostic.confirmationStatus, 'confirmed'); assert.equal(diagnostic.executedSlot, 15);
    assert.equal(diagnostic.accountElapsedMs, 150); assert.equal(diagnostic.elapsedMs, 150);
    assert.equal(s.engine.paper.position(mint), undefined); assert.equal(unavailable(s), 0);
  } finally { await s.close(); }
});

test('all entry invalidation routes abort status work without requesting accounts or overwriting outcomes', async () => {
  const routes = [
    ['feed_gap', s => s.engine.gap('test')],
    ['invalid_account', s => s.engine.onAccount(mint, 15, null)],
    ['preprocessed_idle', s => s.engine.membership(mint, false)],
    ['floor_override', s => s.engine.onAccount(mint, 15, account(0.1))],
    ['graduated', s => s.engine.onAccount(mint, 15, account(0.2, 'complete'))],
    ['restart_unreconciled', s => s.engine.start()],
  ];
  for (const [reason, invalidate] of routes) {
    const s = setup(), wait = waiting(); s.rpc.call = wait.call;
    s.rpc.accounts = () => assert.fail('canceled trigger cannot request accounts');
    try {
      const order = s.signal(), work = s.engine.reconcile(order);
      invalidate(s); assert.equal(wait.signal.aborted, true, reason); await work;
      assert.equal(s.order(order.id).error, reason); assert.equal(unavailable(s), 0);
      assert.equal(s.engine.reconciliations.size, 0);
    } finally { await s.close(); }
  }
});

test('mandatory priority override aborts an in-flight profit reconciliation without losing exit intent', async () => {
  const s = setup(), wait = waiting();
  try {
    const buy = s.signal(); s.engine.paper.fill(buy, { tokens: '50000000000', cost: '10010000' }, 100000);
    s.engine.onAccount(mint, 14, account());
    s.engine.signal({ signature: 'profit', slot: 15, side: 'buy', mint, state: reserves(account(0.4)) });
    const profit = s.engine.paper.pending()[0]; assert.equal(profit.reason, 'profit'); s.rpc.call = wait.call;
    const work = s.engine.reconcile(profit); s.engine.onAccount(mint, 15, account(0.1));
    assert.equal(wait.signal.aborted, true); await work;
    assert.equal(s.order(profit.id).error, 'floor_override');
    assert.equal(s.engine.paper.pending()[0].reason, 'floor');
    assert.equal(s.engine.paper.watch(mint).reason, 'floor'); assert.ok(s.engine.paper.position(mint));
    assert.equal(unavailable(s), 0);
  } finally { await s.close(); }
});

test('clock expiry after status await cancels before accounts, and deadline rejection is not provider failure', async () => {
  for (const reject of [false, true]) {
    const s = setup(); let finish;
    s.rpc.call = () => new Promise((resolve, fail) => { finish = reject ? fail : resolve; });
    s.rpc.accounts = () => assert.fail('expired order cannot request accounts');
    try {
      const order = s.signal(), work = s.engine.reconcile(order);
      s.setNow(order.expires_at_ms); finish(reject ? new Error('deadline') : status()); await work;
      assert.equal(s.order(order.id).error, 'signal_expired'); assert.equal(s.diagnostic(order.id).expiryCause, 'clock');
      assert.equal(s.diagnostic(order.id).statusElapsedMs, 10000); assert.equal(unavailable(s), 0);
    } finally { await s.close(); }
  }
});

test('malformed saved diagnostics cannot prevent cancellation, abort or shutdown', async () => {
  for (const route of ['slot', 'stop', 'reconcile']) {
    const s = setup(), wait = waiting(); s.rpc.call = wait.call;
    try {
      const order = s.signal(); s.store.run('UPDATE paper_orders SET diagnostics_json=? WHERE id=?', '{broken', order.id);
      if (route === 'reconcile') {
        const work = s.engine.reconcile(order); s.engine.onSlot(20); await work;
        assert.equal(wait.signal.aborted, true);
      } else if (route === 'slot') s.engine.onSlot(20);
      else await s.engine.stop();
      assert.equal(s.order(order.id).status, 'canceled');
      assert.equal(s.diagnostic(order.id).stage, 'canceled');
    } finally { await s.close(); }
  }
});

test('coverage generation changing during status wait prevents the next account RPC', async () => {
  const s = setup(); let release;
  s.rpc.call = () => new Promise(resolve => { release = resolve; });
  s.rpc.accounts = () => assert.fail('old coverage generation cannot request accounts');
  try {
    const order = s.signal(), work = s.engine.reconcile(order);
    s.engine.coverage(mint); release(status()); await work;
    assert.equal(s.order(order.id).status, 'pending'); assert.equal(unavailable(s), 0);
  } finally { await s.close(); }
});

test('stop is idempotent, aborts before feed shutdown, drains work and ignores every late feed callback', async () => {
  const s = setup(), wait = waiting(); s.rpc.call = wait.call;
  let stoppedFeeds = 0;
  s.engine.feeds.stop = () => { stoppedFeeds++; assert.equal(wait.signal.aborted, true); };
  try {
    const order = s.signal(), ticking = s.engine.tick();
    const stopping = s.engine.stop(); assert.equal(s.engine.stop(), stopping); await stopping; await ticking;
    assert.equal(s.order(order.id).error, 'stopped'); assert.equal(stoppedFeeds, 1);
    assert.equal(s.engine.reconciliations.size, 0); assert.equal(s.engine.working, false);
    // Closed DB makes any late read/write an immediate test failure, not just a missed fill.
    s.store.close();
    s.engine.onSlot(20); s.engine.onAccount(mint, 15, account()); s.engine.coverage(mint);
    s.engine.membership(mint, false); s.engine.gap('late'); s.engine.onReady(); s.engine.add(second);
    s.engine.discover(); s.engine.start(); s.engine.enqueue({}); s.engine.signal({});
    await s.engine.tick(); await s.engine.reconcile(order); await s.engine.stop();
    wait.release(status()); await Promise.resolve();
    assert.equal(s.engine.ready, false);
  } finally { await s.engine.stop(); }
});

test('unknown, processed, failed and wrong-slot statuses preserve confirmation safety and bounded diagnostics', async () => {
  for (const [response, stage, error] of [
    [{ value: [null] }, 'status_pending', null],
    [status(15, 'processed'), 'status_unconfirmed', null],
    [status(-1), 'status_invalid', null],
    [{ value: [{ slot: 15, confirmationStatus: 'confirmed' }] }, 'status_invalid', null],
    [status(15, 'confirmed', { InstructionError: [2, { Custom: 6002 }], message: 'private' }), 'status_failed', 'trigger_failed'],
    [status(16), 'status_confirmed', 'trigger_slot_changed'],
  ]) {
    const s = setup(); s.rpc.call = async () => response;
    s.rpc.accounts = () => assert.fail('unsafe trigger cannot request reserves');
    try {
      const order = s.signal(); await s.engine.reconcile(order);
      const diagnostic = s.diagnostic(order.id);
      assert.equal(error ? diagnostic.lastStage : diagnostic.stage, stage);
      assert.equal(s.order(order.id).error, error); assert.equal(unavailable(s), 0);
      if (stage === 'status_failed') assert.deepEqual(diagnostic.failure, { kind: 'InstructionError', instructionIndex: 2, customCode: 6002 });
      assert.ok(!JSON.stringify(diagnostic).includes('private'));
    } finally { await s.close(); }
  }
});

test('snapshot freshness follows newer streamed observations and counters/timing accumulate per attempt', async () => {
  const s = setup(); let release;
  s.rpc.accounts = () => new Promise(resolve => { release = resolve; });
  try {
    const order = s.signal(), work = s.engine.reconcile(order); await Promise.resolve();
    s.engine.onAccount(mint, 16, account()); s.setNow(100120);
    release({ context: { slot: 15 }, value: [account()] }); await work;
    assert.equal(s.order(order.id).status, 'pending');
    const first = s.diagnostic(order.id);
    assert.equal(first.stage, 'snapshot_behind'); assert.equal(first.requiredSlot, 16);
    assert.equal(first.snapshotSlot, 15); assert.equal(first.accountElapsedMs, 120);
    const retry = s.engine.reconcile(order); await Promise.resolve(); s.setNow(100150);
    release({ context: { slot: 16 }, value: [account()] }); await retry;
    const filled = s.diagnostic(order.id);
    assert.equal(s.order(order.id).status, 'filled'); assert.equal(filled.stage, 'filled');
    assert.equal(filled.accountAttempts, 2); assert.equal(filled.statusAttempts, 2); assert.equal(filled.accountElapsedMs, 150);
  } finally { await s.close(); }
});

test('confirmed entry rejection records cap and exact drop predicates rather than filling historical trigger prices', async () => {
  for (const [mc, rangePassed, dropPassed] of [[0.45, true, false], [0.6, false, false]]) {
    const s = setup(); s.rpc.accounts = async () => ({ context: { slot: 15 }, value: [account(mc)] });
    try {
      const order = s.signal(); await s.engine.reconcile(order); const d = s.diagnostic(order.id);
      assert.equal(s.order(order.id).error, 'entry_condition_changed'); assert.equal(d.lastStage, 'entry_rejected');
      assert.equal(d.marketCapSol, mc); assert.equal(d.rangePassed, rangePassed); assert.equal(d.dropPassed, dropPassed);
      assert.equal(d.dropBps, Math.round((1 - mc) * 10000)); assert.equal(d.requiredDropBps, 6000);
    } finally { await s.close(); }
  }
});

test('buy and sell triggers retain selected peak slot separately from the unchanged window-start reference', async () => {
  for (const side of ['buy', 'sell']) {
    const s = setup();
    try {
      s.engine.onAccount(mint, 14, account(1.2)); const order = s.signal(mint, 15, side);
      assert.ok(order); const d = s.diagnostic(order.id), quote = JSON.parse(order.quote_json);
      assert.equal(d.triggerSide, side); assert.equal(d.peakSlot, 14); assert.equal(d.windowStartSlot, 11);
      assert.equal(quote.reference.slot, 11); await s.engine.reconcile(order); assert.equal(s.order(order.id).status, 'filled');
    } finally { await s.close(); }
  }
});

test('unsupported unheld accounts stop and unwatch from both streamed and confirmed observations', async () => {
  for (const source of ['stream', 'confirmed']) for (const kind of ['unsupported_quote', 'not_mayhem']) {
    const s = setup();
    try {
      const order = s.signal();
      if (source === 'stream') s.engine.onAccount(mint, 15, account(0.2, kind));
      else { s.rpc.accounts = async () => ({ context: { slot: 15 }, value: [account(0.2, kind)] }); await s.engine.reconcile(order); }
      const watch = s.engine.paper.watch(mint);
      assert.equal(watch.status, 'stopped'); assert.equal(watch.reason, kind); assert.equal(watch.preprocessed, 0);
      assert.equal(s.order(order.id).error, 'invalid_account'); assert.deepEqual(s.removed, [mint]);
      assert.equal(s.engine.paper.active().length, 0); assert.equal(s.engine.states.has(mint), false);
      s.engine.onAccount(mint, 16, account(1)); assert.equal(s.engine.states.has(mint), false);
    } finally { await s.close(); }
  }
});

test('held unsupported and transient malformed observations retain coverage, positions and latched exit intent', async () => {
  for (const source of ['stream', 'confirmed']) for (const kind of ['unsupported_quote', 'not_mayhem', 'invalid_flags', 'missing']) {
    const s = setup();
    try {
      const buy = s.signal(); s.engine.paper.fill(buy, { tokens: '50000000000', cost: '10010000' }, 100000);
      s.engine.onAccount(mint, 15, account(0.1)); const order = s.engine.paper.pending()[0];
      const value = kind === 'missing' ? null : account(0.2, kind);
      if (source === 'stream') s.engine.onAccount(mint, 15, value);
      else { s.rpc.accounts = async () => ({ context: { slot: 15 }, value: [value] }); await s.engine.reconcile(order); }
      assert.equal(s.engine.paper.watch(mint).reason, 'floor'); assert.equal(s.engine.paper.watch(mint).status, 'exit_blocked');
      assert.equal(s.engine.paper.watch(mint).preprocessed, 1); assert.ok(s.engine.paper.position(mint));
      assert.equal(s.engine.paper.pending().length, 0); assert.deepEqual(s.removed, []);
      s.engine.onAccount(mint, 16, account()); assert.equal(s.engine.paper.pending()[0].reason, 'floor');
    } finally { await s.close(); }
  }
  for (const kind of ['invalid_flags', 'missing']) {
    const s = setup();
    try {
      s.signal(); s.engine.onAccount(mint, 15, kind === 'missing' ? null : account(0.2, kind));
      assert.equal(s.engine.paper.watch(mint).status, 'watching'); assert.deepEqual(s.removed, []);
      s.engine.onAccount(mint, 16, account(1)); assert.ok(s.engine.states.has(mint));
    } finally { await s.close(); }
  }
});
