import test from 'node:test';
import assert from 'node:assert/strict';
import { paperConfig } from '../src/paper-store.js';
import { exitQuote } from '../src/paper-math.js';
import { prepare, simulate, variants, strictQuote, study, compare, advanceMultiplier,
  scaledBudget, outcomeMetrics, MULTIPLIER_FACTORS, markdown } from '../research/agent-exit-sensitivity.js';

const cfg = paperConfig({ PAPER_AGENT_MAX_EXPOSURE_LAMPORTS: '50000000000',
  MAX_TRADE_COUNT: '10000', PAPER_AGENT_MAX_WATCHES: '1000' }, 'agent-sell-liquidity');
const initial = { vs: 1000000000, vt: 1000000000000, rs: 100000000, rt: 800000000000 };
function tape(points) {
  let previous = initial;
  return points.map((point, i) => {
    const next = { ...previous, ...point.reserves };
    const e = { signature: `tx${i}`, slot: point.slot, idx: point.idx ?? i, log_index: 0,
      bt: point.bt ?? 1000 + Math.floor(point.slot * 0.4), mint: 'mint1', buy: false,
      agent: i === 0, mayhem: true, ...point.event };
    for (const key of ['vs', 'vt', 'rs', 'rt']) { e[`${key}_before`] = previous[key]; e[`${key}_after`] = next[key]; }
    previous = next; return e;
  });
}
const steady = (end = 95) => tape(Array.from({ length: end + 1 }, (_, slot) => ({ slot })));
const run = (events, config = cfg, delay = 1) => simulate(prepare(events), config, delay);

function mintTape(mint, start, end, changes = {}) {
  return tape(Array.from({ length: end - start + 1 }, (_, i) => ({ slot: start + i,
    event: { mint, signature: `${mint}:${start + i}` },
    ...(i === 0 ? { reserves: { rs: 40000000 } } : changes[start + i] ? { reserves: changes[start + i] } : {}) })));
}

test('all ten multiplier factors update and reverse exactly without floating point', () => {
  assert.deepEqual(Object.values(MULTIPLIER_FACTORS).map(f => Number(f.numerator) / Number(f.denominator)),
    [1.2, 1.4, 1.5, 1.6, 1.8, 2, 2.3, 2.5, 3, 3.5]);
  for (const f of Object.values(MULTIPLIER_FACTORS)) {
    const one = { numerator: '1', denominator: '1' };
    let m = advanceMultiplier(one, -1, 'divide', f);
    assert.deepEqual(m, f);
    m = advanceMultiplier(m, -1, 'divide', f);
    assert.equal(BigInt(m.numerator), BigInt(f.numerator) ** 2n);
    assert.equal(BigInt(m.denominator), BigInt(f.denominator) ** 2n);
    assert.deepEqual(advanceMultiplier(m, 0, 'divide', f), m);
    assert.deepEqual(advanceMultiplier(m, null, 'divide', f), m);
    assert.deepEqual(advanceMultiplier(m, 1, 'reset', f), one);
    m = advanceMultiplier(m, 1, 'divide', f);
    assert.deepEqual(m, f);
    m = advanceMultiplier(m, 1, 'divide', f);
    assert.deepEqual(m, one);
    assert.deepEqual(advanceMultiplier(m, 1, 'divide', f), one);
  }
  for (const f of [{ numerator: '1', denominator: '1' }, { numerator: '2', denominator: '0' },
    { numerator: '1', denominator: '2' }]) {
    assert.throws(() => advanceMultiplier({ numerator: '1', denominator: '1' }, -1, 'divide', f), /invalid_multiplier_factor/);
    assert.throws(() => simulate(prepare(steady()), cfg, 1, 'strict', { multiplierFactor: f }), /invalid_multiplier_factor/);
  }
});

