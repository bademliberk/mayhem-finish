import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify } from '../src/chain.js';
import { config, screeningPolicy } from '../src/config.js';

const ENV_NAMES = ['HELIUS_API_KEY', 'HELIUS_KEY', 'DB_PATH', 'FIRST_CHECK_SECONDS', 'RECHECK_SECONDS',
  'OBSERVATION_SECONDS', 'MIN_MARKET_CAP_SOL', 'MAX_MARKET_CAP_SOL', 'MIN_LIQUIDITY_SOL',
  'RPC_INTERVAL_MS', 'HISTORY_PAGES_PER_PASS', 'BACKFILL_SECONDS', 'TRACKING_SECONDS'];

// Load defaults with no inherited env and no .env file (config() reads .env from cwd).
function defaults(extra = {}) {
  const saved = Object.fromEntries(ENV_NAMES.map(n => [n, process.env[n]]));
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), 'screening-'));
  try {
    for (const n of ENV_NAMES) delete process.env[n];
    Object.assign(process.env, extra);
    process.chdir(dir);
    return config();
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    for (const n of ENV_NAMES) saved[n] === undefined ? delete process.env[n] : process.env[n] = saved[n];
  }
}

const cfg = { minCap: 2, maxCap: 5, minLiquidity: 0.005 };
const curve = (marketCap = 3, liquidity = 1) => ({ marketCap, liquidity, complete: false });
const screen = (c = curve()) => classify(c, cfg);

test('default config carries the screening values', () => {
  const c = defaults();
  assert.equal(c.firstCheck, 30);
  assert.equal(c.recheck, 30);
  assert.equal(c.activeAge, undefined);
  assert.equal(c.staleAge, undefined);
  assert.equal(c.minCap, 2);
  assert.equal(c.maxCap, 5);
  assert.equal(c.minLiquidity, 0.005);
  assert.equal(c.trackingSeconds, 30);
});

test('trackingSeconds is fixed and not env-configurable', () => {
  assert.equal(defaults({ TRACKING_SECONDS: '99' }).trackingSeconds, 30);
});

test('financial screening takes no trade timestamp and reports no trade age', () => {
  assert.equal(screen().category, 'candidate');
  assert.equal(screen().age, null);
});

test('market cap bounds are inclusive at 2 and 5', () => {
  assert.equal(screen(curve(2)).category, 'candidate');
  assert.equal(screen(curve(5)).category, 'candidate');
  assert.equal(screen(curve(1.999999)).category, 'unqualified');
  assert.equal(screen(curve(5.000001)).category, 'unqualified');
});

test('liquidity threshold is strict', () => {
  assert.equal(screen(curve(3, 0.005)).category, 'unqualified');
  assert.deepEqual(screen(curve(3, 0.005)).reasons, ['liquidity_at_or_below_min']);
  assert.equal(screen(curve(3, 0.0050001)).category, 'candidate');
});

test('screeningPolicy is stable, versioned and secret-free', () => {
  const c = { ...defaults(), key: 'SECRET-KEY', db: '/private/path.sqlite' };
  const text = screeningPolicy(c);
  assert.equal(text, screeningPolicy({ ...c }));
  assert.equal(text, '{"version":"financial_only_v1","tradeHistory":"not_checked","firstCheck":30,"recheck":30,'
    + '"minCap":2,"maxCap":5,"minLiquidity":0.005,"trackingSeconds":30}');
  assert.ok(!text.includes('SECRET-KEY') && !text.includes('private'));
  assert.equal(JSON.parse(screeningPolicy({ ...c, minCap: 3 })).minCap, 3);
});
