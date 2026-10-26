import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DownloadStore, acquireLock } from '../src/download-store.js';
import { DownloadRpc, safeError } from '../src/download-rpc.js';
import { inspectBlock, resolveBounds, scan } from '../src/download-scan.js';
import { options, exportJsonl } from '../src/download-cli.js';

const mint = 'DvjbEsdca43oQcw2h3HW1CT7N3x5vRcr3QrvTUHnXvgV';
const config = { format: 1, mint, start: 100, end: 200 };
function setup(t, maxCredits = 1000) {
  const store = new DownloadStore(':memory:');
  store.initialize(config, maxCredits);
  t.after(() => store.close());
  return store;
}
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dood-download-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function entry(signature = 'sig', overrides = {}) {
  return { version: 0, transaction: { signatures: [signature], message: {
    accountKeys: [{ pubkey: 'wallet' }], instructions: [],
  } }, meta: { err: null, preTokenBalances: [{ mint }], postTokenBalances: [{ mint }], innerInstructions: [] }, ...overrides };
}
const block = (transactions = [entry()], blockTime = 150) => ({ blockTime, transactions });
const response = result => ({ ok: true, json: async () => ({ result }) });

test('matches one transaction once even when multiple balances and instructions reference mint', () => {
  const tx = entry();
  tx.transaction.message.accountKeys.push({ pubkey: mint });
  tx.meta.innerInstructions.push({ instructions: [{ parsed: { info: { mint } } }] });
  const result = inspectBlock(block([tx]), mint, 100, 200);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].reasons.length, 3);
  assert.deepEqual(result.issues, []);
  assert.equal(result.matches[0].data, tx);
});

test('finds parsed mint without balances, loaded mint references, and preserves failed transactions', () => {
  const a = entry('a');
  a.meta.preTokenBalances = []; a.meta.postTokenBalances = [];
  a.meta.innerInstructions = [{ instructions: [{ parsed: { info: { mint } } }] }];
  const b = entry('b');
  b.meta.preTokenBalances = []; b.meta.postTokenBalances = [];
  b.meta.loadedAddresses = { writable: [mint] }; b.meta.err = { InstructionError: [0, 'Custom'] };
  const result = inspectBlock(block([a, b]), mint, 100, 200);
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.matches[1].data.meta.err, b.meta.err);
});

test('requests version 1 support and resumes failed blocks with legacy, v0 and v1 transactions', async t => {
  const store = setup(t);
  store.setBounds({ first: 1, last: 1 });
  store.discover([1], 2, true);
  store.fail(1, 'RPC_-32015');
  store.initialize(config);
  const transactions = ['legacy', 0, 1].map(version => entry(`sig-${version}`, { version }));
  const rpc = { call: async (method, params) => {
    assert.equal(method, 'getBlock');
    assert.equal(params[1].maxSupportedTransactionVersion, 1);
    assert.equal(params[1].encoding, 'jsonParsed');
    return block(transactions);
  } };
  const status = await scan({ store, rpc, config });
  assert.equal(status.inspectionComplete, true);
  assert.equal(status.matchingTransactions, 3);
  const saved = JSON.parse(store.get("SELECT data FROM transactions WHERE signature='sig-1'").data);
  assert.equal(saved.version, 1);
});

test('missing metadata and unsupported versions are coverage issues, even on unrelated transactions', () => {
  const result = inspectBlock(block([entry('a', { meta: null }), entry('b', { version: 2 })]), mint, 100, 200);
  assert.equal(result.issues.length, 2);
  assert.throws(() => inspectBlock(block([], null), mint, 100, 200), /timestamp/);
  assert.throws(() => inspectBlock(null, mint, 100, 200), /unavailable/);
});

test('unparsed token instructions and missing CPI metadata prevent completeness claims', () => {
  const tx = entry();
  tx.meta.innerInstructions = null;
  tx.transaction.message.instructions.push({ programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: 'raw' });
  const result = inspectBlock(block([tx]), mint, 100, 200);
  assert.equal(result.issues.length, 2);
});

