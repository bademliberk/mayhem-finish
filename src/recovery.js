import { nowSeconds } from './collector.js';
import { FeedHealth, safeFailure } from './feed-health.js';

const CUTOFF_KEY = 'backfill_cutoff';

// Tracks every unfinished recovery ("episode": a startup or one websocket outage)
// and owns the scan lifecycle. Invariants:
//  * An episode's cutoff is (actual disconnect | last connected | last heartbeat) - margin.
//    It never depends on when an earlier recovery finished.
//  * An episode only becomes runnable once the subscription is live again: a scan whose
//    head was captured before reconnection cannot cover the live-stream gap.
//  * An episode that becomes ready after a scan chain started is "late": the running
//    chain does not cover it (its head predates the reconnect), so it is never closed by
//    that chain. A follow-up chain re-reads the new head (cursor kept, so cheap) unless
//    the late cutoff is older than what the chain covered, in which case it rescans fully.
//  * Coverage rows are closed only for episodes the finished chain actually covered.
//  * The minimum cutoff of all unfinished episodes is persisted so a restart cannot
//    move the lower bound forward.
export class Recovery {
  constructor({ store, collector, programs, margin = 10, retrySeconds = 60, now = nowSeconds, log = console.error }) {
    this.store = store; this.collector = collector; this.programs = programs;
    this.margin = margin; this.retrySeconds = retrySeconds; this.now = now; this.log = log;
    this.health = new FeedHealth(store, 'recovery', () => this.now() * 1000);
    this.episodes = [];
    this.chain = null;
    this.nextAttempt = 0;
    this.headCutoff = null; // cutoff covered by the cursor head left in place for a follow-up
  }

  get pending() { return this.episodes.length > 0; }
  get cutoff() { return this.episodes.length ? Math.min(...this.episodes.map(e => e.cutoff)) : null; }

  begin({ lastHeartbeat, now = this.now() }) {
    if (this.pending) return;
    const persisted = this.store.get('SELECT value FROM metadata WHERE key=?', CUTOFF_KEY);
    const open = this.store.all(`SELECT id,started_at FROM coverage
      WHERE kind IN ('backfill','process_gap','websocket_gap') AND ended_at IS NULL`);
    let since = lastHeartbeat ?? now;
    // Unfinished recovery from an earlier process: never move its lower bound forward.
    if (persisted && Number.isFinite(Number(persisted.value)) && Number(persisted.value) >= 0) since = Math.min(since, Number(persisted.value) + this.margin);
    for (const row of open) since = Math.min(since, row.started_at);
    const id = this.store.coverage('backfill', since, `Startup recovery; cutoff ${Math.max(0, since - this.margin)}`);
    this.episodes.push({ ids: [...open.map(row => row.id), id], since, cutoff: Math.max(0, since - this.margin),
      ready: false, late: false, kind: 'startup' });
    for (const program of this.programs) this.store.setCursor(program, {});
    this.persist();
  }

  // Called every tick while the stream is not connected. One unready episode per outage.
  disconnected(lastConnected, tick = this.now()) {
    if (this.episodes.some(e => !e.ready)) return null;
    const gap = this.store.get(`SELECT started_at FROM coverage WHERE kind='websocket_gap'
      AND ended_at IS NULL ORDER BY id DESC LIMIT 1`);
    return this.open(this.outageStart(gap?.started_at, lastConnected, tick), false, 'Reconnection recovery (awaiting connection)');
  }

  // Called from Stream's onReady: the subscription is live again.
  reconnected(lastConnected, tick = this.now()) {
    const waiting = this.episodes.find(e => !e.ready);
    // Transport acknowledgement does not close gaps. Adopt only rows not already owned
    // by another episode: a running scan must never close a later reconnect's gap.
    const owned = new Set(this.episodes.flatMap(e => e.ids));
    const gaps = this.store.all("SELECT id,started_at FROM coverage WHERE kind='websocket_gap' AND ended_at IS NULL")
      .filter(row => !owned.has(row.id));
    const gap = this.store.get("SELECT started_at FROM coverage WHERE kind='websocket_gap' ORDER BY id DESC LIMIT 1");
    const since = Math.min(this.outageStart(gap?.started_at, lastConnected, tick), ...gaps.map(row => row.started_at));
    if (waiting) {
      waiting.since = Math.min(waiting.since, since);
      waiting.cutoff = Math.min(waiting.cutoff, Math.max(0, since - this.margin));
      waiting.ready = true; waiting.late = this.chain !== null;
      waiting.ids.push(...gaps.map(row => row.id));
      this.persist();
      return waiting;
    }
    const episode = this.open(since, true, 'Reconnection recovery');
    episode.ids.push(...gaps.map(row => row.id));
    return episode;
  }

