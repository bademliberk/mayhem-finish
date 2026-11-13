import { PUMP } from './config.js';
import { agentSellEvents } from './chain.js';
import { LookupCache } from './paper-lookups.js';
import { PaperStore } from './paper-store.js';
import { buildFailureCode, transactionFailure, readOrderDiagnostics } from './paper-diagnostics.js';
import { reserves, cap, entryQuote, entryQuality, exitQuote, terminalExitQuote, writeOffQuote, liquidityRisk, stopLoss, liquidityBudget, budgetCapped, profitable, meetsDrop, higher } from './paper-math.js';

const mandatoryExit = reason => ['floor', 'stop_loss', 'liquidity_risk', 'timeout'].includes(reason);
const exitPriority = reason => ({ profit: 0, stop_loss: 1, liquidity_risk: 2, timeout: 3, floor: 4, graduated_no_amm_exit: 5 }[reason] ?? -1);
const downMoreThanBps = (current, baseline, bps) =>
  current.virtualSol * baseline.virtualTokens * 10000n <
  baseline.virtualSol * current.virtualTokens * BigInt(10000 - bps);
const priceLower = (left, right) => left.virtualSol * right.virtualTokens < right.virtualSol * left.virtualTokens;
const drawdownBps = (current, baseline) => {
  const whole = baseline.virtualSol * current.virtualTokens;
  const drop = whole - current.virtualSol * baseline.virtualTokens;
  return drop <= 0n ? 0 : Number(drop * 10000n / whole);
};

function validateAccount(account) {
  if (!account) return { code: 'missing_account' };
  if (account.owner !== PUMP) return { code: 'wrong_owner' };
  if (!Array.isArray(account.data) || account.data[1] !== 'base64' || typeof account.data[0] !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(account.data[0])) return { code: 'invalid_data' };
  try { return { state: reserves(account) }; }
  catch (error) {
    return { code: error.message === 'not_mayhem' ? 'not_mayhem' : 'invalid_curve', subtype: error.validation ?? null };
  }
}

