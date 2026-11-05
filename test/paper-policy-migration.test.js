import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { PaperStore, paperConfig } from '../src/paper-store.js';
import { bindTrial, preflightTrial, trialIdentity, migrateAgentExitPolicy } from '../src/paper-profiles.js';

const profile = 'agent-sell-liquidity';
const current = paperConfig({}, profile);
const old = { ...current, version: 'agent_sell_liquidity_v1' };
const storeConfig = { firstCheck: 30, recheck: 30, horizon: 86400, paperMode: true };
const mint = '9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const comparison = fileURLToPath(new URL('../src/paper-trial-report.js', import.meta.url));
function fixture(t, config = old) {
  const dir = mkdtempSync(join(tmpdir(), 'paper-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, `${profile}.sqlite`);
  const store = new Store(path, storeConfig), paper = new PaperStore(store, config);
  bindTrial(store, config);
  store.addMint({ mint, timestamp: 100 }); paper.enroll(mint, 100000);
  const entry = paper.request(mint, 'buy', 'agent_sell', { cost: '1000000' }, null, 100000);
  paper.fill(store.get('SELECT * FROM paper_orders WHERE id=?', entry), { tokens: '1000', cost: '1000000', slot: 15 }, 100001);
  const pending = paper.request(mint, 'sell', 'timeout', { net: '900000' }, null, 100002);
  store.run("INSERT INTO metadata VALUES('monitoring_started_at','100')");
  store.close();
  return { dir, path, entry, pending };
}
function read(path, fn) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
function snapshot(path) {
  return read(path, db => JSON.stringify(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(table => ({ ...table, rows: db.prepare(`SELECT * FROM "${table.name}"`).all() }))));
}
function cliOptions(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAPER_') && key !== 'MAX_TRADE_COUNT'));
  return { cwd: dir, env: { ...env, PAPER_TRIAL_DIR: dir, DB_PATH: join(dir, 'normal.sqlite') }, encoding: 'utf8', stdio: 'pipe', timeout: 5000 };
}

test('agent policy identity rejects v1 resumes without changing holdings or history', t => {
  assert.equal(current.version, 'agent_sell_liquidity_v2_event_only');
  assert.notEqual(trialIdentity(current), trialIdentity(old));
  const { path, dir } = fixture(t), before = snapshot(path);
  assert.throws(() => preflightTrial(path, current), /not this trial.*--migrate-exit-policy/);
  const store = new Store(path, storeConfig);
  try { assert.throws(() => bindTrial(store, current), /configuration changed.*--migrate-exit-policy/); }
  finally { store.close(); }
  assert.throws(() => execFileSync(process.execPath, [cli, 'paper-trial', profile], cliOptions(dir)),
    error => error.status === 1 && error.stderr.includes('--migrate-exit-policy'));
  assert.equal(snapshot(path), before);
  assert.equal(existsSync(join(dir, 'normal.sqlite')), false);
});

test('explicit offline migration retains holdings and assumptions and records durable order boundary in reports', t => {
  const { path, dir, entry, pending } = fixture(t);
  const before = read(path, db => ({ position: db.prepare('SELECT * FROM paper_positions').get(),
    entry: db.prepare('SELECT * FROM paper_orders WHERE id=?').get(entry),
    watch: db.prepare('SELECT * FROM paper_watches').get() }));
  const output = JSON.parse(execFileSync(process.execPath,
    [cli, 'paper-trial', profile, '--migrate-exit-policy', '--confirm-offline'], cliOptions(dir)));
  const migration = output.migration;
  assert.equal(output.event, 'paper_trial_policy_migrated');
  assert.equal(migration.lastOldPolicyOrderId, pending);
  assert.deepEqual(migration.canceledPendingOrderIds, [pending]);
  assert.equal(migration.oldIdentity, trialIdentity(old));
  assert.equal(migration.newIdentity, trialIdentity(current));
  assert.deepEqual(migration.oldConfig, old); assert.deepEqual(migration.newConfig, current);
  assert.ok(Number.isSafeInteger(migration.atMs));
  preflightTrial(path, current);
  const store = new Store(path, storeConfig), paper = new PaperStore(store, current);
  try {
    bindTrial(store, current);
    assert.deepEqual(store.get('SELECT * FROM paper_positions'), before.position);
    assert.deepEqual(store.get('SELECT * FROM paper_watches'), before.watch);
    assert.deepEqual(store.get('SELECT * FROM paper_orders WHERE id=?', entry), before.entry);
    const canceled = store.get('SELECT * FROM paper_orders WHERE id=?', pending);
    assert.equal(canceled.status, 'canceled'); assert.equal(canceled.error, 'exit_policy_migration');
    assert.equal(canceled.assumptions_json, JSON.stringify(old));
    assert.equal(store.get("SELECT value FROM metadata WHERE key='monitoring_started_at'").value, '100');
    assert.deepEqual(paper.report().policyMigrations, [migration]);
    const next = paper.request(mint, 'sell', 'timeout', { net: '900000' }, null, Date.now());
    assert.ok(next > migration.lastOldPolicyOrderId);
    assert.equal(JSON.parse(store.get('SELECT assumptions_json FROM paper_orders WHERE id=?', next).assumptions_json).version, current.version);
  } finally { store.close(); }
  const reports = JSON.parse(execFileSync(process.execPath, [comparison, profile], cliOptions(dir))).reports;
  assert.equal(reports[0].available, true);
  assert.deepEqual(reports[0].policyMigrations, [migration]);
  assert.equal(reports[0].positions[0].status, 'open');
  const standalone = JSON.parse(execFileSync(process.execPath, [cli, 'paper-report'], {
    ...cliOptions(dir), env: { ...cliOptions(dir).env, DB_PATH: path },
  }));
  assert.deepEqual(standalone.policyMigrations, [migration]);
  assert.equal(existsSync(join(dir, 'normal.sqlite')), false);
});

test('migration requires explicit offline consent, exact prior config and correct profile', t => {
  const { path, dir } = fixture(t), before = snapshot(path);
  assert.throws(() => migrateAgentExitPolicy(path, current), /confirm-offline/);
  for (const changed of [{ ...current, holdSlots: 81 }, { ...current, swapFeeBps: 126 }, { ...current, entriesEnabled: false }]) {
    assert.throws(() => migrateAgentExitPolicy(path, changed, { confirmOffline: true }), /otherwise-identical/);
  }
  assert.throws(() => migrateAgentExitPolicy(path, paperConfig({}, 'baseline'), { confirmOffline: true }), /Only the agent/);
  for (const args of [['--migrate-exit-policy'], ['--confirm-offline'], ['--migrate-exit-policy', '--confirm-offline', '--extra'], ['--typo']]) {
    assert.throws(() => execFileSync(process.execPath, [cli, 'paper-trial', profile, ...args], cliOptions(dir)),
      error => error.status === 1 && error.stderr.includes('Usage: paper-trial'));
  }
  assert.equal(snapshot(path), before);
  const missing = join(dir, 'missing.sqlite');
  assert.throws(() => migrateAgentExitPolicy(missing, current, { confirmOffline: true }), /existing trial/);
  assert.equal(existsSync(missing), false);
});

test('migration does not enroll ordinary history or rewrite already-current trials', t => {
  const { path } = fixture(t, current), before = snapshot(path);
  assert.throws(() => migrateAgentExitPolicy(path, current, { confirmOffline: true }), /otherwise-identical/);
  assert.equal(snapshot(path), before);
  const db = new DatabaseSync(path);
  db.prepare("DELETE FROM metadata WHERE key='paper_trial_config'").run(); db.close();
  const unbound = snapshot(path);
  assert.throws(() => migrateAgentExitPolicy(path, current, { confirmOffline: true }), /otherwise-identical/);
  assert.equal(snapshot(path), unbound);
});

test('failed migration rolls back pending cancellations, audit record and config together', t => {
  const { path } = fixture(t);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER reject_policy_update BEFORE UPDATE OF value ON metadata
    WHEN NEW.key='paper_trial_config' BEGIN SELECT RAISE(ABORT,'test policy update failure'); END`);
  db.close();
  const before = snapshot(path);
  assert.throws(() => migrateAgentExitPolicy(path, current, { confirmOffline: true }), /test policy update failure/);
  assert.equal(snapshot(path), before);
});

test('migration is one-time and will not replace its existing audit history', t => {
  const { path } = fixture(t);
  migrateAgentExitPolicy(path, current, { confirmOffline: true });
  const before = snapshot(path);
  assert.throws(() => migrateAgentExitPolicy(path, current, { confirmOffline: true }), /otherwise-identical/);
  assert.equal(snapshot(path), before);
});