test('time filter includes start and excludes end and padded outside blocks', () => {
  assert.equal(inspectBlock(block(undefined, 100), mint, 100, 200).matches.length, 1);
  assert.equal(inspectBlock(block(undefined, 200), mint, 100, 200).matches.length, 0);
  assert.equal(inspectBlock(block(undefined, 99), mint, 100, 200).matches.length, 0);
});

test('store commits matches and completion atomically and deduplicates signatures', t => {
  const store = setup(t);
  store.setBounds({ first: 1, last: 3 });
  store.discover([1, 3], 4, true);
  assert.equal(store.claim(), 1);
  const inspected = inspectBlock(block(), mint, 100, 200);
  store.complete(1, 150, [...inspected.matches, ...inspected.matches], []);
  assert.equal(store.claim(), 3);
  const circular = {}; circular.data = circular;
  assert.throws(() => store.complete(3, 150, [{ signature: 'other', reasons: [], data: circular }], []));
  assert.equal(store.get('SELECT status FROM blocks WHERE slot=3').status, 'inflight');
  assert.equal(store.status().matchingTransactions, 1);
  store.initialize(config);
  assert.equal(store.claim(), 3);
  store.complete(3, 150, [], ['missing metadata']);
  assert.equal(store.status().scanFinished, true);
  assert.equal(store.status().inspectionComplete, false);
});

test('resume preserves credit ledger, rejects different config, and allows explicit budget changes', t => {
  const store = setup(t, 2);
  store.reserve('getBlock'); store.reserve('getBlocks');
  assert.throws(() => store.reserve('getBlock'), /CREDIT_BUDGET/);
  store.initialize(config);
  assert.throws(() => store.reserve('getBlock'), /CREDIT_BUDGET/);
  assert.throws(() => store.initialize({ ...config, end: 201 }), /differs/);
  store.initialize(config, 3);
  store.reserve('getBlock');
  assert.equal(store.status().estimatedCredits, 3);
});

test('disk reopen resumes interrupted blocks and preserves discovery cursor', t => {
  const path = join(temp(t), 'state.sqlite');
  let store = new DownloadStore(path);
  store.initialize(config, 9);
  store.setBounds({ first: 1, last: 9 }); store.discover([1, 2], 3, false);
  store.reserve('getBlocks'); store.claim(); store.close();
  store = new DownloadStore(path);
  store.initialize(config);
  assert.equal(store.job().cursor, 3);
  assert.equal(store.claim(), 1);
  assert.equal(store.job().credits, 1);
  store.close();
});

test('scanner resumes without fetching completed blocks and tolerates out-of-order completion', async t => {
  const store = setup(t);
  store.setBounds({ first: 1, last: 5 });
  store.discover([1, 2], 3, false);
  store.complete(1, 150, [], []);
  const fetched = [], completed = [];
  const rpc = { call: async (method, params) => {
    if (method === 'getBlocks') return [3, 5];
    fetched.push(params[0]);
    await sleep(params[0] === 3 ? 20 : 1);
    completed.push(params[0]);
    return block([entry(`sig-${params[0]}`)]);
  } };
  await scan({ store, rpc, config, concurrency: 2 });
  assert.deepEqual(fetched, [2, 3, 5]);
  assert.ok(completed.indexOf(5) < completed.indexOf(3));
  assert.equal(store.status().inspectionComplete, true);
  await scan({ store, rpc, config, concurrency: 2 });
  assert.deepEqual(fetched, [2, 3, 5]);
});

test('unavailable blocks remain visible errors and retry on next run', async t => {
  const store = setup(t);
  store.setBounds({ first: 1, last: 1 });
  const rpc = { call: async method => method === 'getBlocks' ? [1] : null };
  await scan({ store, rpc, config });
  assert.equal(store.status().blocks.error, 1);
  assert.equal(store.status().inspectionComplete, false);
  store.initialize(config);
  rpc.call = async () => block();
  await scan({ store, rpc, config });
  assert.equal(store.status().inspectionComplete, true);
});

