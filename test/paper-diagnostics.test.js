import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { PaperStore, paperConfig } from '../src/paper-store.js';
import { safeOrderDiagnostics, transactionFailure, readOrderDiagnostics } from '../src/paper-diagnostics.js';

const mint = '9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cfg = { firstCheck: 30, recheck: 30, horizon: 86400, paperMode: true };
function setup(path = ':memory:') {
  const store = new Store(path, cfg), paper = new PaperStore(store, paperConfig({}));
  store.addMint({ mint, timestamp: 100 }); paper.enroll(mint, 100000);
  const id = paper.request(mint, 'buy', 'dump', { tokens: '100', cost: '10010000' }, { signature: 'sig', slot: 15 }, 100000);
  return { store, paper, id };
}

test('transaction errors retain only fixed kinds and validated numeric instruction codes', () => {
  assert.equal(transactionFailure(null), null);
  assert.deepEqual(transactionFailure({ InstructionError: [5, { Custom: 6002 }] }),
    { kind: 'InstructionError', instructionIndex: 5, customCode: 6002 });
  assert.deepEqual(transactionFailure({ InstructionError: [0, { Custom: 6042 }] }),
    { kind: 'InstructionError', instructionIndex: 0, customCode: 6042 });
  assert.deepEqual(transactionFailure('BlockhashNotFound'), { kind: 'BlockhashNotFound' });
  assert.deepEqual(transactionFailure('SECRET'), { kind: 'Unknown' });
  assert.deepEqual(transactionFailure({ InstructionError: [1, 'SECRET'] }), { kind: 'InstructionError', instructionIndex: 1 });
  for (const value of [undefined, { message: 'SECRET' }, { InstructionError: [-1, { Custom: 1 }] }]) {
    assert.deepEqual(transactionFailure(value), { kind: 'Unknown' });
  }
  assert.deepEqual(transactionFailure({ InstructionError: [1, { Custom: 'SECRET' }] }), { kind: 'InstructionError', instructionIndex: 1 });
});

test('diagnostic fields are fixed and bounded even for hostile saved/provider data', () => {
  const input = { stage: 'canceled', lastStage: 'snapshot_behind', expiryCause: 'slot', triggerSide: 'sell',
    signalSlot: 15, currentSlot: 20, snapshotSlot: 16, requiredSlot: 17, elapsedMs: 1000, statusElapsedMs: 400,
    accountElapsedMs: 300, confirmationStatus: 'confirmed', marketCapSol: 0.4, dropBps: 5900,
    rangePassed: true, dropPassed: false, failure: { kind: 'InstructionError', instructionIndex: 2, customCode: 6042,
      message: 'SECRET' }, raw: 'SECRET', url: 'https://SECRET', instructions: Array(10000).fill('SECRET') };
  const safe = safeOrderDiagnostics(input);
  assert.equal(safe.failure.customCode, 6042); assert.equal(safe.lastStage, 'snapshot_behind');
  assert.equal(safe.dropPassed, false); assert.ok(!JSON.stringify(safe).includes('SECRET'));
  assert.ok(JSON.stringify(safe).length < 2048);
  assert.deepEqual(safeOrderDiagnostics({ stage: 'SECRET', lastStage: 'SECRET', expiryCause: 'SECRET',
    currentSlot: -1, elapsedMs: Infinity, peakSlot: Number.MAX_SAFE_INTEGER + 1, marketCapSol: NaN,
    dropBps: -1e13, requiredDropBps: 10001, rangePassed: 'SECRET' }), {});
  for (const value of [null, [], 'SECRET', 5]) assert.deepEqual(safeOrderDiagnostics(value), {});
  assert.equal(readOrderDiagnostics('broken SECRET'), null);
  assert.equal(readOrderDiagnostics(null), null);
  assert.deepEqual(readOrderDiagnostics('{"stage":"SECRET","url":"SECRET"}'), {});
});

test('order evidence merges while pending and cannot be changed by late work after cancellation', () => {
  const { store, paper, id } = setup();
  try {
    paper.diagnose(id, { stage: 'requested', triggerSide: 'buy', signalSlot: 15, peakSlot: 13, windowStartSlot: 11 });
    paper.diagnose(id, { stage: 'status_unconfirmed', statusAttempts: 1, confirmationStatus: 'processed', statusElapsedMs: 250 });
    paper.cancel(id, 101000, 'signal_expired', { stage: 'canceled', lastStage: 'status_unconfirmed', expiryCause: 'slot', currentSlot: 20 });
    const before = store.get('SELECT * FROM paper_orders WHERE id=?', id);
    paper.diagnose(id, { stage: 'filled', currentSlot: 99 });
    paper.cancel(id, 102000, 'trigger_failed', { failure: { kind: 'Unknown' } });
    assert.deepEqual(store.get('SELECT * FROM paper_orders WHERE id=?', id), before);
    const report = paper.report(101000), order = report.recentOrders[0];
    assert.equal(order.error, 'signal_expired'); assert.equal(order.diagnostics.triggerSide, 'buy');
    assert.equal(order.diagnostics.peakSlot, 13); assert.equal(order.diagnostics.windowStartSlot, 11);
    assert.equal(order.diagnostics.lastStage, 'status_unconfirmed'); assert.equal(order.diagnostics.expiryCause, 'slot');
    assert.equal(order.diagnostics.statusElapsedMs, 250);
    assert.ok(!Object.hasOwn(order, 'diagnostics_json'));
    assert.match(report.orderDiagnosticsNote, /queueing/);
  } finally { store.close(); }
});

