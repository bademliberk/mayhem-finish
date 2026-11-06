// Subscription/gap-triggered baseline work, not a periodic account poller.
// Pending watches stay here rather than flooding the shared serialized RPC queue.
export const BASELINE_BATCH_SIZE = 100;
const DEADLINE_MS = 5000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;

export class PaperBaselines {
  constructor(feeds) {
    this.feeds = feeds;
    this.pending = new Map(); // watch identity -> outstanding baseline requirement
    this.active = null;
    this.timer = null;
    this.scheduled = null;
  }
  current(member) {
    const f = this.feeds, w = member.watch;
    return !f.stopped && this.pending.get(w) === member && f.watches.get(w.mint) === w
      && f.standard.generation === member.generation && w.seq === member.seq
      && w.subscription === member.subscription && w.subscription != null;
  }
  cancel(watch) {
    this.pending.delete(watch);
    watch.attempts = 0; watch.seq = (watch.seq ?? 0) + 1;
    // Invalidating one member must not cancel the other accounts sharing this RPC.
    if (this.active && !this.active.members.some(member => this.current(member))) {
      const batch = this.active; this.active = null;
      batch.controller.abort();
    }
    this.schedule();
  }
  request(watch) {
    this.cancel(watch);
    const f = this.feeds;
    if (f.stopped || f.watches.get(watch.mint) !== watch || watch.subscription == null) return;
    this.pending.set(watch, { watch, generation: f.standard.generation, subscription: watch.subscription,
      seq: watch.seq, attempts: 0, due: f.now(), batch: null });
    this.schedule();
  }
  clear() {
    const f = this.feeds;
    f.clearTimer(this.timer); this.timer = null; this.scheduled = null;
    for (const member of this.pending.values()) {
      member.watch.seq++; member.watch.attempts = 0;
    }
    this.pending.clear();
    const batch = this.active; this.active = null;
    batch?.controller.abort();
  }
  schedule() {
    const f = this.feeds;
    f.clearTimer(this.timer); this.timer = null;
    if (f.stopped || this.active || this.scheduled || !this.pending.size) return;
    // Coalesce acknowledgments in this turn. The token also fences already-queued
    // microtasks across reconnect, resync and stop.
    const token = {}; this.scheduled = token;
    queueMicrotask(() => {
      if (this.scheduled !== token) return;
      this.scheduled = null;
      this.dispatch();
    });
  }
  dispatch() {
    const f = this.feeds;
    if (f.stopped || this.active) return;
    const members = [], now = f.now();
    let earliest = Infinity;
    for (const [watch, member] of this.pending) {
      if (!this.current(member)) { this.pending.delete(watch); continue; }
      if (member.due <= now) members.push(member);
      else earliest = Math.min(earliest, member.due);
      if (members.length === BASELINE_BATCH_SIZE) break;
    }
    if (!members.length) {
      if (earliest !== Infinity) {
        const timer = f.setTimer(() => {
          if (this.timer !== timer) return;
          this.timer = null; this.schedule();
        }, Math.max(0, earliest - now));
        this.timer = timer;
      }
      return;
    }
    const batch = { members, controller: new AbortController() };
    this.active = batch;
    for (const member of members) member.batch = batch;
    const task = this.run(batch);
    f.tasks.add(task);
    task.then(() => f.tasks.delete(task), () => f.tasks.delete(task));
  }
  async run(batch) {
    const f = this.feeds, { members, controller } = batch;
    try {
      const result = await f.rpc.accounts(members.map(member => member.watch.curve), {
        commitment: f.agentMode ? 'confirmed' : 'processed',
        deadlineMs: f.now() + DEADLINE_MS, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const slot = result?.context?.slot, values = result?.value;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(values) || values.length !== members.length) {
        throw new Error('Malformed baseline batch');
      }
      // Validate the entire envelope first. Missing elements are not missing accounts.
      for (let i = 0; i < members.length; i++) {
        if (!Object.hasOwn(values, i) || (values[i] !== null && (typeof values[i] !== 'object' || Array.isArray(values[i])))) {
          throw new Error('Malformed baseline account');
        }
      }
      for (let i = 0; i < members.length; i++) {
        const member = members[i], watch = member.watch;
        // The preceding callback may synchronously remove watches or reset the feed.
        if (!this.current(member)) continue;
        this.pending.delete(watch); watch.attempts = 0;
        if (slot > watch.lastSlot) {
          watch.lastSlot = slot;
          f.safe('onAccount', watch.mint, slot, values[i], 'baseline');
        }
        if (f.agentMode) f.notifyCoverage(watch);
      }
    } catch {
      if (controller.signal.aborted) return;
      for (const member of members) {
        if (!this.current(member)) continue;
        f.baselineUsage('failed');
        member.due = f.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(member.attempts, 16));
        member.attempts++; member.watch.attempts = member.attempts; member.batch = null;
        // Failed work rejoins behind other queued watches, including new arrivals.
        this.pending.delete(member.watch); this.pending.set(member.watch, member);
      }
    } finally {
      if (this.active === batch) this.active = null;
      this.schedule();
    }
  }
  counts() {
    const inFlight = this.active?.members.filter(member => this.current(member)).length ?? 0;
    return { baselineQueued: this.pending.size - inFlight, baselineInFlight: inFlight };
  }
}