test('repeated block failure circuit breaker stops further spending', async t => {
  const store = setup(t);
  store.setBounds({ first: 1, last: 20 });
  store.discover(Array.from({ length: 20 }, (_, i) => i + 1), 21, true);
  await assert.rejects(scan({ store, config, concurrency: 1, rpc: { call: async () => null } }), /REPEATED_BLOCK_FAILURES/);
  assert.equal(store.status().blocks.error, 10);
  assert.equal(store.status().blocks.pending, 10);
});

test('budget failure leaves claimed slot pending rather than falsely complete', async t => {
  const store = setup(t);
  store.setBounds({ first: 1, last: 2 }); store.discover([1, 2], 3, true);
  const rpc = { call: async () => { throw new Error('CREDIT_BUDGET'); } };
  await assert.rejects(scan({ store, rpc, config, concurrency: 1 }), /CREDIT_BUDGET/);
  assert.equal(store.status().blocks.pending, 2);
  assert.equal(store.status().inspectionComplete, false);
});

test('abort preserves unfinished work and interrupted discovery does not move cursor', async t => {
  const store = setup(t);
  store.setBounds({ first: 1, last: 2 });
  const controller = new AbortController();
  const rpc = { call: async () => { controller.abort(); throw new Error('PAUSED'); } };
  await assert.rejects(scan({ store, rpc, config, signal: controller.signal }), /PAUSED/);
  assert.equal(store.job().cursor, 1);
  assert.equal(store.job().discovery_done, 0);
});

test('bounds resolve across skipped slots and enforce finalized end and archival coverage', async () => {
  const rpc = { call: async (method, params) => {
    if (method === 'getSlot') return 30000;
    if (method === 'getFirstAvailableBlock') return 2;
    if (method === 'getBlockTime') return params[0];
    if (method === 'getBlocks') {
      return Array.from({ length: params[1] - params[0] + 1 }, (_, i) => i + params[0]).filter(s => s >= 2 && s % 2 === 0);
    }
    throw new Error(method);
  } };
  const bounds = await resolveBounds(rpc, 10001, 20001);
  assert.ok(bounds.first < 10001 && bounds.last > 20001);
  await assert.rejects(resolveBounds(rpc, 1, 20000), /archive/);
  await assert.rejects(resolveBounds(rpc, 10000, 40000), /finalized/);
  const missing = { call: async (method, params) => method === 'getBlockTime' ? null : rpc.call(method, params) };
  await assert.rejects(resolveBounds(missing, 10000, 20000), /timestamp/);
});

test('invalid discovery response cannot advance checkpoint', async t => {
  const store = setup(t);
  store.setBounds({ first: 1, last: 3 });
  await assert.rejects(scan({ store, config, rpc: { call: async () => [3, 2] } }), /unordered/);
  assert.equal(store.job().cursor, 1);
});

test('RPC enforces shared pacing across concurrent requests and counts all attempts', async t => {
  const store = setup(t), times = [];
  const rpc = new DownloadRpc({ key: 'secret', store, rps: 50, fetchFn: async () => {
    times.push(Date.now()); return response(7);
  } });
  const values = await Promise.all([rpc.call('getSlot'), rpc.call('getSlot'), rpc.call('getSlot')]);
  assert.deepEqual(values, [7, 7, 7]);
  assert.ok(times[1] - times[0] >= 18 && times[2] - times[1] >= 18);
  assert.equal(store.job().credits, 3);
});

