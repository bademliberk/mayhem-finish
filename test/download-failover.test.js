import test from 'node:test';
import assert from 'node:assert/strict';
import { DownloadRpc } from '../src/download-rpc.js';

function setup(fetchFn, budget = Infinity, options = {}) {
  let used = 0;
  const store = { reserve() { if (used >= budget) throw new Error('CREDIT_BUDGET'); used++; } };
  const rpc = new DownloadRpc({ key: 'primary', backupKey: 'backup', store, rps: 1000, retries: 0, fetchFn, ...options });
  return { rpc, used: () => used };
}
const ok = () => ({ ok: true, json: async () => ({ result: 42 }) });
const quota = () => ({ ok: true, json: async () => ({ error: { code: -1, message: 'credits exhausted' } }) });

test('quota retries same request with backup and retains backup for later requests', async () => {
  const calls = [];
  const { rpc, used } = setup(async (url, opts) => {
    calls.push([new URL(url).searchParams.get('api-key'), JSON.parse(opts.body)]);
    return calls.length === 1 ? quota() : ok();
  });
  assert.equal(await rpc.call('getBlock', [9]), 42);
  await rpc.call('getBlock', [10]);
  assert.deepEqual(calls.map(c => c[0]), ['primary', 'backup', 'backup']);
  assert.deepEqual(calls[0][1], calls[1][1]);
  assert.equal(used(), 3);
});

test('both exhausted keys stop without cycling', async () => {
  const { rpc, used } = setup(async () => quota());
  await assert.rejects(rpc.call('getBlock'), /PROVIDER_QUOTA/);
  assert.equal(used(), 2);
  await assert.rejects(rpc.call('getBlock'), /PROVIDER_QUOTA/);
  assert.equal(used(), 2);
});

test('local budget is never bypassed by credential failover', async () => {
  const { rpc, used } = setup(async () => quota(), 1);
  await assert.rejects(rpc.call('getBlock'), /CREDIT_BUDGET/);
  assert.equal(used(), 1);
});

test('rate limits, auth and transient failures do not switch credentials', async () => {
  for (const status of [429, 401, 403, 500]) {
    const { rpc, used } = setup(async () => ({ ok: false, status }));
    await assert.rejects(rpc.call('getBlock'));
    assert.equal(rpc.keyIndex, 0); assert.equal(used(), 1);
  }
});

test('HTTP 402 and explicit credit-exhaustion HTTP 429 support failover', async () => {
  for (const status of [402, 429]) {
    let calls = 0;
    const { rpc } = setup(async () => ++calls === 1
      ? { ok: false, status, json: async () => ({ error: { message: 'monthly credits exhausted' } }) }
      : ok());
    assert.equal(await rpc.call('getBlock'), 42);
    assert.equal(rpc.keyIndex, 1);
  }
});

test('missing or duplicate backup key stops at primary exhaustion', async () => {
  for (const backupKey of [undefined, 'primary']) {
    const { rpc, used } = setup(async () => quota(), Infinity, { backupKey });
    await assert.rejects(rpc.call('getBlock'), /PROVIDER_QUOTA/);
    assert.equal(used(), 1);
  }
});

test('concurrent primary failures share backup without skipping or cycling keys', async () => {
  const keys = [];
  const { rpc } = setup(async url => {
    const key = new URL(url).searchParams.get('api-key'); keys.push(key);
    if (key === 'primary') { await new Promise(resolve => setTimeout(resolve, 15)); return quota(); }
    return ok();
  });
  assert.deepEqual(await Promise.all([rpc.call('getBlock', [1]), rpc.call('getBlock', [2])]), [42, 42]);
  assert.deepEqual(keys, ['primary', 'primary', 'backup', 'backup']);
});
