import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { PaperStore, paperConfig } from '../src/paper-store.js';
import { PaperEngine } from '../src/paper-engine.js';
import { reserves } from '../src/paper-math.js';
import { decodeCurve, CURVE_VALIDATION_CODES } from '../src/chain.js';
import { PUMP } from '../src/config.js';

const mint = '9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cfg = { firstCheck: 30, recheck: 30, horizon: 86400, minCap: 2, maxCap: 5, minLiquidity: 0.005, trackingSeconds: 30, paperMode: true };
const curveBytes = (mutate = () => {}) => {
  const b = Buffer.alloc(166); Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(b);
  b.writeBigUInt64LE(1000000000000n, 8); b.writeBigUInt64LE(200000000n, 16); b.writeBigUInt64LE(900000000000n, 24);
  b.writeBigUInt64LE(1000000000n, 32); b.writeBigUInt64LE(1000000000000n, 40); b[81] = 1;
  mutate(b); return b;
};
const acct = bytes => ({ owner: PUMP, data: [bytes.toString('base64'), 'base64'] });
function setup() {
  const store = new Store(':memory:', cfg);
  store.addMint({ mint, timestamp: 100 });
  store.evaluate(mint, 130, 1, 'AA==', { marketCap: 3, liquidity: 0.1 }, { category: 'candidate', age: null, passes: true }, null);
  const engine = new PaperEngine(store, { call: async () => ({ value: [] }), accounts: async () => ({ context: { slot: 1 }, value: [] }) },
    paperConfig({}), { now: () => 100000, project: raw => raw });
  engine.attach({ add() {}, remove() {}, start() {}, stop: async () => {}, resync() {}, setPreprocessed() {}, covers: () => true });
  engine.add(mint); engine.onReady(); engine.onSlot(15);
  return { store, engine };
}
const faults = store => store.all('SELECT * FROM paper_account_faults ORDER BY id');

test('decodeCurve errors carry fixed validation codes with unchanged messages', () => {
  const cases = [
    [null, 'missing_or_wrong_owner', /Missing or wrong-owner/],
    [{ owner: 'other', data: ['AA==', 'base64'] }, 'missing_or_wrong_owner', /Missing or wrong-owner/],
    [acct(Buffer.alloc(10)), 'length_or_discriminator', /Unknown curve layout/],
    [acct(curveBytes(b => { b[0] ^= 1; })), 'length_or_discriminator', /Unknown curve layout/],
    [acct(curveBytes(b => { b[83] = 1; })), 'unsupported_quote', /Unsupported non-native-SOL quote/],
    [acct(curveBytes(b => { b[81] = 2; })), 'invalid_flags', /Invalid curve flags/],
    [acct(curveBytes(b => { b[48] = 2; })), 'invalid_flags', /Invalid curve flags/],
    [acct(curveBytes(b => { b.writeBigUInt64LE(0n, 8); })), 'zero_reserves', /Zero virtual token reserves/],
  ];
  for (const [account, validation, message] of cases) {
    assert.throws(() => decodeCurve(account), error => error.validation === validation && message.test(error.message));
    assert.ok(CURVE_VALIDATION_CODES.includes(validation));
  }
  assert.equal(decodeCurve(acct(curveBytes())).mayhem, true);
});

test('engine records the safe validation subtype only for invalid curves', () => {
  const { store, engine } = setup();
  engine.onAccount(mint, 20, acct(curveBytes(b => { b[81] = 2; })));
  engine.onAccount(mint, 21, acct(curveBytes(b => { b[81] = 0; })));
  engine.onAccount(mint, 22, acct(curveBytes(b => { b.writeBigUInt64LE(0n, 8); })));
  engine.onAccount(mint, 23, null);
  const rows = faults(store);
  assert.deepEqual(rows.map(row => [row.code, row.subtype]),
    [['invalid_curve', 'invalid_flags'], ['not_mayhem', null], ['invalid_curve', 'zero_reserves'], ['missing_account', null]]);
  // Existing counters and paper_rejections remain compatible.
  assert.equal(store.get("SELECT count FROM paper_counters WHERE name='account:invalid_curve'").count, 2);
  const legacy = store.all("SELECT detail FROM paper_rejections WHERE reason='invalid_account'").map(row => JSON.parse(row.detail));
  assert.equal(legacy.length, 4); assert.equal(legacy[0].code, 'invalid_curve'); assert.equal(legacy[0].bytes, 166);
  store.close();
});

test('unknown or hostile subtypes and codes are sanitized', () => {
  const { store, engine } = setup();
  const paper = engine.paper;
  paper.accountFault(mint, 5, null, 'invalid_curve', 1, 'https://secret.test/?api-key=SECRET');
  paper.accountFault('not a mint https://secret.test', 6, { owner: 'secret', data: ['secret-key', 'hex'] }, 'raw error text', 2, 'invalid_flags');
  paper.accountFault(mint, 7, null, 'wrong_owner', 3, 'invalid_flags');
  const rows = faults(store);
  assert.deepEqual(rows.map(row => [row.code, row.subtype]), [['invalid_curve', null], ['processing_error', null], ['wrong_owner', null]]);
  assert.equal(rows[1].mint, null);
  assert.ok(!JSON.stringify([rows, store.all('SELECT detail FROM paper_rejections')]).includes('secret'));
  store.close();
});

