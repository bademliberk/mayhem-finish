import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export function acquireLock(path) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recovery = `${lock}.recovery`;
    try { mkdirSync(recovery); }
    catch { throw new Error('Lock recovery is already in progress; inspect stale recovery locks before removing them.'); }
    try {
      let previous;
      try { previous = JSON.parse(readFileSync(`${lock}/owner.json`, 'utf8')); }
      catch { throw new Error('Download lock has no valid owner. Inspect it before removing it manually.'); }
      if (previous.host !== hostname() || !Number.isSafeInteger(previous.pid) || previous.pid <= 0) {
        throw new Error('Download lock belongs to another host or has an invalid owner.');
      }
      let dead = false;
      try { process.kill(previous.pid, 0); }
      catch (probe) {
        if (probe.code !== 'ESRCH') throw new Error('Cannot verify download lock owner.');
        dead = true;
      }
      if (!dead) throw new Error('Another process holds the download lock.');
      rmSync(`${lock}/owner.json`);
      rmdirSync(lock);
      mkdirSync(lock);
      writeFileSync(`${lock}/owner.json`, JSON.stringify(owner), { flag: 'wx' });
      return release;
    } finally { rmdirSync(recovery); }
  }
  writeFileSync(`${lock}/owner.json`, JSON.stringify(owner), { flag: 'wx' });
  return release;
  function release() {
    try {
      const current = JSON.parse(readFileSync(`${lock}/owner.json`, 'utf8'));
      if (current.token === owner.token) rmSync(lock, { recursive: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export class DownloadStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL,
        bounds TEXT, cursor INTEGER, discovery_done INTEGER NOT NULL DEFAULT 0,
        credits INTEGER NOT NULL DEFAULT 0, max_credits INTEGER NOT NULL,
        created_at TEXT NOT NULL, last_stop TEXT);
      CREATE TABLE IF NOT EXISTS blocks (slot INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, block_time INTEGER);
      CREATE INDEX IF NOT EXISTS blocks_status ON blocks(status,slot);
      CREATE TABLE IF NOT EXISTS transactions (signature TEXT PRIMARY KEY, slot INTEGER NOT NULL,
        block_time INTEGER NOT NULL, reasons TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coverage (slot INTEGER PRIMARY KEY, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (method TEXT PRIMARY KEY, attempts INTEGER NOT NULL);
    `);
  }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  initialize(config, maxCredits) {
    const existing = this.job();
    if (existing && existing.config !== JSON.stringify(config)) {
      throw new Error('Database mint/range/format differs. Use another --db or the original configuration.');
    }
    if (!existing) this.run('INSERT INTO job(id,config,max_credits,created_at) VALUES(1,?,?,?)',
      JSON.stringify(config), maxCredits ?? 900000, new Date().toISOString());
    else if (maxCredits !== undefined) this.run('UPDATE job SET max_credits=? WHERE id=1', maxCredits);
    this.run("UPDATE blocks SET status='pending' WHERE status IN ('inflight','error')");
  }
  job() { return this.get('SELECT * FROM job WHERE id=1'); }
  reserve(method) {
    this.atomic(() => {
      const job = this.job();
      if (job.credits >= job.max_credits) throw new Error('CREDIT_BUDGET');
      this.run('UPDATE job SET credits=credits+1 WHERE id=1');
      this.run(`INSERT INTO usage VALUES(?,1) ON CONFLICT(method) DO UPDATE SET attempts=attempts+1`, method);
    });
  }
  setBounds(bounds) {
    this.run('UPDATE job SET bounds=?,cursor=? WHERE id=1', JSON.stringify(bounds), bounds.first);
  }
  discover(slots, cursor, done) {
    this.atomic(() => {
      for (const slot of slots) this.run('INSERT OR IGNORE INTO blocks(slot) VALUES(?)', slot);
      this.run('UPDATE job SET cursor=?,discovery_done=? WHERE id=1', cursor, Number(done));
    });
  }
  claim() {
    return this.atomic(() => {
      const row = this.get("SELECT slot FROM blocks WHERE status='pending' ORDER BY slot LIMIT 1");
      if (row) this.run("UPDATE blocks SET status='inflight',attempts=attempts+1 WHERE slot=?", row.slot);
      return row?.slot;
    });
  }
  pending(slot) { this.run("UPDATE blocks SET status='pending' WHERE slot=?", slot); }
  fail(slot, error) { this.run("UPDATE blocks SET status='error',error=? WHERE slot=?", error, slot); }
  complete(slot, blockTime, matches, issues) {
    this.atomic(() => {
      for (const match of matches) this.run(`INSERT OR IGNORE INTO transactions VALUES(?,?,?,?,?)`,
        match.signature, slot, blockTime, JSON.stringify(match.reasons), JSON.stringify(match.data));
      this.run('DELETE FROM coverage WHERE slot=?', slot);
      if (issues.length) this.run('INSERT INTO coverage VALUES(?,?)', slot, JSON.stringify(issues));
      this.run("UPDATE blocks SET status='done',block_time=?,error=NULL WHERE slot=?", blockTime, slot);
    });
  }
  status() {
    const job = this.job();
    if (!job) return { initialized: false };
    const counts = Object.fromEntries(this.all('SELECT status,count(*) AS n FROM blocks GROUP BY status').map(r => [r.status, r.n]));
    const gaps = this.get('SELECT count(*) AS n FROM coverage').n;
    const finished = Boolean(job.discovery_done) && !['pending', 'inflight', 'error'].some(s => counts[s]);
    return { config: JSON.parse(job.config), bounds: job.bounds ? JSON.parse(job.bounds) : null,
      discoveryDone: Boolean(job.discovery_done), cursor: job.cursor, blocks: counts,
      matchingTransactions: this.get('SELECT count(*) AS n FROM transactions').n,
      coverageIssueBlocks: gaps, scanFinished: finished, inspectionComplete: finished && gaps === 0,
      estimatedCredits: job.credits, maxCredits: job.max_credits,
      usage: this.all('SELECT * FROM usage ORDER BY method'), lastStop: job.last_stop,
      errorExamples: this.all("SELECT slot,error FROM blocks WHERE status='error' ORDER BY slot LIMIT 10"),
      coverageExamples: this.all('SELECT slot,detail FROM coverage ORDER BY slot LIMIT 10') };
  }
  close() { this.db.close(); }
}
