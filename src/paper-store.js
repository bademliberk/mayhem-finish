import { PUMP } from './config.js';
import { CURVE_VALIDATION_CODES, curveLayoutEvidence } from './chain.js';
import { reserves, exitQuote, fullSaleGross } from './paper-math.js';
import { readFeedHealth } from './feed-health.js';
import { trialProfiles } from './paper-profiles.js';
import { paperPerformance } from './paper-performance.js';
import { safeOrderDiagnostics, readOrderDiagnostics } from './paper-diagnostics.js';

export function paperConfig(env = process.env, profile = null) {
  const number = (name, fallback, min, max, integer = true) => {
    // Blank values (e.g. `PAPER_SWAP_FEE_BPS=`) mean unset, never Number('') === 0.
    const raw = env[name];
    const value = Number(raw == null || String(raw).trim() === '' ? fallback : raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`Invalid ${name}`);
    return value;
  };
  const flag = name => {
    const raw = String(env[name] ?? '').trim().toLowerCase();
    if (raw === '' || raw === 'false' || raw === '0') return false;
    if (raw === 'true' || raw === '1') return true;
    throw new Error(`Invalid ${name}`);
  };
  if (profile !== null && !Object.hasOwn(trialProfiles, profile)) throw new Error('Unknown paper trial profile');
  return {
    mode: 'paper', version: 'creation_staged_v2', buyLamports: '10000000',
    profile, entryQualityEnabled: false,
    minEntryLiquidityMultiple: number('PAPER_MIN_LIQUIDITY_MULTIPLE', 2, 0, 100),
    maxRoundTripLossBps: number('PAPER_MAX_ROUND_TRIP_LOSS_BPS', 1000, 0, 10000),
    projectionWindowSlots: 5, signalValiditySlots: 5,
    activationCap: 2, idleMs: 10000, rotationIdleMs: 60000,
    maxTrades: number('MAX_TRADE_COUNT', 25, 1, 100000),
    windowSlots: 5, dropBps: 6000, floorCap: 0.1, ceilingCap: 0.5, profitBps: 3000,
    // Simulation assumptions, not authoritative on-chain fee or fill guarantees.
    swapFeeBps: number('PAPER_SWAP_FEE_BPS', 200, 0, 2000),
    networkFeeLamports: String(number('PAPER_NETWORK_FEE_LAMPORTS', 10000, 0, 10000000)),
    buySlippageBps: number('PAPER_BUY_SLIPPAGE_BPS', 500, 0, 5000),
    sellSlippageBps: number('PAPER_SELL_SLIPPAGE_BPS', 500, 0, 5000),
    maxWatches: number('PAPER_MAX_WATCHES', 10, 1, 20),
    queueLimit: number('PAPER_QUEUE_LIMIT', 1000, 1, 4000),
    maxStateAgeMs: number('PAPER_MAX_STATE_AGE_MS', 5000, 100, 60000),
    orderTtlMs: number('PAPER_ORDER_TTL_MS', 10000, 1000, 60000),
    entriesEnabled: env.PAPER_ENTRIES_ENABLED !== 'false',
    ...(profile === null ? {} : { maxWatches: 10, ...trialProfiles[profile] }),
    ...(profile !== 'agent-sell-liquidity' ? {} : {
      version: 'agent_sell_liquidity_v3_terminal_exit',
      maxWatches: number('PAPER_AGENT_MAX_WATCHES', 20, 1, 1000),
      fractionBps: number('PAPER_AGENT_FRACTION_BPS', 1200, 1, 10000),
      maxSwapBudgetLamports: String(number('PAPER_AGENT_MAX_SWAP_LAMPORTS', 10000000, 1, 1e12)),
      minRealSolLamports: String(number('PAPER_AGENT_MIN_REAL_SOL_LAMPORTS', 10000000, 1, 1e12)),
      maxExposureLamports: String(number('PAPER_AGENT_MAX_EXPOSURE_LAMPORTS', 50000000, 1, 1e13)),
      holdSlots: number('PAPER_AGENT_HOLD_SLOTS', 80, 1, 100000),
      profitBps: number('PAPER_AGENT_PROFIT_BPS', 3000, 0, 100000),
      liquidityExitMultiple: number('PAPER_AGENT_EXIT_MULTIPLE', 2, 0, 100),
      swapFeeBps: number('PAPER_SWAP_FEE_BPS', 125, 0, 2000),
      // Opt-in stop-loss on the full-sale net: 6000 = exit once the position is worth 60% less than it cost.
      // Omitted when unset or 0 so existing trial identities are unchanged.
      ...(() => { const bps = number('PAPER_AGENT_STOP_LOSS_BPS', 0, 0, 9999); return bps ? { stopLossBps: bps } : {}; })(),
      // Opt-in: skip entries whose fraction-based budget would reach PAPER_AGENT_MAX_SWAP_LAMPORTS.
      // Omitted when off so existing trial identities are unchanged.
      ...(flag('PAPER_AGENT_SKIP_CAPPED') ? { skipCappedEntries: true } : {}),
    }),
  };
}