test('factor suite shares buy limits and config, requotes sizing, and reproduces default 1.5', () => {
  const config = { ...cfg, holdSlots: 4, maxSwapBudgetLamports: '50000000' };
  const events = [...mintTape('A', 0, 6), ...mintTape('B', 7, 13),
    ...mintTape('C', 14, 20, { 16: { vs: 2000000000 } }), ...mintTape('D', 21, 27)];
  const studyResult = study(events, config, 'multiplier-factors');
  const prior = study(events, config, 'gradual-multiplier');
  for (const [key, run] of Object.entries(studyResult.runs)) {
    assert.equal(Object.keys(run.arms).length, 11);
    assert.equal(Object.keys(run.primary.comparisons).length, 10);
    assert.deepEqual(run.arms.factor1_5.records, prior.runs[key].arms.gradualMultiplier.records);
    assert.deepEqual(run.arms.baseline.records, prior.runs[key].arms.baseline.records);
    for (const [name, a] of Object.entries(run.arms)) {
      assert.deepEqual(a.cfg, config); assert.equal(a.minimumBudgetLamports, '5000000');
      if (name !== 'baseline') {
        assert.deepEqual(a.multiplierFactor, MULTIPLIER_FACTORS[name]);
        assert.equal(a.sizingPolicy, 'gradual_multiplier');
      }
      for (const p of a.records) assert.ok(BigInt(p.budgetLamports) >= 5000000n && BigInt(p.budgetLamports) <= 50000000n);
    }
  }
  const b = studyResult.runs.delay1.arms.factor1_2.records.find(p => p.mint === 'B');
  assert.equal(b.budgetLamports, '5760000');
  assert.notEqual(b.tokens_raw, studyResult.runs.delay1.arms.factor1_5.records.find(p => p.mint === 'B').tokens_raw);
  const report = markdown(studyResult);
  assert.match(report, /factor1_2/); assert.match(report, /factor3_5/);
  assert.match(report, /factor 6\/5/); assert.match(report, /0\.005000000 SOL/);
});

test('factor sweep applies a common unknown-outcome cutoff to every arm', () => {
  const events = [...mintTape('A', 0, 4), ...mintTape('B', 5, 11)];
  events.find(p => p.mint === 'A' && p.slot === 2).rs_before++;
  const run = study(events, { ...cfg, holdSlots: 2, maxSwapBudgetLamports: '50000000' }, 'multiplier-factors').runs.delay1;
  assert.equal(run.primary.endSlot, 1);
  for (const a of Object.values(run.primary.arms)) {
    assert.equal(a.endSlot, 1); assert.equal(a.resolved, 0); assert.equal(a.multiplierTrajectory.length, 0);
  }
  for (const a of Object.values(run.arms)) assert.equal(a.records.find(p => p.mint === 'B').sizingEvidence.numerator, '1');
});

test('gradual wins reverse one loss step exactly and cannot reduce multiplier below one', () => {
  let m = { numerator: '1', denominator: '1' };
  for (const [net, expected] of [[-1, ['3', '2']], [-1, ['9', '4']], [1, ['3', '2']], [1, ['1', '1']], [1, ['1', '1']]]) {
    m = advanceMultiplier(m, net, 'divide');
    assert.deepEqual(m, { numerator: expected[0], denominator: expected[1] });
  }
  m = advanceMultiplier(m, -1, 'divide');
  for (const net of [0, null, undefined]) assert.deepEqual(advanceMultiplier(m, net, 'divide'), m);
});

test('minimum buy clamps the multiplied raw budget without bypassing the maximum', () => {
  const config = { ...cfg, maxSwapBudgetLamports: '50000000' }, m = { numerator: '3', denominator: '2' };
  assert.equal(scaledBudget(10000000n, config, m, 5000000n).budget, 5000000n);
  assert.equal(scaledBudget(40000000n, config, m, 5000000n).budget, 7200000n);
  assert.equal(scaledBudget(1000000000n, config, m, 5000000n).budget, 50000000n);
  const floor = scaledBudget(10000000n, config, m, 5000000n).evidence;
  assert.equal(floor.floorBinding, true); assert.equal(floor.unscaledBudgetLamports, '5000000');
  assert.throws(() => scaledBudget(10000000n, config, m, 50000001n), /invalid_minimum_budget/);
  assert.throws(() => simulate(prepare(steady()), config, 1, 'strict', { minimumBudgetLamports: '-1' }), /invalid_minimum_budget/);
});