test('RPC timeout covers stalled response body and redacts URL failures', async t => {
  const store = setup(t);
  const rpc = new DownloadRpc({ key: 'secret', store, rps: 1000, timeoutMs: 10, retries: 0,
    fetchFn: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
  await assert.rejects(rpc.call('getBlock'), /REQUEST_TIMEOUT/);
  rpc.fetchFn = async () => { throw new Error('https://host/?api-key=secret'); };
  await assert.rejects(rpc.call('getBlock'), error => error.message === 'TRANSPORT_OR_JSON_FAILURE');
  assert.equal(safeError(new Error('secret')), 'DOWNLOAD_FAILURE');
});

test('RPC classifies auth/quota without retries or leaked provider text', async t => {
  const store = setup(t);
  const rpc = new DownloadRpc({ key: 'secret', store, rps: 1000, fetchFn: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(rpc.call('getBlock'), /AUTH_OR_ACCESS_DENIED/);
  rpc.fetchFn = async () => ({ ok: true, json: async () => ({ error: { code: -1, message: 'credits exhausted secret' } }) });
  await assert.rejects(rpc.call('getBlock'), error => error.message === 'PROVIDER_QUOTA');
  assert.equal(store.job().credits, 2);
});

test('RPC retries rate limits with shared Retry-After cooldown and charges retries', async t => {
  const store = setup(t);
  let calls = 0;
  const rpc = new DownloadRpc({ key: 'secret', store, rps: 1000, fetchFn: async () => {
    if (++calls === 1) return { ok: false, status: 429, headers: { get: () => '1.3' } };
    return response(9);
  } });
  const start = Date.now();
  assert.equal(await rpc.call('getSlot'), 9);
  assert.ok(Date.now() - start >= 1250);
  assert.equal(store.job().credits, 2);
});

test('RPC abort releases stalled transport and limiter waiters without extra charges', async t => {
  const store = setup(t), controller = new AbortController();
  const rpc = new DownloadRpc({ key: 'secret', store, signal: controller.signal, rps: 1,
    fetchFn: async () => new Promise(() => {}) });
  const a = rpc.call('getSlot'), b = rpc.call('getSlot');
  const settled = Promise.allSettled([a, b]);
  await sleep(5); controller.abort();
  assert.ok((await settled).every(r => r.status === 'rejected'));
  assert.equal(store.job().credits, 1);
});

test('lock excludes concurrent runners and recovers exited local owners', t => {
  const path = join(temp(t), 'download.sqlite');
  let release = acquireLock(path);
  assert.throws(() => acquireLock(path), /Another process/);
  release();
  mkdirSync(`${path}.lock`);
  writeFileSync(`${path}.lock/owner.json`, JSON.stringify({ pid: 2147483647, host: hostname(), token: 'old' }));
  release = acquireLock(path);
  assert.throws(() => acquireLock(path), /Another process/);
  release();
});

test('CLI validates timezone, rate, immutable ranges and supports offline help/status', () => {
  assert.deepEqual(options(['--help']), { help: true });
  assert.equal(options([]).command, 'status');
  assert.equal(options(['run']).rps, 8);
  assert.throws(() => options(['run', '--rps', '11']), /rps/);
  assert.throws(() => options(['run', '--start', '2026-10-18T00:00:00']), /timezone/);
  assert.throws(() => options(['run', '--end', '2026-10-17T00:00:00Z']), /after/);
  assert.throws(() => options(['status', '--max-credits', '99']), /only to run/);
  assert.throws(() => options(['export']), /out/);
});

test('JSONL export contains raw metadata, coverage status and completion marker, and refuses overwrite', t => {
  const store = setup(t), path = join(temp(t), 'out.jsonl');
  store.setBounds({ first: 1, last: 1 }); store.discover([1], 2, true);
  const result = inspectBlock(block(), mint, 100, 200);
  store.complete(1, 150, result.matches, []);
  assert.equal(exportJsonl(store, path), 1);
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].inspectionComplete, true);
  assert.deepEqual(rows[1].meta, entry().meta);
  assert.equal(rows[2].transactions, 1);
  assert.throws(() => exportJsonl(store, path), /EEXIST/);
});
