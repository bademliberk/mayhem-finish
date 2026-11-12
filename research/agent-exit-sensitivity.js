// Offline observed-state sensitivity only: no RPC, sockets, trial writes or live replay.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { paperConfig } from '../src/paper-store.js';
import { liquidityBudget, buyBudget, entryQuality, liquidityRisk, stopLoss, sell, profitable,
  terminalExitQuote } from '../src/paper-math.js';

const FIELDS = ['vs', 'vt', 'rs', 'rt'];
const add = (counts, reason) => { counts[reason] = (counts[reason] ?? 0) + 1; };
const amount = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('unsafe_or_invalid_integer');
  return BigInt(value);
};
const stateOf = e => ({ virtualSol: amount(e.vs_after), virtualTokens: amount(e.vt_after),
  realSol: amount(e.rs_after), realTokens: amount(e.rt_after), complete: false });
export function strictQuote(state, position, cfg) {
  const q = sell(state, BigInt(position.tokens_raw), cfg.swapFeeBps);
  const net = q.net - BigInt(cfg.networkFeeLamports);
  if (net <= 0n) throw new Error('fees_exceed_output');
  return { tokens: position.tokens_raw, gross: String(q.gross), net: String(net) };
}
// Exact reduced rational factors; no floating-point multiplier updates.
export const MULTIPLIER_FACTORS = Object.freeze(Object.fromEntries([
  ['1.2', '6', '5'], ['1.4', '7', '5'], ['1.5', '3', '2'], ['1.6', '8', '5'], ['1.8', '9', '5'],
  ['2', '2', '1'], ['2.3', '23', '10'], ['2.5', '5', '2'], ['3', '3', '1'], ['3.5', '7', '2']
].map(([label, numerator, denominator]) => [`factor${label.replace('.', '_')}`, Object.freeze({ numerator, denominator })])));
const DEFAULT_FACTOR = MULTIPLIER_FACTORS.factor1_5;
function validateFactor(factor) {
  const numerator = BigInt(factor.numerator), denominator = BigInt(factor.denominator);
  if (denominator < 1n || numerator <= denominator) throw new Error('invalid_multiplier_factor');
  return { numerator, denominator };
}
export function variants(cfg, suite = 'exits') {
  if (suite === 'take-profit' || suite === 'lower-tp') {
    if (cfg.profitBps !== 3000) throw new Error('take_profit_control_must_be_30_percent');
    const targets = suite === 'lower-tp' ? [1500, 2000, 2500] : [4000, 5000, 6000];
    return { baseline: { ...cfg }, ...Object.fromEntries(targets.map(profitBps =>
      [`tp${profitBps / 100}`, { ...cfg, profitBps }])) };
  }
  if (suite === 'stop-loss') {
    // Each arm changes one thing from the live config: TP 60%, SL 60%, then both together.
    return { baseline: { ...cfg }, tp60: { ...cfg, profitBps: 6000 }, sl60: { ...cfg, stopLossBps: 6000 },
      tp60sl60: { ...cfg, profitBps: 6000, stopLossBps: 6000 } };
  }
  if (suite === 'loss-multiplier') return { baseline: { ...cfg }, lossMultiplier: { ...cfg } };
  if (suite === 'gradual-multiplier') return { baseline: { ...cfg }, lossMultiplier: { ...cfg }, gradualMultiplier: { ...cfg } };
  if (suite === 'multiplier-factors') return { baseline: { ...cfg },
    ...Object.fromEntries(Object.keys(MULTIPLIER_FACTORS).map(name => [name, { ...cfg }])) };
  if (suite !== 'exits') throw new Error('unknown_study_suite');
  return { baseline: { ...cfg }, hold40: { ...cfg, holdSlots: 40 },
    guard3: { ...cfg, liquidityExitMultiple: 3 }, entry5: { ...cfg, maxRoundTripLossBps: 500 } };
}