test('three-arm study shares the floor and cap and retains gradual sizing after a win', () => {
  const events = [...mintTape('A', 0, 6), ...mintTape('B', 7, 13),
    ...mintTape('C', 14, 20, { 16: { vs: 2000000000 } }), ...mintTape('D', 21, 27)];
  const config = { ...cfg, holdSlots: 4, maxSwapBudgetLamports: '50000000' };
  const result = study(events, config, 'gradual-multiplier');
  const arms = result.runs.delay1.arms;
  assert.deepEqual(Object.keys(arms), ['baseline', 'lossMultiplier', 'gradualMultiplier']);
  for (const a of Object.values(arms)) {
    assert.deepEqual(a.cfg, config); assert.equal(a.minimumBudgetLamports, '5000000');
    for (const p of a.records) assert.ok(BigInt(p.budgetLamports) >= 5000000n && BigInt(p.budgetLamports) <= 50000000n);
  }
  assert.deepEqual(arms.gradualMultiplier.records.map(p => p.budgetLamports), ['5000000', '7200000', '10800000', '7200000']);
  assert.equal(arms.lossMultiplier.records.find(p => p.mint === 'D').budgetLamports, '5000000');
  assert.equal(arms.gradualMultiplier.floorBoundEntries, 1);
  assert.equal(arms.gradualMultiplier.boostedEntries, 3);
  assert.deepEqual(arms.gradualMultiplier.multiplierTrajectory[2].after, { numerator: '3', denominator: '2' });
});

test('minimum budget retains liquidity and quality checks at signal and fill', () => {
  const config = { ...cfg, maxSwapBudgetLamports: '50000000', minEntryLiquidityMultiple: 3 };
  const options = { minimumBudgetLamports: '5000000', sizingPolicy: 'gradual_multiplier' };
  const low = tape([{ slot: 0, reserves: { rs: 10000000 } }, { slot: 1 }]);
  assert.equal(simulate(prepare(low), config, 1, 'strict', options).rejections['signal:entry_real_liquidity'], 1);
  const falling = tape([{ slot: 0, reserves: { rs: 20000000 } }, { slot: 1, reserves: { rs: 10000000 } }]);
  assert.equal(simulate(prepare(falling), config, 1, 'strict', options).rejections['fill:entry_real_liquidity'], 1);
  assert.equal(simulate(prepare(steady()), { ...config, maxRoundTripLossBps: 0 }, 1, 'strict', options)
    .rejections['signal:entry_round_trip_loss'], 1);
});

test('gradual sizing stays frozen across a same-slot win before its fill', () => {
  const events = [...mintTape('A', 0, 4), ...mintTape('B', 5, 9),
    ...mintTape('C', 10, 17, { 12: { vs: 2000000000 } }), ...mintTape('D', 13, 19)];
  const result = simulate(prepare(events), { ...cfg, holdSlots: 2, maxSwapBudgetLamports: '50000000' },
    1, 'strict', { sizingPolicy: 'gradual_multiplier', minimumBudgetLamports: '5000000' });
  const win = result.multiplierTrajectory.find(p => p.mint === 'C');
  assert.equal(win.slot, 13); assert.ok(BigInt(win.netLamports) > 0n);
  assert.deepEqual(win.after, { numerator: '3', denominator: '2' });
  assert.equal(result.records.find(p => p.mint === 'D').budgetLamports, '10800000');
});

test('gradual study stops all three arms before unknown outcomes and never updates on censor', () => {
  const events = [...mintTape('A', 0, 4), ...mintTape('B', 5, 11)];
  events.find(p => p.mint === 'A' && p.slot === 2).rs_before++;
  const run = study(events, { ...cfg, holdSlots: 2, maxSwapBudgetLamports: '50000000' }, 'gradual-multiplier').runs.delay1;
  assert.equal(run.primary.endSlot, 1);
  for (const a of Object.values(run.primary.arms)) {
    assert.equal(a.resolved, 0); assert.equal(a.multiplierTrajectory.length, 0);
    assert.equal(a.records[0].censorReason, 'study_cutoff');
  }
  assert.equal(run.arms.gradualMultiplier.records.find(p => p.mint === 'B').sizingEvidence.numerator, '1');
  assert.deepEqual(Object.keys(run.primary.comparisons), ['lossMultiplier', 'gradualMultiplier']);
});

