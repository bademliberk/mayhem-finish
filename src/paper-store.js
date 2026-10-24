export function paperConfig(env = process.env) {
  const number = (name, fallback, min, max, integer = true) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    mode: 'paper', version: 'creation_staged_v2', buyLamports: '10000000',
    activationCap: 2, idleMs: 60000,
    maxTrades: number('MAX_TRADE_COUNT', 25, 1, 100000),
    windowSlots: 5, dropBps: 6000, floorCap: 0.1, ceilingCap: 0.5, profitBps: 3000,
    // Simulation assumptions, not authoritative on-chain fee or fill guarantees.
    swapFeeBps: number('PAPER_SWAP_FEE_BPS', 200, 0, 2000),
    networkFeeLamports: String(number('PAPER_NETWORK_FEE_LAMPORTS', 10000, 0, 10000000)),
    buySlippageBps: number('PAPER_BUY_SLIPPAGE_BPS', 500, 0, 5000),
    sellSlippageBps: number('PAPER_SELL_SLIPPAGE_BPS', 500, 0, 5000),
    maxWatches: number('PAPER_MAX_WATCHES', 10, 1, 10),
    queueLimit: number('PAPER_QUEUE_LIMIT', 1000, 1, 4000),
    maxStateAgeMs: number('PAPER_MAX_STATE_AGE_MS', 5000, 100, 60000),
    orderTtlMs: number('PAPER_ORDER_TTL_MS', 10000, 1000, 60000),
    entriesEnabled: env.PAPER_ENTRIES_ENABLED !== 'false',
  };
}

