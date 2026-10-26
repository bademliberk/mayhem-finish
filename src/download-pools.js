import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function validatePage(result, config) {
  if (!result || !Array.isArray(result.data) || result.data.length > 1000
    || !Object.hasOwn(result, 'paginationToken')
    || (result.paginationToken !== null && (typeof result.paginationToken !== 'string' || !result.paginationToken.length))) {
    throw new Error('INVALID_HISTORY_PAGE');
  }
  for (const entry of result.data) {
    if (!entry || !Number.isSafeInteger(entry.slot) || entry.slot < 0
      || !Number.isSafeInteger(entry.blockTime) || entry.blockTime < config.start || entry.blockTime >= config.end
      || typeof entry.transaction?.signatures?.[0] !== 'string' || !entry.transaction.signatures[0]
      || !Array.isArray(entry.transaction?.message?.accountKeys)
      || !Array.isArray(entry.transaction?.message?.instructions)
      || !Object.hasOwn(entry, 'meta') || (entry.meta !== null && typeof entry.meta !== 'object')) {
      throw new Error('INVALID_HISTORY_PAGE');
    }
  }
  return result;
}

export class PoolStore {
  constructor(path, readOnly = false) {
    if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec('PRAGMA busy_timeout=5000');
    if (!readOnly) this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS pool_job(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL,
        credits INTEGER NOT NULL DEFAULT 0, max_credits INTEGER NOT NULL, last_stop TEXT);
      CREATE TABLE IF NOT EXISTS sources(address TEXT PRIMARY KEY, cursor TEXT, done INTEGER NOT NULL DEFAULT 0,
        pages INTEGER NOT NULL DEFAULT 0, returned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS history(signature TEXT PRIMARY KEY,slot INTEGER NOT NULL,block_time INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_sources(signature TEXT NOT NULL,address TEXT NOT NULL,PRIMARY KEY(signature,address));
      CREATE TABLE IF NOT EXISTS pages(address TEXT NOT NULL,request_cursor TEXT NOT NULL,next_cursor TEXT,
        PRIMARY KEY(address,request_cursor));
      CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,method TEXT NOT NULL,credits INTEGER NOT NULL,settled INTEGER NOT NULL DEFAULT 0);
    `);
  }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  job() { return this.get('SELECT * FROM pool_job WHERE id=1'); }
  initialize(config, budget) {
    this.atomic(() => {
      const job = this.job();
      if (job && job.config !== JSON.stringify(config)) throw new Error('Pool job configuration differs; use original arguments or another --db.');
      if (!job) {
        this.run('INSERT INTO pool_job(id,config,max_credits) VALUES(1,?,?)', JSON.stringify(config), budget ?? 2000);
        for (const address of config.addresses) this.run('INSERT INTO sources(address) VALUES(?)', address);
      } else if (budget !== undefined) this.run('UPDATE pool_job SET max_credits=? WHERE id=1', budget);
    });
  }
  reserve(method) {
    if (method !== 'getTransactionsForAddress') throw new Error('Unexpected pool RPC method.');
    return this.atomic(() => {
      const job = this.job();
      if (job.credits + 100 > job.max_credits) throw new Error('CREDIT_BUDGET');
      this.run('UPDATE pool_job SET credits=credits+100 WHERE id=1');
      return Number(this.run('INSERT INTO requests(method,credits) VALUES(?,100)', method).lastInsertRowid);
    });
  }
  settle(id, result) {
    // Invalid responses keep the worst-case reservation, as do uncertain failures.
    try { validatePage(result, JSON.parse(this.job().config)); } catch { return; }
    const credits = Math.max(10, Math.ceil(result.data.length / 100) * 10);
    this.atomic(() => {
      const request = this.get('SELECT * FROM requests WHERE id=?', id);
      if (!request || request.settled) throw new Error('Invalid credit reservation.');
      this.run('UPDATE pool_job SET credits=credits-? WHERE id=1', request.credits - credits);
      this.run('UPDATE requests SET credits=?,settled=1 WHERE id=?', credits, id);
    });
  }
  commitPage(address, cursor, result) {
    validatePage(result, JSON.parse(this.job().config));
    this.atomic(() => {
      const source = this.get('SELECT * FROM sources WHERE address=?', address);
      if (!source || source.done || source.cursor !== cursor) throw new Error('HISTORY_CURSOR_CONFLICT');
      const next = result.paginationToken;
      if (next !== null && (next === cursor || this.get('SELECT 1 FROM pages WHERE address=? AND request_cursor=?', address, next))) {
        throw new Error('HISTORY_CURSOR_LOOP');
      }
      for (const entry of result.data) {
        const signature = entry.transaction.signatures[0];
        this.run('INSERT OR IGNORE INTO history VALUES(?,?,?,?)', signature, entry.slot, entry.blockTime, JSON.stringify(entry));
        this.run('INSERT OR IGNORE INTO history_sources VALUES(?,?)', signature, address);
      }
      this.run('INSERT INTO pages VALUES(?,?,?)', address, cursor ?? '', next);
      this.run('UPDATE sources SET cursor=?,done=?,pages=pages+1,returned=returned+? WHERE address=?',
        next, Number(next === null), result.data.length, address);
    });
  }
  status() {
    const job = this.job();
    if (!job) return { initialized: false };
    const sources = this.all('SELECT * FROM sources ORDER BY address');
    return { config: JSON.parse(job.config), sources, completeForConfiguredAddresses: sources.every(s => s.done === 1),
      tokenWideComplete: false, uniqueTransactions: this.get('SELECT count(*) AS n FROM history').n,
      returnedTransactions: sources.reduce((n, s) => n + s.returned, 0), pages: sources.reduce((n, s) => n + s.pages, 0),
      estimatedCredits: job.credits, maxCredits: job.max_credits,
      uncertainAttempts: this.get('SELECT count(*) AS n FROM requests WHERE settled=0').n, lastStop: job.last_stop };
  }
  close() { this.db.close(); }
}

export async function scanPools({ store, rpc, signal, onPage = () => {} }) {
  const config = JSON.parse(store.job().config);
  for (const address of config.addresses) {
    while (true) {
      if (signal?.aborted) throw new Error('PAUSED');
      const source = store.get('SELECT * FROM sources WHERE address=?', address);
      if (source.done) break;
      const params = {
        transactionDetails: 'full', encoding: 'jsonParsed', limit: 1000,
        maxSupportedTransactionVersion: 1, commitment: 'finalized', sortOrder: 'desc',
        filters: { blockTime: { gte: config.start, lt: config.end }, tokenAccounts: config.tokenAccounts, status: 'any' },
        ...(source.cursor === null ? {} : { paginationToken: source.cursor }),
      };
      const result = await rpc.call('getTransactionsForAddress', [address, params]);
      store.commitPage(address, source.cursor, result);
      onPage(store.status());
    }
  }
  return store.status();
}
