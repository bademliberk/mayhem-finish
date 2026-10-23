import { createHash } from 'node:crypto';

export function migrateObservations(store) {
  for (const [table, name, type] of [
    ['evaluations', 'screening_policy', "TEXT NOT NULL DEFAULT 'legacy'"],
    ['candidates', 'screening_policy', "TEXT NOT NULL DEFAULT 'legacy'"],
    ['candidates', 'market_cap_sol', 'REAL'], ['candidates', 'liquidity_sol', 'REAL'],
  ]) {
    if (!store.all(`PRAGMA table_info(${table})`).some(c => c.name === name)) {
      store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_observations (
      mint TEXT PRIMARY KEY REFERENCES candidates(mint), started_at_ms INTEGER NOT NULL,
      deadline_ms INTEGER NOT NULL, subscribed_at_ms INTEGER, ended_at_ms INTEGER,
      status TEXT NOT NULL, interrupted INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      last_slot INTEGER, last_source TEXT
    );
    CREATE TABLE IF NOT EXISTS candidate_samples (
      id INTEGER PRIMARY KEY, mint TEXT NOT NULL REFERENCES candidate_observations(mint),
      received_at_ms INTEGER NOT NULL, slot INTEGER NOT NULL, source TEXT NOT NULL,
      market_cap_sol REAL NOT NULL, liquidity_sol REAL NOT NULL, fingerprint TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS candidate_sample_mint ON candidate_samples(mint,slot,id);
  `);
  store.run(`UPDATE candidates SET
    market_cap_sol=(SELECT market_cap_sol FROM evaluations WHERE id=candidates.evaluation_id),
    liquidity_sol=(SELECT liquidity_sol FROM evaluations WHERE id=candidates.evaluation_id)
    WHERE market_cap_sol IS NULL OR liquidity_sol IS NULL`);
  store.run(`INSERT OR IGNORE INTO candidate_observations(mint,started_at_ms,deadline_ms,status)
    SELECT mint,first_seen*1000,first_seen*1000,'not_tracked' FROM candidates`);
}

export class Observations {
  constructor(store) { this.store = store; }
  get(mint) { return this.store.get('SELECT * FROM candidate_observations WHERE mint=?', mint); }
  pending() {
    return this.store.all(`SELECT o.*,m.curve_address FROM candidate_observations o JOIN mints m USING(mint)
      WHERE o.status='tracking'`);
  }
  interrupted(mint, reason) {
    this.store.run("UPDATE candidate_observations SET interrupted=1,last_error=? WHERE mint=? AND status='tracking'", reason, mint);
  }
  subscribed(mint, now) {
    this.store.run(`UPDATE candidate_observations SET subscribed_at_ms=COALESCE(subscribed_at_ms,?)
      WHERE mint=? AND status='tracking'`, now, mint);
  }
  sample(mint, now, slot, source, account, curve) {
    const o = this.get(mint);
    if (!o || o.status !== 'tracking' || now < o.started_at_ms || now >= o.deadline_ms) return false;
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('Invalid curve sample slot');
    if (o.last_slot != null && (slot < o.last_slot ||
        (slot === o.last_slot && source === 'snapshot' && o.last_source === 'subscription'))) return false;
    if (curve.complete) { this.finish(mint, now, 'graduated'); return true; }
    const fingerprint = createHash('sha256').update(account.data[0]).digest('hex');
    const last = this.store.get('SELECT slot,fingerprint FROM candidate_samples WHERE mint=? ORDER BY id DESC LIMIT 1', mint);
    this.store.atomic(() => {
      if (!last || last.slot !== slot || last.fingerprint !== fingerprint) {
        this.store.run(`INSERT INTO candidate_samples
          (mint,received_at_ms,slot,source,market_cap_sol,liquidity_sol,fingerprint) VALUES(?,?,?,?,?,?,?)`,
        mint, now, slot, source, curve.marketCap, curve.liquidity, fingerprint);
      }
      this.store.run('UPDATE candidate_observations SET last_slot=?,last_source=? WHERE mint=?', slot, source, mint);
    });
    return true;
  }
  finish(mint, now, status = null) {
    const o = this.get(mint);
    if (!o || o.status !== 'tracking') return;
    const count = this.store.get('SELECT COUNT(*) n FROM candidate_samples WHERE mint=?', mint).n;
    status ??= o.interrupted || !o.subscribed_at_ms || count === 0 ? 'incomplete' : 'completed';
    this.store.run("UPDATE candidate_observations SET status=?,ended_at_ms=? WHERE mint=? AND status='tracking'", status, now, mint);
  }
  summaries() {
    return this.store.all(`SELECT o.*,c.market_cap_sol entry_market_cap_sol,c.liquidity_sol entry_liquidity_sol,
      c.screening_policy,
      (SELECT COUNT(*) FROM candidate_samples s WHERE s.mint=o.mint) sample_count,
      (SELECT MAX(market_cap_sol) FROM candidate_samples s WHERE s.mint=o.mint) peak_market_cap_sol,
      (SELECT MIN(market_cap_sol) FROM candidate_samples s WHERE s.mint=o.mint) min_market_cap_sol,
      (SELECT liquidity_sol FROM candidate_samples s WHERE s.mint=o.mint ORDER BY market_cap_sol DESC,id LIMIT 1) liquidity_at_peak_sol,
      (SELECT received_at_ms FROM candidate_samples s WHERE s.mint=o.mint ORDER BY market_cap_sol DESC,id LIMIT 1) peak_at_ms,
      (SELECT market_cap_sol FROM candidate_samples s WHERE s.mint=o.mint ORDER BY slot DESC,id DESC LIMIT 1) final_market_cap_sol,
      (SELECT liquidity_sol FROM candidate_samples s WHERE s.mint=o.mint ORDER BY slot DESC,id DESC LIMIT 1) final_liquidity_sol,
      (SELECT received_at_ms FROM candidate_samples s WHERE s.mint=o.mint ORDER BY slot DESC,id DESC LIMIT 1) final_at_ms
      FROM candidate_observations o JOIN candidates c USING(mint) ORDER BY o.started_at_ms`)
      .map(row => ({ ...row,
        peak_change_pct: row.peak_market_cap_sol == null || !row.entry_market_cap_sol ? null : (row.peak_market_cap_sol / row.entry_market_cap_sol - 1) * 100,
        min_change_pct: row.min_market_cap_sol == null || !row.entry_market_cap_sol ? null : (row.min_market_cap_sol / row.entry_market_cap_sol - 1) * 100,
        final_change_pct: row.final_market_cap_sol == null || !row.entry_market_cap_sol ? null : (row.final_market_cap_sol / row.entry_market_cap_sol - 1) * 100,
        time_to_peak_ms: row.peak_at_ms == null ? null : row.peak_at_ms - row.started_at_ms,
        setup_delay_ms: row.subscribed_at_ms == null ? null : row.subscribed_at_ms - row.started_at_ms,
      }));
  }
}