export function prepare(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('empty_or_invalid_tape');
  const audit = { rawEvents: raw.length, duplicates: 0, discontinuities: 0,
    unknownEligibility: 0, invalidReserves: 0, completionEvidence: 0 };
  const seen = new Map(), events = [];
  for (const source of raw) {
    for (const key of ['slot', 'idx', 'log_index', 'bt']) amount(source[key]);
    for (const prefix of FIELDS) for (const suffix of ['before', 'after']) amount(source[`${prefix}_${suffix}`]);
    if (typeof source.signature !== 'string' || typeof source.mint !== 'string' ||
        typeof source.buy !== 'boolean' || typeof source.agent !== 'boolean') throw new Error('invalid_event');
    const key = `${source.signature}:${source.log_index}`;
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))));
    if (seen.has(key)) {
      if (seen.get(key) !== canonical) throw new Error('conflicting_duplicate');
      audit.duplicates++; continue;
    }
    seen.set(key, canonical); events.push({ ...source });
  }
  events.sort((a, b) => a.slot - b.slot || a.idx - b.idx || a.log_index - b.log_index);
  const last = new Map(), transactions = new Map();
  for (const e of events) {
    const previous = last.get(e.mint);
    e.discontinuityFields = previous ? FIELDS.filter(k => previous[`${k}_after`] !== e[`${k}_before`]) : [];
    e.discontinuity = e.discontinuityFields.length > 0;
    e.hardDiscontinuity = e.discontinuityFields.some(k => k !== 'vs');
    if (e.discontinuity) {
      audit.discontinuities++;
      add(audit, e.hardDiscontinuity ? 'nonVirtualSolDiscontinuities' : 'virtualSolOnlyDiscontinuities');
    }
    if (e.mayhem !== true) audit.unknownEligibility++;
    if (!e.vs_after || !e.vt_after) audit.invalidReserves++;
    if (!e.rt_after) audit.completionEvidence++;
    last.set(e.mint, e);
    const key = `${e.signature}:${e.mint}`;
    const tx = transactions.get(key) ?? { slot: e.slot, idx: e.idx, mint: e.mint,
      signature: e.signature, discontinuity: false, signal: null };
    if (tx.slot !== e.slot || tx.idx !== e.idx) throw new Error('inconsistent_transaction_order');
    tx.discontinuity ||= e.discontinuity;
    tx.hardDiscontinuity ||= e.hardDiscontinuity;
    tx.observation = e;
    if (e.agent && !e.buy) tx.signal = e;
    transactions.set(key, tx);
  }
  const slots = new Map();
  for (const tx of transactions.values()) {
    if (!slots.has(tx.slot)) slots.set(tx.slot, []);
    slots.get(tx.slot).push(tx);
  }
  for (const txs of slots.values()) txs.sort((a, b) => a.idx - b.idx || a.mint.localeCompare(b.mint));
  return { slots, audit: { ...audit, events: events.length, mints: last.size,
    agentSells: events.filter(e => e.agent && !e.buy).length },
    firstSlot: events[0].slot, lastSlot: events.at(-1).slot };
}

export function advanceMultiplier(multiplier, net, winPolicy = 'reset', factor = DEFAULT_FACTOR) {
  if (!['reset', 'divide'].includes(winPolicy)) throw new Error('invalid_win_policy');
  const step = validateFactor(factor);
  if (net === null || net === undefined) return { ...multiplier };
  const value = BigInt(net);
  if (value > 0n) {
    if (winPolicy === 'reset') return { numerator: '1', denominator: '1' };
    const numerator = BigInt(multiplier.numerator) * step.denominator,
      denominator = BigInt(multiplier.denominator) * step.numerator;
    if (numerator <= denominator) return { numerator: '1', denominator: '1' };
    let a = numerator, b = denominator;
    while (b) [a, b] = [b, a % b];
    return { numerator: String(numerator / a), denominator: String(denominator / a) };
  }
  if (value < 0n) return { numerator: String(BigInt(multiplier.numerator) * step.numerator),
    denominator: String(BigInt(multiplier.denominator) * step.denominator) };
  return { ...multiplier };
}
export function scaledBudget(realSol, cfg, multiplier = { numerator: '1', denominator: '1' }, minimumBudget = 0n) {
  const numerator = BigInt(multiplier.numerator), denominator = BigInt(multiplier.denominator);
  if (numerator < 1n || denominator < 1n) throw new Error('invalid_multiplier');
  const requested = realSol * BigInt(cfg.fractionBps) * numerator / (10000n * denominator);
  const maximum = BigInt(cfg.maxSwapBudgetLamports), minimum = BigInt(minimumBudget);
  if (minimum < 0n || minimum > maximum) throw new Error('invalid_minimum_budget');
  const budget = requested > maximum ? maximum : requested < minimum ? minimum : requested;
  const unscaled = liquidityBudget(realSol, cfg);
  return { budget, evidence: { ...multiplier, unscaledBudgetLamports: String(unscaled < minimum ? minimum : unscaled),
    requestedBudgetLamports: String(requested), budgetLamports: String(budget),
    ...(minimum > 0n ? { minimumBudgetLamports: String(minimum), floorBinding: requested < minimum } : {}),
    capBinding: requested > maximum, multiplierClipped: numerator > denominator && requested > maximum } };
}
export function outcomeMetrics(records) {
  let net = 0n, peak = 0n, drawdown = 0n, grossWins = 0n, grossLosses = 0n;
  let wins = 0, losses = 0, breakeven = 0, run = 0, maxLossStreak = 0;
  for (const p of records) {
    if (p.status !== 'resolved') { run = 0; continue; }
    const value = BigInt(p.quoteProxyLamports);
    net += value;
    if (net > peak) peak = net;
    if (peak - net > drawdown) drawdown = peak - net;
    if (value > 0n) { wins++; grossWins += value; run = 0; }
    else if (value < 0n) { losses++; grossLosses -= value; maxLossStreak = Math.max(maxLossStreak, ++run); }
    else { breakeven++; run = 0; }
  }
  return { wins, losses, breakeven, winRate: wins + losses + breakeven ? wins / (wins + losses + breakeven) : null,
    netQuoteProxyLamports: String(net), realizedMaxDrawdownLamports: String(drawdown),
    profitFactor: grossLosses ? Number(grossWins) / Number(grossLosses) : null,
    maxLossStreak, unresolvedCostLamports: String(records.filter(p => p.status !== 'resolved')
      .reduce((n, p) => n + BigInt(p.entry_cost_lamports), 0n)) };
}

