import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { trialPath, trialProfiles } from './paper-profiles.js';
import { PaperStore } from './paper-store.js';

const cfg = config();
const profiles = process.argv.slice(2);
try {
  const reports = (profiles.length ? profiles : Object.keys(trialProfiles)).map(profile => {
    const path = trialPath(profile, process.env.PAPER_TRIAL_DIR, cfg.db);
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('BEGIN');
      const store = { get: (q, ...p) => db.prepare(q).get(...p), all: (q, ...p) => db.prepare(q).all(...p) };
      const saved = store.get("SELECT value FROM metadata WHERE key='paper_trial_config'")?.value;
      if (!saved) return { profile, available: false, reason: 'not_a_trial_database' };
      const assumptions = JSON.parse(saved);
      if (assumptions.profile !== profile) return { profile, available: false, reason: 'profile_mismatch' };
      const paper = Object.assign(Object.create(PaperStore.prototype), { store, cfg: assumptions });
      return { profile, available: true, startedAt: store.get("SELECT value FROM metadata WHERE key='monitoring_started_at'")?.value ?? null,
        heartbeat: store.get("SELECT value FROM metadata WHERE key='heartbeat'")?.value ?? null, ...paper.report() };
    } catch { return { profile, available: false, reason: 'database_unavailable_or_incompatible' }; }
    finally { db?.close(); }
  });
  console.log(JSON.stringify({ comparison: 'Independent paper runs; unequal dates and coverage confound comparisons. No guaranteed returns.', reports }, null, 2));
} catch {
  console.error('Usage: node src/paper-trial-report.js [baseline|coverage20|liquidity20|drop50|window8 ...]');
  process.exitCode = 1;
}