export class PaperEngine {
  constructor(store, rpc, cfg, { now = Date.now, project, executor = null, log = console.error } = {}) {
    this.store = store; this.rpc = rpc; this.cfg = cfg; this.now = now; this.project = project;
    // Live mode: a real executor replaces the simulated fill. Orders in `submitted` may already be on-chain:
    // only chain results settle them, never gaps, stops, supersedes or TTLs.
    this.executor = executor; this.log = log; this.submitted = new Set(); this.liveHalted = null;
    this.liveForeign = new Set(); this.liveExitFailures = new Map(); this.liveResolveAt = new Map(); this.liveBuying = new Set();
    const live = ['live', 'live_dry_run'].includes(cfg.mode);
    if (Boolean(executor) !== live) throw new Error('Live configurations require an executor, and an executor requires a live configuration');
    if (live && (cfg.strategy !== 'agent-sell-liquidity' || !cfg.live)) throw new Error('Live execution supports only agent-sell-liquidity with live limits');
    this.dryRun = cfg.mode === 'live_dry_run';
    this.paper = new PaperStore(store, cfg); this.states = new Map(); this.ready = false;
    for (const row of store.all('SELECT mint,failures,last_code,last_at_ms,retry_at_ms FROM live_exit_failures')) {
      this.liveExitFailures.set(row.mint, { failures: row.failures, code: row.last_code, at: row.last_at_ms, until: row.retry_at_ms });
    }
    this.agentMode = cfg.strategy === 'agent-sell-liquidity'; this.observationRevision = 0;
    this.terminalExits = this.agentMode && cfg.version === 'agent_sell_liquidity_v4_post_drop_confirmation';
    this.dropConfirmations = new Map();
    this.startupExitGrace = new Map();
    this.coverageSlots = new Map();
    this.lookups = new LookupCache(rpc, name => { if (!this.stopped) this.paper.count(name); }, now);
    this.slot = 0; this.slotAt = 0; this.epoch = 0; this.queue = []; this.working = false; this.stopped = false; this.draining = false;
    this.reconciliations = new Map(); this.exitAttempts = new Map(); this.stopPromise = null;
  }
  attach(feeds) { this.feeds = feeds; }
  request(mint, side, reason, quote, signal, diagnostics = {}, now = this.now()) {
    const id = this.paper.request(mint, side, reason, quote, signal, now);
    if (id) this.paper.diagnose(id, { stage: 'requested', createdAtMs: now, updatedAtMs: now,
      elapsedMs: 0, currentSlot: this.slot, signalSlot: signal?.slot, triggerSide: signal?.side, ...diagnostics });
    return id;
  }
  timing(order, active = this.reconciliations.get(order.id)) {
    const now = this.now(), patch = { currentSlot: this.slot, updatedAtMs: now,
      elapsedMs: Math.max(0, now - order.created_at_ms) };
    if (active?.waitKind) {
      const field = `${active.waitKind}ElapsedMs`;
      patch[field] = (active.diagnostics[field] ?? 0) + Math.max(0, now - active.waitAt);
    }
    return patch;
  }
  diagnose(order, patch) {
    const active = this.reconciliations.get(order.id);
    const update = { ...this.timing(order, active), ...patch };
    if (active) Object.assign(active.diagnostics, update);
    this.paper.diagnose(order.id, update);
  }
  cancel(id, now, reason, diagnostics = {}) {
    if (this.submitted.has(id)) { this.paper.count(`live:cancel_blocked:${reason}`); return; }
    const active = this.reconciliations.get(id);
    const order = this.store.get("SELECT * FROM paper_orders WHERE id=? AND status='pending'", id);
    if (order) {
      const last = active?.diagnostics ?? readOrderDiagnostics(order.diagnostics_json);
      this.paper.cancel(id, now, reason, { ...this.timing(order, active),
        lastStage: last?.stage === 'unavailable' ? last.lastStage : last?.stage, ...diagnostics, stage: 'canceled' });
    }
    // Abort even if another path has already made the order terminal.
    active?.controller.abort();
  }
  expire(order) {
    if (this.submitted.has(order.id)) return false;
    const expiryCause = this.now() >= order.expires_at_ms ? 'clock' :
      order.side === 'buy' && this.slot > order.signal_slot + (this.cfg.signalValiditySlots ?? 5) - 1 ? 'slot' : null;
    if (expiryCause) this.cancel(order.id, this.now(), 'signal_expired', { expiryCause });
    return Boolean(expiryCause);
  }
  current(order, active) {
    if (this.stopped || active.controller.signal.aborted ||
        !this.store.get("SELECT 1 FROM paper_orders WHERE id=? AND status='pending'", order.id)) return false;
    if (this.expire(order)) return false;
    if (this.agentMode && order.side === 'buy') {
      const cursor = this.paper.agentCursor(order.mint);
      if (!cursor || cursor.ambiguous || cursor.revision !== active.triggerRevision) {
        this.cancel(order.id, this.now(), 'sell_superseded'); return false;
      }
    }
    if (this.epoch !== active.epoch) return false;
    if (this.agentMode && order.side === 'sell' && mandatoryExit(order.reason)) {
      // Transaction coverage changes affect entry history, not account-driven exit confirmations.
      return this.states.has(order.mint) && this.paper.position(order.mint)?.entry_order_id === active.entryOrderId;
    }
    return this.states.get(order.mint)?.since === active.generation.since;
  }
  unwatch(mint) {
    this.exitAttempts.delete(mint); this.startupExitGrace.delete(mint);
    this.states.delete(mint); this.coverageSlots.delete(mint); this.feeds.remove(mint);
    this.store.run('UPDATE paper_watches SET preprocessed=0 WHERE mint=?', mint);
  }
  discover() {
    if (this.stopped) return;
    for (const row of this.store.all('SELECT mint FROM paper_discoveries WHERE handled=0')) {
      this.add(row.mint);
      this.store.run('UPDATE paper_discoveries SET handled=1 WHERE mint=?', row.mint);
    }
  }
  coverage(mint) {
    if (this.stopped) return;
    // An acknowledgment without a current slot must wait for the first slot notification.
    const since = this.slot || Infinity;
    this.coverageSlots.set(mint, since);
    const row = this.states.get(mint);
    if (row) { row.since = Math.max(row.slot, since); row.history = [{ state: row.state, slot: row.slot, at: row.at }]; }
  }
  membership(mint, enabled) {
    if (this.stopped || this.agentMode) return;
    const watch = this.paper.watch(mint);
    if (!watch || Boolean(watch.preprocessed) === enabled) return;
    this.store.run('UPDATE paper_watches SET preprocessed=? WHERE mint=?', Number(enabled), mint);
    this.feeds.setPreprocessed(mint, enabled);
    this.paper.count(enabled ? 'preprocessed_activated' : 'preprocessed_idle');
    if (!enabled) {
      for (const order of this.paper.pending().filter(order => order.mint === mint && order.side === 'buy')) {
        this.cancel(order.id, this.now(), 'preprocessed_idle');
      }
    }
  }
  start() {
    if (this.stopped) return;
    const active = this.paper.active();
    const held = active.filter(row => this.paper.position(row.mint));
    const monitoredHeld = held.filter(row => row.reason !== 'graduated_no_amm_exit');
    if (monitoredHeld.length > this.cfg.maxWatches) {
      throw new Error(`Open paper positions exceed PAPER_MAX_WATCHES (${this.cfg.maxWatches}); manual reconciliation required before startup`);
    }
    const heldMints = new Set(held.map(row => row.mint));
    const unheld = active.filter(row => !heldMints.has(row.mint))
      .sort((a, b) => b.enrolled_at_ms - a.enrolled_at_ms || a.mint.localeCompare(b.mint));
    const excess = unheld.slice(this.cfg.maxWatches - monitoredHeld.length);
    this.store.atomic(() => {
      for (const event of this.store.all("SELECT signature,mint,event_index FROM paper_agent_events WHERE outcome='drop_confirmation_pending'")) {
        this.store.run(`UPDATE paper_agent_events SET outcome='drop_confirmation_interrupted',detail=?
          WHERE signature=? AND mint=? AND event_index=?`, JSON.stringify({ reason: 'restart_before_confirmation' }),
        event.signature, event.mint, event.event_index);
        this.paper.count('agent:drop_confirmation_interrupted');
      }
      // Unknown pending fills are canceled on restart, not assumed to have happened.
      // Live submissions may be on-chain: keep them blocked and resolve them from chain in tick().
      for (const order of this.paper.pending()) {
        const stage = readOrderDiagnostics(order.diagnostics_json)?.stage;
        if (this.executor && ['live_submitted', 'live_unknown'].includes(stage)) {
          this.submitted.add(order.id);
          if (stage === 'live_submitted') this.paper.diagnose(order.id, { stage: 'live_unknown', updatedAtMs: this.now() });
        } else this.cancel(order.id, this.now(), 'restart_unreconciled');
      }
      for (const row of excess) {
        this.store.run("UPDATE paper_watches SET status='stopped',reason='subscription_cap',preprocessed=0 WHERE mint=?", row.mint);
        this.paper.count('restart_subscription_cap');
      }
    });
    for (const row of this.paper.active()) {
      const held = Boolean(this.paper.position(row.mint));
      if (this.terminalExits && held) {
        if (row.reason === 'graduated_no_amm_exit') {
          this.writeOff(row.mint, row.reason, 'graduated_no_amm_exit'); continue;
        }
        this.startupExitGrace.set(row.mint, this.now() + this.cfg.orderTtlMs);
      }
      const enabled = !this.agentMode && row.reason !== 'graduated_no_amm_exit' &&
        (held || Boolean(row.preprocessed && this.now() - row.last_change_ms < this.cfg.idleMs));
      this.store.run('UPDATE paper_watches SET preprocessed=? WHERE mint=?', Number(enabled), row.mint);
      if (row.reason !== 'graduated_no_amm_exit') this.feeds.add(row.mint, row.curve_address, enabled);
    }
    this.discover();
    this.feeds.start();
  }
  add(mint) {
    if (this.stopped) return;
    const admission = this.paper.admit(mint, this.now(), true);
    if (admission.evicted) this.unwatch(admission.evicted);
    if (admission.enrolled) this.feeds.add(mint, this.paper.watch(mint).curve_address, false);
  }
  gap(reason) {
    if (this.stopped) return;
    this.ready = false; this.epoch++; this.slot = 0; this.slotAt = 0; this.states.clear(); this.queue = [];
    this.coverageSlots.clear(); this.lookups.clear();
    this.paper.count(`gap:${reason}`);
    for (const order of this.paper.pending()) this.cancel(order.id, this.now(), 'feed_gap');
    this.clearDropConfirmations('drop_confirmation_feed_gap');
    if (this.terminalExits) {
      // A gap is missing data, not evidence of zero recovery: hold write-offs until feeds recover (see onReady).
      for (const watch of this.paper.active()) {
        if (watch.reason !== 'graduated_no_amm_exit' && this.paper.position(watch.mint)) this.startupExitGrace.set(watch.mint, Infinity);
      }
    }
  }
  onReady() {
    if (this.stopped) return;
    this.ready = true;
    // After a gap, the reconnection baseline gets one order TTL to arrive, as on restart.
    for (const [mint, until] of this.startupExitGrace) {
      if (until === Infinity) this.startupExitGrace.set(mint, this.now() + this.cfg.orderTtlMs);
    }
  }
  onSlot(slot) {
    if (this.stopped || !Number.isSafeInteger(slot) || slot < 0) return;
    if (slot < this.slot) return;
    const jumped = this.slot && slot > this.slot + 8;
    this.slot = slot; this.slotAt = this.now();
    if (jumped) {
      // Skipped leader slots or dropped slot notifications are not lost account or transaction data:
      // sockets that actually fail report their own gaps. Restart only local signal windows so no
      // entry spans the discontinuity, without tearing down feeds or canceling orders.
      this.paper.count('slot_discontinuity');
      this.clearDropConfirmations('drop_confirmation_slot_gap');
      // Only mints that already had coverage: a jump must not grant coverage the feeds never acknowledged.
      for (const mint of [...this.coverageSlots.keys()]) this.coverage(mint);
    }
    for (const order of this.paper.pending()) this.expire(order);
    if (this.agentMode) this.checkDropConfirmations();
    if (this.agentMode) this.checkAgentExits();
    if (slot) {
      for (const [mint, since] of this.coverageSlots) {
        if (since === Infinity) this.coverage(mint);
      }
    }
  }
  invalidateAccount(mint, slot, account, code, subtype = null) {
    if (this.stopped) return;
    this.cancelDropConfirmation(mint, 'drop_confirmation_invalid_account', { slot, code });
    this.states.delete(mint); this.startupExitGrace.delete(mint);
    this.coverageSlots.set(mint, Math.max(slot, this.slot) || Infinity);
    for (const order of this.paper.pending().filter(order => order.mint === mint)) {
      this.cancel(order.id, this.now(), 'invalid_account');
    }
    this.store.run('UPDATE paper_watches SET last_slot=?,account_error=? WHERE mint=?', slot, code, mint);
    this.paper.count('invalid_account');
    this.paper.accountFault(mint, slot, account, code, this.now(), subtype);
    if (this.terminalExits && this.paper.position(mint)) {
      if (this.timeoutDue(this.paper.position(mint))) this.latchExit(mint, 'timeout');
      const reason = this.paper.watch(mint).reason;
      if (mandatoryExit(reason) && this.writeOff(mint, reason, code, { observedSlot: slot })) return;
    }
    if ((code === 'not_mayhem' || subtype === 'unsupported_quote') && !this.paper.position(mint)) {
      this.store.run("UPDATE paper_watches SET status='stopped',reason=? WHERE mint=?",
        code === 'not_mayhem' ? 'not_mayhem' : 'unsupported_quote', mint);
      this.unwatch(mint);
    }
  }
  onAccount(mint, slot, account, source = 'live') {
    if (this.stopped || !Number.isSafeInteger(slot) || slot < 0) return;
    const watch = this.paper.watch(mint);
    if (!watch || !['watching', 'holding', 'exit_blocked'].includes(watch.status)) return;
    const old = this.states.get(mint);
    if (slot < (old?.slot ?? watch.last_slot ?? -1)) {
      this.paper.count('out_of_order_account'); return;
    }
    const { state, code, subtype } = validateAccount(account);
    if (code) { this.invalidateAccount(mint, slot, account, code, subtype); return; }
    try {
      const row = { state, slot, at: this.now(), revision: ++this.observationRevision, account,
        since: old?.since ?? Math.max(slot, this.coverageSlots.get(mint) ?? slot), history: old?.history ?? [] };
      // Confirmation snapshots cannot authorize another exit attempt by themselves.
      row.exitRevision = source === 'rpc' ? old?.exitRevision : row.revision;
      const historySlots = Math.max(this.cfg.windowSlots ?? 5,
        this.cfg.localBottomSlots ? this.cfg.localBottomSlots + (this.cfg.signalValiditySlots ?? 0) + 2 : 0);
      row.history = row.history.filter(item => item.slot >= slot - historySlots + 1);
      if (!state.complete) row.history.push({ state, slot, at: row.at });
      // Several writes in one slot have no transaction index; retain their observed peak only.
      if (row.history.length > 1000) { this.paper.count('history_overflow'); row.history = []; row.since = slot; }
      this.states.set(mint, row);
      // A gap hold (Infinity) lasts until feeds are ready again; data alone does not end it.
      if (this.startupExitGrace.get(mint) !== Infinity) this.startupExitGrace.delete(mint);
      this.store.run('UPDATE paper_watches SET last_slot=?,last_cap=?,account_error=NULL,last_observed_ms=? WHERE mint=?', slot, state.complete ? null : cap(state), this.now(), mint);
      const fingerprint = account.data[0];
      const changed = fingerprint !== watch.fingerprint;
      if (changed) this.store.run('UPDATE paper_watches SET fingerprint=?,last_change_ms=? WHERE mint=?', fingerprint, this.now(), mint);
      if (this.agentMode) this.checkDropConfirmation(mint);
      if (!this.agentMode && !state.complete && cap(state) > this.cfg.floorCap &&
          (this.paper.position(mint) || (changed && cap(state) < this.cfg.activationCap))) this.membership(mint, true);
      if (state.complete) {
        for (const order of this.paper.pending().filter(o => o.mint === mint)) this.cancel(order.id, this.now(), 'graduated');
        this.store.run('UPDATE paper_watches SET status=?,reason=? WHERE mint=?', this.paper.position(mint) ? 'exit_blocked' : 'stopped', 'graduated_no_amm_exit', mint);
        // Live mode has no AMM adapter. Persist a manual action immediately instead of leaving a
        // graduated holding as an unreported blocked position (or attempting the curve seller).
        if (this.executor && !this.dryRun && this.paper.position(mint)) {
          this.liveExit(mint, 'graduated_no_amm_exit', 'graduated_no_amm_exit', { observedSlot: slot });
          return;
        }
        if (this.terminalExits && this.writeOff(mint, 'graduated_no_amm_exit', 'graduated_no_amm_exit', { observedSlot: slot })) return;
        this.unwatch(mint); return;
      }
      if (this.paper.position(mint) && watch.reason === 'graduated_no_amm_exit') {
        this.unwatch(mint); return;
      }
      if (this.paper.position(mint)) {
        const reason = this.exitIntent(mint, state);
        if (reason) this.requestExit(mint, state, reason, null);
        else if (this.agentMode) this.requestExit(mint, state, 'profit', null);
      } else if (!this.agentMode && cap(state) <= this.cfg.floorCap) {
        const pending = this.paper.pending().find(o => o.mint === mint);
        if (pending) this.cancel(pending.id, this.now(), 'floor_override');
        this.store.run("UPDATE paper_watches SET status='stopped',reason='floor' WHERE mint=?", mint);
        this.unwatch(mint);
      }
    } catch {
      this.invalidateAccount(mint, slot, account, 'processing_error');
    }
  }
  timeoutDue(position) {
    return this.agentMode && position && Number.isSafeInteger(position.timeout_slot) && this.slot >= position.timeout_slot;
  }
  writeOff(mint, reason, cause, evidence = {}) {
    const position = this.paper.position(mint);
    if (!this.terminalExits || this.stopped || !position ||
        (!mandatoryExit(reason) && reason !== 'graduated_no_amm_exit')) return false;
    // Live: no modeled burn. Sell everything on-chain for whatever the curve gives; a graduated curve has no
    // curve market (no AMM here), so it stays held and is reported for manual handling.
    if (this.executor && !this.dryRun) return this.liveExit(mint, reason, cause, evidence);
    for (const order of this.paper.pending().filter(row => row.mint === mint)) this.cancel(order.id, this.now(), 'terminal_write_off');
    const quote = { ...writeOffQuote(position, this.cfg, cause), evidence };
    const closed = this.paper.writeOff(mint, reason, quote, this.now());
    if (closed) this.unwatch(mint);
    return closed;
  }
  checkAgentExits() {
    for (const watch of this.paper.active()) {
      if (watch.reason === 'graduated_no_amm_exit') {
        if (this.terminalExits) this.writeOff(watch.mint, watch.reason, 'graduated_no_amm_exit');
        continue;
      }
      const position = this.paper.position(watch.mint);
      if (this.timeoutDue(position)) this.latchExit(watch.mint, 'timeout');
      const row = this.states.get(watch.mint);
      const reason = this.paper.watch(watch.mint).reason;
      if (this.terminalExits && position && mandatoryExit(reason)) {
        const pending = this.paper.pending().find(order => order.mint === watch.mint);
        // Cache age alone must not abort a still-valid confirmation.
        if (pending && !this.expire(pending)) continue;
        // A quiet but covered curve gets its one event-driven attempt at the unchanged reserves before any write-off.
        const usable = row && (this.observationFresh(row) ||
          (this.quietCovered(watch.mint, row) && this.exitAttemptAvailable(watch.mint, position, row)));
        const unavailable = watch.account_error || (!row ? 'missing_observation' : !usable ? 'stale_observation' : null);
        if (unavailable) {
          if (this.now() < (this.startupExitGrace.get(watch.mint) ?? 0)) continue;
          this.writeOff(watch.mint, reason, unavailable, { observedSlot: row?.slot ?? watch.last_slot,
            observedAtMs: row?.at ?? watch.last_observed_ms });
          continue;
        }
      }
      if (row && position) this.requestExit(watch.mint, row.state, this.exitIntent(watch.mint, row.state) ?? 'profit', null);
    }
  }
  observationFresh(row) {
    return Boolean(row) && this.now() >= row.at && this.now() - row.at <= this.cfg.maxStateAgeMs;
  }
  // Terminal-exit policy: accountSubscribe notifies on change, so silence on a live, covered subscription means unchanged
  // reserves, not unknown ones. Gaps and invalid accounts clear cached rows, so a cached row implies neither since.
  quietCovered(mint, row) {
    return this.terminalExits && this.ready && Boolean(row) && this.now() >= row.at && this.feeds.covers(mint) &&
      this.slotAt > 0 && this.now() >= this.slotAt && this.now() - this.slotAt <= this.cfg.maxStateAgeMs;
  }
  exitAttemptAvailable(mint, position, observation) {
    if (!position || !Number.isSafeInteger(observation?.exitRevision)) return false;
    const previous = this.exitAttempts.get(mint);
    return previous?.entryOrderId !== position.entry_order_id || previous.revision !== observation.exitRevision;
  }
  exitIntent(mint, state) {
    const watch = this.paper.watch(mint), position = this.paper.position(mint);
    if (!position || state.complete || watch.reason === 'graduated_no_amm_exit') return null;
    if (this.agentMode && (watch.reason === 'timeout' || this.timeoutDue(position))) return 'timeout';
    if (!this.agentMode && (watch.reason === 'floor' || cap(state) <= this.cfg.floorCap)) return 'floor';
    if (watch.reason === 'liquidity_risk' || liquidityRisk(state, position, this.cfg)) return 'liquidity_risk';
    // A triggered stop is latched like the other mandatory exits: a later bounce does not cancel it.
    if (this.agentMode && (watch.reason === 'stop_loss' || stopLoss(state, position, this.cfg))) return 'stop_loss';
    return null;
  }
  latchExit(mint, reason) {
    if (!mandatoryExit(reason)) return;
    this.store.atomic(() => {
      const watch = this.paper.watch(mint);
      if (exitPriority(watch.reason) > exitPriority(reason)) return;
      // Persist before quoting/canceling: an illiquid exit, or a crash, must not lose intent.
      if (watch.status !== 'exit_blocked' || watch.reason !== reason) {
        this.store.run("UPDATE paper_watches SET status='exit_blocked',reason=? WHERE mint=?", reason, mint);
      }
      const pending = this.paper.pending().find(order => order.mint === mint);
      if (pending && exitPriority(pending.reason) < exitPriority(reason)) {
        if (this.agentMode && pending.side === 'sell' && mandatoryExit(pending.reason)) {
          // Keep the quote, authorization and deadline while promoting an existing mandatory exit.
          this.store.run("UPDATE paper_orders SET reason=? WHERE id=? AND status='pending'", reason, pending.id);
          const active = this.reconciliations.get(pending.id);
          if (active) active.order.reason = reason;
        } else this.cancel(pending.id, this.now(), `${reason}_override`);
      }
    });
  }
  requestExit(mint, state, reason, signal, observation = this.states.get(mint)) {
    const position = this.paper.position(mint), watch = this.paper.watch(mint);
    if (this.stopped || !position || watch.reason === 'graduated_no_amm_exit' || state.complete ||
        watch.account_error || !observation ||
        !(this.observationFresh(observation) ||
          (this.quietCovered(mint, observation) && this.exitIntent(mint, observation.state))) ||
        (!signal && state !== observation.state)) return;
    // Predictions may request profit, but only observed (or freshly confirmed) reserves latch risk.
    const intent = this.exitIntent(mint, observation.state);
    if (intent) {
      reason = intent; state = observation.state; signal = null;
      this.latchExit(mint, reason);
    } else if (mandatoryExit(reason)) return;
    if (this.paper.pending().some(order => order.mint === mint)) return;
    if (this.executor && this.liveBackoff(mint)) return;
    const eventDriven = this.agentMode && mandatoryExit(reason);
    if (eventDriven) {
      if (!this.exitAttemptAvailable(mint, position, observation)) return;
      // Claim the event at evaluation, including unquotable reserves or orders that expire before execution.
      this.exitAttempts.set(mint, { entryOrderId: position.entry_order_id, revision: observation.exitRevision });
    }
    try {
      const quote = this.terminalExits && eventDriven ? terminalExitQuote(state, position, this.cfg) : exitQuote(state, position, this.cfg);
      if (eventDriven) quote.exitObservationRevision = observation.exitRevision;
      if (quote.terminalOutcome === 'write_off') {
        this.writeOff(mint, reason, quote.writeOffReason, { observedSlot: observation.slot,
          observedAtMs: observation.at, reserveEvidence: quote.reserveEvidence });
        return;
      }
      if (reason === 'profit' && !profitable(quote, position, this.cfg)) return;
      if (signal?.base) quote.projectionBase = signal.base;
      if (!signal && Number.isSafeInteger(observation.slot)) quote.observationSlot = observation.slot;
      this.request(mint, 'sell', reason, quote, signal);
    } catch {
      this.paper.count('exit_insufficient_liquidity');
    }
  }
  agentFresh(mint, slot) {
    const row = this.states.get(mint), age = this.now() - this.slotAt;
    return this.ready && this.feeds.covers(mint) && row && this.slot > 0 && age >= 0 && age <= this.cfg.maxStateAgeMs &&
      this.now() >= row.at && this.now() - row.at <= this.cfg.maxStateAgeMs &&
      slot >= (this.coverageSlots.get(mint) ?? Infinity) && slot <= this.slot + 2 &&
      this.slot < slot + this.cfg.signalValiditySlots;
  }
  agentLocalBottom(mint, event, state) {
    const window = this.cfg.localBottomSlots;
    if (!window) return { enabled: false, accepted: true };
    const row = this.states.get(mint), coverage = this.coverageSlots.get(mint);
    const startSlot = event.slot - window + 1;
    if (!row || !Number.isSafeInteger(coverage) || coverage > startSlot || row.since > startSlot) {
      return { enabled: true, accepted: false, complete: false, startSlot, currentMc: cap(state), priorLowMc: null };
    }
    // Same-slot curve notifications have no transaction ordering. Exclude them to avoid using a state
    // that may have arrived after the triggering sell; the sell's own post-trade reserves are the endpoint.
    const history = row.history.filter(sample => sample.slot < event.slot);
    const baseline = history.filter(sample => sample.slot <= startSlot)
      .reduce((latest, sample) => !latest || sample.slot > latest.slot ? sample : latest, null);
    if (!baseline) return { enabled: true, accepted: false, complete: false, startSlot, currentMc: cap(state), priorLowMc: null };
    const samples = [baseline, ...history.filter(sample => sample.slot >= startSlot && sample.slot < event.slot)];
    const priorLowMc = samples.reduce((low, sample) => Math.min(low, cap(sample.state)), Infinity);
    const currentMc = cap(state);
    return { enabled: true, accepted: currentMc <= priorLowMc, complete: true, startSlot, currentMc, priorLowMc };
  }
  cancelDropConfirmation(mint, outcome, detail = null) {
    const candidate = this.dropConfirmations.get(mint);
    if (!candidate) return false;
    this.dropConfirmations.delete(mint);
    this.paper.agentOutcome(candidate.event, outcome, detail);
    return true;
  }
  clearDropConfirmations(outcome) {
    for (const mint of [...this.dropConfirmations.keys()]) this.cancelDropConfirmation(mint, outcome);
  }
  checkDropConfirmations() {
    for (const mint of [...this.dropConfirmations.keys()]) this.checkDropConfirmation(mint);
  }
  checkDropConfirmation(mint) {
    const candidate = this.dropConfirmations.get(mint);
    if (!candidate) return;
    const cursor = this.paper.agentCursor(mint), watch = this.paper.watch(mint), row = this.states.get(mint);
    if (!cursor || cursor.ambiguous || cursor.revision !== candidate.revision) {
      this.cancelDropConfirmation(mint, 'drop_confirmation_superseded'); return;
    }
    if (!watch || watch.status !== 'watching' || this.paper.position(mint)) {
      this.cancelDropConfirmation(mint, 'drop_confirmation_entry_unavailable'); return;
    }
    if (row?.state?.complete) {
      this.cancelDropConfirmation(mint, 'drop_confirmation_graduated'); return;
    }
    // Every observed reserve update in the confirmation window counts, even if the price later recovers.
    for (const sample of row?.history ?? []) {
      if (sample.slot <= candidate.startSlot || sample.slot > candidate.endSlot) continue;
      if (downMoreThanBps(sample.state, candidate.baselineState, candidate.maxDrawdownBps)) {
        this.cancelDropConfirmation(mint, 'post_drop_drawdown', {
          startSlot: candidate.startSlot, endSlot: candidate.endSlot, observedSlot: sample.slot,
          baselineMc: cap(candidate.baselineState), observedMc: cap(sample.state),
          maxDrawdownBps: candidate.maxDrawdownBps,
        });
        return;
      }
      if (sample.slot > candidate.latestSlot) {
        candidate.latestSlot = sample.slot; candidate.latestState = sample.state;
      }
      if (priceLower(sample.state, candidate.lowestState)) {
        candidate.lowestSlot = sample.slot; candidate.lowestState = sample.state;
      }
    }
    // A live, covered account subscription is change-only: if no newer account arrived, reserves stayed still.
    if (row && row.slot > candidate.startSlot && row.slot > candidate.latestSlot) {
      candidate.latestSlot = row.slot; candidate.latestState = row.state;
      if (priceLower(row.state, candidate.lowestState)) {
        candidate.lowestSlot = row.slot; candidate.lowestState = row.state;
      }
    }
    if (this.slot < candidate.endSlot) return;
    if (this.slot > candidate.endSlot + (this.cfg.signalValiditySlots ?? 5)) {
      this.cancelDropConfirmation(mint, 'drop_confirmation_stale'); return;
    }
    if (!this.ready || !this.feeds.covers(mint) || !row || !this.quietCovered(mint, row)) return;
    // Check the current price as well, so a late update cannot pass the window on stale cached reserves.
    if (downMoreThanBps(candidate.latestState, candidate.baselineState, candidate.maxDrawdownBps)) {
      this.cancelDropConfirmation(mint, 'post_drop_drawdown', {
        startSlot: candidate.startSlot, endSlot: candidate.endSlot, observedSlot: candidate.latestSlot,
        baselineMc: cap(candidate.baselineState), observedMc: cap(candidate.latestState),
        maxDrawdownBps: candidate.maxDrawdownBps,
      });
      return;
    }
    if (!this.agentFresh(mint, this.slot)) return;
    this.dropConfirmations.delete(mint);
    this.submitAgentBuy(candidate, candidate.latestState, true);
  }
  submitAgentBuy(candidate, state, confirmed) {
    const { event, revision, localBottom, receivedAt } = candidate;
    const mint = event.mint, reject = (reason, detail) => this.paper.agentOutcome(event, reason, detail);
    const watch = this.paper.watch(mint), cursor = this.paper.agentCursor(mint);
    if (!this.ready || !this.feeds.covers(mint) || !this.agentFresh(mint, confirmed ? this.slot : event.slot) ||
        !watch || watch.status !== 'watching' || this.paper.position(mint) ||
        !this.cfg.entriesEnabled || !this.paper.capacity().remaining ||
        !cursor || cursor.ambiguous || cursor.revision !== revision) {
      reject('drop_confirmation_entry_unavailable'); return;
    }
    if (this.liveHalted) { reject('live_halted'); return; }
    if (this.liveForeign.has(mint)) { reject('live_foreign_holding'); return; }
    try {
      if (state.complete || state.realSol < BigInt(this.cfg.minRealSolLamports)) return reject('minimum_real_liquidity');
      if (this.cfg.skipCappedEntries && budgetCapped(state.realSol, this.cfg)) return reject('capped_budget_skipped');
      const mc = cap(state);
      if ((this.cfg.minEntryMcSol != null && mc < this.cfg.minEntryMcSol) ||
          (this.cfg.maxEntryMcSol != null && mc >= this.cfg.maxEntryMcSol)) return reject('mcap_outside_band', { mc });
      const budget = liquidityBudget(state.realSol, this.cfg);
      if (budget <= 0n) return reject('budget_too_small');
      const quote = entryQuote(state, this.cfg, budget);
      quote.entryQuality = entryQuality(state, this.cfg, budget);
      if (quote.entryQuality.rejection) return reject(quote.entryQuality.rejection, quote.entryQuality);
      const signalSlot = confirmed ? this.slot : event.slot;
      const referenceReserves = Object.fromEntries(['realSol', 'realTokens', 'virtualSol', 'virtualTokens']
        .map(key => [key, state[key].toString()]));
      Object.assign(quote, { requestedBudgetLamports: budget.toString(), triggerRevision: revision,
        eventIndex: event.index, eventActor: event.user, referenceReserves,
        provenance: 'successful_mayhem_ancestor', receivedAtMs: receivedAt,
        ...(localBottom.enabled ? { localBottomEvidence: localBottom } : {}),
        ...(confirmed ? { dropConfirmationEvidence: { startSlot: candidate.startSlot, endSlot: candidate.endSlot,
          baselineMc: cap(candidate.baselineState), lowestMc: cap(candidate.lowestState), lowestSlot: candidate.lowestSlot,
          observedDrawdownBps: drawdownBps(candidate.lowestState, candidate.baselineState),
          confirmedMc: mc, maxDrawdownBps: candidate.maxDrawdownBps },
          triggerSignature: event.signature, triggerSlot: event.slot } : {}) });
      if (!this.paper.exposureAllows(budget + BigInt(this.cfg.networkFeeLamports))) return reject('exposure_cap');
      const id = this.request(mint, 'buy', 'agent_sell', quote,
        { signature: confirmed ? null : event.signature, slot: signalSlot, side: 'sell' },
        { eventIndex: event.index, triggerRevision: revision, requestedBudgetLamports: budget.toString(),
          referenceRealSolLamports: state.realSol.toString(), triggerToRequestSlots: Math.max(0, this.slot - event.slot),
          ...(confirmed ? { dropConfirmSlots: candidate.endSlot - candidate.startSlot,
            dropConfirmationDrawdownBps: candidate.maxDrawdownBps } : {}) }, this.now());
      reject(id ? (confirmed ? 'drop_confirmation_passed' : 'buy_pending') : 'entry_blocked',
        { requestedBudgetLamports: budget.toString(), referenceReserves, ...(confirmed ? { endSlot: candidate.endSlot } : {}) });
    } catch { reject('entry_quote_unavailable'); }
  }
  agentTransaction(tx) {
    if (this.stopped || !this.agentMode) return;
    const receivedAt = this.now();
    this.paper.count('agent:frames_processed');
    for (const event of agentSellEvents(tx)) {
      const watch = this.paper.watch(event.mint);
      if (!watch || !['watching', 'holding', 'exit_blocked'].includes(watch.status)) continue;
      // Admission is synchronous: a new sell invalidates an in-flight reconciliation immediately.
      this.store.atomic(() => {
        const { outcome, revision } = this.paper.advanceAgent(event, receivedAt);
        if (outcome === 'duplicate_sell' || outcome === 'older_sell') return;
        if (outcome === 'ambiguous_sell_slot') this.cancelDropConfirmation(event.mint, 'drop_confirmation_ambiguous_signal');
        if (outcome === 'received') this.cancelDropConfirmation(event.mint, 'drop_confirmation_superseded');
        for (const order of this.paper.pending().filter(o => o.mint === event.mint && o.side === 'buy')) {
          this.cancel(order.id, receivedAt, outcome === 'ambiguous_sell_slot' ? outcome : 'sell_superseded');
        }
        if (outcome !== 'received') return;
        const reject = (reason, detail) => this.paper.agentOutcome(event, reason, detail);
        if (!event.reserves) return reject('missing_sell_reserves');
        if (!this.agentFresh(event.mint, event.slot)) return reject('coverage_or_state_stale');
        if (this.draining) return reject('shutdown_draining');
        if (watch.status !== 'watching' || this.paper.position(event.mint) || !this.cfg.entriesEnabled ||
            this.paper.capacity().remaining <= this.dropConfirmations.size) return reject('entries_disabled_or_cap');
        if (this.liveHalted) return reject('live_halted');
        if (this.liveForeign.has(event.mint)) return reject('live_foreign_holding');
        try {
          const state = { ...this.states.get(event.mint).state,
            ...Object.fromEntries(Object.entries(event.reserves).map(([key, value]) => [key, BigInt(value)])) };
          if (state.complete || state.realSol < BigInt(this.cfg.minRealSolLamports)) return reject('minimum_real_liquidity');
          if (this.cfg.skipCappedEntries && budgetCapped(state.realSol, this.cfg)) return reject('capped_budget_skipped');
          const localBottom = this.agentLocalBottom(event.mint, event, state);
          if (!localBottom.accepted) return reject(localBottom.complete ? 'not_local_bottom' : 'local_bottom_history_incomplete', localBottom);
          if (this.cfg.minEntryMcSol != null || this.cfg.maxEntryMcSol != null) {
            const mc = cap(state);
            if (this.cfg.minEntryMcSol != null && mc < this.cfg.minEntryMcSol) return reject('mcap_below_band', { mc });
            if (this.cfg.maxEntryMcSol != null && mc >= this.cfg.maxEntryMcSol) return reject('mcap_above_band', { mc });
          }
          const budget = liquidityBudget(state.realSol, this.cfg);
          if (budget <= 0n) return reject('budget_too_small');
          const quote = entryQuote(state, this.cfg, budget);
          quote.entryQuality = entryQuality(state, this.cfg, budget);
          if (quote.entryQuality.rejection) return reject(quote.entryQuality.rejection, quote.entryQuality);
          Object.assign(quote, { requestedBudgetLamports: budget.toString(), triggerRevision: revision,
            eventIndex: event.index, eventActor: event.user, referenceReserves: event.reserves,
            provenance: 'successful_mayhem_ancestor', receivedAtMs: receivedAt,
            ...(localBottom.enabled ? { localBottomEvidence: localBottom } : {}) });
          if (!this.paper.exposureAllows(budget + BigInt(this.cfg.networkFeeLamports))) return reject('exposure_cap');
          const startSlot = Math.max(this.slot, event.slot);
          const candidate = { event, revision, localBottom, receivedAt, baselineState: state,
            latestState: state, latestSlot: startSlot, lowestState: state, lowestSlot: startSlot, startSlot,
            endSlot: startSlot + (this.cfg.dropConfirmSlots ?? 0),
            maxDrawdownBps: this.cfg.maxPostDropDrawdownBps ?? 1000 };
          if (this.cfg.dropConfirmSlots > 0) {
            this.dropConfirmations.set(event.mint, candidate);
            reject('drop_confirmation_pending', { startSlot: candidate.startSlot, endSlot: candidate.endSlot,
              baselineMc: cap(state), maxDrawdownBps: candidate.maxDrawdownBps });
            this.checkDropConfirmation(event.mint);
          } else this.submitAgentBuy(candidate, state, false);
        } catch { reject('entry_quote_unavailable'); }
      });
    }
  }
  enqueue(raw) {
    if (this.stopped || this.agentMode) return;
    if (this.queue.length >= this.cfg.queueLimit) { this.gap('queue_overflow'); this.feeds.resync?.(); return; }
    this.queue.push(raw);
  }
  async tick() {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      this.discover();
      if (this.agentMode) this.checkAgentExits();
      if (this.stopped) return;
      for (const watch of this.paper.active()) {
        if (watch.preprocessed && !this.paper.position(watch.mint) &&
            this.now() - (watch.last_change_ms ?? watch.enrolled_at_ms) >= this.cfg.idleMs) this.membership(watch.mint, false);
      }
      for (let i = 0; i < 100 && this.queue.length && !this.stopped; i++) this.signal(this.queue.shift());
      for (const watch of this.paper.active()) {
        if (watch.status === 'watching' && this.paper.capacity().successfulBuys >= this.cfg.maxTrades &&
            !this.paper.pending().some(order => order.mint === watch.mint)) {
          this.store.run("UPDATE paper_watches SET status='stopped',reason='trade_cap' WHERE mint=?", watch.mint);
          this.unwatch(watch.mint); continue;
        }
        const row = this.states.get(watch.mint);
        if (!this.draining && watch.status === 'exit_blocked' && mandatoryExit(watch.reason) && row) {
          this.requestExit(watch.mint, row.state, watch.reason, null);
        }
      }
      if (this.draining && this.executor) {
        for (const position of this.store.all("SELECT mint FROM paper_positions WHERE status='open'")) {
          if (!this.paper.pending().some(order => order.mint === position.mint)) {
            this.liveExit(position.mint, 'timeout', 'shutdown_drain', { requestedAtMs: this.now() });
          }
        }
      }
      if (this.executor && this.submitted.size) await this.liveResolveUnknown();
      for (const order of this.paper.pending()) {
        if (this.stopped) break;
        if (this.submitted.has(order.id)) continue;
        // Live sends wait for confirmation; awaiting them here would block every other exit meanwhile.
        if (this.executor) this.reconcile(order).catch(() => this.paper.count('live:reconcile_error'));
        else await this.reconcile(order);
      }
    } finally { this.working = false; }
  }
  signal(raw) {
    if (this.stopped || this.agentMode) return;
    let prediction;
    this.paper.count('frames_processed');
    try { prediction = this.project(raw, this.states, this.cfg, (...args) => this.lookups.resolve(...args), this.now()); }
    catch (error) { this.paper.rejection(error.code ?? 'unsupported', error.details, this.now()); return; }
    this.paper.count('projections_decoded');
    const { signature, slot, mint, state: projected } = prediction;
    if (!this.paper.seen(signature, slot, this.now())) { this.paper.count('duplicate_signal'); return; }
    const reject = reason => this.paper.signal(signature, mint, reason);
    const row = this.states.get(mint), watch = this.paper.watch(mint);
    if (!row || !watch || !this.ready) return reject('not_ready');
    if (!watch.preprocessed || !this.feeds.covers(mint)) return reject('preprocessed_not_active');
    const slotAgeMs = this.now() - this.slotAt, reserveAgeMs = this.now() - row.at;
    const causes = [];
    if (slot < this.slot - 1) causes.push('slot_behind');
    if (slot > this.slot + 2) causes.push('slot_ahead');
    if (slotAgeMs > this.cfg.maxStateAgeMs) causes.push('slot_heartbeat_stale');
    if (reserveAgeMs > this.cfg.maxStateAgeMs) causes.push('reserve_stale');
    const { base } = prediction;
    const fallback = row.slot === slot && base?.model === 'isolated_prior_slot' &&
      Number.isSafeInteger(base.slot) && base.slot < slot && base.slot >= slot - (this.cfg.projectionWindowSlots ?? 5) + 1 &&
      Number.isFinite(base.at) && base.at <= this.now() && this.now() - base.at <= this.cfg.maxStateAgeMs;
    if (row.slot >= slot && !fallback) causes.push('already_applied');
    if (causes.length) {
      for (const cause of causes) this.paper.count(`stale:${cause}`);
      this.paper.signal(signature, mint, 'stale_or_already_executed', JSON.stringify({
        causes, signalSlot: slot, currentSlot: this.slot, reserveSlot: row.slot, slotAgeMs, reserveAgeMs,
      }));
      return;
    }
    if (fallback) this.paper.count('projection_prior_slot_fallback');
    const position = this.paper.position(mint);
    if (position) {
      if (mandatoryExit(watch.reason) || watch.reason === 'graduated_no_amm_exit') {
        this.requestExit(mint, row.state, watch.reason, null);
        return reject('mandatory_exit_pending');
      }
      this.requestExit(mint, projected, 'profit', {signature, slot, base, side: prediction.side});
      return reject('exit_prediction_checked');
    }
    if (watch.status !== 'watching' || !this.cfg.entriesEnabled || !this.paper.capacity().remaining) return reject('entries_disabled_or_cap');
    if (row.since > slot - this.cfg.windowSlots + 1) return reject(this.cfg.windowSlots === 5 ? 'insufficient_five_slot_history' : 'insufficient_window_history');
    const history = row.history.filter(h => h.slot >= slot - this.cfg.windowSlots + 1 && (fallback ? h.slot < slot : h.slot <= slot));
    if (!history.length) return reject('no_observed_peak');
    const peak = history.reduce((a, b) => higher(a.state, b.state) ? a : b), high = peak.state;
    const mc = cap(projected);
    if (!(mc > this.cfg.floorCap && mc < this.cfg.ceilingCap)) return reject('outside_buy_range');
    if (!meetsDrop(projected, high, this.cfg)) return reject('drop_below_threshold');
    try {
      const quote = entryQuote(projected, this.cfg);
      quote.entryQuality = entryQuality(projected, this.cfg);
      if (this.cfg.entryQualityEnabled && quote.entryQuality.rejection) {
        this.paper.signal(signature, mint, quote.entryQuality.rejection, JSON.stringify(quote.entryQuality)); return;
      }
      if (base) quote.projectionBase = base;
      quote.reference = { slot: slot - this.cfg.windowSlots + 1, virtualSol: high.virtualSol.toString(), virtualTokens: high.virtualTokens.toString() };
      const id = this.request(mint, 'buy', 'dump', quote, {signature, slot, side: prediction.side},
        { peakSlot: peak.slot, windowStartSlot: quote.reference.slot });
      reject(id ? 'buy_pending' : 'entry_blocked');
    } catch { reject('entry_quote_unavailable'); }
  }
  reconcile(order) {
    if (this.stopped) return Promise.resolve();
    if (this.reconciliations.has(order.id)) return this.reconciliations.get(order.id).promise;
    order = this.store.get("SELECT * FROM paper_orders WHERE id=? AND status='pending'", order.id);
    if (!order || this.expire(order)) return Promise.resolve();
    const generation = this.states.get(order.mint);
    if (!generation || (!this.ready && !mandatoryExit(order.reason))) return Promise.resolve();
    const limited = this.agentMode && order.side === 'sell' && mandatoryExit(order.reason);
    const active = { controller: new AbortController(), order, generation: { ...generation }, epoch: this.epoch,
      entryOrderId: limited ? this.paper.position(order.mint)?.entry_order_id : null,
      triggerRevision: this.agentMode && order.side === 'buy' ? JSON.parse(order.quote_json).triggerRevision : null,
      diagnostics: readOrderDiagnostics(order.diagnostics_json) ?? {} };
    this.reconciliations.set(order.id, active);
    active.promise = this.reconcileActive(order, active).finally(() => {
      // cancel() already ignores filled/canceled orders; failed exits wait for a new account event.
      if (limited) this.cancel(order.id, this.now(), 'awaiting_account_update');
      this.reconciliations.delete(order.id);
    });
    return active.promise;
  }
  /** Fast entry (live only): use the accepted post-confirmation reserves and the normal slippage guard. */
  async fastEntry(order, active) {
    const predicted = JSON.parse(order.quote_json);
    const watch = this.paper.watch(order.mint);
    if (!this.ready || !this.cfg.entriesEnabled || watch.status !== 'watching' || !this.feeds.covers(order.mint)) {
      this.cancel(order.id, this.now(), 'entries_paused'); return;
    }
    if (!this.agentFresh(order.mint, order.signal_slot)) { this.cancel(order.id, this.now(), 'coverage_or_state_stale'); return; }
    const reference = predicted.referenceReserves;
    const state = { ...this.states.get(order.mint).state,
      ...Object.fromEntries(Object.entries(reference).map(([key, value]) => [key, BigInt(value)])) };
    const budget = BigInt(predicted.requestedBudgetLamports);
    const quote = entryQuote(state, this.cfg, budget);
    quote.entryQuality = entryQuality(state, this.cfg, budget);
    if (this.cfg.entryQualityEnabled && quote.entryQuality.rejection) { this.cancel(order.id, this.now(), quote.entryQuality.rejection); return; }
    Object.assign(quote, { requestedBudgetLamports: budget.toString(), triggerRevision: predicted.triggerRevision,
      eventIndex: predicted.eventIndex, referenceReserves: reference, slot: order.signal_slot, model: 'live_fast_entry_event_reserves' });
    this.diagnose(order, { stage: 'ready_to_fill', requestedBudgetLamports: budget.toString(),
      currentRealSolLamports: state.realSol.toString(), exposureLamports: this.paper.exposure().total.toString() });
    if (!this.current(order, active)) return;
    // The SDK quotes from a curve account; rebuild one from the event reserves on the cached account layout.
    await this.liveFill(order, quote, active, this.eventCurveAccount(order.mint, reference));
  }
  /** The last observed curve account with its reserve fields replaced by the event's post-trade reserves. */
  eventCurveAccount(mint, reserves) {
    const account = this.states.get(mint)?.account;
    if (!account) return null;
    const bytes = Buffer.from(account.data[0], 'base64');
    bytes.writeBigUInt64LE(BigInt(reserves.virtualTokens), 8); bytes.writeBigUInt64LE(BigInt(reserves.virtualSol), 16);
    bytes.writeBigUInt64LE(BigInt(reserves.realTokens), 24); bytes.writeBigUInt64LE(BigInt(reserves.realSol), 32);
    return { ...account, data: [bytes.toString('base64'), 'base64'] };
  }
  async reconcileActive(order, active) {
    const { generation, controller } = active;
    try {
      let executedSlot = null;
      if (!this.current(order, active)) return;
      if (this.executor && this.cfg.fastEntry && this.agentMode && order.side === 'buy') { await this.fastEntry(order, active); return; }
      if (order.signal_signature) {
        this.diagnose(order, { stage: 'status_pending', statusAttempts: (active.diagnostics.statusAttempts ?? 0) + 1 });
        active.waitKind = 'status'; active.waitAt = this.now();
        const result = await this.rpc.call('getSignatureStatuses', [[order.signal_signature], { searchTransactionHistory: false }],
          { deadlineMs: order.expires_at_ms, signal: controller.signal });
        if (!this.current(order, active)) return;
        const timing = this.timing(order, active); active.waitKind = null;
        const status = result?.value?.[0];
        const confirmationStatus = ['processed', 'confirmed', 'finalized'].includes(status?.confirmationStatus) ? status.confirmationStatus : 'unknown';
        this.diagnose(order, { ...timing, confirmationStatus, executedSlot: status?.slot });
        if (!status) { this.paper.count('status_pending'); return; }
        if (status.err === undefined) {
          this.diagnose(order, { stage: 'status_invalid' }); this.paper.count('status_invalid'); return;
        }
        if (status.err !== null) {
          this.diagnose(order, { stage: 'status_failed', failure: transactionFailure(status.err) });
          this.cancel(order.id, this.now(), 'trigger_failed'); return;
        }
        if (!Number.isSafeInteger(status.slot) || status.slot < 0) {
          this.diagnose(order, { stage: 'status_invalid' }); this.paper.count('status_invalid'); return;
        }
        if (!['confirmed', 'finalized'].includes(status.confirmationStatus)) {
          this.diagnose(order, { stage: 'status_unconfirmed' }); this.paper.count('status_unconfirmed'); return;
        }
        executedSlot = status.slot;
        this.diagnose(order, { stage: 'status_confirmed' });
        if (executedSlot !== order.signal_slot) { this.cancel(order.id, this.now(), 'trigger_slot_changed'); return; }
      }
      if (!this.current(order, active)) return;
      const watch = this.paper.watch(order.mint);
      this.diagnose(order, { stage: 'account_pending', accountAttempts: (active.diagnostics.accountAttempts ?? 0) + 1 });
      active.waitKind = 'account'; active.waitAt = this.now();
      const observationRevision = this.states.get(order.mint)?.revision;
      const snapshot = await this.rpc.accounts([watch.curve_address],
        { commitment: 'confirmed', deadlineMs: order.expires_at_ms, signal: controller.signal });
      if (!this.current(order, active)) return;
      const timing = this.timing(order, active); active.waitKind = null;
      const slot = snapshot?.context?.slot;
      const predicted = JSON.parse(order.quote_json);
      const observationSlot = Number.isSafeInteger(predicted.observationSlot) ? predicted.observationSlot : 0;
      const requiredSlot = Math.max(executedSlot ?? 0, generation.slot, this.states.get(order.mint).slot, observationSlot);
      this.diagnose(order, { ...timing, snapshotSlot: slot, requiredSlot });
      if (!Number.isSafeInteger(slot) || slot < requiredSlot) {
        this.diagnose(order, { stage: 'snapshot_behind' }); this.paper.count('snapshot_behind'); return;
      }
      if (this.agentMode && order.side === 'buy' && slot >= order.signal_slot + this.cfg.signalValiditySlots) {
        this.cancel(order.id, this.now(), 'signal_expired', { expiryCause: 'slot', snapshotSlot: slot }); return;
      }
      const latest = this.states.get(order.mint);
      if (this.agentMode && latest.revision !== observationRevision && slot <= latest.slot) {
        this.paper.count('agent:snapshot_observation_changed');
        this.diagnose(order, { stage: 'snapshot_changed' }); return;
      }
      const { state, code, subtype } = validateAccount(snapshot.value?.[0]);
      if (code) { this.invalidateAccount(order.mint, slot, snapshot.value?.[0], code, subtype); return; }
      if (state.complete) {
        this.cancel(order.id, this.now(), 'graduated');
        this.store.run('UPDATE paper_watches SET status=?,reason=? WHERE mint=?',
          this.paper.position(order.mint) ? 'exit_blocked' : 'stopped', 'graduated_no_amm_exit', order.mint);
        if (this.terminalExits && this.writeOff(order.mint, 'graduated_no_amm_exit', 'graduated_no_amm_exit', { observedSlot: slot })) return;
        this.unwatch(order.mint); return;
      }
      const mc = cap(state);
      if (!this.agentMode && mc <= this.cfg.floorCap && order.side === 'buy') {
        this.cancel(order.id, this.now(), 'floor');
        this.store.run("UPDATE paper_watches SET status='stopped',reason='floor' WHERE mint=?", order.mint);
        this.unwatch(order.mint); return;
      }
      let quote;
      if (order.side === 'buy') {
        if (!this.ready || !this.cfg.entriesEnabled || watch.status !== 'watching' ||
            (!this.agentMode && !watch.preprocessed) || !this.feeds.covers(order.mint)) {
          this.cancel(order.id, this.now(), 'entries_paused'); return;
        }
        let budget = BigInt(this.cfg.buyLamports);
        if (this.agentMode) {
          if (!this.agentFresh(order.mint, order.signal_slot)) { this.cancel(order.id, this.now(), 'coverage_or_state_stale'); return; }
          budget = BigInt(predicted.requestedBudgetLamports);
          this.diagnose(order, { currentRealSolLamports: state.realSol.toString(), requestedBudgetLamports: budget.toString(),
            exposureLamports: this.paper.exposure().total.toString(), triggerToFillSlots: Math.max(0, slot - order.signal_slot) });
          if (state.realSol < BigInt(this.cfg.minRealSolLamports) || budget > liquidityBudget(state.realSol, this.cfg)) {
            this.cancel(order.id, this.now(), 'liquidity_budget_changed'); return;
          }
        } else {
          const reference = { virtualSol: BigInt(predicted.reference.virtualSol), virtualTokens: BigInt(predicted.reference.virtualTokens) };
          const rangePassed = mc > this.cfg.floorCap && mc < this.cfg.ceilingCap;
          const dropPassed = meetsDrop(state, reference, this.cfg);
          const dropBps = Number((reference.virtualSol * state.virtualTokens - state.virtualSol * reference.virtualTokens) * 10000n /
            (reference.virtualSol * state.virtualTokens));
          this.diagnose(order, { marketCapSol: mc, dropBps, rangePassed, dropPassed,
            floorCapSol: this.cfg.floorCap, ceilingCapSol: this.cfg.ceilingCap, requiredDropBps: this.cfg.dropBps });
          if (!rangePassed || !dropPassed) {
            this.diagnose(order, { stage: 'entry_rejected' });
            this.cancel(order.id, this.now(), 'entry_condition_changed'); return;
          }
        }
        quote = entryQuote(state, this.cfg, budget);
        quote.entryQuality = entryQuality(state, this.cfg, budget);
        if (this.agentMode) Object.assign(quote, { requestedBudgetLamports: budget.toString(),
          triggerRevision: predicted.triggerRevision, eventIndex: predicted.eventIndex, referenceReserves: predicted.referenceReserves,
          confirmedReserves: Object.fromEntries(['realSol', 'realTokens', 'virtualSol', 'virtualTokens'].map(key => [key, state[key].toString()])) });
        if (this.cfg.entryQualityEnabled && quote.entryQuality.rejection) {
          this.cancel(order.id, this.now(), quote.entryQuality.rejection); return;
        }
        if (BigInt(quote.tokens) * 10000n < BigInt(predicted.tokens) * BigInt(10000 - this.cfg.buySlippageBps)) {
          this.cancel(order.id, this.now(), 'buy_slippage'); return;
        }
      } else {
        const position = this.paper.position(order.mint);
        if (!position) { this.cancel(order.id, this.now(), 'no_position'); return; }
        const intent = this.exitIntent(order.mint, state);
        if (intent) {
          // Retain the confirmed trigger as the latest observation, including a drained pool.
          // Otherwise a retry could quote an older streamed state after this order is canceled.
          this.onAccount(order.mint, slot, snapshot.value[0], 'rpc');
          if (this.paper.watch(order.mint).account_error) return;
          this.latchExit(order.mint, intent);
          if (intent !== order.reason) {
            this.requestExit(order.mint, state, intent, null, { state, slot, at: this.now() }); return;
          }
        }
        quote = this.terminalExits && mandatoryExit(order.reason) ? terminalExitQuote(state, position, this.cfg) : exitQuote(state, position, this.cfg);
        if (order.reason === 'profit' && !profitable(quote, position, this.cfg)) { this.cancel(order.id, this.now(), 'profit_disappeared'); return; }
        // Terminal mandatory liquidation accepts the recovery supported by this confirmed snapshot.
        if (!quote.terminalOutcome && BigInt(quote.net) * 10000n < BigInt(predicted.net) * BigInt(10000 - this.cfg.sellSlippageBps)) {
          this.cancel(order.id, this.now(), 'sell_slippage'); return;
        }
      }
      quote.slot = slot;
      quote.model ??= order.reason === 'floor' ? 'hypothetical_floor_fill_confirmed_state' :
        order.signal_signature ? 'hypothetical_fill_after_confirmed_trigger' : 'hypothetical_fill_confirmed_state';
      if (!this.current(order, active)) return;
      this.diagnose(order, { stage: 'ready_to_fill' });
      if (this.agentMode && order.side === 'buy') {
        // The holding must never be evaluated against an older pre-entry observation.
        this.onAccount(order.mint, slot, snapshot.value[0], 'rpc');
        if (!this.current(order, active)) return;
      }
      if (this.executor) { await this.liveFill(order, quote, active, order.side === 'buy' ? snapshot.value[0] : null); return; }
      this.paper.fill(order, quote, this.now());
      if (order.side === 'sell') this.unwatch(order.mint);
    } catch {
      // An expected abort or deadline must not become a provider failure, or touch terminal evidence.
      if (!this.current(order, active)) return;
      const timing = this.timing(order, active); active.waitKind = null;
      this.diagnose(order, { ...timing, lastStage: active.diagnostics.stage, stage: 'unavailable' });
      this.paper.count('reconciliation_unavailable');
    }
  }

  // ---- live execution ----
  // Live: chain results settle submitted orders. Dry run: buys are simulated against the real chain and, when the
  // simulation passes, recorded at the modeled quote; sells are built (curve read + instructions) but cannot be
  // simulated without real tokens, so they are recorded at the modeled quote too. Dry-run orders never become `submitted`.
  liveBackoff(mint) {
    const entry = this.liveExitFailures.get(mint);
    return entry && this.now() < entry.until ? entry : null;
  }
  liveExitFailed(mint, code) {
    const failures = (this.liveExitFailures.get(mint)?.failures ?? 0) + 1;
    const delay = Math.min(60000, 2000 * 2 ** Math.min(failures - 1, 5));
    const entry = { failures, until: this.now() + delay, at: this.now(), code };
    this.liveExitFailures.set(mint, entry);
    this.store.run(`INSERT INTO live_exit_failures(mint,failures,last_code,last_at_ms,retry_at_ms) VALUES(?,?,?,?,?)
      ON CONFLICT(mint) DO UPDATE SET failures=excluded.failures,last_code=excluded.last_code,
      last_at_ms=excluded.last_at_ms,retry_at_ms=excluded.retry_at_ms`, mint, failures, code, entry.at, entry.until);
    if (failures === 10) {
      this.liveHalt('exit_failing');
      const tokens = this.paper.position(mint)?.tokens_raw ?? null;
      this.paper.manualAction(mint, 'exit_failing', { failures, code, tokens }, this.now());
      this.log(JSON.stringify({ event: 'live_manual_action', mint, reason: 'exit_failing', failures, lastError: code,
        note: 'Exits keep retrying every 60 s; check the curve and sell manually if needed.' }));
    }
    this.paper.count('live:exit_retry_backoff');
    return entry;
  }
  /** Confirmed on-chain result -> recorded quote. Refundable token-account rent is excluded on both sides, so
   * PnL and profit targets compare like with like; the tip, priority and base fees are real costs and included. */
  liveQuote(order, modeled, result) {
    const base = { model: 'live_fill', slot: result.slot, signature: result.signature,
      modeled: { cost: modeled.cost ?? null, net: modeled.net ?? null, tokens: modeled.tokens ?? null, slot: modeled.slot ?? null },
      ...(modeled.burnOnly ? { executionMode: 'burn_only' } : {}),
      solDeltaLamports: result.lamports.toString(), ataLamports: result.ataLamports.toString(),
      transactionFeeLamports: result.fee.toString(), tokensDelta: result.tokens.toString(),
      tokenProgram: result.tokenProgram ?? null };
    if (order.side === 'buy') {
      return { ...base, tokens: result.tokens.toString(), cost: (-(result.lamports + result.ataLamports)).toString(),
        requestedBudgetLamports: modeled.requestedBudgetLamports };
    }
    // tokensDelta covers sold + burned tokens; record how many were burned so the split is visible.
    return { ...base, tokens: (-result.tokens).toString(), gross: modeled.gross ?? null,
      net: (result.lamports + result.ataLamports).toString(),
      ...(result.burnedTokens && result.burnedTokens !== '0' ? { soldTokens: result.soldTokens, burnedTokens: result.burnedTokens } : {}) };
  }
  async liveTokenProgram(mint) {
    const position = this.paper.position(mint);
    const entry = position && this.store.get('SELECT fill_json FROM paper_orders WHERE id=?', position.entry_order_id);
    const saved = entry?.fill_json ? JSON.parse(entry.fill_json).tokenProgram : null;
    return saved || this.executor.mintTokenProgram(mint);
  }
  /** Build and sign (no network send). Returns a prepared transaction or { status: 'no_tokens' }. */
  async liveBuild(order, modeled, confirmed = null) {
    if (order.side === 'buy') return this.executor.prepareBuy(order.mint, BigInt(modeled.requestedBudgetLamports), this.cfg.buySlippageBps, confirmed);
    const position = this.paper.position(order.mint);
    if (!position) throw new Error('no_position');
    const owned = BigInt(position.tokens_raw);
    let tokens = owned, close = true;
    if (!this.dryRun) {
      const held = await this.executor.tokenBalance(order.mint, await this.liveTokenProgram(order.mint));
      if (held <= 0n) return { status: 'no_tokens' };
      // Sell only what this trial bought; keep (and do not close) any balance it did not open.
      if (held < owned) tokens = held;
      else if (held > owned) close = false;
    }
    // First attempt sells everything. Once a sale of this position has failed on-chain, retries sell what the curve
    // can pay and burn the remainder in the same transaction (closing the account), so no tokens are left behind.
    const mode = this.liveExitFailures.get(order.mint)?.failures ? 'capped' : 'full';
    // LIVE_FORCE_SELL: zero minimum, so the first sell lands whatever the price. Otherwise profit exits keep the
    // modeled minimum and mandatory exits take a fresh quote with a wider tolerance.
    const min = this.cfg.live.forceSell ? 0n
      : order.reason === 'profit' ? BigInt(modeled.net) * BigInt(10000 - this.cfg.sellSlippageBps) / 10000n : null;
    return this.executor.prepareSell(order.mint, tokens, min !== null && min < 0n ? 0n : min, close, this.cfg.live.exitSlippageBps, mode);
  }
  /** Opt-in zero-recovery fallback. It never burns tokens that exceed this trial's recorded position. */
  async liveBurnBuild(order) {
    const position = this.paper.position(order.mint);
    if (!position) throw new Error('no_position');
    const program = await this.liveTokenProgram(order.mint);
    const held = await this.executor.tokenBalance(order.mint, program);
    if (held <= 0n) return { status: 'no_tokens' };
    const owned = BigInt(position.tokens_raw);
    if (held > owned) throw new Error('foreign_balance_present');
    return this.executor.prepareBurnClose(order.mint, held, program);
  }
  async liveFill(order, modeled, active, confirmed = null) {
    if (order.side === 'sell' && this.liveBackoff(order.mint)) { this.cancel(order.id, this.now(), 'live_exit_backoff'); return; }
    if (order.side === 'buy') {
      if (this.liveBuying.size >= (this.cfg.live.maxBuysInFlight ?? 1)) { this.cancel(order.id, this.now(), 'live_buy_in_flight'); return; }
      this.liveBuying.add(order.id);
    }
    try { await this.liveFillUnlocked(order, modeled, active, confirmed); }
    finally { this.liveBuying.delete(order.id); }
  }
  async liveFillUnlocked(order, modeled, active, confirmed) {
    // Checks and the (send-free) build run together: every RPC here delays the send inside a ~5-slot signal window.
    const [blocked, initialBuild] = await Promise.all([
      order.side === 'buy' ? this.liveBuyBlocked(order, BigInt(modeled.requestedBudgetLamports)) : null,
      this.liveBuild(order, modeled, confirmed).then(value => ({ value }), error => ({ error })),
    ]);
    if (blocked) { this.cancel(order.id, this.now(), blocked); return; }
    if (order.side === 'buy' && !this.current(order, active)) return;
    let built = initialBuild;
    // A mandatory exit gets one on-demand refresh and rebuild before it contributes to the durable failure count.
    if (built.error && order.side === 'sell' && mandatoryExit(order.reason) && this.executor.refreshExitState) {
      try {
        await this.executor.refreshExitState();
        built = await this.liveBuild(order, modeled, confirmed).then(value => ({ value }), error => ({ error }));
      } catch (error) { built = { error }; }
    }
    let prepared = built.value;
    if (built.error) {
      const error = built.error;
      // Nothing was signed for broadcast: safe to cancel.
      let code = buildFailureCode(error), failure = null;
      if (order.side === 'sell') failure = this.liveExitFailed(order.mint, code);
      const threshold = Number(this.cfg.live.burnOnlyAfterFailures ?? 0);
      if (order.side === 'sell' && mandatoryExit(order.reason) && threshold > 0 && failure.failures >= threshold) {
        try {
          prepared = await this.liveBurnBuild(order);
          if (prepared.status !== 'no_tokens') {
            modeled = { ...modeled, model: 'live_burn_only', burnOnly: true, net: '0' };
            this.diagnose(order, { stage: 'ready_to_fill', liveError: code });
          }
        } catch (burnError) {
          code = buildFailureCode(burnError);
          prepared = null;
          if (failure.failures === threshold) this.paper.manualAction(order.mint, 'burn_only_failed', {
            failures: failure.failures, code, tokens: this.paper.position(order.mint)?.tokens_raw ?? null,
          }, this.now());
        }
      }
      if (!prepared) {
        this.cancel(order.id, this.now(), 'live_build_failed', { liveError: code });
        return;
      }
    }
    if (prepared.status === 'no_tokens') { this.liveNoTokens(order); return; }
    // A gap, stop, expiry or supersede during the build cancels the order: then nothing may be sent or recorded.
    if (this.stopped || !this.store.get("SELECT 1 FROM paper_orders WHERE id=? AND status='pending'", order.id)) return;
    if (order.side === 'buy' && !this.current(order, active)) return;
    if (this.dryRun) { await this.liveDryRun(order, modeled, prepared); return; }
    // Persist the signature BEFORE anything leaves the process: after a crash it is resolved from chain, never canceled.
    this.submitted.add(order.id);
    this.diagnose(order, { stage: 'live_submitted', liveSubmittedAtMs: this.now(), liveSignature: prepared.signature,
      liveTokenProgram: prepared.tokenProgram, liveLastValidBlockHeight: prepared.lastValidBlockHeight });
    let result;
    try { result = await this.executor.submit(prepared); }
    catch { result = { signature: prepared.signature, status: 'unknown' }; }
    await this.liveSettle(order, modeled, { tokenProgram: prepared.tokenProgram, soldTokens: prepared.soldTokens,
      burnedTokens: prepared.burnedTokens, ...result });
  }
  async liveDryRun(order, modeled, prepared) {
    let simulation = null;
    if (order.side === 'buy') {
      const result = await this.executor.submit(prepared);
      const error = result.simulationError;
      this.log(JSON.stringify({ event: 'live_dry_run', side: 'buy', mint: order.mint, ok: error == null, unitsConsumed: result.unitsConsumed,
        simulationError: error == null ? undefined : JSON.stringify(error).slice(0, 200) }));
      if (error != null) {
        const failure = transactionFailure(typeof error === 'string' || typeof error === 'object' ? error : 'Unknown');
        this.diagnose(order, { stage: 'status_failed', failure, liveStatus: 'simulated' });
        this.cancel(order.id, this.now(), 'live_simulation_failed');
        return;
      }
      simulation = { unitsConsumed: result.unitsConsumed ?? null };
      if (Number.isSafeInteger(result.unitsConsumed)) this.diagnose(order, { liveUnitsConsumed: result.unitsConsumed });
    } else this.log(JSON.stringify({ event: 'live_dry_run', side: 'sell', reason: order.reason, mint: order.mint, built: true,
      note: 'Sell built but not simulated (dry-run wallet holds no tokens); recorded at the modeled quote.' }));
    this.diagnose(order, { liveStatus: 'simulated' });
    const quote = { ...modeled, dryRun: { simulatedBuy: order.side === 'buy', simulation, tokenProgram: prepared.tokenProgram } };
    if (this.paper.fill(order, quote, this.now()) && order.side === 'sell') { this.unwatch(order.mint); this.liveCheckLoss(); }
  }
  liveNoTokens(order) {
    // The wallet no longer holds this position's tokens (sold or moved outside this trial). Assume they are gone:
    // close the position at zero recovery, unsubscribe, and keep trading. No SOL from that sale reached this trial's
    // books, so the full entry cost counts as a loss, which keeps LIVE_MAX_LOSS_SOL conservative.
    this.cancel(order.id, this.now(), 'live_no_tokens');
    const closed = this.liveCloseMissing(order.mint, 'sell_without_tokens');
    this.unwatch(order.mint);
    this.liveCheckLoss();
    this.log(JSON.stringify({ event: 'live_external_exit', mint: order.mint, reason: 'position_without_wallet_tokens', closed,
      note: 'Tokens missing from the wallet; position closed at zero recovery and the mint unsubscribed. Trading continues.' }));
  }
  /** Close an open position whose tokens left the wallet outside this trial, at zero recovery. Returns true if closed. */
  liveCloseMissing(mint, cause) {
    return this.store.atomic(() => {
      const position = this.paper.position(mint);
      if (!position) return false;
      const at = this.now();
      const quote = { model: 'live_external_exit', note: 'Tokens left the wallet outside this trial; recorded at zero recovery.',
        cause, tokens: position.tokens_raw, net: '0', entryOrderId: position.entry_order_id };
      const id = Number(this.store.run(`INSERT INTO paper_orders (mint,side,status,created_at_ms,expires_at_ms,reason,quote_json,
          assumptions_json,settled_at_ms,fill_json,diagnostics_json) VALUES(?,'sell','filled',?,?,'external_exit',?,?,?,?,?)`,
        mint, at, at, JSON.stringify(quote), JSON.stringify(this.cfg), at, JSON.stringify(quote),
        JSON.stringify({ stage: 'filled', liveStatus: 'ok' })).lastInsertRowid);
      this.store.run(`UPDATE paper_positions SET status='closed',exit_order_id=?,closed_at_ms=?,exit_net_lamports='0',pnl_lamports=?
        WHERE mint=? AND status='open'`, id, at, (-BigInt(position.entry_cost_lamports)).toString(), mint);
      this.store.run("UPDATE paper_watches SET status='closed',reason='external_exit' WHERE mint=?", mint);
      this.store.run('DELETE FROM live_exit_failures WHERE mint=?', mint);
      this.liveExitFailures.delete(mint);
      this.paper.resolveManualActions(mint, cause, at);
      this.paper.count('live:external_exit');
      return true;
    });
  }
  async liveSettle(order, modeled, result) {
    const record = { liveSignature: result.signature ?? undefined, liveStatus: result.status };
    if (result.status === 'ok') {
      if (order.side === 'buy' && result.tokens <= 0n) {
        // SOL left the wallet without tokens arriving: impossible for a curve buy, so stop and ask for a human.
        this.submitted.delete(order.id);
        this.cancel(order.id, this.now(), 'live_buy_without_tokens', record);
        this.liveHalt('buy_without_tokens');
        this.paper.manualAction(order.mint, 'buy_without_tokens', {}, this.now());
        this.log(JSON.stringify({ event: 'live_manual_action', mint: order.mint, signature: result.signature, reason: 'buy_without_tokens' }));
        return;
      }
      let recorded = false;
      try {
        const quote = this.liveQuote(order, modeled, result);
        this.diagnose(order, { ...record, stage: 'live_filled' });
        // A confirmed fill is a fact: modeled exposure limits cannot veto recording it.
        recorded = this.paper.fill(order, quote, this.now(), { live: true });
      } catch { recorded = false; }
      if (!recorded) {
        // Keep it submitted: the next tick re-resolves the signature and retries recording; no new entries meanwhile.
        this.diagnose(order, { ...record, stage: 'live_unknown' });
        this.liveHalt('record_failed');
        this.log(JSON.stringify({ event: 'live_record_failed', side: order.side, mint: order.mint, signature: result.signature }));
        return;
      }
      this.submitted.delete(order.id); this.liveExitFailures.delete(order.mint);
      this.store.run('DELETE FROM live_exit_failures WHERE mint=?', order.mint);
      this.log(JSON.stringify({ event: 'live_fill', side: order.side, reason: order.reason, mint: order.mint,
        signature: result.signature, solDelta: result.lamports.toString(), tokens: result.tokens.toString() }));
      if (order.side === 'sell') {
        this.paper.resolveManualActions(order.mint, modeled.burnOnly ? 'burn_only_confirmed' : 'exit_confirmed', this.now());
        this.unwatch(order.mint); this.liveCheckLoss();
        // A partial liquidation (or a balance this trial did not open) leaves tokens behind: report, never track.
        if (result.burnedTokens && result.burnedTokens !== '0') {
          this.paper.count('live:sell_and_burn');
          this.log(JSON.stringify({ event: 'live_sell_and_burn', mint: order.mint, soldTokens: result.soldTokens,
            burnedTokens: result.burnedTokens, note: 'Curve could not pay for the whole position: sold the payable part, burned the rest.' }));
        }
        if (typeof result.postTokens === 'bigint' && result.postTokens > 0n) {
          this.liveForeign.add(order.mint);
          this.paper.manualAction(order.mint, 'residual_tokens_after_exit', { tokens: result.postTokens.toString() }, this.now());
          this.log(JSON.stringify({ event: 'live_manual_action', mint: order.mint, reason: 'residual_tokens_after_exit',
            tokens: result.postTokens.toString(), note: 'Position closed; the remaining tokens are excluded from entries.' }));
        }
      }
      return;
    }
    if (['rejected', 'failed'].includes(result.status)) {
      this.submitted.delete(order.id);
      // A failed transaction that landed still paid its base, priority and tip: real, unrecoverable cost.
      if (result.status === 'failed' && typeof result.lamports === 'bigint' && result.lamports < 0n) {
        this.liveAddCost(-(result.lamports + (result.ataLamports ?? 0n)));
      }
      if (order.side === 'sell') {
        const first = !this.liveExitFailures.get(order.mint)?.failures;
        this.liveExitFailed(order.mint, `live_${result.status}`);
        // The first failed full sale is retried immediately as a capped sale + burn, not after a backoff.
        if (first && result.status === 'failed') this.liveExitFailures.get(order.mint).until = 0;
      }
      this.cancel(order.id, this.now(), `live_${result.status}`, { ...record,
        ...(Number.isSafeInteger(result.errorCode) ? { liveErrorCode: result.errorCode } : {}),
        ...(result.err ? { failure: transactionFailure(result.err) } : {}) });
      return;
    }
    // Unknown: may still land. Keep it pending and blocked; tick() re-resolves it from chain.
    this.diagnose(order, { ...record, stage: 'live_unknown' });
    this.store.run('UPDATE paper_orders SET expires_at_ms=? WHERE id=?', Number.MAX_SAFE_INTEGER, order.id);
    this.paper.count('live:unknown');
  }
  /** Re-resolve unknown submissions from chain (signature status + balances), at most every 2 s per order. */
  async liveResolveUnknown() {
    for (const order of this.paper.pending()) {
      if (this.stopped) return;
      if (!this.submitted.has(order.id) || this.reconciliations.has(order.id)) continue;
      if (this.now() < (this.liveResolveAt.get(order.id) ?? 0)) continue;
      this.liveResolveAt.set(order.id, this.now() + 2000);
      const diag = readOrderDiagnostics(order.diagnostics_json) ?? {};
      if (!diag.liveSignature) {
        // Crashed between marking and persisting a signature: nothing could have been broadcast.
        this.submitted.delete(order.id); this.cancel(order.id, this.now(), 'live_never_signed'); continue;
      }
      // Height first: if the signature is still unseen afterwards, it can never land.
      const height = Number.isSafeInteger(diag.liveLastValidBlockHeight)
        ? await this.executor.blockHeight().catch(() => null) : null;
      const result = await this.executor.resolve(diag.liveSignature, order.mint).catch(() => ({ status: 'unknown' }));
      if (result.status === 'unknown') {
        // A signature the cluster has seen may already have landed: keep resolving it, never expire it.
        const expired = !result.seen && (height != null ? height > diag.liveLastValidBlockHeight
          : this.now() - (diag.liveSubmittedAtMs ?? 0) > 150000);
        if (expired) {
          this.submitted.delete(order.id); this.liveResolveAt.delete(order.id);
          if (order.side === 'sell') this.liveExitFailed(order.mint, 'live_expired_unseen');
          this.cancel(order.id, this.now(), 'live_expired_unseen', { liveSignature: diag.liveSignature });
        }
        continue;
      }
      this.liveResolveAt.delete(order.id);
      await this.liveSettle(order, JSON.parse(order.quote_json), { ...result, tokenProgram: diag.liveTokenProgram });
    }
  }
  async liveBuyBlocked(order, budget) {
    if (this.draining) return 'live_shutdown_draining';
    if (this.liveHalted) return `live_halted_${this.liveHalted}`;
    if (this.liveForeign.has(order.mint)) return 'live_foreign_holding';
    // At most LIVE_MAX_BUYS_IN_FLIGHT live buys at once (default 1, which keeps wallet and exposure checks exact).
    const limit = this.cfg.live.maxBuysInFlight ?? 1;
    const inFlight = new Set([...this.liveBuying].filter(id => id !== order.id));
    for (const id of this.submitted) if (id !== order.id && this.store.get('SELECT side FROM paper_orders WHERE id=?', id)?.side === 'buy') inFlight.add(id);
    if (inFlight.size >= limit) return 'live_buy_in_flight';
    // Worst case: every open position and this buy go to zero, after paying the buy's and every exit's overhead.
    // The buy budget is a hard cap on swap SOL (executor), so this bound is exact up to the priority-fee ceiling.
    const openCount = BigInt(this.store.get("SELECT COUNT(*) n FROM paper_positions WHERE status='open'").n);
    const overhead = this.executor.maxOverheadLamports('buy') + (openCount + 1n) * this.executor.maxOverheadLamports('sell');
    const worst = -this.liveRealizedLamports() + this.paper.exposure(order.id).open + budget + overhead;
    if (worst > BigInt(this.cfg.live.maxLossLamports)) return 'live_loss_budget';
    // Other buys in flight have not settled yet: count their budgets against the loss and wallet limits too.
    const pendingBudgets = [...inFlight].reduce((sum, id) => {
      const row = this.store.get('SELECT quote_json FROM paper_orders WHERE id=?', id);
      return sum + (row ? BigInt(JSON.parse(row.quote_json).requestedBudgetLamports ?? 0) : 0n);
    }, 0n);
    if (pendingBudgets && worst + pendingBudgets > BigInt(this.cfg.live.maxLossLamports)) return 'live_loss_budget';
    let balance;
    if (this.cfg.live.checkBalancePerBuy === false) {
      balance = this.executor.balanceCached?.() ?? null;
      if (balance == null) return 'live_balance_unavailable';
      balance -= pendingBudgets;
    } else {
      try { balance = await this.executor.balance(); } catch { return 'live_balance_unavailable'; }
      balance -= pendingBudgets;
    }
    const reserve = budget + BigInt(this.cfg.live.perTradeReserveLamports);
    if (balance - reserve < BigInt(this.cfg.live.minWalletLamports)) { this.liveHalt('wallet_floor'); return 'live_wallet_floor'; }
    return null;
  }
  liveRealizedLamports() {
    const failed = BigInt(this.store.get("SELECT value FROM metadata WHERE key='live_failed_tx_cost_lamports'")?.value ?? '0');
    return this.store.all("SELECT pnl_lamports FROM paper_positions WHERE status='closed' AND pnl_lamports IS NOT NULL")
      .reduce((sum, row) => sum + BigInt(row.pnl_lamports), 0n) - failed;
  }
  /** Persisted, so failed-transaction fees count toward LIVE_MAX_LOSS_SOL across restarts. */
  liveAddCost(lamports) {
    if (lamports <= 0n) return;
    const key = 'live_failed_tx_cost_lamports';
    const total = BigInt(this.store.get('SELECT value FROM metadata WHERE key=?', key)?.value ?? '0') + lamports;
    this.store.run('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, total.toString());
    this.liveCheckLoss();
  }
  liveCheckLoss() {
    if (-this.liveRealizedLamports() >= BigInt(this.cfg.live.maxLossLamports)) this.liveHalt('max_loss');
  }
  liveHalt(reason) {
    if (this.liveHalted) return;
    this.liveHalted = reason; this.paper.count(`live:halted:${reason}`);
    // Persisted: a restart must not silently resume entries after a halt that needs a human.
    this.store.run("INSERT INTO metadata VALUES('live_halted',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", reason);
    this.log(JSON.stringify({ event: 'live_entries_halted', reason, note: 'Open positions still exit normally.' }));
  }
  /** Live mandatory exit: a real full sale at whatever a fresh quote supports (within LIVE_EXIT_SLIPPAGE_BPS). */
  liveExit(mint, reason, cause, evidence) {
    if (cause === 'graduated_no_amm_exit') {
      this.store.run("UPDATE paper_watches SET status='stopped',reason='graduated_live_unsellable' WHERE mint=?", mint);
      const position = this.paper.position(mint);
      if (position) {
        const recorded = this.paper.manualAction(mint, 'graduated_held_tokens', {
          tokens: position.tokens_raw,
          detail: { observed_slot: Number.isSafeInteger(evidence?.observedSlot) ? evidence.observedSlot : null },
        }, this.now());
        if (recorded) {
          this.paper.count('live:graduated_unsellable');
          this.log(JSON.stringify({ event: 'live_manual_action', mint, reason: 'graduated_held_tokens',
            tokens: position.tokens_raw, note: 'Curve completed; sell on PumpSwap manually.' }));
        }
      }
      this.unwatch(mint);
      return true;
    }
    if (this.stopped || this.paper.pending().some(order => order.mint === mint) || this.liveBackoff(mint)) return false;
    const id = this.request(mint, 'sell', reason, { net: '0', model: 'live_mandatory_full_sale', liveCause: cause, evidence }, null);
    if (!id) return false;
    const order = this.store.get('SELECT * FROM paper_orders WHERE id=?', id);
    const active = { controller: new AbortController(), order, epoch: this.epoch, diagnostics: {} };
    this.reconciliations.set(id, active);
    active.promise = this.liveFill(order, JSON.parse(order.quote_json), active)
      .catch(() => { this.paper.count('live:exit_error'); this.liveExitFailed(mint, 'exit_error'); })
      .finally(() => this.reconciliations.delete(id));
    return false;
  }
  /** Reconcile this database with current wallet ownership without sending an order. */
  async liveReconcileWallet({ allowForeign = true } = {}) {
    if (this.dryRun) return { held: 0, closedMissing: [], foreign: [] };
    const held = await this.executor.heldMints();
    const owned = new Set(this.store.all("SELECT mint FROM paper_positions WHERE status='open'").map(row => row.mint));
    // A sell or buy that may have landed before a crash is resolved from chain after startup, so the wallet may
    // legitimately disagree with the database for those mints until then.
    const unresolved = new Set(this.paper.pending().filter(order =>
      ['live_submitted', 'live_unknown'].includes(readOrderDiagnostics(order.diagnostics_json)?.stage)).map(order => order.mint));
    const missing = [...owned].filter(mint => !held.has(mint) && !unresolved.has(mint) &&
      this.paper.watch(mint)?.reason !== 'graduated_live_unsellable');
    const closedMissing = [];
    for (const mint of missing) {
      if (this.liveCloseMissing(mint, 'missing_at_startup')) {
        owned.delete(mint); closedMissing.push(mint);
        this.log(JSON.stringify({ event: 'live_external_exit', mint, reason: 'missing_at_startup',
          note: 'Wallet no longer holds this position; closed at zero recovery.' }));
      }
    }
    const foreign = [...held].filter(mint => !owned.has(mint) && !unresolved.has(mint));
    this.liveForeign = new Set(foreign);
    if (foreign.length) {
      this.log(JSON.stringify({ event: 'live_foreign_tokens', count: foreign.length,
        note: 'Wallet holds tokens this trial did not open; they are left untouched and excluded from entries.' }));
      if (!allowForeign) throw new Error(`Wallet holds ${foreign.length} mint(s) not owned by this database; refusing startup. Resume the owning database or remove strict wallet ownership enforcement.`);
    }
    return { held: held.size, closedMissing, foreign };
  }
  /** Startup: the wallet and this database must agree before any order is sent. */
  async liveStartupChecks({ resume = false, allowForeign = true } = {}) {
    const halted = this.store.get("SELECT value FROM metadata WHERE key='live_halted'")?.value;
    if (halted && resume) {
      this.store.run("DELETE FROM metadata WHERE key='live_halted'");
      this.log(JSON.stringify({ event: 'live_halt_cleared', reason: halted }));
    } else if (halted) {
      this.liveHalted = halted;
      this.log(JSON.stringify({ event: 'live_entries_halted', reason: halted, note: 'Halt persisted from a previous run; exits only. Restart with --resume-entries to clear it.' }));
    }
    const balance = await this.executor.balance();
    if (balance < BigInt(this.cfg.live.minWalletLamports)) throw new Error('Wallet SOL is below LIVE_MIN_WALLET_SOL; refusing to start');
    await this.liveReconcileWallet({ allowForeign });
    for (const row of this.store.all(`SELECT p.mint FROM paper_positions p JOIN paper_watches w ON w.mint=p.mint
      WHERE p.status='open' AND w.reason IN ('graduated_no_amm_exit','graduated_live_unsellable')`)) {
      this.liveExit(row.mint, 'graduated_no_amm_exit', 'graduated_no_amm_exit', { recoveredAtStartup: true });
    }
    this.liveCheckLoss();
  }
  /** First shutdown signal: stop entries and actively liquidate every owned position. */
  beginDrain() {
    if (this.draining || this.stopped) return this.drainStatus();
    this.draining = true;
    for (const order of this.paper.pending().filter(row => row.side === 'buy')) this.cancel(order.id, this.now(), 'shutdown_draining');
    for (const position of this.store.all(`SELECT p.mint FROM paper_positions p
      LEFT JOIN paper_watches w ON w.mint=p.mint
      WHERE p.status='open' AND COALESCE(w.reason,'')!='graduated_live_unsellable'`)) {
      this.latchExit(position.mint, 'timeout');
      this.liveExit(position.mint, 'timeout', 'shutdown_drain', { requestedAtMs: this.now() });
    }
    const status = this.drainStatus();
    this.log(JSON.stringify({ event: 'live_shutdown_draining', ...status,
      note: status.manualPositions.length
        ? 'New entries are disabled; actionable positions are being exited. Graduated positions require manual sale.'
        : 'New entries are disabled; open positions are being exited before shutdown.' }));
    return status;
  }
  drainStatus() {
    const graduated = this.store.all(`SELECT p.mint,p.tokens_raw FROM paper_positions p
      JOIN paper_watches w ON w.mint=p.mint
      WHERE p.status='open' AND w.reason='graduated_live_unsellable'`);
    return {
      openPositions: this.store.get("SELECT COUNT(*) n FROM paper_positions WHERE status='open'").n,
      actionablePositions: this.store.get(`SELECT COUNT(*) n FROM paper_positions p
        LEFT JOIN paper_watches w ON w.mint=p.mint
        WHERE p.status='open' AND COALESCE(w.reason,'')!='graduated_live_unsellable'`).n,
      manualPositions: graduated,
      pendingExits: this.store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='sell' AND status='pending'").n,
      submitted: this.submitted.size,
    };
  }
  recordDrainFailure(reason = 'shutdown_drain_timeout') {
    const rows = this.store.all(`SELECT p.mint,p.tokens_raw FROM paper_positions p
      LEFT JOIN paper_watches w ON w.mint=p.mint
      WHERE p.status='open' AND COALESCE(w.reason,'')!='graduated_live_unsellable'`);
    for (const row of rows) {
      const failure = this.liveExitFailures.get(row.mint);
      this.paper.manualAction(row.mint, reason, {
        failures: failure?.failures ?? null, code: failure?.code ?? null, tokens: row.tokens_raw,
      }, this.now());
    }
    return rows.map(row => row.mint);
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; this.ready = false; this.epoch++; this.queue = [];
    this.clearDropConfirmations('drop_confirmation_stopped');
    for (const order of this.paper.pending()) this.cancel(order.id, this.now(), 'stopped');
    for (const active of this.reconciliations.values()) active.controller.abort();
    // Cancellation happens before feed teardown; wait for all continuations, including failed teardown.
    this.stopPromise = Promise.allSettled([
      ...[...this.reconciliations.values()].map(active => active.promise),
      Promise.resolve().then(() => this.feeds?.stop()), Promise.resolve().then(() => this.lookups.stop()),
    ]).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    });
    return this.stopPromise;
  }
}
