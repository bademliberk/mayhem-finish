import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const trialProfiles = {
  baseline: {},
  'agent-sell-liquidity': { strategy: 'agent-sell-liquidity', maxWatches: 20, entryQualityEnabled: true,
    liquidityExitEnabled: true, liquidityExitMultiple: 2 },
  coverage20: { maxWatches: 20 },
  liquidity20: { maxWatches: 20, entryQualityEnabled: true },
  drop50: { maxWatches: 20, entryQualityEnabled: true, dropBps: 5000 },
  window8: { maxWatches: 20, entryQualityEnabled: true, windowSlots: 8 },
  'liquidity-exit100': { maxWatches: 20, entryQualityEnabled: true, maxTrades: 100,
    liquidityExitEnabled: true, liquidityExitMultiple: 2 },
};

export function trialPath(profile, root = 'data/paper-trials', normalPath = 'data/collector.sqlite') {
  if (!Object.hasOwn(trialProfiles, profile)) throw new Error('Unknown paper trial profile');
  const path = resolve(join(root, `${profile}.sqlite`));
  if (path === resolve(normalPath)) throw new Error('Trial database must differ from the normal database');
  return path;
}

export function livePath(dryRun, root = 'data/live-trials', normalPath = 'data/collector.sqlite') {
  const path = resolve(join(root || 'data/live-trials', dryRun ? 'agent-sell-liquidity-dry-run.sqlite' : 'agent-sell-liquidity.sqlite'));
  if (path === resolve(normalPath)) throw new Error('Live database must differ from the normal database');
  return path;
}

// All persisted inputs are nonsecret. Key order does not affect identity.
export function trialIdentity(cfg) {
  return JSON.stringify(Object.fromEntries(Object.entries(cfg).sort(([a], [b]) => a.localeCompare(b))));
}
function mismatchMessage(cfg, prefix) {
  if (cfg.mode && cfg.mode !== 'paper') return `${prefix}; use a new LIVE_TRIAL_DIR (open positions in the old database still need handling)`;
  return cfg.profile === 'agent-sell-liquidity'
    ? `${prefix}; no policy was changed. Stop all trial processes, then explicitly migrate the otherwise-identical v1 or v2 trial to v3 terminal-exit policy with: node src/cli.js paper-trial agent-sell-liquidity --migrate-exit-policy --confirm-offline (same PAPER_TRIAL_DIR and configuration)`
    : `${prefix}; use a new trial directory`;
}

// Explicit offline opt-in only: never open Store, run schema migrations, or start feeds.
// The caller must stop all writers; the SQLite lock serializes this atomic policy boundary.
export function migrateAgentExitPolicy(path, cfg, { confirmOffline = false } = {}) {
  if (!confirmOffline) throw new Error('Stop all trial processes and pass --confirm-offline before policy migration');
  if (cfg.profile !== 'agent-sell-liquidity' || cfg.strategy !== 'agent-sell-liquidity' ||
      cfg.version !== 'agent_sell_liquidity_v3_terminal_exit') throw new Error('Only the agent v1 or event-only v2 to terminal-exit v3 policy migration is supported');
  if (!existsSync(path)) throw new Error('Policy migration requires an existing trial database');
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const oldIdentities = ['agent_sell_liquidity_v1', 'agent_sell_liquidity_v2_event_only']
        .map(version => trialIdentity({ ...cfg, version }));
      const newIdentity = trialIdentity(cfg);
      const saved = db.prepare("SELECT value FROM metadata WHERE key='paper_trial_config'").get()?.value;
      if (!oldIdentities.includes(saved)) throw new Error('Policy migration requires an otherwise-identical agent v1 or v2 trial configuration; no changes made');
      if (db.prepare("SELECT 1 FROM metadata WHERE key='paper_trial_terminal_exit_migration'").get()) {
        throw new Error('Terminal-exit v3 policy migration was already recorded; no changes made');
      }
      const lastOldPolicyOrderId = db.prepare('SELECT COALESCE(MAX(id),0) id FROM paper_orders').get().id;
      const canceledPendingOrderIds = db.prepare("SELECT id FROM paper_orders WHERE status='pending' ORDER BY id").all().map(row => row.id);
      const atMs = Date.now();
      const migration = { atMs, oldConfig: JSON.parse(saved), newConfig: JSON.parse(newIdentity),
        oldIdentity: saved, newIdentity, lastOldPolicyOrderId, canceledPendingOrderIds,
        note: 'Open holdings retained and now managed by terminal-exit v3; historical orders retain original assumptions. Aggregate performance spans policy versions.' };
      db.prepare("UPDATE paper_orders SET status='canceled',settled_at_ms=?,error='exit_policy_migration' WHERE status='pending'").run(atMs);
      db.prepare("INSERT INTO metadata(key,value) VALUES('paper_trial_terminal_exit_migration',?)").run(JSON.stringify(migration));
      db.prepare("UPDATE metadata SET value=? WHERE key='paper_trial_config'").run(newIdentity);
      db.exec('COMMIT');
      return migration;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
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
    if (saved !== trialIdentity(cfg)) throw new Error(mismatchMessage(cfg, 'Existing database is not this trial configuration'));
  } finally { db.close(); }
}
export function bindTrial(store, cfg) {
  const expected = trialIdentity(cfg);
  store.atomic(() => {
    const saved = store.get("SELECT value FROM metadata WHERE key='paper_trial_config'")?.value;
    if (saved) {
      if (saved !== expected) throw new Error(mismatchMessage(cfg, 'Paper trial configuration changed'));
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