test('loss multiplier updates exactly on net loss/loss/win and not zero/unknown', () => {
  let m = { numerator: '1', denominator: '1' };
  m = advanceMultiplier(m, '-10000'); assert.deepEqual(m, { numerator: '3', denominator: '2' });
  m = advanceMultiplier(m, '-1'); assert.deepEqual(m, { numerator: '9', denominator: '4' });
  assert.deepEqual(advanceMultiplier(m, '0'), m);
  assert.deepEqual(advanceMultiplier(m, null), m);
  m = advanceMultiplier(m, '1'); assert.deepEqual(m, { numerator: '1', denominator: '1' });
});

test('scaled budget uses exact integer flooring and never raises the swap cap', () => {
  assert.equal(scaledBudget(40000000n, cfg, { numerator: '3', denominator: '2' }).budget, 7200000n);
  assert.equal(scaledBudget(40000000n, cfg, { numerator: '9', denominator: '4' }).budget, 10000000n);
  assert.equal(scaledBudget(101n, cfg, { numerator: '9', denominator: '4' }).budget, 27n);
  assert.equal(scaledBudget(100000000n, cfg, { numerator: '81', denominator: '16' }).budget, 10000000n);
  assert.equal(scaledBudget(100000000n, cfg, { numerator: '81', denominator: '16' }).evidence.multiplierClipped, true);
});

test('replay requotes loss/loss/win sizing and resets after the win', () => {
  const events = [...mintTape('A', 0, 6), ...mintTape('B', 7, 13),
    ...mintTape('C', 14, 20, { 16: { vs: 2000000000 } }), ...mintTape('D', 21, 27)];
  const result = simulate(prepare(events), { ...cfg, holdSlots: 4 }, 1, 'strict', { sizingPolicy: 'loss_multiplier' });
  const rows = Object.fromEntries(result.records.map(p => [p.mint, p]));
  assert.deepEqual(['A', 'B', 'C', 'D'].map(m => rows[m].sizingEvidence.budgetLamports),
    ['4800000', '7200000', '10000000', '4800000']);
  assert.equal(result.boostedEntries, 2);
  assert.ok(BigInt(rows.C.quoteProxyLamports) > 0n);
  assert.deepEqual(result.multiplierTrajectory[2].after, { numerator: '1', denominator: '1' });
  const base = simulate(prepare(events), { ...cfg, holdSlots: 4 });
  assert.notEqual(rows.B.tokens_raw, base.records.find(p => p.mint === 'B').tokens_raw);
});

test('pending sizing is frozen across a later loss, including same-slot signals', () => {
  const events = [...mintTape('A', 0, 4), ...mintTape('B', 3, 9), ...mintTape('C', 4, 10)];
  const result = simulate(prepare(events), { ...cfg, holdSlots: 2 }, 1, 'strict', { sizingPolicy: 'loss_multiplier' });
  const rows = Object.fromEntries(result.records.map(p => [p.mint, p]));
  assert.equal(result.multiplierTrajectory[0].slot, 4);
  assert.equal(rows.B.sizingEvidence.numerator, '1');
  assert.equal(rows.C.sizingEvidence.numerator, '1');
  assert.equal(rows.B.budgetLamports, '4800000');
  assert.equal(rows.C.budgetLamports, '4800000');
});

test('pending boosted sizing survives another trade winning before its fill', () => {
  const events = [...mintTape('A', 0, 4), ...mintTape('B', 5, 12, { 7: { vs: 2000000000 } }),
    ...mintTape('C', 7, 14)];
  const result = simulate(prepare(events), { ...cfg, holdSlots: 2 }, 1, 'strict', { sizingPolicy: 'loss_multiplier' });
  const c = result.records.find(p => p.mint === 'C');
  assert.equal(c.sizingEvidence.numerator, '3');
  assert.equal(c.budgetLamports, '7200000');
  assert.ok(result.multiplierTrajectory.some(p => p.mint === 'B' && BigInt(p.netLamports) > 0n));
});