export function simulate(tape, cfg, delaySlots = 1, continuity = 'strict', options = {}) {
  if (![1, 2, 3, 4].includes(delaySlots)) throw new Error('unsupported_delay');
  if (!['strict', 'observed_virtual'].includes(continuity)) throw new Error('unsupported_continuity');
  const sizingPolicy = options.sizingPolicy ?? 'fixed';
  if (!['fixed', 'loss_multiplier', 'gradual_multiplier'].includes(sizingPolicy)) throw new Error('unsupported_sizing_policy');
  const multiplierFactor = { ...(options.multiplierFactor ?? DEFAULT_FACTOR) };
  validateFactor(multiplierFactor);
  const minimumBudget = BigInt(options.minimumBudgetLamports ?? '0');
  if (minimumBudget < 0n || minimumBudget > BigInt(cfg.maxSwapBudgetLamports)) throw new Error('invalid_minimum_budget');
  const endSlot = options.endSlot ?? tape.lastSlot;
  if (!Number.isSafeInteger(endSlot) || endSlot < tape.firstSlot || endSlot > tape.lastSlot) throw new Error('invalid_end_slot');
  let multiplier = { numerator: '1', denominator: '1' }, maximumMultiplier = { ...multiplier };
  const multiplierTrajectory = [];
  let cappedSignals = 0, multiplierClippedSignals = 0;
  // This small study does not approximate an admission scheduler. Fail if caps could bind.
  if (cfg.maxWatches < tape.audit.mints || cfg.maxTrades < tape.audit.mints ||
      BigInt(cfg.maxExposureLamports) < BigInt(tape.audit.mints) *
        (BigInt(cfg.maxSwapBudgetLamports) + BigInt(cfg.networkFeeLamports))) throw new Error('cohort_caps_could_bind');
  const rejections = {}, exitReasons = {}, records = [], pending = new Map(), holdings = new Map();
  const used = new Set(), lastObservation = new Map();
  let candidates = 0, acceptedSignals = 0, peakExposure = 0n;
  const exitWindowSlots = 4;
  let censoredCost = 0n;
  const exposure = () => {
    const total = [...holdings.values()].reduce((n, p) => n + BigInt(p.entry_cost_lamports), 0n) + censoredCost +
      [...pending.values()].reduce((n, p) => n + p.budget + BigInt(cfg.networkFeeLamports), 0n);
    if (total > peakExposure) peakExposure = total;
  };
  const censor = (p, reason, slot) => {
    p.status = 'censored'; p.censorReason = reason; p.censorSlot = slot; censoredCost += BigInt(p.entry_cost_lamports);
    holdings.delete(p.mint); records.push(p);
  };
  const request = (p, reason, slot, observation, quote = null) => {
    p.intent = { reason, slot, target: slot + delaySlots,
      expires: slot + delaySlots + exitWindowSlots, observation, quote };
  };
  const quality = (e, budget, frozenMultiplier = { numerator: '1', denominator: '1' }) => {
    if (e.mayhem !== true) throw new Error('unknown_eligibility');
    if (e.rt_after === 0) throw new Error('completion_evidence');
    const state = stateOf(e);
    if (state.realSol < BigInt(cfg.minRealSolLamports)) throw new Error('min_real_sol');
    if (budget > scaledBudget(state.realSol, cfg, frozenMultiplier, minimumBudget).budget) throw new Error('budget_no_longer_supported');
    const q = entryQuality(state, cfg, budget);
    if (q.rejection) throw new Error(q.rejection);
    return { state, quality: q, buy: buyBudget(state, budget, cfg.swapFeeBps) };
  };
  const finish = (p, q, e) => {
    p.status = 'resolved'; p.exitSlot = e.slot; p.exitSignature = e.signature;
    p.exitReason = p.intent.reason; p.exitQuote = q;
    p.quoteProxyLamports = String(BigInt(q.net) - BigInt(p.entry_cost_lamports));
    add(exitReasons, p.exitReason); records.push(p); holdings.delete(p.mint);
    if (sizingPolicy !== 'fixed') {
      const before = { ...multiplier };
      multiplier = advanceMultiplier(multiplier, p.quoteProxyLamports,
        sizingPolicy === 'gradual_multiplier' ? 'divide' : 'reset', multiplierFactor);
      if (BigInt(multiplier.numerator) * BigInt(maximumMultiplier.denominator) >
          BigInt(maximumMultiplier.numerator) * BigInt(multiplier.denominator)) maximumMultiplier = { ...multiplier };
      multiplierTrajectory.push({ mint: p.mint, slot: e.slot, signature: e.signature,
        netLamports: p.quoteProxyLamports, before, after: { ...multiplier } });
    }
  };
  // Clock ticks are independent of trades. No observation is synthesized on empty slots.
  for (let slot = tape.firstSlot; slot <= endSlot; slot++) {
    for (const [mint, order] of pending) if (slot >= order.signal.slot + cfg.signalValiditySlots) {
      add(rejections, 'entry_observation_missing_or_expired'); pending.delete(mint);
    }
    for (const p of holdings.values()) {
      if (slot >= p.deadline && p.intent?.reason !== 'timeout') {
        if (p.intent) p.intent.reason = 'timeout';
        else request(p, 'timeout', p.deadline, lastObservation.get(p.mint));
      }
      if (p.intent && slot > p.intent.expires) {
        // quietExit mirrors the live v3 engine: a covered curve with no trades has unchanged reserves, so the exit
        // fills at the last observed state. Off by default; the strict study keeps these outcomes unknown.
        const last = options.quietExit ? lastObservation.get(p.mint) : null;
        // Beyond a mint's recorded horizon, missing trades mean the tape ended, not a quiet curve (~0.4 s per slot).
        const horizon = options.horizonBt?.[p.mint];
        const withinTape = last && (horizon == null || last.bt + Math.ceil((slot - last.slot) * 0.4) <= horizon);
        let filled = false;
        if (withinTape && last.vs_after && last.vt_after && last.rt_after && last.mayhem === true) {
          try {
            const state = stateOf(last);
            if (p.intent.reason !== 'profit') { finish(p, terminalExitQuote(state, p, cfg), last); filled = true; }
            else {
              const q = strictQuote(state, p, cfg);
              if (profitable(q, p, cfg)) { finish(p, q, last); filled = true; }
              else { p.intent = null; filled = true; }
            }
          } catch { /* fall through to censoring */ }
        }
        if (!filled) censor(p, 'exit_observation_missing', slot);
        else if (p.status === 'resolved') { p.quietExit = true; continue; }
      }
    }
    const txs = tape.slots.get(slot) ?? [];
    const signals = new Map();
    for (const tx of txs) if (tx.signal) {
      if (!signals.has(tx.mint)) signals.set(tx.mint, []);
      signals.get(tx.mint).push(tx.signal);
    }
    // Conservative slot batching: a new/ambiguous signal cancels an older entry before
    // any observation in this slot. Historical transaction indices never resolve ambiguity.
    for (const [mint, sells] of signals) {
      candidates += sells.length;
      if (pending.delete(mint)) add(rejections, 'superseded_signal');
      if (used.has(mint)) { add(rejections, 'already_entered'); continue; }
      if (sells.length !== 1) { add(rejections, 'ambiguous_slot'); continue; }
      const signal = sells[0];
      try {
        if (!cfg.entriesEnabled) throw new Error('entries_disabled');
        const frozenMultiplier = { ...multiplier };
        const { budget, evidence } = scaledBudget(amount(signal.rs_after), cfg, frozenMultiplier, minimumBudget);
        if (evidence.capBinding) cappedSignals++;
        if (evidence.multiplierClipped) multiplierClippedSignals++;
        // Optional entry band on market cap in SOL (supply 1e15 raw units, as live Mayhem mints report).
        // Mirrors the live engine: skip a signal whose 12% budget would reach the swap cap.
        if (cfg.skipCappedEntries && amount(signal.rs_after) * BigInt(cfg.fractionBps) / 10000n >= BigInt(cfg.maxSwapBudgetLamports)) {
          throw new Error('capped_budget_skipped');
        }
        if (cfg.entryMcPredicate) {
          const mc = Number(BigInt(signal.vs_after) * 1000000000000000n / BigInt(signal.vt_after)) / 1e9;
          if (!cfg.entryMcPredicate(mc)) throw new Error('mcap_outside_bands');
        }
        if (cfg.minEntryMcSol != null || cfg.maxEntryMcSol != null) {
          const mc = Number(BigInt(signal.vs_after) * 1000000000000000n / BigInt(signal.vt_after)) / 1e9;
          if (cfg.minEntryMcSol != null && mc < cfg.minEntryMcSol) throw new Error('mcap_below_band');
          if (cfg.maxEntryMcSol != null && mc >= cfg.maxEntryMcSol) throw new Error('mcap_above_band');
        }
        const q = quality(signal, budget, frozenMultiplier);
        pending.set(mint, { signal, budget, tokens: q.buy.tokens, frozenMultiplier, sizingEvidence: evidence,
          signalLossBps: q.quality.roundTripLossBps, target: slot + delaySlots });
        acceptedSignals++;
      } catch (error) { add(rejections, `signal:${error.message}`); }
    }
    exposure();
    for (const tx of txs) {
      const e = tx.observation, mint = tx.mint;
      let p = holdings.get(mint), order = pending.get(mint);
      if (continuity === 'strict' ? tx.discontinuity : tx.hardDiscontinuity) {
        if (p) censor(p, 'reserve_discontinuity', slot);
        if (order && order.signal.slot < slot) {
          pending.delete(mint); add(rejections, 'entry_reserve_discontinuity');
        }
        p = null; order = pending.get(mint);
      }
      if (!e.vs_after || !e.vt_after || !e.rt_after || e.mayhem !== true) {
        if (p) censor(p, e.rt_after === 0 ? 'completion_without_account_evidence' : 'invalid_or_unknown_state', slot);
        if (order) { pending.delete(mint); add(rejections, 'entry_invalid_or_unknown_state'); }
        lastObservation.set(mint, e); continue;
      }
      if (order && slot >= order.target) {
        try {
          if ((e.bt - order.signal.bt) * 1000 > cfg.maxStateAgeMs || e.bt < order.signal.bt) {
            throw new Error('entry_observation_time_gap');
          }
          const q = quality(e, order.budget, order.frozenMultiplier);
          if (q.buy.tokens * 10000n < order.tokens * BigInt(10000 - cfg.buySlippageBps)) throw new Error('buy_slippage');
          p = { mint, entrySignature: e.signature, signalSignature: order.signal.signature,
            entrySlot: slot, signalSlot: order.signal.slot, budgetLamports: String(order.budget),
            tokens_raw: String(q.buy.tokens), entry_cost_lamports: String(q.buy.cost + BigInt(cfg.networkFeeLamports)),
            signalLossBps: order.signalLossBps, fillLossBps: q.quality.roundTripLossBps,
            deadline: slot + cfg.holdSlots, entry_order_id: `${mint}:${slot}` };
          if (sizingPolicy !== 'fixed' || minimumBudget > 0n) p.sizingEvidence = order.sizingEvidence;
          holdings.set(mint, p); used.add(mint);
        } catch (error) { add(rejections, `fill:${error.message}`); }
        pending.delete(mint);
      }
      if (p) {
        const state = stateOf(e);
        // A newly observed mandatory condition outranks a discretionary pending sale (and a stop yields to liquidity risk).
        if (['profit', 'stop_loss'].includes(p.intent?.reason) && liquidityRisk(state, p, cfg)) {
          request(p, 'liquidity_risk', slot, e);
        } else if (p.intent?.reason === 'profit' && stopLoss(state, p, cfg)) {
          request(p, 'stop_loss', slot, e);
        }
        if (p.intent && slot >= p.intent.target) {
          const anchor = p.intent.observation;
          if (!anchor || e.bt < anchor.bt || (e.bt - anchor.bt) * 1000 > cfg.maxStateAgeMs) {
            censor(p, 'exit_observation_time_gap', slot); p = null;
          } else {
            try {
              if (p.intent.reason !== 'profit') { finish(p, terminalExitQuote(state, p, cfg), e); p = null; }
              else {
                const q = strictQuote(state, p, cfg);
                if (profitable(q, p, cfg) && BigInt(q.net) * 10000n >=
                    BigInt(p.intent.quote.net) * BigInt(10000 - cfg.sellSlippageBps)) {
                  finish(p, q, e); p = null;
                } else p.intent = null;
              }
            } catch { if (p?.intent?.reason === 'profit') p.intent = null;
              else { censor(p, 'unsupported_terminal_quote', slot); p = null; } }
          }
        }
        if (p) {
          if (slot >= p.deadline) {
            if (!p.intent) request(p, 'timeout', p.deadline, e);
            else p.intent.reason = 'timeout';
          } else if (liquidityRisk(state, p, cfg)) {
            if (!p.intent || ['profit', 'stop_loss'].includes(p.intent.reason)) request(p, 'liquidity_risk', slot, e);
          } else if (stopLoss(state, p, cfg)) {
            if (!p.intent || p.intent.reason === 'profit') request(p, 'stop_loss', slot, e);
          } else if (!p.intent) {
            try { const q = strictQuote(state, p, cfg);
              if (profitable(q, p, cfg)) request(p, 'profit', slot, e, q);
            } catch { /* No supported discretionary sale; keep observing. */ }
          }
        }
      }
      lastObservation.set(mint, e); exposure();
    }
  }
  const pendingAtEnd = [...pending.values()].map(order => ({ mint: order.signal.mint,
    signalSlot: order.signal.slot, budgetLamports: String(order.budget), multiplier: order.frozenMultiplier }));
  for (const p of [...holdings.values()]) censor(p, endSlot < tape.lastSlot ? 'study_cutoff' : 'tape_end', endSlot);
  for (const _ of pending.values()) add(rejections, endSlot < tape.lastSlot ? 'entry_study_cutoff' : 'entry_tape_end');
  const resolved = records.filter(p => p.status === 'resolved');
  return { cfg, delaySlots, continuity, exitWindowSlots, candidates, acceptedSignals, entries: records.length,
    sizingPolicy, multiplierFactor, minimumBudgetLamports: String(minimumBudget), endSlot, multiplier, maximumMultiplier, multiplierTrajectory,
    floorBoundEntries: records.filter(p => p.sizingEvidence?.floorBinding).length,
    cappedSignals, multiplierClippedSignals, pendingAtEnd, metrics: outcomeMetrics(records),
    boostedEntries: records.filter(p => p.sizingEvidence &&
      BigInt(p.sizingEvidence.budgetLamports) > BigInt(p.sizingEvidence.unscaledBudgetLamports)).length,
    cappedEntries: records.filter(p => p.sizingEvidence?.capBinding).length,
    resolved: resolved.length, censored: records.length - resolved.length,
    rejections, exitReasons, peakExposureLamports: String(peakExposure),
    entryCostLamports: String(records.reduce((sum, p) => sum + BigInt(p.entry_cost_lamports), 0n)),
    resolvedQuoteProxyLamports: String(resolved.reduce((sum, p) => sum + BigInt(p.quoteProxyLamports), 0n)),
    partialSales: resolved.filter(p => p.exitQuote.terminalOutcome === 'partial_sale').length,
    writeOffs: resolved.filter(p => p.exitQuote.terminalOutcome === 'write_off').length,
    records };
}