test('diagnostic cancellation composes with atomic intent updates and rolls back with them', () => {
  const { store, paper, id } = setup();
  try {
    assert.throws(() => store.atomic(() => {
      paper.cancel(id, 100500, 'floor_override', { stage: 'canceled', currentSlot: 16 });
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(paper.pending().length, 1);
    assert.equal(store.get('SELECT diagnostics_json FROM paper_orders WHERE id=?', id).diagnostics_json, null);
    store.atomic(() => paper.cancel(id, 100600, 'floor_override', { stage: 'canceled', currentSlot: 16 }));
    assert.equal(paper.pending().length, 0);
    assert.equal(paper.report().recentOrders[0].diagnostics.currentSlot, 16);
  } finally { store.close(); }
});

test('filled order evidence is immutable and malformed persisted diagnostics are not exposed raw', () => {
  const { store, paper, id } = setup();
  try {
    store.run('UPDATE paper_orders SET diagnostics_json=? WHERE id=?', '{"stage":"SECRET","url":"SECRET"}', id);
    assert.deepEqual(paper.report().recentOrders[0].diagnostics, {});
    paper.diagnose(id, { stage: 'ready_to_fill', rangePassed: true, dropPassed: true });
    paper.fill(store.get('SELECT * FROM paper_orders WHERE id=?', id), { tokens: '100', cost: '10010000' }, 100500);
    const before = store.get('SELECT diagnostics_json FROM paper_orders WHERE id=?', id);
    assert.equal(JSON.parse(before.diagnostics_json).stage, 'filled');
    paper.diagnose(id, { stage: 'canceled' });
    assert.deepEqual(store.get('SELECT diagnostics_json FROM paper_orders WHERE id=?', id), before);
    assert.ok(!JSON.stringify(paper.report().recentOrders).includes('SECRET'));
  } finally { store.close(); }
});

test('old order schema supports truly read-only reports and additive migration preserves history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'order-diagnostics-')), path = join(dir, 'trial.sqlite');
  let store;
  try {
    const h = setup(path); store = h.store;
    h.paper.cancel(h.id, 100600, 'entry_condition_changed');
    store.run("INSERT INTO metadata VALUES('paper_trial_config',?)", JSON.stringify(h.paper.cfg));
    store.db.exec('ALTER TABLE paper_orders DROP COLUMN diagnostics_json');
    const before = { ...store.get('SELECT * FROM paper_orders WHERE id=?', h.id) };
    store.close(); store = null;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('BEGIN');
      const reader = { get: (sql, ...p) => db.prepare(sql).get(...p), all: (sql, ...p) => db.prepare(sql).all(...p) };
      const paper = Object.assign(Object.create(PaperStore.prototype), { store: reader, cfg: paperConfig({}) });
      assert.equal(paper.report().recentOrders[0].diagnostics, null);
      assert.equal(reader.all('PRAGMA table_info(paper_orders)').some(x => x.name === 'diagnostics_json'), false);
    } finally { db.close(); }
    store = new Store(path, cfg);
    const savedConfig = store.get("SELECT value FROM metadata WHERE key='paper_trial_config'").value;
    const paper = new PaperStore(store, paperConfig({}));
    const { diagnostics_json, ...after } = store.get('SELECT * FROM paper_orders WHERE id=?', h.id);
    assert.equal(diagnostics_json, null); assert.deepEqual(after, before);
    assert.equal(store.get("SELECT value FROM metadata WHERE key='paper_trial_config'").value, savedConfig);
    assert.equal(paper.report().recentOrders[0].diagnostics, null);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('fault report distinguishes cumulative events from unique mints in retained samples', () => {
  const { store, paper } = setup();
  try {
    for (let i = 0; i < 130; i++) paper.accountFault(mint, i, null, 'missing_account', i);
    const report = paper.report();
    assert.deepEqual(report.accountFaultSummary, { totalEvents: 130, retainedSamples: 100, distinctMintsInRetainedSamples: 1 });
    assert.match(report.accountFaultEvidenceNote, /not unique mints/);
  } finally { store.close(); }
});