test('scaled budget support is rechecked at fill and entry quality remains strict', () => {
  const events = [...mintTape('A', 0, 4), ...mintTape('B', 5, 10, { 6: { rs: 30000000 } })];
  const result = simulate(prepare(events), { ...cfg, holdSlots: 2 }, 1, 'strict', { sizingPolicy: 'loss_multiplier' });
  assert.equal(result.rejections['fill:budget_no_longer_supported'], 1);
  assert.equal(result.entries, 1);
  const strict = simulate(prepare([...mintTape('A', 0, 4)]), { ...cfg, holdSlots: 2, maxRoundTripLossBps: 0 },
    1, 'strict', { sizingPolicy: 'loss_multiplier' });
  assert.equal(strict.entries, 0);
  assert.equal(strict.rejections['signal:entry_round_trip_loss'], 1);
});

test('unknown outcome does not update multiplier and primary stops both arms before it', () => {
  const events = [...mintTape('A', 0, 4), ...mintTape('B', 5, 11)];
  events.find(p => p.mint === 'A' && p.slot === 2).rs_before++;
  const result = study(events, { ...cfg, holdSlots: 2 }, 'loss-multiplier');
  const run = result.runs.delay1;
  assert.equal(run.primary.endSlot, 1);
  assert.equal(run.primary.firstUnknown.slot, 2);
  assert.equal(run.primary.arms.baseline.resolved, 0);
  assert.equal(run.primary.arms.lossMultiplier.resolved, 0);
  assert.equal(run.primary.arms.lossMultiplier.multiplierTrajectory.length, 0);
  assert.equal(run.primary.arms.lossMultiplier.records[0].censorReason, 'study_cutoff');
  assert.equal(run.arms.lossMultiplier.records.find(p => p.mint === 'B').sizingEvidence.numerator, '1');
  assert.match(run.continuationAssumption, /conditional/);
});

test('realized drawdown and profit factor exclude unknown position P&L', () => {
  const rows = [10, -5, -20, 2].map(n => ({ status: 'resolved', quoteProxyLamports: String(n), entry_cost_lamports: '30' }));
  rows.push({ status: 'censored', entry_cost_lamports: '40' });
  const m = outcomeMetrics(rows);
  assert.equal(m.netQuoteProxyLamports, '-13');
  assert.equal(m.realizedMaxDrawdownLamports, '25');
  assert.equal(m.profitFactor, 12 / 25); assert.equal(m.maxLossStreak, 2);
  assert.equal(m.unresolvedCostLamports, '40'); assert.equal(m.winRate, 0.5);
});

test('research arms change exactly one baseline field and leave input untouched', () => {
  const arms = variants(cfg);
  for (const [name, field] of [['hold40', 'holdSlots'], ['guard3', 'liquidityExitMultiple'], ['entry5', 'maxRoundTripLossBps']]) {
    assert.deepEqual(Object.keys(cfg).filter(k => arms[name][k] !== cfg[k]), [field]);
  }
  assert.equal(cfg.holdSlots, 80);
});

test('take-profit suite changes only profit target and retains 30% control', () => {
  const arms = variants(cfg, 'take-profit');
  assert.deepEqual(Object.keys(arms), ['baseline', 'tp40', 'tp50', 'tp60']);
  for (const [name, bps] of [['tp40', 4000], ['tp50', 5000], ['tp60', 6000]]) {
    assert.equal(arms[name].profitBps, bps);
    assert.deepEqual(Object.keys(cfg).filter(k => arms[name][k] !== cfg[k]), ['profitBps']);
  }
  assert.throws(() => variants({ ...cfg, profitBps: 2000 }, 'take-profit'), /control/);
  assert.throws(() => variants(cfg, 'unknown'), /unknown_study_suite/);
});

