import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { PaperStore, paperConfig } from '../src/paper-store.js';

const mint = '9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cfg = { firstCheck: 30, recheck: 30, horizon: 86400, paperMode: true };
function setup(realSol = 1000000000n) {
  const store = new Store(':memory:', cfg), paper = new PaperStore(store, paperConfig({}));
  store.addMint({ mint, timestamp: 1 }); paper.enroll(mint, 1000);
  const quote = { tokens: '1000000000', cost: '10010000' };
  const id = paper.request(mint, 'buy', 'dump', quote, null, 1000);
  paper.fill(store.get('SELECT * FROM paper_orders WHERE id=?', id), quote, 1000);
  const b = Buffer.alloc(166); Buffer.from([23,183,248,55,96,216,172,96]).copy(b);
  b.writeBigUInt64LE(1000000000000n, 8); b.writeBigUInt64LE(200000000n, 16);
  b.writeBigUInt64LE(900000000000n, 24); b.writeBigUInt64LE(realSol, 32);
  b.writeBigUInt64LE(1000000000000n, 40); b[81] = 1;
  store.run('UPDATE paper_watches SET fingerprint=?,last_cap=?,last_observed_ms=?,last_change_ms=? WHERE mint=?',
    b.toString('base64'), 0.2, 2000, 2000, mint);
  return { store, paper };
}

test('position report separates aged unresolved exposure and saved liquidity from realized PnL', () => {
  const { store, paper } = setup(3n);
  try {
    store.run("UPDATE paper_watches SET status='exit_blocked',reason='liquidity_risk' WHERE mint=?", mint);
    const report = paper.report(5000), health = report.openPositionHealth[0];
    assert.equal(health.heldMs, 4000);
    assert.equal(health.observationAgeMs, 3000);
    assert.equal(health.exitReason, 'liquidity_risk');
    assert.equal(health.entryCostLamports, '10010000');
    assert.equal(health.fullExitSupported, false);
    assert.equal(health.fullSaleGrossLamports, '199800');
    assert.equal(health.liquidityCoverageBps, '0');
    assert.equal(health.modeledExitNetLamports, null);
    assert.equal(report.realizedPnlLamports, '0');
    assert.equal(report.performance.zeroRecoveryScenarioPnlLamports, '-10010000');
    assert.equal(report.performance.unresolvedFraction, 1);
    assert.deepEqual(report.performance.unresolvedByExitState, [{
      exitStatus: 'insufficient_liquidity_or_invalid_amount', exitReason: 'liquidity_risk',
      positions: 1, costLamports: '10010000', oldestHeldMs: 4000,
    }]);
    assert.ok(report.feedHealth.process);
    assert.equal(store.get("SELECT COUNT(*) n FROM paper_positions WHERE status='open'").n, 1);
  } finally { store.close(); }
});

test('confirmed graduation reason outranks an older apparently liquid saved fingerprint', () => {
  const { store, paper } = setup();
  try {
    assert.equal(paper.report(3000).openPositionHealth[0].fullExitSupported, true);
    // Same transition as graduation found only by confirmed order reconciliation.
    store.run("UPDATE paper_watches SET status='exit_blocked',reason='graduated_no_amm_exit' WHERE mint=?", mint);
    const health = paper.report(5000).openPositionHealth[0];
    assert.equal(health.exitStatus, 'graduated');
    assert.equal(health.fullExitSupported, false);
    assert.equal(health.modeledExitNetLamports, null);
    assert.equal(health.realSolLamports, null);
    assert.equal(health.lastMarketCapSol, null);
    assert.equal(health.lastObservedMs, 2000, 'never fabricate a newer observation');
  } finally { store.close(); }
});