// Live agent trial: same strategy assumptions, separate identity so paper and live (or dry-run) databases never mix.
// Risk limits (wallet floor, max loss) are runtime settings, not identity, so they can change without a new database.
export function liveConfig(env = process.env) {
  const raw = String(env.LIVE_DRY_RUN ?? '').trim().toLowerCase();
  if (!['', 'false', '0', 'true', '1'].includes(raw)) throw new Error('Invalid LIVE_DRY_RUN');
  return { ...paperConfig(env, 'agent-sell-liquidity'), mode: ['true', '1'].includes(raw) ? 'live_dry_run' : 'live' };
}

const FAULT_CODES = ['missing_account', 'wrong_owner', 'invalid_data', 'invalid_curve', 'not_mayhem', 'processing_error'];
const FAULT_SAMPLE_LIMIT = 100;
const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Reduce any fault-like input to fixed, bounded, payload-free fields (used for new and backfilled samples).
function safeFault(input, slot, account) {
  const data = account?.data;
  const code = FAULT_CODES.includes(input.code) ? input.code : 'processing_error';
  return { mint: BASE58_MINT.test(input.mint) ? input.mint : null,
    slot: Number.isSafeInteger(slot) ? slot : null, code,
    subtype: code === 'invalid_curve' && CURVE_VALIDATION_CODES.includes(input.subtype) ? input.subtype : null,
    present: account != null, ownerMatches: account?.owner === PUMP,
    base64: Array.isArray(data) && data[1] === 'base64',
    bytes: Array.isArray(data) && typeof data[0] === 'string' ? Buffer.byteLength(data[0], 'base64') : null,
    ...curveLayoutEvidence(account) };
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
    for (const [name, type] of [['fingerprint', 'TEXT'], ['last_change_ms', 'INTEGER'], ['preprocessed', 'INTEGER NOT NULL DEFAULT 0'], ['account_error', 'TEXT'], ['last_observed_ms', 'INTEGER']]) {
      if (!columns.includes(name)) store.db.exec(`ALTER TABLE paper_watches ADD COLUMN ${name} ${type}`);
    }
    if (!store.all('PRAGMA table_info(paper_orders)').some(row => row.name === 'diagnostics_json')) {
      store.db.exec('ALTER TABLE paper_orders ADD COLUMN diagnostics_json TEXT');
    }
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_agent_cursors (
        mint TEXT PRIMARY KEY REFERENCES paper_watches(mint), slot INTEGER NOT NULL,
        signature TEXT NOT NULL, event_index INTEGER NOT NULL, revision INTEGER NOT NULL, ambiguous INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS paper_agent_events (
        id INTEGER PRIMARY KEY, signature TEXT NOT NULL, mint TEXT NOT NULL, event_index INTEGER NOT NULL,
        slot INTEGER NOT NULL, received_at_ms INTEGER NOT NULL, outcome TEXT NOT NULL, detail TEXT,
        UNIQUE(signature,mint,event_index)
      );
    `);
    const positionColumns = store.all('PRAGMA table_info(paper_positions)').map(row => row.name);
    for (const name of ['entry_snapshot_slot', 'timeout_slot']) {
      if (!positionColumns.includes(name)) store.db.exec(`ALTER TABLE paper_positions ADD COLUMN ${name} INTEGER`);
    }
    // Durable account-fault samples, separate from decoder-rejection churn. A one-time copy of the
    // existing safe samples happens only when this table is first created (never re-copied after pruning).
    const faultsExisted = store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_account_faults'") != null;
    store.atomic(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS paper_account_faults (
        id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, mint TEXT, slot INTEGER, code TEXT NOT NULL, subtype TEXT,
        present INTEGER NOT NULL, owner_matches INTEGER NOT NULL, base64 INTEGER NOT NULL, bytes INTEGER,
        source_rejection_id INTEGER UNIQUE,
        curve_discriminator_matches INTEGER, quote_layout TEXT, quote_mint_observed TEXT
      )`);
      const faultColumns = store.all('PRAGMA table_info(paper_account_faults)').map(row => row.name);
      for (const [name, type] of [['curve_discriminator_matches', 'INTEGER'], ['quote_layout', 'TEXT'], ['quote_mint_observed', 'TEXT']]) {
        if (!faultColumns.includes(name)) store.db.exec(`ALTER TABLE paper_account_faults ADD COLUMN ${name} ${type}`);
      }
      if (faultsExisted) return;
      for (const row of store.all("SELECT id,at_ms,detail FROM paper_rejections WHERE reason='invalid_account' ORDER BY id DESC LIMIT ?", FAULT_SAMPLE_LIMIT).reverse()) {
        let old;
        try { old = JSON.parse(row.detail); } catch { continue; }
        if (old === null || typeof old !== 'object' || Array.isArray(old)) continue;
        // Reconstruct only the safe summary fields; historical subtype detail was never recorded.
        const fault = safeFault(old, old.slot, null);
        const bytes = Number.isSafeInteger(old.bytes) && old.bytes >= 0 ? old.bytes : null;
        store.run(`INSERT OR IGNORE INTO paper_account_faults(at_ms,mint,slot,code,subtype,present,owner_matches,base64,bytes,source_rejection_id)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, Number.isSafeInteger(row.at_ms) ? row.at_ms : 0, fault.mint, fault.slot, fault.code, null,
        old.present === true ? 1 : 0, old.ownerMatches === true ? 1 : 0, old.base64 === true ? 1 : 0, bytes, row.id);
      }
    });
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
    if (['slotSubscribe', 'accountSubscribe', 'preprocessedSubscribe', 'transactionSubscribe'].includes(details?.method)) {
      safe.method = details.method; safe.code = Number.isSafeInteger(details.code) ? details.code : null;
    }
    this.store.run('INSERT INTO paper_rejections(reason,at_ms,detail) VALUES(?,?,?)', reason, now, JSON.stringify(safe));
    this.store.run('DELETE FROM paper_rejections WHERE id NOT IN (SELECT id FROM paper_rejections ORDER BY id DESC LIMIT 100)');
  }
  accountFault(mint, slot, account, code, now, subtype = null) {
    const detail = safeFault({ mint, code, subtype }, slot, account);
    this.count(`account:${detail.code}`);
    this.store.run('INSERT INTO paper_rejections(reason,at_ms,detail) VALUES(?,?,?)', 'invalid_account', now, JSON.stringify(detail));
    this.store.run('DELETE FROM paper_rejections WHERE id NOT IN (SELECT id FROM paper_rejections ORDER BY id DESC LIMIT 100)');
    this.store.run(`INSERT INTO paper_account_faults(at_ms,mint,slot,code,subtype,present,owner_matches,base64,bytes,
      curve_discriminator_matches,quote_layout,quote_mint_observed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    Number.isSafeInteger(now) ? now : 0, detail.mint, detail.slot, detail.code, detail.subtype,
    Number(detail.present), Number(detail.ownerMatches), Number(detail.base64), detail.bytes,
    detail.curveDiscriminatorMatches == null ? null : Number(detail.curveDiscriminatorMatches), detail.quoteLayout, detail.quoteMintObserved);
    this.store.run(`DELETE FROM paper_account_faults WHERE id NOT IN (SELECT id FROM paper_account_faults ORDER BY id DESC LIMIT ${FAULT_SAMPLE_LIMIT})`);
  }
  capacity() {
    const used = this.store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='buy' AND status IN ('pending','filled')").n;
    const bought = this.store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='buy' AND status='filled'").n;
    return { max: this.cfg.maxTrades, successfulBuys: bought, pendingBuys: used - bought, remaining: Math.max(0, this.cfg.maxTrades - used) };
  }
  enroll(mint, now) { return this.admit(mint, now).enrolled; }
  admit(mint, now, rotate = false) {
    return this.store.atomic(() => {
      const skipped = { enrolled: false, evicted: null };
      if (this.watch(mint)) return skipped;
      if (!this.cfg.entriesEnabled || !this.capacity().remaining) { this.count('enrollment_entry_cap'); return skipped; }
      const row = this.store.get('SELECT curve_address FROM mints WHERE mint=?', mint);
      if (!row) return skipped;
      let evicted = null;
      if (this.active().length >= this.cfg.maxWatches) {
        const pending = new Set(this.pending().map(order => order.mint));
        const eligible = rotate ? this.active().filter(watch => watch.status === 'watching' &&
          !this.position(watch.mint) && !pending.has(watch.mint) &&
          now - (watch.last_change_ms ?? watch.enrolled_at_ms) >= this.cfg.rotationIdleMs)
          .sort((a, b) => (a.last_change_ms ?? a.enrolled_at_ms) - (b.last_change_ms ?? b.enrolled_at_ms) ||
            a.enrolled_at_ms - b.enrolled_at_ms || a.mint.localeCompare(b.mint)) : [];
        if (!eligible.length) { this.count('enrollment_watch_cap'); return skipped; }
        evicted = eligible[0].mint;
        this.store.run("UPDATE paper_watches SET status='stopped',reason='idle_rotation',preprocessed=0 WHERE mint=?", evicted);
        this.count('idle_rotation');
      }
      this.store.run('INSERT INTO paper_watches(mint,curve_address,enrolled_at_ms) VALUES(?,?,?)', mint, row.curve_address, now);
      return { enrolled: true, evicted };
    });
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
  agentCursor(mint) { return this.store.get('SELECT * FROM paper_agent_cursors WHERE mint=?', mint); }
  advanceAgent(event, now) {
    const old = this.agentCursor(event.mint);
    let outcome = 'received', revision = old?.revision ?? 0;
    if (old && event.slot < old.slot) outcome = 'older_sell';
    else if (old && event.slot === old.slot) {
      if (old.signature === event.signature && old.event_index === event.index) outcome = 'duplicate_sell';
      else {
        outcome = 'ambiguous_sell_slot';
        if (!old.ambiguous) this.store.run('UPDATE paper_agent_cursors SET ambiguous=1,revision=revision+1 WHERE mint=?', event.mint);
        revision += old.ambiguous ? 0 : 1;
      }
    } else {
      revision++;
      this.store.run(`INSERT INTO paper_agent_cursors VALUES(?,?,?,?,?,0)
        ON CONFLICT(mint) DO UPDATE SET slot=excluded.slot,signature=excluded.signature,
        event_index=excluded.event_index,revision=excluded.revision,ambiguous=0`,
      event.mint, event.slot, event.signature, event.index, revision);
    }
    this.store.run(`INSERT OR IGNORE INTO paper_agent_events(signature,mint,event_index,slot,received_at_ms,outcome)
      VALUES(?,?,?,?,?,?)`, event.signature, event.mint, event.index, event.slot, now, outcome);
    this.store.run('DELETE FROM paper_agent_events WHERE id NOT IN (SELECT id FROM paper_agent_events ORDER BY id DESC LIMIT 1000)');
    if (outcome !== 'received') this.count(`agent:${outcome}`);
    return { outcome, revision };
  }
  agentOutcome(event, outcome, detail = null) {
    this.store.run('UPDATE paper_agent_events SET outcome=?,detail=? WHERE signature=? AND mint=? AND event_index=?',
      outcome, detail == null ? null : JSON.stringify(detail), event.signature, event.mint, event.index);
    this.count(`agent:${outcome}`);
  }
  exposure(excludeOrder = null) {
    const open = this.store.all("SELECT entry_cost_lamports FROM paper_positions WHERE status='open'")
      .reduce((sum, row) => sum + BigInt(row.entry_cost_lamports), 0n);
    const reserved = this.pending().filter(row => row.side === 'buy' && row.id !== excludeOrder).reduce((sum, row) => {
      const quote = JSON.parse(row.quote_json), cfg = JSON.parse(row.assumptions_json);
      return sum + (quote.requestedBudgetLamports == null ? BigInt(quote.cost) :
        BigInt(quote.requestedBudgetLamports) + BigInt(cfg.networkFeeLamports));
    }, 0n);
    return { open, reserved, total: open + reserved };
  }
  exposureAllows(cost, excludeOrder = null) {
    return this.cfg.strategy !== 'agent-sell-liquidity' ||
      this.exposure(excludeOrder).total + cost <= BigInt(this.cfg.maxExposureLamports);
  }
  request(mint, side, reason, quote, signal, now) {
    // SAVEPOINT supports atomic signal/cursor admission without nesting BEGIN transactions.
    this.store.db.exec('SAVEPOINT paper_request');
    try {
      const id = this.requestWithinTransaction(mint, side, reason, quote, signal, now);
      this.store.db.exec('RELEASE paper_request'); return id;
    } catch (error) {
      this.store.db.exec('ROLLBACK TO paper_request; RELEASE paper_request'); throw error;
    }
  }
  requestWithinTransaction(mint, side, reason, quote, signal, now) {
    if (this.store.get("SELECT 1 FROM paper_orders WHERE mint=? AND status='pending'", mint)) return null;
    if (side === 'buy') {
      if (this.cfg.strategy === 'agent-sell-liquidity') {
        const reservation = quote.requestedBudgetLamports == null ? BigInt(quote.cost) :
          BigInt(quote.requestedBudgetLamports) + BigInt(this.cfg.networkFeeLamports);
        if (!this.exposureAllows(reservation)) { this.count('agent:exposure_cap'); return null; }
      }
      if (!this.cfg.entriesEnabled || !this.capacity().remaining || this.watch(mint)?.status !== 'watching' ||
          this.store.get('SELECT 1 FROM paper_positions WHERE mint=?', mint)) return null;
    } else if (!this.position(mint)) return null;
    const result = this.store.run(`INSERT INTO paper_orders
      (mint,side,status,created_at_ms,expires_at_ms,signal_signature,signal_slot,reason,quote_json,assumptions_json)
      VALUES(?,?,'pending',?,?,?,?,?,?,?)`, mint, side, now, now + this.cfg.orderTtlMs,
    signal?.signature ?? null, signal?.slot ?? null, reason, JSON.stringify(quote), JSON.stringify(this.cfg));
    return Number(result.lastInsertRowid);
  }
  diagnose(id, patch) {
    const order = this.store.get("SELECT diagnostics_json FROM paper_orders WHERE id=? AND status='pending'", id);
    if (!order) return;
    const value = { ...readOrderDiagnostics(order.diagnostics_json), ...safeOrderDiagnostics(patch) };
    this.store.run("UPDATE paper_orders SET diagnostics_json=? WHERE id=? AND status='pending'", JSON.stringify(value), id);
  }
  cancel(id, now, reason, diagnostics) {
    if (!diagnostics) return this.store.run("UPDATE paper_orders SET status='canceled',settled_at_ms=?,error=? WHERE id=? AND status='pending'", now, reason, id);
    const order = this.store.get("SELECT diagnostics_json FROM paper_orders WHERE id=? AND status='pending'", id);
    if (!order) return { changes: 0 };
    const value = { ...readOrderDiagnostics(order.diagnostics_json), ...safeOrderDiagnostics(diagnostics) };
    // One terminal write, also safe inside the engine's existing intent/restart transactions.
    return this.store.run("UPDATE paper_orders SET status='canceled',settled_at_ms=?,error=?,diagnostics_json=? WHERE id=? AND status='pending'",
      now, reason, JSON.stringify(value), id);
  }
  writeOff(mint, reason, quote, now) {
    return this.store.atomic(() => {
      const position = this.position(mint);
      if (!position || position.entry_order_id !== quote.entryOrderId || quote.terminalOutcome !== 'write_off') return false;
      const id = this.requestWithinTransaction(mint, 'sell', reason, quote, null, now);
      if (!id) return false;
      return this.fillWithinTransaction(this.store.get('SELECT * FROM paper_orders WHERE id=?', id), quote, now);
    });
  }
  // `live`: a confirmed on-chain fill is a fact, so modeled exposure limits can no longer veto recording it.
  fill(order, quote, now, { live = false } = {}) {
    return this.store.atomic(() => this.fillWithinTransaction(order, quote, now, live));
  }
  fillWithinTransaction(order, quote, now, live = false) {
    const pending = this.store.get("SELECT mint,side,diagnostics_json FROM paper_orders WHERE id=? AND status='pending'", order.id);
    if (!pending || pending.mint !== order.mint || pending.side !== order.side) return false;
    if (order.side === 'buy' && !live && !this.exposureAllows(BigInt(quote.cost), order.id)) {
      this.cancel(order.id, now, 'exposure_cap'); return false;
    }
    if (order.side === 'buy' && this.cfg.strategy === 'agent-sell-liquidity' &&
        (!Number.isSafeInteger(quote.slot) || !Number.isSafeInteger(quote.slot + this.cfg.holdSlots))) {
      this.cancel(order.id, now, 'invalid_fill_slot'); return false;
    }
    const position = order.side === 'sell' ? this.position(order.mint) : null;
    if (order.side === 'sell' && !position) return false;
    if (quote.terminalOutcome) {
      const sold = BigInt(quote.soldTokens), burned = BigInt(quote.burnedTokens);
      const gross = BigInt(quote.gross), swapFee = BigInt(quote.swapFee);
      const writeOff = quote.terminalOutcome === 'write_off';
      if (order.side !== 'sell' || this.cfg.strategy !== 'agent-sell-liquidity' ||
          this.cfg.version !== 'agent_sell_liquidity_v3_terminal_exit' ||
          position.entry_order_id !== quote.entryOrderId || quote.originalTokens !== position.tokens_raw ||
          quote.tokens !== position.tokens_raw || !['full_sale', 'partial_sale', 'write_off'].includes(quote.terminalOutcome) ||
          sold < 0n || burned < 0n || sold + burned !== BigInt(position.tokens_raw) ||
          quote.remainingTokens !== '0' || quote.accountClosed !== true || gross < 0n || swapFee < 0n ||
          BigInt(quote.net) !== gross - swapFee - BigInt(quote.networkFee) ||
          quote.networkFee !== String(this.cfg.networkFeeLamports) ||
          (quote.terminalOutcome === 'full_sale' && burned !== 0n) ||
          (quote.terminalOutcome === 'partial_sale' && burned === 0n) ||
          (writeOff ? sold !== 0n || gross !== 0n || swapFee !== 0n || !quote.writeOffReason :
            sold <= 0n || gross <= swapFee || !quote.reserveEvidence || gross > BigInt(quote.reserveEvidence.realSol))) {
        throw new Error('Invalid terminal settlement');
      }
    }
    const status = quote.terminalOutcome === 'write_off' ? 'written_off' : 'filled';
    if (pending.diagnostics_json != null) this.diagnose(order.id, { stage: status, updatedAtMs: now });
    this.store.run('UPDATE paper_orders SET status=?,settled_at_ms=?,fill_json=? WHERE id=?', status, now, JSON.stringify(quote), order.id);
    if (order.side === 'buy') {
      this.store.run(`INSERT INTO paper_positions(mint,tokens_raw,entry_cost_lamports,entry_order_id,opened_at_ms)
        VALUES(?,?,?,?,?)`, order.mint, quote.tokens, quote.cost, order.id, now);
      if (this.cfg.strategy === 'agent-sell-liquidity') this.store.run(
        'UPDATE paper_positions SET entry_snapshot_slot=?,timeout_slot=? WHERE mint=?', quote.slot, quote.slot + this.cfg.holdSlots, order.mint);
      this.store.run("UPDATE paper_watches SET status='holding',reason=NULL WHERE mint=?", order.mint);
    } else {
      this.store.run(`UPDATE paper_positions SET status='closed',exit_order_id=?,closed_at_ms=?,exit_net_lamports=?,pnl_lamports=? WHERE mint=?`,
        order.id, now, quote.net, (BigInt(quote.net) - BigInt(position.entry_cost_lamports)).toString(), order.mint);
      this.store.run("UPDATE paper_watches SET status='closed',reason=? WHERE mint=?", order.reason, order.mint);
    }
    return true;
  }
  positionHealth(position, now) {
    const watch = this.watch(position.mint);
    const health = { mint: position.mint, model: 'saved_curve_observation_not_live_quote',
      heldMs: Math.max(0, now - position.opened_at_ms), entryCostLamports: position.entry_cost_lamports,
      watchStatus: watch?.status ?? null, exitReason: watch?.reason ?? null,
      pendingExitReason: this.store.get("SELECT reason FROM paper_orders WHERE mint=? AND side='sell' AND status='pending'", position.mint)?.reason ?? null,
      fullSaleGrossLamports: null, liquidityCoverageBps: null,
      lastObservedMs: watch?.last_observed_ms ?? null, lastChangeMs: watch?.last_change_ms ?? null,
      observationAgeMs: watch?.last_observed_ms == null ? null : Math.max(0, now - watch.last_observed_ms),
      unchangedMs: watch?.last_change_ms == null ? null : Math.max(0, now - watch.last_change_ms),
      lastMarketCapSol: watch?.last_cap ?? null, accountError: watch?.account_error ?? null,
      realSolLamports: null, fullExitSupported: null, modeledExitNetLamports: null, exitStatus: 'no_saved_state' };
    // Reconciliation can confirm graduation without replacing the prior saved fingerprint.
    if (watch?.reason === 'graduated_no_amm_exit') {
      health.exitStatus = 'graduated'; health.fullExitSupported = false; health.lastMarketCapSol = null; return health;
    }
    if (watch?.account_error) { health.exitStatus = 'invalid_latest_account'; return health; }
    if (!watch?.fingerprint) return health;
    let state;
    try { state = reserves({ owner: PUMP, data: [watch.fingerprint, 'base64'] }); }
    catch { health.exitStatus = 'invalid_saved_state'; return health; }
    health.realSolLamports = state.realSol.toString();
    if (state.complete) { health.exitStatus = 'graduated'; health.fullExitSupported = false; return health; }
    try {
      const gross = fullSaleGross(state, BigInt(position.tokens_raw));
      health.fullSaleGrossLamports = gross.toString();
      if (gross > 0n) health.liquidityCoverageBps = (state.realSol * 10000n / gross).toString();
      health.modeledExitNetLamports = exitQuote(state, position, this.cfg).net;
      health.fullExitSupported = true; health.exitStatus = 'modeled_exit_available';
    } catch { health.fullExitSupported = false; health.exitStatus = 'insufficient_liquidity_or_invalid_amount'; }
    return health;
  }
  report(now = Date.now()) {
    const positions = this.store.all('SELECT * FROM paper_positions ORDER BY opened_at_ms');
    const openPositionHealth = positions.filter(row => row.status === 'open').map(row => this.positionHealth(row, now));
    // Read-only comparisons must also work before the new diagnostics columns are migrated.
    const faultColumns = new Set(this.store.all('PRAGMA table_info(paper_account_faults)').map(row => row.name));
    const evidenceColumns = [['curve_discriminator_matches', 'curveDiscriminatorMatches'], ['quote_layout', 'quoteLayout'], ['quote_mint_observed', 'quoteMintObserved']]
      .map(([column, alias]) => `${faultColumns.has(column) ? column : 'NULL'} ${alias}`).join(',');
    return {
      mode: this.cfg.mode ?? 'paper', assumptions: this.cfg, capacity: this.capacity(), feedHealth: readFeedHealth(this.store, now),
      ...(this.cfg.strategy !== 'agent-sell-liquidity' ? {} : {
        policyMigrations: (() => {
          return this.store.all("SELECT value FROM metadata WHERE key IN ('paper_trial_policy_migration','paper_trial_terminal_exit_migration')")
            .map(row => JSON.parse(row.value)).sort((a, b) => a.atMs - b.atMs);
        })(),
        exposure: Object.fromEntries(Object.entries(this.exposure()).map(([key, value]) => [`${key}Lamports`, value.toString()])),
        recentAgentEvents: this.store.get("SELECT 1 FROM sqlite_master WHERE name='paper_agent_events'") ?
          this.store.all('SELECT * FROM paper_agent_events ORDER BY id DESC LIMIT 25') : [],
        agentStrategyNote: this.cfg.version === 'agent_sell_liquidity_v3_terminal_exit'
          ? 'Mandatory exits recover supported liquidity and model burning the remainder; unavailable reserves are zero-recovery write-offs. One network fee models combined sell/burn/account closure; no rent credit. Not actual sales, burns or account closures. Entry screening still requires a full modeled exit.'
          : 'Budget includes swap fees; total entry cost adds modeled network fees. Rent and non-fill attempt fees excluded. Events are live confirmed signals, not recovered history. Timeout attempts do not guarantee exits.',
      }),
      performance: paperPerformance(this.store, positions, openPositionHealth),
      coverage: this.store.all(`SELECT mint,status,last_cap,last_change_ms,last_observed_ms,account_error,preprocessed FROM paper_watches
        WHERE status IN ('watching','holding','exit_blocked')`),
      realizedPnlLamports: positions.reduce((sum, row) => sum + BigInt(row.pnl_lamports ?? '0'), 0n).toString(),
      watches: this.store.all('SELECT status,COUNT(*) count FROM paper_watches GROUP BY status'),
      orders: this.store.all('SELECT side,status,COUNT(*) count FROM paper_orders GROUP BY side,status'),
      positions,
      openPositionHealth,
      recentOrders: this.store.all('SELECT * FROM paper_orders ORDER BY id DESC LIMIT 25').map(({ diagnostics_json, ...order }) =>
        ({ ...order, diagnostics: readOrderDiagnostics(diagnostics_json) })),
      orderDiagnosticsNote: 'Bounded evidence recorded after diagnostics were enabled; historical missing evidence is unknown. Status/account elapsed times include RPC queueing and retries, not network latency alone.',
      recentSignals: this.store.all('SELECT * FROM paper_signals ORDER BY received_at_ms DESC LIMIT 25'),
      recentRejections: this.store.all('SELECT * FROM paper_rejections ORDER BY id DESC LIMIT 25'),
      recentAccountFaults: this.store.all(`SELECT at_ms atMs,mint,slot,code,subtype,present,owner_matches ownerMatches,base64,bytes,${evidenceColumns}
        FROM paper_account_faults ORDER BY id DESC LIMIT ${FAULT_SAMPLE_LIMIT}`).map(row => ({ ...row, present: Boolean(row.present),
        ownerMatches: Boolean(row.ownerMatches), base64: Boolean(row.base64),
        curveDiscriminatorMatches: row.curveDiscriminatorMatches == null ? null : Boolean(row.curveDiscriminatorMatches) })),
      accountFaultSummary: {
        totalEvents: this.store.get("SELECT COALESCE(SUM(count),0) n FROM paper_counters WHERE name IN ('account:missing_account','account:wrong_owner','account:invalid_data','account:invalid_curve','account:not_mayhem','account:processing_error')").n,
        retainedSamples: this.store.get('SELECT COUNT(*) n FROM paper_account_faults').n,
        distinctMintsInRetainedSamples: this.store.get('SELECT COUNT(DISTINCT mint) n FROM paper_account_faults').n,
      },
      accountFaultEvidenceNote: 'Events count rejected observations, not unique mints. Distinct mints cover only the latest 100 retained samples, not all historical faults. quoteMintObserved is read at the documented prefix offset, not proof of a historical account layout. Missing historical evidence remains unknown.',
      counters: this.store.all('SELECT * FROM paper_counters ORDER BY name'),
      blocked: this.store.all("SELECT * FROM paper_watches WHERE status='exit_blocked'"),
      usage: this.store.all("SELECT * FROM usage WHERE source IN ('preprocessed','preprocessed_bytes','paper_agent') OR method IN ('paper_account_received_bytes','paper_agent_received_bytes') ORDER BY day,source,method"),
      note: this.cfg.version === 'agent_sell_liquidity_v3_terminal_exit'
        ? 'Paper results include confirmed-state modeled sales and explicit zero-recovery write-offs, not actual trades, balances or achievable returns. Burn/account closure is modeled with one network fee and no rent credit. No AMM execution or proceeds are assumed.'
        : 'Hypothetical fills using later executed reserves and configured fees; not actual trades, balances or achievable returns. Unsupported transactions are skipped. Graduation exits require manual attention; no AMM execution.',
    };
  }
}
