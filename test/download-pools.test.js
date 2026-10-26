import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PoolStore, scanPools, validatePage } from '../src/download-pools.js';
import { DownloadRpc } from '../src/download-rpc.js';
import { poolOptions, exportPools, DEFAULT_POOLS } from '../src/download-pools-cli.js';

const config = { format: 1, addresses: ['a', 'b'], start: 100, end: 200, tokenAccounts: 'none', pageSize: 1000, sortOrder: 'desc', maxVersion: 1 };
const entry = (signature = 'sig') => ({ slot: 5, blockTime: 150, version: 1,
  transaction: { signatures: [signature], message: { accountKeys: [], instructions: [] } }, meta: { err: null } });
const page = (data = [], paginationToken = null) => ({ data, paginationToken });
function setup(t, budget = 2000) {
  const store = new PoolStore(':memory:'); store.initialize(config, budget);
  t.after(() => store.close()); return store;
}
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pool-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}

test('1000 full jsonParsed v1 options and per-address pagination deduplicate overlap', async t => {
  const store = setup(t), calls = [];
  const rpc = { call: async (method, [address, opts]) => {
    calls.push([address, opts.paginationToken]);
    assert.equal(method, 'getTransactionsForAddress');
    assert.equal(opts.limit, 1000); assert.equal(opts.transactionDetails, 'full');
    assert.equal(opts.encoding, 'jsonParsed'); assert.equal(opts.maxSupportedTransactionVersion, 1);
    assert.deepEqual(opts.filters, { blockTime: { gte: 100, lt: 200 }, tokenAccounts: 'none', status: 'any' });
    if (address === 'a' && !opts.paginationToken) return page([entry()], '5:0');
    return page([entry(), entry('other')]);
  } };
  const result = await scanPools({ store, rpc });
  assert.equal(result.pages, 3); assert.equal(result.returnedTransactions, 5);
  assert.equal(result.uniqueTransactions, 2); assert.equal(result.completeForConfiguredAddresses, true);
  assert.equal(result.tokenWideComplete, false);
  assert.deepEqual(calls, [['a', undefined], ['a', '5:0'], ['b', undefined]]);
  assert.equal(store.get('SELECT count(*) AS n FROM history_sources').n, 4);
  await scanPools({ store, rpc }); assert.equal(calls.length, 3);
});

test('empty and short pages continue until explicit null token', async t => {
  const store = setup(t); let calls = 0;
  await scanPools({ store, rpc: { call: async () => ++calls === 1 ? page([], 'next') : page() } });
  assert.equal(calls, 3); assert.equal(store.status().pages, 3);
});

test('invalid response and repeated or cyclic cursors never advance checkpoint', t => {
  const store = setup(t);
  for (const result of [{ data: [] }, page([], ''), page([{}]), page([{ ...entry(), blockTime: 200 }])]) {
    assert.throws(() => store.commitPage('a', null, result), /INVALID_HISTORY_PAGE/);
  }
  store.commitPage('a', null, page([], 'x'));
  assert.throws(() => store.commitPage('a', 'x', page([], 'x')), /HISTORY_CURSOR_LOOP/);
  store.commitPage('a', 'x', page([], 'y'));
  assert.throws(() => store.commitPage('a', 'y', page([], 'x')), /HISTORY_CURSOR_LOOP/);
  assert.equal(store.get("SELECT cursor FROM sources WHERE address='a'").cursor, 'y');
});

test('atomic page rollback preserves cursor and no partial transactions', t => {
  const store = setup(t), circular = entry('bad'); circular.meta.self = circular;
  assert.throws(() => store.commitPage('a', null, page([entry(), circular], 'x')));
  assert.equal(store.status().uniqueTransactions, 0);
  assert.equal(store.get("SELECT cursor FROM sources WHERE address='a'").cursor, null);
});