export function compare(base, arm) {
  const b = new Map(base.records.map(p => [p.mint, p]));
  const baselineProfitTransitions = {};
  for (const p of arm.records) {
    const q = b.get(p.mint);
    if (q?.exitReason === 'profit' && q.entrySignature === p.entrySignature &&
        q.tokens_raw === p.tokens_raw && q.entry_cost_lamports === p.entry_cost_lamports) {
      add(baselineProfitTransitions, p.status === 'resolved' ? p.exitReason : 'censored');
    }
  }
  const pairs = arm.records.flatMap(p => {
    const q = b.get(p.mint);
    if (!q || q.entrySignature !== p.entrySignature || q.tokens_raw !== p.tokens_raw ||
        q.entry_cost_lamports !== p.entry_cost_lamports || p.status !== 'resolved' || q.status !== 'resolved') return [];
    return [{ mint: p.mint, deltaLamports: String(BigInt(p.quoteProxyLamports) - BigInt(q.quoteProxyLamports)),
      exitSlotDelta: p.exitSlot - q.exitSlot }];
  });
  return { pairs: pairs.length, deltaLamports: String(pairs.reduce((n, p) => n + BigInt(p.deltaLamports), 0n)),
    better: pairs.filter(p => BigInt(p.deltaLamports) > 0n).length,
    worse: pairs.filter(p => BigInt(p.deltaLamports) < 0n).length,
    unchanged: pairs.filter(p => p.deltaLamports === '0').length, baselineProfitTransitions, details: pairs };
}