test('lower-TP suite changes only target and exits after each lower threshold', () => {
  const arms = variants(cfg, 'lower-tp');
  assert.deepEqual(Object.keys(arms), ['baseline', 'tp15', 'tp20', 'tp25']);
  for (const [name, bps] of [['tp15', 1500], ['tp20', 2000], ['tp25', 2500]]) {
    assert.equal(arms[name].profitBps, bps);
    assert.deepEqual(Object.keys(cfg).filter(k => arms[name][k] !== cfg[k]), ['profitBps']);
  }
  assert.throws(() => variants({ ...cfg, profitBps: 2000 }, 'lower-tp'), /control/);
  // Reserve-price increases must exceed net targets after fees and sale impact.
  const levels = { 2: 1220000000, 6: 1270000000, 10: 1320000000, 14: 1400000000 };
  const events = tape(Array.from({ length: 96 }, (_, slot) => ({ slot,
    ...(levels[slot] ? { reserves: { vs: levels[slot] } } : {}) })));
  const results = study(events, cfg, 'lower-tp');
  for (const [name, expected] of [['tp15', 3], ['tp20', 7], ['tp25', 11], ['baseline', 15]]) {
    assert.equal(results.runs.delay1.arms[name].records[0].exitSlot, expected);
    assert.equal(results.runs.delay1.arms[name].records[0].exitReason, 'profit');
  }
  assert.equal(results.runs.delay1.comparisons.tp15.worse, 1);
});

test('lower TP can exit in profit before the control times out at a loss', () => {
  const events = tape(Array.from({ length: 96 }, (_, slot) => ({ slot,
    ...(slot === 2 ? { reserves: { vs: 1320000000 } } : slot === 6 ? { reserves: { vs: 1000000000 } } : {}) })));
  const results = study(events, cfg, 'lower-tp').runs.delay1;
  assert.equal(results.arms.baseline.records[0].exitReason, 'timeout');
  assert.ok(BigInt(results.arms.baseline.records[0].quoteProxyLamports) < 0n);
  for (const name of ['tp15', 'tp20', 'tp25']) {
    assert.equal(results.arms[name].records[0].exitReason, 'profit');
    assert.equal(results.comparisons[name].better, 1);
  }
});

test('higher TP waits for its own threshold and a subsequent observation', () => {
  const levels = { 2: 1400000000, 6: 1500000000, 10: 1600000000, 14: 1700000000 };
  const events = tape(Array.from({ length: 96 }, (_, slot) => ({ slot,
    ...(levels[slot] ? { reserves: { vs: levels[slot] } } : {}) })));
  const results = study(events, cfg, 'take-profit');
  const arms = results.runs.delay1.arms;
  for (const [name, expected] of [['baseline', 3], ['tp40', 7], ['tp50', 11], ['tp60', 15]]) {
    assert.equal(arms[name].records[0].exitSlot, expected);
    assert.equal(arms[name].records[0].exitReason, 'profit');
  }
  assert.equal(results.runs.delay1.comparisons.tp60.better, 1);
  assert.deepEqual(results.runs.delay1.comparisons.tp60.baselineProfitTransitions, { profit: 1 });
});

test('missed higher TP can turn baseline profit into a timeout or censored outcome', () => {
  const events = tape(Array.from({ length: 96 }, (_, slot) => ({ slot,
    ...(slot === 2 ? { reserves: { vs: 1400000000 } } : slot === 6 ? { reserves: { vs: 1000000000 } } : {}) })));
  const results = study(events, cfg, 'take-profit').runs.delay1;
  assert.deepEqual(results.comparisons.tp40.baselineProfitTransitions, { timeout: 1 });
  assert.equal(results.comparisons.tp40.worse, 1);
  assert.equal(results.arms.tp40.records[0].exitSlot, 82);
  const short = study(events.slice(0, 6), cfg, 'take-profit').runs.delay1;
  assert.deepEqual(short.comparisons.tp40.baselineProfitTransitions, { censored: 1 });
  assert.equal(short.comparisons.tp40.pairs, 0);
});

test('quiet-slot timeout timer fires at 40/80 slots from entry, not next trigger trade', () => {
  const events = tape([0, 1, ...Array.from({ length: 19 }, (_, i) => 6 + i * 5)].map(slot => ({ slot })));
  const short = run(events, { ...cfg, holdSlots: 40 }).records[0];
  const base = run(events).records[0];
  assert.equal(short.intent.slot, 41); assert.equal(base.intent.slot, 81);
  assert.equal(short.exitSlot, 46); assert.equal(base.exitSlot, 86);
  assert.equal(short.exitReason, 'timeout');
});