export class PaperStore {
  constructor(store, cfg) {
    this.store = store; this.cfg = cfg;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_watches (
        mint TEXT PRIMARY KEY REFERENCES mints(mint), curve_address TEXT NOT NULL,
        enrolled_at_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'watching', reason TEXT,
        last_slot INTEGER, last_cap REAL
      );
      CREATE TABLE IF NOT EXISTS paper_orders (
        id INTEGER PRIMARY KEY, mint TEXT NOT NULL REFERENCES paper_watches(mint), side TEXT NOT NULL,
        status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
        signal_signature TEXT, signal_slot INTEGER, reason TEXT NOT NULL, quote_json TEXT NOT NULL,
        assumptions_json TEXT NOT NULL, settled_at_ms INTEGER, fill_json TEXT, error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS paper_pending_mint ON paper_orders(mint) WHERE status='pending';
      CREATE TABLE IF NOT EXISTS paper_positions (
        mint TEXT PRIMARY KEY REFERENCES paper_watches(mint), tokens_raw TEXT NOT NULL,
        entry_cost_lamports TEXT NOT NULL, entry_order_id INTEGER NOT NULL REFERENCES paper_orders(id),
        opened_at_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', exit_order_id INTEGER,
        closed_at_ms INTEGER, exit_net_lamports TEXT, pnl_lamports TEXT
      );
      CREATE TABLE IF NOT EXISTS paper_signals (
        signature TEXT PRIMARY KEY, slot INTEGER NOT NULL, received_at_ms INTEGER NOT NULL,
        mint TEXT, outcome TEXT NOT NULL, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS paper_rejections (id INTEGER PRIMARY KEY, reason TEXT NOT NULL, at_ms INTEGER NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_counters (name TEXT PRIMARY KEY, count INTEGER NOT NULL);
    `);
    // Rebuild only the parent table; preserve child FK names and all historical paper rows.
    if (store.all('PRAGMA foreign_key_list(paper_watches)').some(row => row.table === 'candidates')) {
      store.db.exec('PRAGMA foreign_keys=OFF');
      try {
        store.atomic(() => {
          store.db.exec(`CREATE TABLE paper_watches_new (
            mint TEXT PRIMARY KEY REFERENCES mints(mint), curve_address TEXT NOT NULL,
            enrolled_at_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'watching', reason TEXT,
            last_slot INTEGER, last_cap REAL
          );
          INSERT INTO paper_watches_new SELECT * FROM paper_watches;
          DROP TABLE paper_watches;
          ALTER TABLE paper_watches_new RENAME TO paper_watches;`);
          if (store.all('PRAGMA foreign_key_check').length) throw new Error('Paper watch migration foreign-key failure');
        });
      } finally { store.db.exec('PRAGMA foreign_keys=ON'); }
    }
    const columns = store.all('PRAGMA table_info(paper_watches)').map(row => row.name);
    for (const [name, type] of [['fingerprint', 'TEXT'], ['last_change_ms', 'INTEGER'], ['preprocessed', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!columns.includes(name)) store.db.exec(`ALTER TABLE paper_watches ADD COLUMN ${name} ${type}`);
    }
  }
  count(name) {
    this.store.run('INSERT INTO paper_counters VALUES(?,1) ON CONFLICT(name) DO UPDATE SET count=count+1', name);
  }
  rejection(reason, details = {}, now) {
    this.count(`decode:${reason}`);
    // Bounded public-chain metadata only; never raw transport errors or credential-bearing URLs.
    const key = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(value) ? value : null;
    const safe = { signature: key(details?.signature), slot: Number.isSafeInteger(details?.slot) ? details.slot : null,
      table: key(details?.table), instructions: (details?.instructions ?? []).slice(0,8).map(ix => ({
        program: key(ix.program), discriminator: /^[a-f0-9]{0,16}$/.test(ix.discriminator) ? ix.discriminator : null,
        accounts: Number.isSafeInteger(ix.accounts) ? ix.accounts : null, bytes: Number.isSafeInteger(ix.bytes) ? ix.bytes : null,
      })) };
    if (['slotSubscribe', 'accountSubscribe', 'preprocessedSubscribe'].includes(details?.method)) {
      safe.method = details.method; safe.code = Number.isSafeInteger(details.code) ? details.code : null;
    }
    this.store.run('INSERT INTO paper_rejections(reason,at_ms,detail) VALUES(?,?,?)', reason, now, JSON.stringify(safe));
    this.store.run('DELETE FROM paper_rejections WHERE id NOT IN (SELECT id FROM paper_rejections ORDER BY id DESC LIMIT 100)');
  }
  capacity() {
    const used = this.store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='buy' AND status IN ('pending','filled')").n;
    const bought = this.store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='buy' AND status='filled'").n;
    return { max: this.cfg.maxTrades, successfulBuys: bought, pendingBuys: used - bought, remaining: Math.max(0, this.cfg.maxTrades - used) };
  }
  enroll(mint, now) {
    if (this.store.get('SELECT 1 FROM paper_watches WHERE mint=?', mint)) return false;
    if (!this.cfg.entriesEnabled || !this.capacity().remaining) { this.count('enrollment_entry_cap'); return false; }
    if (this.active().length >= this.cfg.maxWatches) { this.count('enrollment_watch_cap'); return false; }
    const row = this.store.get('SELECT curve_address FROM mints WHERE mint=?', mint);
    if (!row) return false;
    this.store.run('INSERT INTO paper_watches(mint,curve_address,enrolled_at_ms) VALUES(?,?,?)', mint, row.curve_address, now);
    return true;
  }
  active() {
    return this.store.all("SELECT * FROM paper_watches WHERE status IN ('watching','holding','exit_blocked')");
  }
  watch(mint) { return this.store.get('SELECT * FROM paper_watches WHERE mint=?', mint); }
  position(mint) { return this.store.get("SELECT * FROM paper_positions WHERE mint=? AND status='open'", mint); }
  pending() { return this.store.all("SELECT * FROM paper_orders WHERE status='pending' ORDER BY id"); }
  seen(signature, slot, now) {
    const result = this.store.run("INSERT OR IGNORE INTO paper_signals(signature,slot,received_at_ms,outcome) VALUES(?,?,?,'received')", signature, slot, now);
    return Boolean(result.changes);
  }
  signal(signature, mint, outcome, detail = null) {
    this.store.run('UPDATE paper_signals SET mint=?,outcome=?,detail=? WHERE signature=?', mint, outcome, detail, signature);
    this.count(outcome);
  }
  request(mint, side, reason, quote, signal, now) {
    return this.store.atomic(() => {
      if (this.store.get("SELECT 1 FROM paper_orders WHERE mint=? AND status='pending'", mint)) return null;
      if (side === 'buy') {
        if (!this.cfg.entriesEnabled || !this.capacity().remaining || this.watch(mint)?.status !== 'watching' ||
            this.store.get('SELECT 1 FROM paper_positions WHERE mint=?', mint)) return null;
      } else if (!this.position(mint)) return null;
      const result = this.store.run(`INSERT INTO paper_orders
        (mint,side,status,created_at_ms,expires_at_ms,signal_signature,signal_slot,reason,quote_json,assumptions_json)
        VALUES(?,?,'pending',?,?,?,?,?,?,?)`, mint, side, now, now + this.cfg.orderTtlMs,
      signal?.signature ?? null, signal?.slot ?? null, reason, JSON.stringify(quote), JSON.stringify(this.cfg));
      return Number(result.lastInsertRowid);
    });
  }
  cancel(id, now, reason) {
    this.store.run("UPDATE paper_orders SET status='canceled',settled_at_ms=?,error=? WHERE id=? AND status='pending'", now, reason, id);
  }
  fill(order, quote, now) {
    this.store.atomic(() => {
      if (!this.store.get("SELECT 1 FROM paper_orders WHERE id=? AND status='pending'", order.id)) return;
      this.store.run("UPDATE paper_orders SET status='filled',settled_at_ms=?,fill_json=? WHERE id=?", now, JSON.stringify(quote), order.id);
      if (order.side === 'buy') {
        this.store.run(`INSERT INTO paper_positions(mint,tokens_raw,entry_cost_lamports,entry_order_id,opened_at_ms)
          VALUES(?,?,?,?,?)`, order.mint, quote.tokens, quote.cost, order.id, now);
        this.store.run("UPDATE paper_watches SET status='holding',reason=NULL WHERE mint=?", order.mint);
      } else {
        const position = this.position(order.mint);
        this.store.run(`UPDATE paper_positions SET status='closed',exit_order_id=?,closed_at_ms=?,exit_net_lamports=?,pnl_lamports=? WHERE mint=?`,
          order.id, now, quote.net, (BigInt(quote.net) - BigInt(position.entry_cost_lamports)).toString(), order.mint);
        this.store.run("UPDATE paper_watches SET status='closed',reason=? WHERE mint=?", order.reason, order.mint);
      }
    });
  }
  report() {
    const positions = this.store.all('SELECT * FROM paper_positions ORDER BY opened_at_ms');
    return {
      mode: 'paper', assumptions: this.cfg, capacity: this.capacity(),
      coverage: this.store.all(`SELECT mint,status,last_cap,last_change_ms,preprocessed FROM paper_watches
        WHERE status IN ('watching','holding','exit_blocked')`),
      realizedPnlLamports: positions.reduce((sum, row) => sum + BigInt(row.pnl_lamports ?? '0'), 0n).toString(),
      watches: this.store.all('SELECT status,COUNT(*) count FROM paper_watches GROUP BY status'),
      orders: this.store.all('SELECT side,status,COUNT(*) count FROM paper_orders GROUP BY side,status'),
      positions,
      recentOrders: this.store.all('SELECT * FROM paper_orders ORDER BY id DESC LIMIT 25'),
      recentSignals: this.store.all('SELECT * FROM paper_signals ORDER BY received_at_ms DESC LIMIT 25'),
      recentRejections: this.store.all('SELECT * FROM paper_rejections ORDER BY id DESC LIMIT 25'),
      counters: this.store.all('SELECT * FROM paper_counters ORDER BY name'),
      blocked: this.store.all("SELECT * FROM paper_watches WHERE status='exit_blocked'"),
      usage: this.store.all("SELECT * FROM usage WHERE source IN ('preprocessed','preprocessed_bytes') OR method='paper_account_received_bytes' ORDER BY day,source,method"),
      note: 'Hypothetical fills using later executed reserves and configured fees; not actual trades, balances or achievable returns. Unsupported transactions are skipped. Graduation exits require manual attention; no AMM execution.',
    };
  }
}
