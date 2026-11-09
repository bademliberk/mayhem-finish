import { PUMP } from './config.js';
import { agentSellEvents } from './chain.js';
import { LookupCache } from './paper-lookups.js';
import { PaperStore } from './paper-store.js';
import { transactionFailure, readOrderDiagnostics } from './paper-diagnostics.js';
import { reserves, cap, entryQuote, entryQuality, exitQuote, terminalExitQuote, writeOffQuote, liquidityRisk, liquidityBudget, profitable, meetsDrop, higher } from './paper-math.js';

const mandatoryExit = reason => ['floor', 'liquidity_risk', 'timeout'].includes(reason);
const exitPriority = reason => ({ profit: 0, liquidity_risk: 1, timeout: 2, floor: 3, graduated_no_amm_exit: 4 }[reason] ?? -1);

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
  constructor(store, rpc, cfg, { now = Date.now, project } = {}) {
    this.store = store; this.rpc = rpc; this.cfg = cfg; this.now = now; this.project = project;
    this.paper = new PaperStore(store, cfg); this.states = new Map(); this.ready = false;
    this.agentMode = cfg.strategy === 'agent-sell-liquidity'; this.observationRevision = 0;
    this.terminalExits = this.agentMode && cfg.version === 'agent_sell_liquidity_v3_terminal_exit';
    this.startupExitGrace = new Map();
    this.coverageSlots = new Map();
    this.lookups = new LookupCache(rpc, name => { if (!this.stopped) this.paper.count(name); }, now);
    this.slot = 0; this.slotAt = 0; this.epoch = 0; this.queue = []; this.working = false; this.stopped = false;
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
      // Unknown pending fills are canceled on restart, not assumed to have happened.
      for (const order of this.paper.pending()) this.cancel(order.id, this.now(), 'restart_unreconciled');
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
      // Only mints that already had coverage: a jump must not grant coverage the feeds never acknowledged.
      for (const mint of [...this.coverageSlots.keys()]) this.coverage(mint);
    }
    for (const order of this.paper.pending()) this.expire(order);
    if (this.agentMode) this.checkAgentExits();
    if (slot) {
      for (const [mint, since] of this.coverageSlots) {
        if (since === Infinity) this.coverage(mint);
      }
    }
  }
  invalidateAccount(mint, slot, account, code, subtype = null) {
    if (this.stopped) return;
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
      const row = { state, slot, at: this.now(), revision: ++this.observationRevision,
        since: old?.since ?? Math.max(slot, this.coverageSlots.get(mint) ?? slot), history: old?.history ?? [] };
      // Confirmation snapshots cannot authorize another exit attempt by themselves.
      row.exitRevision = source === 'rpc' ? old?.exitRevision : row.revision;
      row.history = row.history.filter(item => item.slot >= slot - this.cfg.windowSlots + 1);
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
      if (!this.agentMode && !state.complete && cap(state) > this.cfg.floorCap &&
          (this.paper.position(mint) || (changed && cap(state) < this.cfg.activationCap))) this.membership(mint, true);
      if (state.complete) {
        for (const order of this.paper.pending().filter(o => o.mint === mint)) this.cancel(order.id, this.now(), 'graduated');
        this.store.run('UPDATE paper_watches SET status=?,reason=? WHERE mint=?', this.paper.position(mint) ? 'exit_blocked' : 'stopped', 'graduated_no_amm_exit', mint);
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
  // v3 only: accountSubscribe notifies on change, so silence on a live, covered subscription means unchanged
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
        for (const order of this.paper.pending().filter(o => o.mint === event.mint && o.side === 'buy')) {
          this.cancel(order.id, receivedAt, outcome === 'ambiguous_sell_slot' ? outcome : 'sell_superseded');
        }
        if (outcome !== 'received') return;
        const reject = (reason, detail) => this.paper.agentOutcome(event, reason, detail);
        if (!event.reserves) return reject('missing_sell_reserves');
        if (!this.agentFresh(event.mint, event.slot)) return reject('coverage_or_state_stale');
        if (watch.status !== 'watching' || this.paper.position(event.mint) || !this.cfg.entriesEnabled ||
            !this.paper.capacity().remaining) return reject('entries_disabled_or_cap');
        try {
          const state = { ...this.states.get(event.mint).state,
            ...Object.fromEntries(Object.entries(event.reserves).map(([key, value]) => [key, BigInt(value)])) };
          if (state.complete || state.realSol < BigInt(this.cfg.minRealSolLamports)) return reject('minimum_real_liquidity');
          const budget = liquidityBudget(state.realSol, this.cfg);
          if (budget <= 0n) return reject('budget_too_small');
          const quote = entryQuote(state, this.cfg, budget);
          quote.entryQuality = entryQuality(state, this.cfg, budget);
          if (quote.entryQuality.rejection) return reject(quote.entryQuality.rejection, quote.entryQuality);
          Object.assign(quote, { requestedBudgetLamports: budget.toString(), triggerRevision: revision,
            eventIndex: event.index, eventActor: event.user, referenceReserves: event.reserves,
            provenance: 'successful_mayhem_ancestor', receivedAtMs: receivedAt });
          if (!this.paper.exposureAllows(budget + BigInt(this.cfg.networkFeeLamports))) return reject('exposure_cap');
          const id = this.request(event.mint, 'buy', 'agent_sell', quote, { signature: event.signature, slot: event.slot, side: 'sell' },
            { eventIndex: event.index, triggerRevision: revision, requestedBudgetLamports: budget.toString(),
              referenceRealSolLamports: event.reserves.realSol, triggerToRequestSlots: Math.max(0, this.slot - event.slot) }, receivedAt);
          reject(id ? 'buy_pending' : 'entry_blocked', { requestedBudgetLamports: budget.toString(), referenceReserves: event.reserves });
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
        if (watch.status === 'exit_blocked' && mandatoryExit(watch.reason) && row) {
          this.requestExit(watch.mint, row.state, watch.reason, null);
        }
      }
      for (const order of this.paper.pending()) {
        if (this.stopped) break;
        await this.reconcile(order);
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
  async reconcileActive(order, active) {
    const { generation, controller } = active;
    try {
      let executedSlot = null;
      if (!this.current(order, active)) return;
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
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; this.ready = false; this.epoch++; this.queue = [];
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