test('3x guard triggers earlier than 2x with identical entry evidence', () => {
  const events = steady();
  for (let i = 6; i < events.length; i++) {
    events[i].rs_after = 25000000;
    if (i > 6) events[i].rs_before = 25000000;
  }
  const base = run(events), guard = run(events, { ...cfg, liquidityExitMultiple: 3 });
  assert.equal(guard.records[0].exitReason, 'liquidity_risk');
  assert.equal(guard.records[0].exitSlot, 7);
  assert.equal(base.records[0].exitReason, 'timeout');
  assert.equal(compare(base, guard).pairs, 1);
});

test('5% entry quality rejects a signal accepted by 10%', () => {
  // Higher test-only fee creates a round-trip loss between 5% and 10%.
  const base = { ...cfg, swapFeeBps: 350 };
  assert.equal(run(steady(), base).entries, 1);
  const strict = run(steady(), { ...base, maxRoundTripLossBps: 500 });
  assert.equal(strict.entries, 0);
  assert.equal(strict.rejections['signal:entry_round_trip_loss'], 1);
});

test('fill rechecks available budget support without resizing the frozen budget', () => {
  const events = steady();
  // The new 12% budget would be smaller; cancel rather than resize to pass.
  events[1].rs_after = 50000000;
  const result = run(events);
  assert.equal(result.entries, 0);
  assert.equal(result.rejections['fill:budget_no_longer_supported'], 1);
});

test('5% round-trip gate is rechecked at the first fill observation', () => {
  const events = tape([{ slot: 0, reserves: { rs: 10000000 } },
    { slot: 1, reserves: { vs: 600000000, vt: 1000, rt: 800 } }]);
  const result = run(events, { ...cfg, maxRoundTripLossBps: 500 });
  assert.equal(result.acceptedSignals, 1);
  assert.equal(result.entries, 0);
  assert.equal(result.rejections['fill:entry_round_trip_loss'], 1);
});

test('exclusive five-slot entry deadline rejects the first observation at slot+5', () => {
  const result = run(tape([{ slot: 0 }, { slot: 5 }]));
  assert.equal(result.entries, 0);
  assert.equal(result.rejections.entry_observation_missing_or_expired, 1);
});

test('first eligible observation fails slippage rather than selecting a later recovery', () => {
  const result = run(tape([{ slot: 0 }, { slot: 1, reserves: { vs: 1200000000 } },
    { slot: 2, reserves: { vs: 1000000000 } }]));
  assert.equal(result.entries, 0);
  assert.equal(result.rejections['fill:buy_slippage'], 1);
});

test('distinct same-slot agent sells are ambiguous regardless of historical tx order', () => {
  const events = tape([{ slot: 0 }, { slot: 0, event: { agent: true } }, { slot: 1 }]);
  const result = run(events);
  assert.equal(result.entries, 0); assert.equal(result.rejections.ambiguous_slot, 1);
});

test('last qualifying sell per transaction is used, not last arbitrary trade', () => {
  const events = tape([{ slot: 0 }, { slot: 0, idx: 0,
    event: { signature: 'tx0', log_index: 1, agent: true }, reserves: { rs: 80000000 } },
  { slot: 0, idx: 0, event: { signature: 'tx0', log_index: 2, buy: true, agent: false } }, { slot: 1 }]);
  const result = run(events);
  assert.equal(result.candidates, 1);
  assert.equal(result.records[0].budgetLamports, '9600000');
});

test('new signal supersedes prior pending entry conservatively before slot fills', () => {
  const events = tape([{ slot: 0 }, { slot: 1, event: { agent: true } }, { slot: 2 }]);
  const result = run(events);
  assert.equal(result.rejections.superseded_signal, 1);
  assert.equal(result.records[0].signalSlot, 1); assert.equal(result.records[0].entrySlot, 2);
});

test('reserve discontinuity censors a holding and never produces a write-off', () => {
  const events = steady(); events[3].rs_before++;
  const result = run(events);
  assert.equal(result.records[0].censorReason, 'reserve_discontinuity');
  assert.equal(result.writeOffs, 0); assert.equal(result.resolved, 0);
});