  outageStart(gapStart, lastConnected, tick) {
    return Math.min(...[gapStart, lastConnected].filter(Number.isFinite), tick);
  }

  open(since, ready, detail) {
    const cutoff = Math.max(0, since - this.margin);
    const id = this.store.coverage('backfill', since, `${detail}; cutoff ${cutoff}`);
    const episode = { ids: [id], since, cutoff, ready, late: ready && this.chain !== null, kind: 'reconnect' };
    this.episodes.push(episode);
    this.persist();
    return episode;
  }

  flushHealth() {
    this.health.update({ phase: this.nextAttempt > this.now() ? 'backoff' : this.chain ? 'recovering' : this.pending ? 'waiting' : 'complete',
      pending: this.episodes.length, cutoff: this.cutoff, nextRetryAt: this.nextAttempt ? this.nextAttempt * 1000 : null });
  }

  persist() {
    this.flushHealth();
    const cutoff = this.cutoff;
    if (cutoff == null) this.store.run('DELETE FROM metadata WHERE key=?', CUTOFF_KEY);
    else this.store.run(`INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      CUTOFF_KEY, String(cutoff));
  }

  // One scan attempt. Returns idle | waiting | completed | partial | failed.
  async run(tick = this.now()) {
    if (!this.chain) {
      const members = this.episodes.filter(e => e.ready);
      if (!members.length) return 'idle';
      if (tick < this.nextAttempt) return 'waiting';
      const cutoff = Math.min(...members.map(e => e.cutoff));
      for (const member of members) member.late = false;
      const followUp = this.headCutoff != null && cutoff >= this.headCutoff;
      if (!followUp) for (const program of this.programs) this.store.setCursor(program, {});
      this.chain = { members, cutoff, done: new Set() };
    } else if (tick < this.nextAttempt) return 'waiting';
    const chain = this.chain;
    this.health.update({ attempts: this.health.value.attempts + 1 });
    this.flushHealth();
    try {
      for (const program of this.programs) {
        if (chain.done.has(program)) continue;
        if (await this.collector.scan(program, chain.cutoff)) chain.done.add(program);
      }
    } catch (error) {
      this.health.failure('backfill_failed', error);
      this.log(JSON.stringify({ event: 'backfill_deferred', ...safeFailure('backfill_failed', error, this.now() * 1000) }));
      this.nextAttempt = this.now() + this.retrySeconds;
      this.flushHealth();
      return 'failed';
    }
    if (chain.done.size < this.programs.length) {
      this.nextAttempt = this.now() + this.retrySeconds;
      this.flushHealth();
      return 'partial';
    }
    this.complete(chain);
    return 'completed';
  }

  complete(chain) {
    const ended = this.now();
    this.health.update({ failureStreak: 0, lastProgressAt: ended * 1000 });
    for (const member of chain.members) {
      for (const id of member.ids) this.store.run('UPDATE coverage SET ended_at=? WHERE id=? AND ended_at IS NULL', ended, id);
    }
    this.episodes = this.episodes.filter(e => !chain.members.includes(e));
    this.chain = null;
    this.nextAttempt = 0;
    // Reconnects during the scan keep the head cursor so their follow-up reads only the new head;
    // otherwise the next reconnect needs only its own disconnected interval.
    if (this.episodes.some(e => e.ready)) this.headCutoff = chain.cutoff;
    else {
      this.headCutoff = null;
      for (const program of this.programs) this.store.setCursor(program, {});
    }
    this.persist();
  }
}
