import { PaperStore } from './paper-store.js';
import { reserves, cap, entryQuote, exitQuote, profitable, meetsDrop, higher } from './paper-math.js';

export class PaperEngine {
  constructor(store, rpc, cfg, { now = Date.now, project } = {}) {
    this.store = store; this.rpc = rpc; this.cfg = cfg; this.now = now; this.project = project;
    this.paper = new PaperStore(store, cfg); this.states = new Map(); this.ready = false;
    this.slot = 0; this.slotAt = 0; this.epoch = 0; this.queue = []; this.working = false; this.stopped = false;
  }
  attach(feeds) { this.feeds = feeds; }
  unwatch(mint) { this.states.delete(mint); this.feeds.remove(mint); }
  start() {
    // Unknown pending fills are canceled on restart, not assumed to have happened.
    for (const order of this.paper.pending()) this.paper.cancel(order.id, this.now(), 'restart_unreconciled');
    for (const row of this.paper.active()) {
      if (row.reason !== 'graduated_no_amm_exit') this.feeds.add(row.mint, row.curve_address);
    }
    for (const row of this.store.all(`SELECT mint FROM candidate_observations WHERE status='paper_watch'
      AND mint NOT IN (SELECT mint FROM paper_watches)`)) this.add(row.mint);
    this.feeds.start();
  }
  add(mint) {
    if (this.stopped) return;
    if (this.paper.enroll(mint, this.now())) this.feeds.add(mint, this.paper.watch(mint).curve_address);
  }
  gap(reason) {
    this.ready = false; this.epoch++; this.slot = 0; this.slotAt = 0; this.states.clear(); this.queue = [];
    this.paper.count(`gap:${reason}`);
    for (const order of this.paper.pending()) this.paper.cancel(order.id, this.now(), 'feed_gap');
  }
  onReady() { if (!this.stopped) this.ready = true; }
  onSlot(slot) {
    if (!Number.isSafeInteger(slot) || slot < 0) return;
    if (this.slot && slot > this.slot + 8) {
      this.gap('slot_progress_gap'); this.feeds.resync?.(); return;
    }
    if (slot < this.slot) return;
    this.slot = slot; this.slotAt = this.now();
  }
  onAccount(mint, slot, account) {
    if (this.stopped || !Number.isSafeInteger(slot) || slot < 0) return;
    const watch = this.paper.watch(mint);
    if (!watch || !['watching', 'holding', 'exit_blocked'].includes(watch.status)) return;
    try {
      const state = reserves(account), old = this.states.get(mint);
      if (old && slot < old.slot) {
        this.paper.count('out_of_order_account'); return;
      }
      const row = { state, slot, at: this.now(), since: old?.since ?? slot, history: old?.history ?? [] };
      row.history = row.history.filter(item => item.slot >= slot - this.cfg.windowSlots + 1);
      if (!state.complete) row.history.push({ state, slot });
      // Several writes in one slot have no transaction index; retain their observed peak only.
      if (row.history.length > 1000) { this.paper.count('history_overflow'); row.history = []; row.since = slot; }
      this.states.set(mint, row);
      this.store.run('UPDATE paper_watches SET last_slot=?,last_cap=? WHERE mint=?', slot, state.complete ? null : cap(state), mint);
      if (state.complete) {
        for (const order of this.paper.pending().filter(o => o.mint === mint)) this.paper.cancel(order.id, this.now(), 'graduated');
        this.store.run('UPDATE paper_watches SET status=?,reason=? WHERE mint=?', this.paper.position(mint) ? 'exit_blocked' : 'stopped', 'graduated_no_amm_exit', mint);
        this.unwatch(mint); return;
      }
      if (this.paper.position(mint) && watch.reason === 'graduated_no_amm_exit') {
        this.unwatch(mint); return;
      }
      if (cap(state) <= this.cfg.floorCap) {
        const pending = this.paper.pending().find(o => o.mint === mint);
        if (pending && pending.reason !== 'floor') this.paper.cancel(pending.id, this.now(), 'floor_override');
        if (this.paper.position(mint)) this.requestExit(mint, state, 'floor', null);
        else {
          this.store.run("UPDATE paper_watches SET status='stopped',reason='floor' WHERE mint=?", mint);
          this.unwatch(mint);
        }
      } else if (watch.status === 'exit_blocked' && watch.reason === 'floor') {
        this.requestExit(mint, state, 'floor', null);
      }
    } catch {
      this.paper.count('invalid_account');
      this.gap('invalid_account');
      this.feeds.resync?.();
    }
  }
  requestExit(mint, state, reason, signal) {
    const position = this.paper.position(mint);
    if (!position) return;
    try {
      const quote = exitQuote(state, position, this.cfg);
      if (reason === 'profit' && !profitable(quote, position, this.cfg)) return;
      this.paper.request(mint, 'sell', reason, quote, signal, this.now());
      if (reason === 'floor') this.store.run("UPDATE paper_watches SET status='exit_blocked',reason='floor' WHERE mint=?", mint);
    } catch {
      if (reason === 'floor') this.store.run("UPDATE paper_watches SET status='exit_blocked',reason='floor' WHERE mint=?", mint);
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
      for (let i = 0; i < 100 && this.queue.length && !this.stopped; i++) this.signal(this.queue.shift());
      for (const watch of this.paper.active()) {
        if (watch.status === 'watching' && this.paper.capacity().successfulBuys >= this.cfg.maxTrades &&
            !this.paper.pending().some(order => order.mint === watch.mint)) {
          this.store.run("UPDATE paper_watches SET status='stopped',reason='trade_cap' WHERE mint=?", watch.mint);
          this.unwatch(watch.mint); continue;
        }
        const row = this.states.get(watch.mint);
        if (watch.status === 'exit_blocked' && watch.reason === 'floor' && row &&
            this.now() - row.at <= this.cfg.maxStateAgeMs) this.requestExit(watch.mint, row.state, 'floor', null);
      }
      for (const order of this.paper.pending()) {
        if (this.stopped) break;
        await this.reconcile(order);
      }
    } finally { this.working = false; }
  }
  signal(raw) {
    let prediction;
    try { prediction = this.project(raw, this.states, this.cfg); }
    catch (error) { this.paper.count(`decode:${error.code ?? 'unsupported'}`); return; }
    const { signature, slot, mint, state: projected } = prediction;
    if (!this.paper.seen(signature, slot, this.now())) { this.paper.count('duplicate_signal'); return; }
    const reject = reason => this.paper.signal(signature, mint, reason);
    const row = this.states.get(mint), watch = this.paper.watch(mint);
    if (!row || !watch || !this.ready) return reject('not_ready');
    if (slot < this.slot - 1 || slot > this.slot + 2 || this.now() - this.slotAt > this.cfg.maxStateAgeMs ||
        this.now() - row.at > this.cfg.maxStateAgeMs || row.slot >= slot) return reject('stale_or_already_executed');
    const position = this.paper.position(mint);
    if (position) {
      if (watch.reason === 'floor' || watch.reason === 'graduated_no_amm_exit') return reject('mandatory_exit_pending');
      this.requestExit(mint, projected, 'profit', {signature, slot});
      return reject('exit_prediction_checked');
    }
    if (watch.status !== 'watching' || !this.cfg.entriesEnabled || !this.paper.capacity().remaining) return reject('entries_disabled_or_cap');
    if (row.since > slot - this.cfg.windowSlots + 1) return reject('insufficient_five_slot_history');
    const history = row.history.filter(h => h.slot >= slot - this.cfg.windowSlots + 1 && h.slot <= slot);
    if (!history.length) return reject('no_observed_peak');
    const high = history.reduce((a, b) => higher(a.state, b.state) ? a : b).state;
    const mc = cap(projected);
    if (!(mc > this.cfg.floorCap && mc < this.cfg.ceilingCap)) return reject('outside_buy_range');
    if (!meetsDrop(projected, high, this.cfg)) return reject('drop_below_threshold');
    try {
      const quote = entryQuote(projected, this.cfg);
      quote.reference = { slot: slot - this.cfg.windowSlots + 1, virtualSol: high.virtualSol.toString(), virtualTokens: high.virtualTokens.toString() };
      const id = this.paper.request(mint, 'buy', 'dump', quote, {signature, slot}, this.now());
      reject(id ? 'buy_pending' : 'entry_blocked');
    } catch { reject('entry_quote_unavailable'); }
  }
  async reconcile(order) {
    const now = this.now();
    if (now >= order.expires_at_ms || (order.side === 'buy' && this.slot > order.signal_slot + this.cfg.windowSlots - 1)) {
      this.paper.cancel(order.id, now, 'signal_expired'); return;
    }
    const generation = this.states.get(order.mint), epoch = this.epoch;
    if (!generation || (!this.ready && order.reason !== 'floor')) return;
    try {
      let executedSlot = null;
      if (order.signal_signature) {
        const result = await this.rpc.call('getSignatureStatuses', [[order.signal_signature], { searchTransactionHistory: false }], { deadlineMs: order.expires_at_ms });
        const status = result?.value?.[0];
        if (!status) return;
        if (status.err !== null) { this.paper.cancel(order.id, this.now(), 'trigger_failed'); return; }
        if (!Number.isSafeInteger(status.slot) || !['confirmed', 'finalized'].includes(status.confirmationStatus)) return;
        executedSlot = status.slot;
        if (executedSlot !== order.signal_slot) { this.paper.cancel(order.id, this.now(), 'trigger_slot_changed'); return; }
      }
      if (this.stopped || !this.store.get("SELECT 1 FROM paper_orders WHERE id=? AND status='pending'", order.id)) return;
      const watch = this.paper.watch(order.mint);
      const snapshot = await this.rpc.accounts([watch.curve_address], { commitment: 'confirmed', deadlineMs: order.expires_at_ms });
      if (this.stopped || this.now() >= order.expires_at_ms || !this.store.get("SELECT 1 FROM paper_orders WHERE id=? AND status='pending'", order.id)) return;
      if (this.epoch !== epoch || this.states.get(order.mint)?.since !== generation.since) return;
      if (order.side === 'buy' && this.slot > order.signal_slot + this.cfg.windowSlots - 1) {
        this.paper.cancel(order.id, this.now(), 'signal_expired'); return;
      }
      const slot = snapshot?.context?.slot;
      if (!Number.isSafeInteger(slot) || slot < (executedSlot ?? generation.slot)) return;
      const state = reserves(snapshot.value?.[0]);
      if (state.complete) {
        this.paper.cancel(order.id, this.now(), 'graduated');
        this.store.run('UPDATE paper_watches SET status=?,reason=? WHERE mint=?',
          this.paper.position(order.mint) ? 'exit_blocked' : 'stopped', 'graduated_no_amm_exit', order.mint);
        this.unwatch(order.mint); return;
      }
      const mc = cap(state);
      if (mc <= this.cfg.floorCap && order.side === 'buy') {
        this.paper.cancel(order.id, this.now(), 'floor');
        this.store.run("UPDATE paper_watches SET status='stopped',reason='floor' WHERE mint=?", order.mint);
        this.unwatch(order.mint); return;
      }
      const predicted = JSON.parse(order.quote_json);
      let quote;
      if (order.side === 'buy') {
        if (!this.ready || !this.cfg.entriesEnabled || watch.status !== 'watching') { this.paper.cancel(order.id, this.now(), 'entries_paused'); return; }
        const reference = { virtualSol: BigInt(predicted.reference.virtualSol), virtualTokens: BigInt(predicted.reference.virtualTokens) };
        if (!(mc > this.cfg.floorCap && mc < this.cfg.ceilingCap) || !meetsDrop(state, reference, this.cfg)) {
          this.paper.cancel(order.id, this.now(), 'entry_condition_changed'); return;
        }
        quote = entryQuote(state, this.cfg);
        if (BigInt(quote.tokens) * 10000n < BigInt(predicted.tokens) * BigInt(10000 - this.cfg.buySlippageBps)) {
          this.paper.cancel(order.id, this.now(), 'buy_slippage'); return;
        }
      } else {
        const position = this.paper.position(order.mint);
        if (!position) { this.paper.cancel(order.id, this.now(), 'no_position'); return; }
        if (mc <= this.cfg.floorCap && order.reason !== 'floor') {
          this.paper.cancel(order.id, this.now(), 'floor_override');
          this.requestExit(order.mint, state, 'floor', null); return;
        }
        quote = exitQuote(state, position, this.cfg);
        if (order.reason === 'profit' && !profitable(quote, position, this.cfg)) { this.paper.cancel(order.id, this.now(), 'profit_disappeared'); return; }
        if (BigInt(quote.net) * 10000n < BigInt(predicted.net) * BigInt(10000 - this.cfg.sellSlippageBps)) {
          this.paper.cancel(order.id, this.now(), 'sell_slippage'); return;
        }
      }
      quote.slot = slot; quote.model = order.reason === 'floor' ? 'hypothetical_floor_fill_confirmed_state' : 'hypothetical_fill_after_confirmed_trigger';
      this.paper.fill(order, quote, this.now());
      if (order.side === 'sell') this.unwatch(order.mint);
    } catch { this.paper.count('reconciliation_unavailable'); }
  }
  async stop() {
    this.stopped = true; this.queue = [];
    await this.feeds.stop();
  }
}