test('fault samples are capped at 100 newest and survive decoder-rejection churn and restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'faults-'));
  try {
    const path = join(dir, 'f.db');
    let store = new Store(path, cfg), paper = new PaperStore(store, paperConfig({}));
    for (let i = 0; i < 130; i++) paper.accountFault(mint, i, null, 'missing_account', i);
    for (let i = 0; i < 500; i++) paper.rejection('token_program', { slot: i }, 1000 + i);
    assert.equal(store.get('SELECT COUNT(*) n FROM paper_rejections WHERE reason=?', 'invalid_account').n, 0, 'legacy table churned');
    assert.equal(store.get('SELECT COUNT(*) n FROM paper_rejections').n, 100);
    let report = paper.report(0);
    assert.equal(report.recentAccountFaults.length, 100);
    assert.equal(report.recentAccountFaults[0].slot, 129); assert.equal(report.recentAccountFaults.at(-1).slot, 30);
    assert.deepEqual(Object.keys(report.recentAccountFaults[0]).sort(),
      ['atMs', 'base64', 'bytes', 'code', 'curveDiscriminatorMatches', 'mint', 'ownerMatches', 'present', 'quoteLayout', 'quoteMintObserved', 'slot', 'subtype']);
    assert.equal(report.recentAccountFaults[0].present, false);
    store.close();
    store = new Store(path, cfg); paper = new PaperStore(store, paperConfig({}));
    assert.equal(paper.report(0).recentAccountFaults.length, 100);
    assert.equal(faults(store).length, 100);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('existing safe fault samples are copied once, sanitized, and never re-copied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'faults-'));
  try {
    const path = join(dir, 'legacy.db');
    let store = new Store(path, cfg), paper = new PaperStore(store, paperConfig({}));
    store.db.exec('DROP TABLE paper_account_faults'); // simulate a pre-upgrade database
    const old = (i, detail) => store.run('INSERT INTO paper_rejections(reason,at_ms,detail) VALUES(?,?,?)', 'invalid_account', 10 + i, JSON.stringify(detail));
    for (let i = 0; i < 3; i++) old(i, { mint, slot: i, code: 'invalid_curve', present: true, ownerMatches: true, base64: true, bytes: 82 });
    old(3, { mint: 'https://secret.test/?api-key=SECRET', slot: 'bad', code: 'secret error text', present: true, bytes: -5, extra: 'secret payload', subtype: 'invalid_flags' });
    store.run('INSERT INTO paper_rejections(reason,at_ms,detail) VALUES(?,?,?)', 'invalid_account', 99, 'not json secret');
    store.run('INSERT INTO paper_rejections(reason,at_ms,detail) VALUES(?,?,?)', 'token_program', 98, '{}');
    store.close();

    store = new Store(path, cfg); paper = new PaperStore(store, paperConfig({}));
    let rows = faults(store);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map(row => row.at_ms), [10, 11, 12, 13]);
    assert.deepEqual([rows[0].code, rows[0].subtype, rows[0].bytes, rows[0].present, rows[0].owner_matches], ['invalid_curve', null, 82, 1, 1]);
    assert.deepEqual([rows[3].mint, rows[3].slot, rows[3].code, rows[3].subtype, rows[3].bytes], [null, null, 'processing_error', null, null]);
    assert.ok(!JSON.stringify(rows).includes('secret'));
    assert.equal(store.get("SELECT COUNT(*) n FROM paper_rejections WHERE reason='invalid_account'").n, 5, 'legacy rows untouched');

    // Reopening, even after new faults prune older samples, never duplicates or resurrects copied rows.
    for (let i = 0; i < 100; i++) paper.accountFault(mint, 100 + i, null, 'missing_account', 1000 + i);
    store.close();
    store = new Store(path, cfg); paper = new PaperStore(store, paperConfig({}));
    rows = faults(store);
    assert.equal(rows.length, 100); assert.ok(rows.every(row => row.source_rejection_id === null));
    assert.equal(paper.report(0).recentAccountFaults[0].slot, 199);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only the newest 100 legacy samples are copied and a fresh database starts empty', () => {
  const store = new Store(':memory:', cfg);
  let paper = new PaperStore(store, paperConfig({}));
  assert.deepEqual(paper.report(0).recentAccountFaults, []);
  store.db.exec('DROP TABLE paper_account_faults');
  for (let i = 0; i < 100; i++) store.run('INSERT INTO paper_rejections(reason,at_ms,detail) VALUES(?,?,?)', 'invalid_account', i, JSON.stringify({ mint, slot: i, code: 'wrong_owner' }));
  paper = new PaperStore(store, paperConfig({}));
  assert.equal(faults(store).length, 100);
  assert.equal(reserves(acct(curveBytes())).mayhem, true);
  store.close();
});