test('missing timeout observation and tape exhaustion remain unknown', () => {
  const events = tape([{ slot: 0 }, { slot: 1 }, { slot: 60 }]);
  const result = run(events, { ...cfg, holdSlots: 40 });
  assert.equal(result.records[0].censorReason, 'exit_observation_missing');
  assert.equal(result.records[0].intent.slot, 41);
  assert.equal(result.writeOffs, 0);
  assert.equal(run(tape([{ slot: 0 }, { slot: 1 }])).records[0].censorReason, 'tape_end');
});

test('mandatory partial recovery and zero recovery use production terminal math', () => {
  for (const rs of [1000000, 0]) {
    const result = run(tape([{ slot: 0 }, { slot: 1 }, { slot: 2, reserves: { rs } }, { slot: 3 }]));
    const p = result.records[0];
    assert.equal(p.status, 'resolved');
    assert.equal(p.exitQuote.terminalOutcome, rs ? 'partial_sale' : 'write_off');
    assert.equal(BigInt(p.exitQuote.soldTokens) + BigInt(p.exitQuote.burnedTokens), BigInt(p.tokens_raw));
    assert.equal(p.exitQuote.networkFee, '10000');
    assert.equal(p.quoteProxyLamports, String(BigInt(p.exitQuote.net) - BigInt(p.entry_cost_lamports)));
  }
});

test('timeout overrides risk but preserves an already pending observation target', () => {
  const result = run(tape([{ slot: 0 }, { slot: 1 }, { slot: 2, reserves: { rs: 1000000 } },
    { slot: 3 }]), { ...cfg, holdSlots: 2 });
  assert.equal(result.records[0].exitReason, 'timeout');
  assert.equal(result.records[0].exitSlot, 3);
});

test('risk intent stays latched after liquidity recovery', () => {
  const result = run(tape([{ slot: 0 }, { slot: 1 }, { slot: 2, reserves: { rs: 1000000 } },
    { slot: 3, reserves: { rs: 100000000 } }]));
  assert.equal(result.records[0].exitReason, 'liquidity_risk');
  assert.equal(result.records[0].exitQuote.terminalOutcome, 'full_sale');
});

test('strict no-market-cap adapter matches production exit net and gross', () => {
  const state = { virtualSol: 1000000000n, virtualTokens: 1000000000000n,
    realSol: 100000000n, realTokens: 800000000000n, supply: 1000000000000n, complete: false };
  const position = { tokens_raw: '100000000' };
  const a = strictQuote(state, position, cfg), b = exitQuote(state, position, cfg);
  assert.equal(a.net, b.net); assert.equal(a.gross, b.gross);
});

test('duplicate evidence deduplicates, conflicting or unsafe evidence fails loudly', () => {
  const events = steady();
  assert.equal(prepare([...events, { ...events[0] }]).audit.duplicates, 1);
  assert.throws(() => prepare([...events, { ...events[0], rs_after: 2 }]), /conflicting_duplicate/);
  assert.throws(() => prepare([{ ...events[0], vt_after: Number.MAX_SAFE_INTEGER + 1 }]), /unsafe/);
});

test('unknown Mayhem identity is not assumed and configured caps must cover cohort', () => {
  const events = steady(); events[0].mayhem = null;
  assert.equal(run(events).entries, 0);
  assert.throws(() => run(steady(), { ...cfg, maxExposureLamports: '1' }), /caps_could_bind/);
});

test('supplementary mode tolerates only virtual SOL jumps, retaining strict control', () => {
  const events = steady(); events[3].vs_before++;
  const parsed = prepare(events);
  assert.equal(parsed.audit.virtualSolOnlyDiscontinuities, 1);
  assert.equal(simulate(parsed, cfg).censored, 1);
  assert.equal(simulate(parsed, cfg, 1, 'observed_virtual').resolved, 1);
  events[4].rt_before++;
  assert.equal(simulate(prepare(events), cfg, 1, 'observed_virtual').censored, 1);
});

test('study is deterministic and contains separate delay assumptions and censored records', () => {
  const events = steady();
  const a = study(events, cfg), b = study(events, cfg);
  assert.deepEqual(a, b);
  assert.equal(a.runs.delay1.arms.baseline.records[0].entrySlot, 1);
  assert.equal(a.runs.delay2.arms.baseline.records[0].entrySlot, 2);
  assert.equal(a.runs.delay1.comparisons.hold40.pairs, 1);
});
