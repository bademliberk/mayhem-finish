import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const trialProfiles = {
  baseline: {},
  coverage20: { maxWatches: 20 },
  liquidity20: { maxWatches: 20, entryQualityEnabled: true },
  drop50: { maxWatches: 20, entryQualityEnabled: true, dropBps: 5000 },
  window8: { maxWatches: 20, entryQualityEnabled: true, windowSlots: 8 },
};

export function trialPath(profile, root = 'data/paper-trials', normalPath = 'data/collector.sqlite') {
  if (!Object.hasOwn(trialProfiles, profile)) throw new Error('Unknown paper trial profile');
  const path = resolve(join(root, `${profile}.sqlite`));
  if (path === resolve(normalPath)) throw new Error('Trial database must differ from the normal database');
  return path;
}

// All persisted inputs are nonsecret. Key order does not affect identity.
export function trialIdentity(cfg) {
  return JSON.stringify(Object.fromEntries(Object.entries(cfg).sort(([a], [b]) => a.localeCompare(b))));
}
// Reject incompatible existing files before Store performs any migrations.
export function preflightTrial(path, cfg) {
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (!tables.length) return;
    const saved = tables.some(t => t.name === 'metadata') &&
      db.prepare("SELECT value FROM metadata WHERE key='paper_trial_config'").get()?.value;
    if (saved !== trialIdentity(cfg)) throw new Error('Existing database is not this trial configuration; use a new trial directory');
  } finally { db.close(); }
}
export function bindTrial(store, cfg) {
  const expected = trialIdentity(cfg);
  store.atomic(() => {
    const saved = store.get("SELECT value FROM metadata WHERE key='paper_trial_config'")?.value;
    if (saved) {
      if (saved !== expected) throw new Error('Paper trial configuration changed; use a new trial directory');
      return;
    }
    if (store.get('SELECT COUNT(*) n FROM mints').n ||
        store.get('SELECT COUNT(*) n FROM paper_orders').n ||
        store.get("SELECT 1 FROM metadata WHERE key='monitoring_started_at'")) {
      throw new Error('Cannot enroll an existing run database into a paper trial');
    }
    store.run("INSERT INTO metadata VALUES('paper_trial_config',?)", expected);
  });
}