test('disk resume keeps committed cursor and credit reservations', t => {
  const path = join(temp(t), 'pool.sqlite');
  let store = new PoolStore(path); store.initialize(config, 200);
  store.commitPage('a', null, page([entry()], 'x')); store.reserve('getTransactionsForAddress'); store.close();
  store = new PoolStore(path); store.initialize(config);
  assert.equal(store.job().credits, 100); assert.equal(store.job().max_credits, 200);
  assert.equal(store.get("SELECT cursor FROM sources WHERE address='a'").cursor, 'x');
  assert.throws(() => store.initialize({ ...config, end: 201 }), /differs/);
  store.close();
});

test('page pricing reserves 100, settles in groups of 100, and persists budget', t => {
  const store = setup(t, 100);
  let id = store.reserve('getTransactionsForAddress');
  assert.throws(() => store.reserve('getTransactionsForAddress'), /CREDIT_BUDGET/);
  store.settle(id, page([entry()])); assert.equal(store.job().credits, 10);
  assert.throws(() => store.reserve('getTransactionsForAddress'), /CREDIT_BUDGET/);
  store.initialize(config, 1000);
  for (const [count, cost] of [[0, 10], [100, 10], [101, 20], [1000, 100]]) {
    const before = store.job().credits;
    id = store.reserve('getTransactionsForAddress');
    store.settle(id, page(Array.from({ length: count }, (_, i) => entry(`s${i}`))));
    assert.equal(store.job().credits - before, cost);
  }
  id = store.reserve('getTransactionsForAddress'); store.settle(id, {});
  assert.equal(store.status().uncertainAttempts, 1);
});

test('transport settles success and conservatively retains failed attempt reservation', async t => {
  const store = setup(t);
  const rpc = new DownloadRpc({ key: 'secret', store, retries: 0, rps: 1000,
    fetchFn: async () => ({ ok: true, json: async () => ({ result: page([entry()]) }) }) });
  await rpc.call('getTransactionsForAddress', []); assert.equal(store.job().credits, 10);
  rpc.fetchFn = async () => { throw new Error('api-key=secret'); };
  await assert.rejects(rpc.call('getTransactionsForAddress'), error => error.message === 'TRANSPORT_OR_JSON_FAILURE');
  assert.equal(store.job().credits, 110);
});

test('interrupted page resumes using last committed token, abort dispatches no further calls', async t => {
  const store = setup(t), controller = new AbortController();
  let calls = 0;
  await assert.rejects(scanPools({ store, signal: controller.signal, rpc: { call: async () => {
    calls++; controller.abort(); throw new Error('PAUSED');
  } } }), /PAUSED/);
  assert.equal(store.status().pages, 0); assert.equal(calls, 1);
  store.commitPage('a', null, page([], 'resume'));
  const seen = [];
  await scanPools({ store, rpc: { call: async (_, [address, opts]) => { seen.push([address, opts.paginationToken]); return page(); } } });
  assert.deepEqual(seen, [['a', 'resume'], ['b', undefined]]);
});

test('CLI supports custom address replacement, wallet mode, offline commands and rejects bad arguments', () => {
  assert.equal(poolOptions([]).command, 'status');
  assert.equal(poolOptions(['run']).rps, 2);
  assert.deepEqual(poolOptions(['run']).config.addresses, DEFAULT_POOLS);
  assert.deepEqual(poolOptions(['run', '--address', DEFAULT_POOLS[1], '--token-accounts', 'balanceChanged']).config.addresses, [DEFAULT_POOLS[1]]);
  for (const args of [['run', '--max-credits', '99'], ['run', '--rps', '11'], ['export'], ['run', '--start', '2026-10-18'], ['status', '--address', DEFAULT_POOLS[0]]]) {
    assert.throws(() => poolOptions(args));
  }
});

test('export preserves source addresses, raw entries and partial-coverage header without overwrite', t => {
  const store = setup(t), path = join(temp(t), 'data.jsonl');
  store.commitPage('a', null, page([entry()])); store.commitPage('b', null, page([entry()]));
  assert.equal(exportPools(store, path), 1);
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].tokenWideComplete, false); assert.deepEqual(rows[1].sourceAddresses, ['a', 'b']);
  assert.equal(rows[1].version, 1); assert.equal(rows[2].type, 'export-complete');
  assert.throws(() => exportPools(store, path), /EEXIST/);
});
