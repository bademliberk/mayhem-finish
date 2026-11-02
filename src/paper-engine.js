import { PUMP } from './config.js';
import { LookupCache } from './paper-lookups.js';
import { PaperStore } from './paper-store.js';
import { transactionFailure, readOrderDiagnostics } from './paper-diagnostics.js';
import { reserves, cap, entryQuote, entryQuality, exitQuote, liquidityRisk, profitable, meetsDrop, higher } from './paper-math.js';

const mandatoryExit = reason => reason === 'floor' || reason === 'liquidity_risk';
const exitPriority = reason => ({ profit: 0, liquidity_risk: 1, floor: 2, graduated_no_amm_exit: 3 }[reason] ?? -1);

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
    this.coverageSlots = new Map();
    this.lookups = new LookupCache(rpc, name => { if (!this.stopped) this.paper.count(name); }, now);
    this.slot = 0; this.slotAt = 0; this.epoch = 0; this.queue = []; this.working = false; this.stopped = false;
    this.reconciliations = new Map(); this.stopPromise = null;
  }
  attach(feeds) { this.feeds = feeds; }
  request(mint, side, reason, quote, signal, diagnostics = {}) {
    const now = this.now(), id = this.paper.request(mint, side, reason, quote, signal, now);
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
    return this.epoch === active.epoch && this.states.get(order.mint)?.since === active.generation.since;
  }
  unwatch(mint) {
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
    if (this.stopped) return;
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
      const enabled = row.reason !== 'graduated_no_amm_exit' &&
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
  }
  onReady() { if (!this.stopped) this.ready = true; }
  onSlot(slot) {
    if (this.stopped || !Number.isSafeInteger(slot) || slot < 0) return;
    if (this.slot && slot > this.slot + 8) {
      this.gap('slot_progress_gap'); this.feeds.resync?.(); return;
    }
    if (slot < this.slot) return;
    this.slot = slot; this.slotAt = this.now();
    for (const order of this.paper.pending()) this.expire(order);
    if (slot) {
      for (const [mint, since] of this.coverageSlots) {
        if (since === Infinity) this.coverage(mint);
      }
    }
  }
  invalidateAccount(mint, slot, account, code, subtype = null) {
    if (this.stopped) return;
    this.states.delete(mint);
    this.coverageSlots.set(mint, Math.max(slot, this.slot) || Infinity);
    for (const order of this.paper.pending().filter(order => order.mint === mint)) {
      this.cancel(order.id, this.now(), 'invalid_account');
    }
    this.store.run('UPDATE paper_watches SET last_slot=?,account_error=? WHERE mint=?', slot, code, mint);
    this.paper.count('invalid_account');
    this.paper.accountFault(mint, slot, account, code, this.now(), subtype);
    if ((code === 'not_mayhem' || subtype === 'unsupported_quote') && !this.paper.position(mint)) {
      this.store.run("UPDATE paper_watches SET status='stopped',reason=? WHERE mint=?",
        code === 'not_mayhem' ? 'not_mayhem' : 'unsupported_quote', mint);
      this.unwatch(mint);
    }
  }
  onAccount(mint, slot, account) {
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
      const row = { state, slot, at: this.now(), since: old?.since ?? Math.max(slot, this.coverageSlots.get(mint) ?? slot), history: old?.history ?? [] };
      row.history = row.history.filter(item => item.slot >= slot - this.cfg.windowSlots + 1);
      if (!state.complete) row.history.push({ state, slot, at: row.at });
      // Several writes in one slot have no transaction index; retain their observed peak only.
      if (row.history.length > 1000) { this.paper.count('history_overflow'); row.history = []; row.since = slot; }
      this.states.set(mint, row);
      this.store.run('UPDATE paper_watches SET last_slot=?,last_cap=?,account_error=NULL,last_observed_ms=? WHERE mint=?', slot, state.complete ? null : cap(state), this.now(), mint);
      const fingerprint = account.data[0];
      const changed = fingerprint !== watch.fingerprint;
      if (changed) this.store.run('UPDATE paper_watches SET fingerprint=?,last_change_ms=? WHERE mint=?', fingerprint, this.now(), mint);
      if (!state.complete && cap(state) > this.cfg.floorCap &&
          (this.paper.position(mint) || (changed && cap(state) < this.cfg.activationCap))) this.membership(mint, true);
      if (state.complete) {
        for (const order of this.paper.pending().filter(o => o.mint === mint)) this.cancel(order.id, this.now(), 'graduated');
        this.store.run('UPDATE paper_watches SET status=?,reason=? WHERE mint=?', this.paper.position(mint) ? 'exit_blocked' : 'stopped', 'graduated_no_amm_exit', mint);
        this.unwatch(mint); return;
      }
      if (this.paper.position(mint) && watch.reason === 'graduated_no_amm_exit') {
        this.unwatch(mint); return;
      }
      if (this.paper.position(mint)) {
        const reason = this.exitIntent(mint, state);
        if (reason) this.requestExit(mint, state, reason, null);
      } else if (cap(state) <= this.cfg.floorCap) {
        const pending = this.paper.pending().find(o => o.mint === mint);
        if (pending) this.cancel(pending.id, this.now(), 'floor_override');
        this.store.run("UPDATE paper_watches SET status='stopped',reason='floor' WHERE mint=?", mint);
        this.unwatch(mint);
      }
    } catch {
      this.invalidateAccount(mint, slot, account, 'processing_error');
    }
  }
  exitIntent(mint, state) {
    const watch = this.paper.watch(mint), position = this.paper.position(mint);
    if (!position || state.complete || watch.reason === 'graduated_no_amm_exit') return null;
    if (watch.reason === 'floor' || cap(state) <= this.cfg.floorCap) return 'floor';
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
        this.cancel(pending.id, this.now(), `${reason}_override`);
      }
    });
  }
  requestExit(mint, state, reason, signal, observation = this.states.get(mint)) {
    const position = this.paper.position(mint), watch = this.paper.watch(mint);
    if (this.stopped || !position || watch.reason === 'graduated_no_amm_exit' || state.complete ||
        watch.account_error || !observation || this.now() < observation.at ||
        this.now() - observation.at > this.cfg.maxStateAgeMs || (!signal && state !== observation.state)) return;
    // Predictions may request profit, but only observed (or freshly confirmed) reserves latch risk.
    const intent = this.exitIntent(mint, observation.state);
    if (intent) {
      reason = intent; state = observation.state; signal = null;
      this.latchExit(mint, reason);
    } else if (mandatoryExit(reason)) return;
    if (this.paper.pending().some(order => order.mint === mint)) return;
    try {
      const quote = exitQuote(state, position, this.cfg);
      if (reason === 'profit' && !profitable(quote, position, this.cfg)) return;
      if (signal?.base) quote.projectionBase = signal.base;
      if (!signal && Number.isSafeInteger(observation.slot)) quote.observationSlot = observation.slot;
      this.request(mint, 'sell', reason, quote, signal);
    } catch {
      this.paper.count('exit_insufficient_liquidity');
    }
  }
  enqueue(raw) {
    if (this.stopped) return;
    if (this.queue.length >= this.cfg.queueLimit) { this.gap('queue_overflow'); this.feeds.resync?.(); return; }
    this.queue.push(raw);
  }
  async tick() {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      this.discover();
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
    if (this.stopped) return;
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
    if (!this.store.get("SELECT 1 FROM paper_orders WHERE id=? AND status='pending'", order.id) || this.expire(order)) return Promise.resolve();
    const generation = this.states.get(order.mint);
    if (!generation || (!this.ready && !mandatoryExit(order.reason))) return Promise.resolve();
    const saved = this.store.get('SELECT diagnostics_json FROM paper_orders WHERE id=?', order.id);
    const active = { controller: new AbortController(), generation: { ...generation }, epoch: this.epoch,
      diagnostics: readOrderDiagnostics(saved?.diagnostics_json) ?? {} };
    this.reconciliations.set(order.id, active);
    active.promise = this.reconcileActive(order, active).finally(() => this.reconciliations.delete(order.id));
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
      const { state, code, subtype } = validateAccount(snapshot.value?.[0]);
      if (code) { this.invalidateAccount(order.mint, slot, snapshot.value?.[0], code, subtype); return; }
      if (state.complete) {
        this.cancel(order.id, this.now(), 'graduated');
        this.store.run('UPDATE paper_watches SET status=?,reason=? WHERE mint=?',
          this.paper.position(order.mint) ? 'exit_blocked' : 'stopped', 'graduated_no_amm_exit', order.mint);
        this.unwatch(order.mint); return;
      }
      const mc = cap(state);
      if (mc <= this.cfg.floorCap && order.side === 'buy') {
        this.cancel(order.id, this.now(), 'floor');
        this.store.run("UPDATE paper_watches SET status='stopped',reason='floor' WHERE mint=?", order.mint);
        this.unwatch(order.mint); return;
      }
      let quote;
      if (order.side === 'buy') {
        if (!this.ready || !this.cfg.entriesEnabled || watch.status !== 'watching' || !watch.preprocessed || !this.feeds.covers(order.mint)) { this.cancel(order.id, this.now(), 'entries_paused'); return; }
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
        quote = entryQuote(state, this.cfg);
        quote.entryQuality = entryQuality(state, this.cfg);
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
          this.onAccount(order.mint, slot, snapshot.value[0]);
          if (this.paper.watch(order.mint).account_error) return;
          this.latchExit(order.mint, intent);
          if (intent !== order.reason) {
            this.requestExit(order.mint, state, intent, null, { state, slot, at: this.now() }); return;
          }
        }
        quote = exitQuote(state, position, this.cfg);
        if (order.reason === 'profit' && !profitable(quote, position, this.cfg)) { this.cancel(order.id, this.now(), 'profit_disappeared'); return; }
        if (BigInt(quote.net) * 10000n < BigInt(predicted.net) * BigInt(10000 - this.cfg.sellSlippageBps)) {
          this.cancel(order.id, this.now(), 'sell_slippage'); return;
        }
      }
      quote.slot = slot;
      quote.model = order.reason === 'floor' ? 'hypothetical_floor_fill_confirmed_state' :
        order.signal_signature ? 'hypothetical_fill_after_confirmed_trigger' : 'hypothetical_fill_confirmed_state';
      if (!this.current(order, active)) return;
      this.diagnose(order, { stage: 'ready_to_fill' });
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
      Promise.resolve().then(() => this.feeds.stop()), Promise.resolve().then(() => this.lookups.stop()),
    ]).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    });
    return this.stopPromise;
  }
}