export function compareSizing(base, arm) {
  const baseline = new Map(base.records.map(p => [p.mint, p]));
  let sameEntrySignals = 0, changedEntrySignals = 0;
  const pairs = [];
  for (const p of arm.records) {
    const q = baseline.get(p.mint);
    if (!q || q.signalSignature !== p.signalSignature || q.entrySignature !== p.entrySignature) {
      changedEntrySignals++; continue;
    }
    sameEntrySignals++;
    if (q.status === 'resolved' && p.status === 'resolved') pairs.push({ mint: p.mint,
      baselineEntryCost: q.entry_cost_lamports, candidateEntryCost: p.entry_cost_lamports,
      deltaLamports: String(BigInt(p.quoteProxyLamports) - BigInt(q.quoteProxyLamports)) });
  }
  return { sameEntrySignals, changedEntrySignals, baselineOnlyMints: base.records.filter(p =>
    !arm.records.some(q => q.mint === p.mint)).length, pairs: pairs.length,
    deltaLamports: String(pairs.reduce((n, p) => n + BigInt(p.deltaLamports), 0n)), details: pairs };
}

export function study(raw, cfg, suite = 'exits') {
  const configs = variants(cfg, suite);
  const sizingSuite = ['loss-multiplier', 'gradual-multiplier', 'multiplier-factors'].includes(suite);
  const minimumBudgetLamports = ['gradual-multiplier', 'multiplier-factors'].includes(suite)
    ? String(BigInt(cfg.maxSwapBudgetLamports) / 10n) : '0';
  const tape = prepare(raw), runs = {};
  for (const continuity of ['strict', 'observed_virtual']) for (const delay of [1, 2]) {
    const arms = {};
    const optionsFor = name => ({ minimumBudgetLamports,
      multiplierFactor: MULTIPLIER_FACTORS[name] ?? DEFAULT_FACTOR,
      sizingPolicy: name === 'gradualMultiplier' || Object.hasOwn(MULTIPLIER_FACTORS, name)
        ? 'gradual_multiplier' : name === 'lossMultiplier' ? 'loss_multiplier' : 'fixed' });
    for (const [name, config] of Object.entries(configs)) arms[name] = simulate(tape, config, delay, continuity, optionsFor(name));
    const key = continuity === 'strict' ? `delay${delay}` : `observedVirtualDelay${delay}`;
    const comparison = sizingSuite ? compareSizing : compare;
    runs[key] = { arms, comparisons: Object.fromEntries(Object.entries(arms)
      .filter(([name]) => name !== 'baseline').map(([name, arm]) => [name, comparison(arms.baseline, arm)])) };
    if (sizingSuite) {
      const censored = Object.entries(arms).flatMap(([name, arm]) => arm.records
        .filter(p => p.status === 'censored' && p.censorReason !== 'tape_end')
        .map(p => ({ arm: name, slot: p.censorSlot, reason: p.censorReason, mint: p.mint })))
        .sort((a, b) => a.slot - b.slot);
      const firstUnknown = censored[0] ?? null;
      const endSlot = firstUnknown ? firstUnknown.slot - 1 : tape.lastSlot;
      const primaryArms = Object.fromEntries(Object.entries(configs).map(([name, config]) =>
        [name, simulate(tape, config, delay, continuity, { ...optionsFor(name), endSlot })]));
      runs[key].primary = { endSlot, firstUnknown, arms: primaryArms,
        ...(primaryArms.lossMultiplier ? { comparison: compareSizing(primaryArms.baseline, primaryArms.lossMultiplier) } : {}),
        comparisons: Object.fromEntries(Object.entries(primaryArms).filter(([name]) => name !== 'baseline')
          .map(([name, arm]) => [name, compareSizing(primaryArms.baseline, arm)])) };
      runs[key].continuationAssumption = 'Full-period results leave the multiplier unchanged on censored outcomes; conditional sensitivity, not an exact path.';
    }
  }
  return { studyVersion: 5, suite, minimumBudgetLamports, audit: tape.audit, firstSlot: tape.firstSlot, lastSlot: tape.lastSlot,
    assumptions: [
      'Selected wallet cohort; previously studied, not an unbiased or out-of-sample test.',
      'Unimpacted transaction-end reserve observations; not live-engine replay or reconstructed strategy P&L.',
      'One-slot and two-slot minimum execution delays; first subsequent observation, never best price.',
      'Conservative whole-slot signal supersession and ambiguity rejection before any entry fill.',
      'Exit observation window is four slots after target; clock advances without trades.',
      'Block-time freshness proxy uses whole seconds and a five-second configured limit; no account delivery timestamps.',
      'Strict runs censor all reserve discontinuities. Supplementary observed_virtual runs allow only virtual-SOL jumps and use each new reported post-state without interpolation; changes between observations remain unknown.',
      'Missing/other-discontinuous/complete-unknown state is censored, never turned into a live stale-state loss.',
      'Historical path does not include hypothetical own-trade impact; immediate entry quality does.',
      'No wallet/account validation, actual signature confirmation, provider latency or admission scalability reconstruction.',
      sizingSuite
        ? 'Sizing comparisons require matching signal/entry signatures and resolved exits, but permit different quantities/costs. Portfolio net is a partial observed-state proxy, not full P&L.'
        : 'Matched comparisons require identical entry signature, tokens and cost and both exits resolved.',
      ...(sizingSuite ? [
        'Multiplier starts at 1; resolved net loss multiplies by the arm-specific rational factor (default 3/2). lossMultiplier resets to 1 on a win; gradualMultiplier and factor arms divide by their factor with a minimum of 1. Zero/unknown leaves it unchanged. BigInt sizing with the configured hard swap cap.',
        `All arms use a minimum swap budget of ${minimumBudgetLamports} lamports, applied after multiplying the raw liquidity-fraction budget and before the maximum cap. This is a budget floor, not a multiplier floor adjustment or a guarantee of entry. Liquidity and round-trip-quality gates still apply at signal and fill.`,
        'Signal multiplier is frozen with its budget and reused for fill checks. Signals precede outcome processing within each slot.',
        'Primary comparisons stop all arms before the earliest unknown outcome in any arm. Full-period continuation is conditional on ignoring unknown outcomes.',
        'Drawdown uses cumulative resolved outcomes only, not marked-to-market equity. Outstanding costs are reported separately.'
      ] : [])
    ], runs };
}
const sol = value => (Number(value) / 1e9).toFixed(9);
function sizingMarkdown(result) {
  const lines = ['# Loss Multiplier Study', '',
    '**Observed-state sizing sensitivity, not live results or complete strategy P&L.**', '',
    'Baseline keeps 1×. Multiplier arms start at 1× and multiply by their factor after a resolved net loss. On a net win, lossMultiplier resets to 1×; gradualMultiplier and factor arms divide by their factor, floored at 1×.', '',
    `Minimum buy budget: ${sol(result.minimumBudgetLamports)} SOL; maximum: ${sol(result.runs.delay1.arms.baseline.cfg.maxSwapBudgetLamports)} SOL, identical across arms. Clamp is applied after multiplying the raw liquidity-fraction budget. Entry-quality checks remain mandatory.`, '',
    `Source SHA-256: ${result.sourceSha256 ?? 'fixture'}`, '',
    `${result.audit.events} events across ${result.audit.mints} selected mints.`, ''];
  for (const run of Object.values(result.runs)) {
    lines.push(`## ${run.arms.baseline.continuity} — ${run.arms.baseline.delaySlots}-slot delay`, '',
      `Primary cutoff: slot ${run.primary.endSlot}. First unknown: ${JSON.stringify(run.primary.firstUnknown)}.`, '');
    for (const [label, arms] of [['Primary common prefix', run.primary.arms],
      ['Conditional full-period continuation (unknown outcomes do not change multiplier)', run.arms]]) {
      lines.push(`### ${label}`, '',
        '| Arm | Entries / resolved / unknown | Wins / losses | Net quote proxy SOL | Realized drawdown SOL | Deployed SOL | Peak exposure SOL | Unresolved cost SOL |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
      for (const [name, a] of Object.entries(arms)) {
        const m = a.metrics;
        lines.push(`| ${name} | ${a.entries} / ${a.resolved} / ${a.censored} | ${m.wins} / ${m.losses} | ${sol(m.netQuoteProxyLamports)} | ${sol(m.realizedMaxDrawdownLamports)} | ${sol(a.entryCostLamports)} | ${sol(a.peakExposureLamports)} | ${sol(m.unresolvedCostLamports)} |`);
      }
      lines.push('');
      for (const [name, a] of Object.entries(arms)) {
        lines.push(`- **${name}:** sizing policy ${a.sizingPolicy}, factor ${a.multiplierFactor.numerator}/${a.multiplierFactor.denominator}; win rate ${a.metrics.winRate === null ? 'N/A' : (a.metrics.winRate * 100).toFixed(1) + '%'}; profit factor ${a.metrics.profitFactor === null ? 'N/A' : a.metrics.profitFactor.toFixed(3)}; max observed losing streak ${a.metrics.maxLossStreak}.`,
          `  Maximum multiplier reached: ${a.maximumMultiplier.numerator}/${a.maximumMultiplier.denominator}; boosted filled entries: ${a.boostedEntries}; floor-bound filled entries: ${a.floorBoundEntries}; cap-bound sizing evaluations: ${a.cappedSignals}; multiplier-clipped evaluations: ${a.multiplierClippedSignals}.`,
          `  Rejections: ${JSON.stringify(a.rejections)}; pending orders at cutoff: ${a.pendingAtEnd.length}.`);
      }
      lines.push('');
    }
    lines.push(`Primary matched-signal comparisons: ${JSON.stringify(run.primary.comparisons)}`, '');
  }
  lines.push('## Limits', '', ...result.assumptions.map(s => `- ${s}`), '',
    'The older wallet round-trip sample lacks intermediate reserves for a defensible resized-strategy replay. Historical wallet P&L was not multiplied to manufacture these results.', '');
  return lines.join('\n');
}
export function markdown(result) {
  if (['loss-multiplier', 'gradual-multiplier', 'multiplier-factors'].includes(result.suite)) return sizingMarkdown(result);
  const lines = [result.suite === 'stop-loss' ? '# Stop-Loss and Take-Profit Sensitivity' : result.suite === 'lower-tp' ? '# Lower Take Profit Sensitivity' : result.suite === 'take-profit' ? '# Take Profit Sensitivity' : '# Earlier Exit Sensitivity', '', '**Exploratory observed-state quotes, not strategy P&L or a deployment recommendation.**', '',
    `Source SHA-256: ${result.sourceSha256 ?? 'fixture'}`, '',
    `${result.audit.events} events; ${result.audit.mints} mints; ${result.audit.agentSells} agent sells; ${result.audit.discontinuities} reserve discontinuities.`, '',
    `${result.audit.virtualSolOnlyDiscontinuities ?? 0} discontinuities affect virtual SOL only; ${result.audit.nonVirtualSolDiscontinuities ?? 0} affect other reserve fields. Before-reserves are reconstructed from trade amounts, so discontinuities do not by themselves prove missing transactions.`, ''];
  for (const [delay, run] of Object.entries(result.runs)) {
    lines.push(`## ${run.arms.baseline.continuity === 'strict' ? 'Strict continuity' : 'Supplementary observed virtual reserves'} — ${run.arms.baseline.delaySlots}-slot delay`, '',
      '| Arm | Entries | Resolved | Censored | Partial / write-off | Matched exits vs baseline | Matched recovery delta (SOL) |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const [name, arm] of Object.entries(run.arms)) {
      const pair = run.comparisons[name];
      lines.push(`| ${name} | ${arm.entries} | ${arm.resolved} | ${arm.censored} | ${arm.partialSales} / ${arm.writeOffs} | ${pair?.pairs ?? '—'} | ${pair?.pairs ? sol(pair.deltaLamports) : 'N/A'} |`);
    }
    lines.push('', 'Resolved-only totals are deliberately not used to rank arms with unequal entry/coverage subsets.', '');
    for (const [name, arm] of Object.entries(run.arms)) {
      const censored = {}; for (const p of arm.records) if (p.status === 'censored') add(censored, p.censorReason);
      const losses = arm.records.map(p => p.fillLossBps).sort((a, b) => a - b);
      const comparison = run.comparisons[name];
      lines.push(`### ${name}`, '',
        `- Entry round-trip loss: ${losses.length ? `${losses[0] / 100}%–${losses.at(-1) / 100}%` : 'N/A'}`,
        `- Matched improved/worsened/unchanged: ${comparison ? `${comparison.better}/${comparison.worse}/${comparison.unchanged}` : 'control'}`,
        `- TP: ${arm.cfg.profitBps / 100}% net; SL: ${arm.cfg.stopLossBps ? `-${arm.cfg.stopLossBps / 100}% net` : 'off'}; hold: ${arm.cfg.holdSlots} slots; liquidity guard: ${arm.cfg.liquidityExitMultiple}×`,
        `- Baseline profit exits become: ${comparison ? JSON.stringify(comparison.baselineProfitTransitions) : 'control'}`,
        `- Exit reasons: ${JSON.stringify(arm.exitReasons)}`,
        `- Coverage exclusions: ${JSON.stringify(censored)}`, `- Signal/fill exclusions: ${JSON.stringify(arm.rejections)}`, '');
    }
  }
  lines.push('## Interpretation limits', '', ...result.assumptions.map(s => `- ${s}`), '',
    'Missing or censored outcomes are not zero-return trades. Do not select a winner from unmatched resolved subsets. All configurations and per-position evidence are retained in results.json.', '');
  return lines.join('\n');
}

async function main() {
  const [input, output, suite = 'exits'] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node --env-file=.env research/agent-exit-sensitivity.js INPUT NEW_OUTPUT_DIRECTORY [exits|take-profit|lower-tp|stop-loss|loss-multiplier|gradual-multiplier|multiplier-factors]');
  const text = await readFile(resolve(input), 'utf8');
  const result = study(JSON.parse(text), paperConfig(process.env, 'agent-sell-liquidity'), suite);
  result.sourcePath = resolve(input); result.sourceSha256 = createHash('sha256').update(text).digest('hex');
  // Refuse existing output directories: preserve prior evidence rather than overwrite it.
  await mkdir(resolve(output));
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(output, 'report.md'), markdown(result), { flag: 'wx' });
  console.log(JSON.stringify({ output: resolve(output), audit: result.audit,
    comparisons: Object.fromEntries(Object.entries(result.runs).map(([key, run]) => [key, run.comparisons])) }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
