import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { addresses, screeningPolicy } from './config.js';
import { migrateObservations } from './observations.js';
import { filterReasons } from './chain.js';

export class Store {
  constructor(path, cfg) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.cfg = cfg;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mints (
        mint TEXT PRIMARY KEY, state_address TEXT NOT NULL, curve_address TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_check_at INTEGER NOT NULL, next_check INTEGER NOT NULL, deadline INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'monitoring', history_complete INTEGER NOT NULL DEFAULT 0,
        name TEXT, symbol TEXT, initial_state_base64 TEXT, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS due_mints ON mints(status,next_check);
      CREATE TABLE IF NOT EXISTS mayhem_trades (
        signature TEXT NOT NULL, event_index INTEGER NOT NULL, mint TEXT NOT NULL,
        traded_at INTEGER NOT NULL, slot INTEGER NOT NULL, side TEXT NOT NULL,
        sol_lamports TEXT NOT NULL, token_raw TEXT NOT NULL,
        PRIMARY KEY(signature,event_index)
      );
      CREATE INDEX IF NOT EXISTS mint_trades ON mayhem_trades(mint,traded_at);
      CREATE TABLE IF NOT EXISTS mayhem_activity (
        mint TEXT PRIMARY KEY REFERENCES mints(mint), created_at INTEGER NOT NULL,
        first_trade_at INTEGER, observed_first_trade_at INTEGER, last_trade_at INTEGER, trade_count INTEGER NOT NULL DEFAULT 0,
        observation_ended_at INTEGER, end_reason TEXT, history_complete INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIEW IF NOT EXISTS activity_durations AS SELECT *,
        last_trade_at-first_trade_at AS trading_span_seconds,
        last_trade_at-created_at AS last_trade_age_from_creation_seconds
        FROM mayhem_activity;
      CREATE TABLE IF NOT EXISTS evaluations (
        id INTEGER PRIMARY KEY, mint TEXT NOT NULL REFERENCES mints(mint), checked_at INTEGER NOT NULL,
        slot INTEGER NOT NULL, state_base64 TEXT NOT NULL, market_cap_sol REAL NOT NULL,
        liquidity_sol REAL NOT NULL, last_trade_at INTEGER, trade_age_seconds INTEGER,
        category TEXT NOT NULL, passes_filters INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidates (
        mint TEXT PRIMARY KEY REFERENCES mints(mint), first_seen INTEGER NOT NULL,
        evaluation_id INTEGER NOT NULL REFERENCES evaluations(id)
      );
      CREATE TABLE IF NOT EXISTS long_inactive (
        mint TEXT PRIMARY KEY REFERENCES mints(mint), first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL, evaluation_id INTEGER NOT NULL REFERENCES evaluations(id),
        recovered_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS no_trades (
        mint TEXT PRIMARY KEY REFERENCES mints(mint), checked_at INTEGER NOT NULL,
        evaluation_id INTEGER NOT NULL REFERENCES evaluations(id)
      );
      CREATE TABLE IF NOT EXISTS unqualified (
        mint TEXT PRIMARY KEY REFERENCES mints(mint), checked_at INTEGER NOT NULL,
        evaluation_id INTEGER NOT NULL REFERENCES evaluations(id), reasons_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue (
        signature TEXT PRIMARY KEY, slot INTEGER NOT NULL, queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS quarantined_transactions (
        signature TEXT PRIMARY KEY, slot INTEGER NOT NULL, queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL, reason TEXT NOT NULL, quarantined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graduations (
        mint TEXT PRIMARY KEY REFERENCES mints(mint), detected_at INTEGER NOT NULL,
        slot INTEGER NOT NULL, state_base64 TEXT, curve_base64 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed (signature TEXT PRIMARY KEY, slot INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (address TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coverage (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, started_at INTEGER NOT NULL,
        ended_at INTEGER, detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        day TEXT NOT NULL, source TEXT NOT NULL, method TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(day,source,method)
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.atomic(() => {
      this.run(`INSERT OR IGNORE INTO quarantined_transactions
        SELECT signature,slot,queued_at,attempts,last_error,unixepoch() FROM queue
        WHERE last_error='Transaction logs truncated; history remains incomplete'`);
      this.run('DELETE FROM queue WHERE signature IN (SELECT signature FROM quarantined_transactions)');
    });
    if (!this.all('PRAGMA table_info(evaluations)').some(column => column.name === 'history_scope')) {
      this.db.exec("ALTER TABLE evaluations ADD COLUMN history_scope TEXT NOT NULL DEFAULT 'legacy'");
    }
    if (!this.all('PRAGMA table_info(mints)').some(column => column.name === 'last_check_at')) {
      this.db.exec('ALTER TABLE mints ADD COLUMN last_check_at INTEGER');
      this.run(`UPDATE mints SET last_check_at=COALESCE(
        (SELECT MAX(checked_at) FROM evaluations WHERE evaluations.mint=mints.mint),created_at)`);
      this.run("UPDATE mints SET next_check=last_check_at+? WHERE status='monitoring'", cfg.recheck);
    }
    if (!this.all('PRAGMA table_info(mayhem_activity)').some(column => column.name === 'observed_first_trade_at')) {
      this.db.exec('ALTER TABLE mayhem_activity ADD COLUMN observed_first_trade_at INTEGER');
      this.run('UPDATE mayhem_activity SET observed_first_trade_at=first_trade_at,first_trade_at=created_at');
    }
    this.run(`UPDATE mints SET status='long_inactive' WHERE status='monitoring'
      AND mint IN (SELECT mint FROM long_inactive)`);
    // Existing candidate records also stop polling after upgrading the collector.
    this.run(`UPDATE mints SET status='qualified' WHERE status='monitoring'
      AND mint IN (SELECT mint FROM candidates)`);
    if (!this.get("SELECT 1 FROM metadata WHERE key='terminal_outcomes_v1'")) {
      this.atomic(() => {
        const rows = this.all(`SELECT e.* FROM evaluations e JOIN mints m USING(mint)
          WHERE m.status='monitoring' AND e.id=(SELECT MAX(id) FROM evaluations WHERE mint=m.mint)
          AND e.category IN ('never_traded','unqualified','inactive_nonqualifying')`);
        for (const row of rows) {
          const noTrade = row.category === 'never_traded';
          if (noTrade) this.run('INSERT OR IGNORE INTO no_trades VALUES(?,?,?)', row.mint, row.checked_at, row.id);
          else this.run('INSERT OR IGNORE INTO unqualified VALUES(?,?,?,?)', row.mint, row.checked_at, row.id,
            JSON.stringify(filterReasons({ marketCap: row.market_cap_sol, liquidity: row.liquidity_sol }, cfg)));
          this.run('UPDATE mints SET status=? WHERE mint=?', noTrade ? 'no_trades' : 'unqualified', row.mint);
        }
        this.run("INSERT INTO metadata VALUES('terminal_outcomes_v1','1')");
      });
    }
    this.atomic(() => migrateObservations(this));
    this.policy = cfg.trackingSeconds ? screeningPolicy(cfg) : 'legacy';
  }
  activatePolicy(now = Math.floor(Date.now() / 1000)) {
    if (this.policy === 'legacy' || this.get("SELECT value FROM metadata WHERE key='screening_policy'")?.value === this.policy) return;
    this.atomic(() => {
      // Keep explicit error backoffs; only reschedule ordinary pending checks.
      this.run(`UPDATE mints SET next_check=last_check_at+CASE WHEN last_check_at=created_at THEN ? ELSE ? END
        WHERE status='monitoring' AND last_error IS NULL`, this.cfg.firstCheck, this.cfg.recheck);
      this.run("INSERT INTO metadata VALUES('screening_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", this.policy);
      this.run("INSERT INTO metadata VALUES('policy_started_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(now));
    });
  }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addMint(event) {
    const { state, curve } = addresses(event.mint);
    this.run(`INSERT OR IGNORE INTO mints(mint,state_address,curve_address,created_at,last_check_at,next_check,deadline,name,symbol)
      VALUES(?,?,?,?,?,?,?,?,?)`, event.mint, state, curve, event.timestamp, event.timestamp,
    event.timestamp + this.cfg.firstCheck, event.timestamp + this.cfg.horizon, event.name ?? '', event.symbol ?? '');
    this.run('INSERT OR IGNORE INTO mayhem_activity(mint,created_at,first_trade_at) VALUES(?,?,?)', event.mint, event.timestamp, event.timestamp);
    this.refreshActivity(event.mint);
  }
  refreshActivity(mint) {
    const row = this.get('SELECT * FROM mints WHERE mint=?', mint);
    if (!row) return;
    const activity = this.get('SELECT * FROM mayhem_activity WHERE mint=?', mint);
    const end = Math.min(row.deadline, activity.observation_ended_at ?? row.deadline);
    const stats = this.get(`SELECT MIN(traded_at) first_at, MAX(traded_at) last_at, COUNT(*) n
      FROM mayhem_trades WHERE mint=? AND traded_at>=? AND traded_at<=?`, mint, row.created_at, end);
    this.run('UPDATE mayhem_activity SET first_trade_at=created_at,observed_first_trade_at=?,last_trade_at=?,trade_count=? WHERE mint=?',
      stats.first_at, stats.last_at, stats.n, mint);
    if (stats.last_at != null) this.run(`UPDATE long_inactive SET recovered_at=?
      WHERE mint=? AND recovered_at IS NULL AND last_seen<?`, stats.last_at, mint, stats.last_at);
  }
  apply(signature, slot, events) {
    this.atomic(() => {
      if (!this.get('SELECT 1 FROM processed WHERE signature=?', signature)) {
        for (const event of events) {
          if (event.type === 'create') this.addMint(event);
          if (event.type === 'trade') {
            this.run(`INSERT OR IGNORE INTO mayhem_trades VALUES(?,?,?,?,?,?,?,?)`, signature,
              event.index, event.mint, event.timestamp, event.slot, event.buy ? 'buy' : 'sell', event.solAmount, event.tokenAmount);
            this.refreshActivity(event.mint);
          }
        }
        this.run('INSERT INTO processed VALUES(?,?)', signature, slot);
      }
      this.run('DELETE FROM queue WHERE signature=?', signature);
      this.run('DELETE FROM quarantined_transactions WHERE signature=?', signature);
    });
  }
  quarantine(signature, slot, now, reason) {
    this.atomic(() => {
      const queued = this.get('SELECT * FROM queue WHERE signature=?', signature);
      this.run('INSERT OR IGNORE INTO quarantined_transactions VALUES(?,?,?,?,?,?)',
        signature, slot, queued?.queued_at ?? now, (queued?.attempts ?? 0) + 1, reason, now);
      this.run('DELETE FROM queue WHERE signature=?', signature);
    });
  }
  graduate(mint, now, slot, state, curve) {
    this.atomic(() => {
      this.run('INSERT OR IGNORE INTO graduations VALUES(?,?,?,?,?)', mint, now, slot, state, curve);
      this.run('UPDATE mints SET last_check_at=?,initial_state_base64=COALESCE(initial_state_base64,?) WHERE mint=?', now, state, mint);
      this.finish(mint, now, 'graduated');
    });
  }
  enqueue(signature, slot, now) {
    if (!this.get('SELECT 1 FROM processed WHERE signature=?', signature) &&
        !this.get('SELECT 1 FROM quarantined_transactions WHERE signature=?', signature)) {
      this.run('INSERT OR IGNORE INTO queue(signature,slot,queued_at) VALUES(?,?,?)', signature, slot, now);
    }
  }
  cursor(address) { return JSON.parse(this.get('SELECT data FROM cursors WHERE address=?', address)?.data ?? '{}'); }
  setCursor(address, data) {
    this.run('INSERT INTO cursors VALUES(?,?) ON CONFLICT(address) DO UPDATE SET data=excluded.data', address, JSON.stringify(data));
  }
  completeHistory(mint) {
    this.run('UPDATE mints SET history_complete=1 WHERE mint=?', mint);
    this.run('UPDATE mayhem_activity SET history_complete=1 WHERE mint=?', mint);
  }
  finish(mint, now, reason) {
    this.run('UPDATE mints SET status=?,last_error=NULL WHERE mint=?', reason, mint);
    this.run('UPDATE mayhem_activity SET observation_ended_at=?,end_reason=? WHERE mint=?', now, reason, mint);
    this.refreshActivity(mint);
  }
  evaluate(mint, now, slot, state, curve, result, lastTrade) {
    this.atomic(() => {
      const inserted = this.run(`INSERT INTO evaluations(mint,checked_at,slot,state_base64,market_cap_sol,
        liquidity_sol,last_trade_at,trade_age_seconds,category,passes_filters,history_scope,screening_policy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      mint, now, slot, state, curve.marketCap, curve.liquidity, lastTrade, result.age, result.category, Number(result.passes),
      result.historyScope ?? 'legacy', this.policy);
      this.run('UPDATE mints SET initial_state_base64=COALESCE(initial_state_base64,?),last_check_at=?,next_check=?,last_error=NULL WHERE mint=?',
        state, now, now + this.cfg.recheck, mint);
      if (result.category === 'candidate') {
        const candidate = this.run(`INSERT OR IGNORE INTO candidates
          (mint,first_seen,evaluation_id,market_cap_sol,liquidity_sol,screening_policy) VALUES(?,?,?,?,?,?)`,
        mint, now, inserted.lastInsertRowid, curve.marketCap, curve.liquidity, this.policy);
        if (candidate.changes) {
          const started = result.detectedAtMs ?? now * 1000;
          this.run(`INSERT INTO candidate_observations(mint,started_at_ms,deadline_ms,status) VALUES(?,?,?,?)`,
            mint, started, started + (this.cfg.trackingSeconds ?? 0) * 1000,
            this.cfg.trackingSeconds ? 'tracking' : 'not_tracked');
        }
        // Never schedule this candidate again.
        this.run("UPDATE mints SET status='qualified' WHERE mint=?", mint);
      }
      if (result.category === 'long_inactive') {
        this.run(`INSERT INTO long_inactive VALUES(?,?,?,?,NULL) ON CONFLICT(mint) DO UPDATE SET
          last_seen=excluded.last_seen,evaluation_id=excluded.evaluation_id,recovered_at=NULL`, mint, now, now, inserted.lastInsertRowid);
        this.run("UPDATE mints SET status='long_inactive' WHERE mint=? AND status!='qualified'", mint);
      }
      if (result.category === 'never_traded') {
        this.run('INSERT OR IGNORE INTO no_trades VALUES(?,?,?)', mint, now, inserted.lastInsertRowid);
        this.run("UPDATE mints SET status='no_trades' WHERE mint=?", mint);
      }
      if (result.category === 'unqualified') {
        this.run('INSERT OR IGNORE INTO unqualified VALUES(?,?,?,?)', mint, now, inserted.lastInsertRowid,
          JSON.stringify(result.reasons ?? filterReasons(curve, this.cfg)));
        this.run("UPDATE mints SET status='unqualified' WHERE mint=?", mint);
      }
      if (['candidate', 'long_inactive', 'unqualified', 'never_traded'].includes(result.category)) {
        this.run('UPDATE mayhem_activity SET observation_ended_at=?,end_reason=? WHERE mint=?', now, result.category, mint);
      }
      if (result.category === 'graduated') this.finish(mint, now, 'graduated');
    });
  }
  coverage(kind, now, detail) {
    return Number(this.run('INSERT INTO coverage(kind,started_at,detail) VALUES(?,?,?)', kind, now, detail).lastInsertRowid);
  }
  usage(source, method, amount = 1) {
    const day = new Date().toISOString().slice(0, 10);
    this.run(`INSERT INTO usage VALUES(?,?,?,?) ON CONFLICT(day,source,method)
      DO UPDATE SET amount=amount+excluded.amount`, day, source, method, amount);
  }
  close() { this.db.close(); }
}
