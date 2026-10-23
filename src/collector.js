import { transactionEvents, decodeCurve, classify } from './chain.js';
import { MAYHEM } from './config.js';

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export class Collector {
  constructor(store, rpc, cfg, onCandidate = () => {}) {
    this.store = store; this.rpc = rpc; this.cfg = cfg; this.onCandidate = onCandidate;
  }
  async ingest(signature) {
    if (this.store.get('SELECT 1 FROM processed WHERE signature=?', signature)) return;
    if (this.store.get('SELECT 1 FROM quarantined_transactions WHERE signature=?', signature)) {
      throw new Error('Quarantined transaction: unresolved truncated logs');
    }
    const tx = await this.rpc.transaction(signature);
    // A complete live notification may have resolved this signature while RPC was pending.
    if (this.store.get('SELECT 1 FROM processed WHERE signature=?', signature)) return;
    if (!tx) throw new Error('Transaction unavailable; retry required');
    try {
      this.store.apply(signature, tx.slot, transactionEvents(tx));
    } catch (error) {
      if (error.code === 'TRUNCATED_LOGS') this.store.quarantine(signature, tx.slot, nowSeconds(), error.message);
      throw error;
    }
  }
  // A scan advances its durable page cursor only after every item is handled.
  // Revisit the previous checkpoint's slot to avoid skipping same-slot transactions.
  async scan(address, cutoff, direct = false) {
    const cursor = this.store.cursor(address);
    for (let page = 0; page < this.cfg.historyPages; page++) {
      const entries = await this.rpc.signatures(address, cursor.before ? { before: cursor.before } : {});
      if (!cursor.pendingHead && entries.length) {
        cursor.pendingHead = entries[0].signature;
        cursor.pendingSlot = entries[0].slot;
      }
      let done = entries.length === 0;
      for (const entry of entries) {
        if ((cursor.headSlot != null && entry.slot < cursor.headSlot) ||
            (entry.blockTime != null && entry.blockTime < cutoff)) { done = true; break; }
        if (!entry.err) {
          if (direct) await this.ingest(entry.signature);
          else this.store.enqueue(entry.signature, entry.slot, nowSeconds());
        }
      }
      if (done || entries.length < 1000) {
        this.store.setCursor(address, { head: cursor.pendingHead ?? cursor.head, headSlot: cursor.pendingSlot ?? cursor.headSlot });
        return true;
      }
      cursor.before = entries.at(-1).signature;
      this.store.setCursor(address, cursor);
    }
    return false;
  }
  async drain(limit = 50) {
    const rows = this.store.all('SELECT * FROM queue WHERE retry_at<=? ORDER BY slot LIMIT ?', nowSeconds(), limit);
    for (const row of rows) {
      try {
        await this.ingest(row.signature);
        // Already processed rows may have survived a crash before queue deletion.
        this.store.run('DELETE FROM queue WHERE signature=?', row.signature);
      } catch (error) {
        this.store.run('UPDATE queue SET attempts=attempts+1,retry_at=?,last_error=? WHERE signature=?',
          nowSeconds() + Math.min(300, 2 ** Math.min(row.attempts + 1, 8)), error.message, row.signature);
      }
    }
  }
  async recentSignatures(address, limit) {
    const entries = await this.rpc.signatures(address, { limit });
    if (!Array.isArray(entries)) throw new Error('Malformed signature history; retry');
    const window = entries.slice(0, limit);
    const seen = new Set();
    for (const [index, entry] of window.entries()) {
      if (!entry || typeof entry.signature !== 'string' || !entry.signature ||
          !Number.isSafeInteger(entry.slot) || !Object.hasOwn(entry, 'err') ||
          entry.err === undefined || seen.has(entry.signature) ||
          (index > 0 && entry.slot > window[index - 1].slot)) {
        throw new Error('Malformed signature history; retry');
      }
      seen.add(entry.signature);
    }
    return window;
  }
  async recentTrade(row, entries = null) {
    entries ??= await this.recentSignatures(row.state_address, 20);
    for (const entry of entries) {
      if (entry.err) continue;
      await this.ingest(entry.signature);
      const trade = this.store.get(`SELECT traded_at FROM mayhem_trades
        WHERE signature=? AND mint=? AND traded_at>=? AND traded_at<=?
        ORDER BY event_index DESC LIMIT 1`, entry.signature, row.mint, row.created_at, row.deadline);
      if (trade) return { lastTrade: trade.traded_at, head: entries[0]?.signature };
    }
    return { lastTrade: null, head: entries[0]?.signature };
  }
  async evaluate(row) {
    if (nowSeconds() >= row.deadline) {
      this.store.finish(row.mint, row.deadline, 'deadline');
      return { mint: row.mint, category: 'deadline' };
    }
    const entries = await this.recentSignatures(row.state_address, 20);
    const snapshot = await this.rpc.accounts([row.state_address, row.curve_address]);
    const [state, curveAccount] = snapshot.value;
    const curve = decodeCurve(curveAccount);
    if (!curve.mayhem) throw new Error('Curve is not Mayhem-enabled');
    if (curve.complete) {
      // Graduation detection does not depend on available transaction logs or a defined price.
      this.store.graduate(row.mint, nowSeconds(), snapshot.context.slot,
        state?.owner === MAYHEM ? state.data[0] : null, curveAccount.data[0]);
      return { mint: row.mint, category: 'graduated' };
    }
    if (!state || state.owner !== MAYHEM) throw new Error('Missing or wrong-owner Mayhem state');
    const { lastTrade, head } = await this.recentTrade(row, entries);
    // Close a race between history scanning and the account snapshot: if a new
    // signature arrived, retry rather than classify using an out-of-date last trade.
    const latest = await this.recentSignatures(row.state_address, 1);
    if (latest[0]?.signature !== head) throw new Error('Mayhem history changed during evaluation; retry');
    const checkedAt = nowSeconds();
    if (checkedAt >= row.deadline) {
      this.store.finish(row.mint, row.deadline, 'deadline');
      return { mint: row.mint, category: 'deadline' };
    }
    const result = { ...classify(lastTrade, checkedAt, curve, this.cfg), historyScope: 'latest_20_transactions', detectedAtMs: Date.now() };
    this.store.evaluate(row.mint, checkedAt, snapshot.context.slot, state.data[0], curve, result, lastTrade);
    if (result.category === 'candidate') this.onCandidate(row.mint);
    return { mint: row.mint, ...result, marketCapSOL: curve.marketCap, liquiditySOL: curve.liquidity, slot: snapshot.context.slot };
  }
  async checkDue(limit = 20) {
    // Terminal outcomes have no trade stream or further checks; their activity
    // observation closes at classification. Deadlines apply to active rows only.
    const rows = this.store.all(`SELECT * FROM mints WHERE status='monitoring'
      AND last_check_at<=? AND next_check<=? ORDER BY last_check_at LIMIT ?`,
      nowSeconds() - this.cfg.recheck, nowSeconds(), limit);
    for (const row of rows) {
      if (nowSeconds() - row.next_check > this.cfg.recheck) {
        const gap = this.store.coverage('late_evaluation', row.next_check, `Delayed evaluation for ${row.mint}`);
        this.store.run('UPDATE coverage SET ended_at=? WHERE id=?', nowSeconds(), gap);
      }
      try {
        const result = await this.evaluate(row);
        if (['candidate', 'long_inactive', 'unqualified', 'never_traded', 'graduated', 'deadline'].includes(result.category)) console.log(JSON.stringify(result));
      } catch (error) {
        const gap = this.store.coverage('evaluation_failure', nowSeconds(), `${row.mint}: ${error.message}`);
        this.store.run('UPDATE coverage SET ended_at=? WHERE id=?', nowSeconds() + this.cfg.recheck, gap);
        this.store.run('UPDATE mints SET next_check=?,last_error=? WHERE mint=?', nowSeconds() + this.cfg.recheck, error.message, row.mint);
        console.error(`Check deferred ${row.mint}: ${error.message}`);
      }
    }
  }
}
