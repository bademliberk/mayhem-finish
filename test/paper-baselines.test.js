import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperBaselines } from '../src/paper-baselines.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(accounts) {
  let now = 100000, sequence = 0;
  const timers = new Map(), calls = [], events = [], failures = [];
  const feeds = {
    stopped: false, agentMode: true, watches: new Map(), standard: { generation: 0 }, tasks: new Set(),
    now: () => now, setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: id => timers.delete(id), baselineUsage: method => failures.push(method), notifyCoverage() {},
    safe: (...args) => events.push(args),
    rpc: { accounts: (...args) => { calls.push(args); return accounts ? accounts(...args)
      : Promise.resolve({ context: { slot: 50 }, value: args[0].map(() => ({})) }); } },
  };
  const baselines = new PaperBaselines(feeds);
  const add = n => {
    const watch = { mint: `mint${n}`, curve: `curve${n}`, seq: 0, subscription: n + 1, lastSlot: -1 };
    feeds.watches.set(watch.mint, watch); baselines.request(watch); return watch;
  };
  const advance = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.fn(); }
  };
  const stop = async () => { feeds.stopped = true; baselines.clear(); await Promise.all([...feeds.tasks]); assert.equal(timers.size, 0); };
  return { feeds, baselines, calls, events, failures, timers, add, advance, stop };
}

test('one updated or removed member does not cancel other members of a baseline batch', async () => {
  const pending = deferred(); const t = setup(() => pending.promise);
  const a = t.add(1), b = t.add(2), c = t.add(3); await settle();
  assert.deepEqual(t.calls[0][0], [a.curve, b.curve, c.curve]);
  a.lastSlot = 80; t.baselines.cancel(a); // a live account notification satisfies a
  t.baselines.cancel(b); t.feeds.watches.delete(b.mint); // b was removed
  assert.equal(t.calls[0][1].signal.aborted, false);
  assert.deepEqual(t.baselines.counts(), { baselineQueued: 0, baselineInFlight: 1 });
  pending.resolve({ context: { slot: 500 }, value: [{ old: 1 }, { old: 2 }, { fresh: 3 }] }); await settle();
  assert.deepEqual(t.events, [['onAccount', c.mint, 500, { fresh: 3 }, 'baseline']]);
  assert.equal(a.lastSlot, 80); assert.equal(t.baselines.pending.size, 0);
  t.advance(60000); await settle(); assert.equal(t.calls.length, 1, 'no freshness polling after success');
  await t.stop();
});

test('malformed batch envelopes never fabricate missing accounts or partially deliver', async () => {
  for (const values of [[], [{}], [{}, {}, {}], [{}, undefined], [{}, 7], [{}, []], Array(2)]) {
    const t = setup(async () => ({ context: { slot: 51 }, value: values })); t.add(1); t.add(2); await settle();
    assert.deepEqual(t.events, []); assert.equal(t.failures.length, 2);
    assert.equal(t.baselines.pending.size, 2); assert.equal(t.timers.size, 1);
    assert.equal(t.baselines.active, null); await t.stop();
  }
  const t = setup(async () => ({ context: { slot: 51 }, value: [null, {}] })); t.add(1); t.add(2); await settle();
  assert.equal(t.events[0][3], null); assert.equal(t.events.length, 2);
  assert.deepEqual(t.failures, []); await t.stop();
});

test('retry work uses one timer and yields fairly to other baseline batches', async () => {
  let failed = false;
  const t = setup(async addresses => {
    if (!failed) { failed = true; throw new Error('offline'); }
    return { context: { slot: 60 }, value: addresses.map(() => ({})) };
  });
  for (let i = 0; i < 300; i++) t.add(i);
  await settle();
  assert.equal(t.calls.length, 3); assert.equal(t.events.length, 200);
  assert.equal(t.baselines.pending.size, 100); assert.equal(t.timers.size, 1);
  const later = t.add(300); await settle();
  assert.deepEqual(t.calls[3][0], [later.curve]);
  t.advance(999); await settle(); assert.equal(t.calls.length, 4);
  t.advance(1); await settle();
  assert.equal(t.calls.length, 5); assert.equal(t.events.length, 301);
  assert.equal(t.baselines.pending.size, 0); assert.equal(t.timers.size, 0);
  await t.stop();
});

test('waiting in feed-local queue does not consume the next batch RPC deadline', async () => {
  const first = deferred(); let count = 0;
  const t = setup(addresses => ++count === 1 ? first.promise
    : Promise.resolve({ context: { slot: 60 }, value: addresses.map(() => ({})) }));
  for (let i = 0; i < 101; i++) t.add(i);
  await settle(); assert.equal(t.calls.length, 1); assert.equal(t.calls[0][1].deadlineMs, 105000);
  t.advance(4000); first.resolve({ context: { slot: 50 }, value: Array.from({ length: 100 }, () => ({})) });
  await settle(); assert.equal(t.calls.length, 2); assert.equal(t.calls[1][1].deadlineMs, 109000);
  await t.stop();
});

test('baseline callbacks can remove other batch members or reset the entire generation', async () => {
  for (const action of ['remove', 'reset']) {
    const t = setup(); t.add(1); const b = t.add(2);
    t.feeds.safe = (...args) => {
      t.events.push(args);
      if (action === 'remove') { t.baselines.cancel(b); t.feeds.watches.delete(b.mint); }
      else { t.feeds.standard.generation++; t.baselines.clear(); }
    };
    await settle(); assert.equal(t.events.length, 1); assert.equal(t.baselines.pending.size, 0);
    await t.stop();
  }
});

test('retired generations and removed/re-added identities cannot restore baseline coverage', async () => {
  const replies = [];
  const t = setup(() => { const reply = deferred(); replies.push(reply); return reply.promise; });
  const old = t.add(1); await settle();
  t.baselines.cancel(old); t.feeds.watches.delete(old.mint);
  const replacement = t.add(1); await settle();
  assert.equal(t.calls[0][1].signal.aborted, true);
  replies[0].resolve({ context: { slot: 999 }, value: [{ old: true }] }); await settle();
  assert.deepEqual(t.events, []);
  t.feeds.standard.generation++; t.baselines.clear();
  assert.equal(t.calls[1][1].signal.aborted, true);
  replies[1].resolve({ context: { slot: 999 }, value: [{ old: true }] }); await settle();
  assert.deepEqual(t.events, []); assert.equal(replacement.lastSlot, -1);
  t.baselines.request(replacement); await settle();
  replies[2].resolve({ context: { slot: 50 }, value: [{}] }); await settle();
  assert.equal(t.events.length, 1); assert.equal(replacement.lastSlot, 50);
  await t.stop();
});

test('stop cancels queued dispatch and stale retry callbacks without RPC resurrection', async () => {
  const t = setup(async () => { throw new Error('offline'); });
  t.add(1); await settle(); const staleRetry = [...t.timers.values()][0].fn;
  t.add(2); // coalesced dispatch has not run yet
  await t.stop(); staleRetry(); await settle();
  assert.equal(t.calls.length, 1); assert.equal(t.feeds.tasks.size, 0); assert.equal(t.baselines.pending.size, 0);
});
