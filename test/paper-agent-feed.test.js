import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PaperFeeds, MAX_FRAME_BYTES } from '../src/paper-feeds.js';
import { agentTransaction } from '../src/paper-agent-feed.js';
import { readFeedHealth } from '../src/feed-health.js';
import { MAYHEM } from '../src/config.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventEmitter {
  constructor(url, kind) { super(); Object.assign(this, { url, kind, readyState: 0, sent: [], autoPong: true }); }
  open() { this.readyState = 1; this.emit('open'); }
  send(raw) { if (this.readyState !== 1) throw new Error('closed'); this.sent.push(JSON.parse(raw)); }
  text(message) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1006); }
  ping() { if (this.autoPong) this.emit('pong'); }
  request(method, n = 0) { return this.sent.filter(row => row.method === method)[n]; }
  ack(method, result, n = 0) { this.text({ id: this.request(method, n).id, result }); }
}
const transaction = (signature = 'signature', slot = 55) => ({ signature, slot, transaction: {
  meta: { err: null, logMessages: [] }, transaction: { signatures: [signature], message: { accountKeys: [] } },
} });
const notify = (socket, subscription = 4, tx = transaction()) => socket.text({ method: 'transactionNotification', params: { subscription, result: tx } });
function setup({ accounts, watches = [['m1', 'curve1', false]] } = {}) {
  let clock = 100000, sequence = 0;
  const sockets = [], events = [], timers = new Map(), rows = new Map(), usage = [], calls = [];
  const store = {
    usage: (...args) => usage.push(args),
    run: (_sql, key, value) => rows.set(key, value),
    get: (_sql, key) => rows.has(key) ? { value: rows.get(key) } : undefined,
  };
  const feeds = new PaperFeeds(store, {
    // Deliberately no API key: legacy constructor derivation would throw.
    wsUrl: 'wss://confirmed.example.test/',
    accounts: async (...args) => { calls.push(args); return accounts ? accounts(...args) : { context: { slot: 50 }, value: [{}] }; },
  }, {
    agentMode: true,
    onAccount: (...args) => events.push(['account', ...args]),
    onAgentTransaction: tx => events.push(['tx', tx]),
    onTransaction: () => assert.fail('legacy transaction callback'),
    onCoverage: mint => events.push(['coverage', mint]),
    onReady: () => events.push(['ready']), onGap: reason => events.push(['gap', reason]),
    onSlot: slot => events.push(['slot', slot]),
    onSubscriptionError: detail => events.push(['error', detail]),
    socketFactory: (url, kind) => { const socket = new Socket(url, kind); sockets.push(socket); return socket; },
    setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: id => timers.delete(id), now: () => clock,
  });
  for (const args of watches) feeds.add(...args);
  const of = type => events.filter(event => event[0] === type);
  const socket = kind => sockets.filter(row => row.kind === kind).at(-1);
  const advance = ms => {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= clock && timers.has(id)) { timers.delete(id); timer.fn(); }
  };
  const bringUp = async () => {
    feeds.start(); const standard = socket('standard'), agent = socket('agent');
    standard.open(); standard.ack('slotSubscribe', 9);
    for (let n = 0; n < watches.length; n++) standard.ack('accountSubscribe', 20 + n, n);
    if (agent) { agent.open(); agent.ack('transactionSubscribe', 4); }
    await settle(); return [standard, agent];
  };
  return { feeds, sockets, socket, timers, rows, store, usage, calls, events, of, advance, bringUp, now: () => clock };
}

test('confirmed transport filters every watch and never derives beta credentials', async () => {
  const t = setup({ watches: [['m1', 'curve1', false], ['m2', 'curve2', true]] });
  const [standard, agent] = await t.bringUp();
  assert.deepEqual(t.sockets.map(s => s.kind), ['standard', 'agent']);
  assert.ok(t.sockets.every(s => s.url === 'wss://confirmed.example.test/'));
  assert.deepEqual(agent.request('transactionSubscribe').params, [
    { accountRequired: [MAYHEM], accountInclude: ['curve1', 'curve2'], vote: false, failed: false },
    { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 1 },
  ]);
  assert.equal(standard.request('accountSubscribe').params[1].commitment, 'confirmed');
  assert.equal(t.calls[0][1].commitment, 'confirmed');
  assert.deepEqual(t.of('coverage'), [['coverage', 'm1'], ['coverage', 'm2']]);
  t.feeds.setPreprocessed('m1', false); t.feeds.setPreprocessed('m2', false); t.advance(100);
  assert.equal(t.feeds.covers('m1'), true); assert.equal(t.feeds.covers('m2'), true);
  assert.equal(t.sockets.length, 2);
  await t.feeds.stop(); assert.equal(t.timers.size, 0);
});

test('normalizes the Helius envelope and delivers only exact acknowledged active subscription IDs', async () => {
  const t = setup(); t.feeds.start();
  const a = t.socket('standard'), b = t.socket('agent'); a.open(); b.open();
  a.ack('slotSubscribe', 9); a.ack('accountSubscribe', 20); await settle();
  notify(b); assert.equal(t.of('tx').length, 0);
  b.text({ id: b.request('transactionSubscribe').id + 99, result: 4 });
  notify(b); assert.equal(t.of('tx').length, 0);
  b.ack('transactionSubscribe', 4);
  notify(b, '4'); notify(b, 99); notify(b);
  const raw = transaction();
  assert.deepEqual(t.of('tx'), [['tx', { signature: raw.signature, slot: raw.slot,
    meta: raw.transaction.meta, transaction: raw.transaction.transaction }]]);
  const failed = transaction(); failed.transaction.meta.err = { InstructionError: [0, 'failure'] };
  notify(b, 4, failed); assert.equal(t.of('tx').length, 1);
  assert.deepEqual(agentTransaction(t.of('tx')[0][1]), t.of('tx')[0][1]);
  await t.feeds.stop();
});

test('coverage requires fresh account baseline plus standard and confirmed acknowledgment', async () => {
  let resolve;
  const t = setup({ accounts: () => new Promise(r => { resolve = r; }) });
  t.feeds.start(); const a = t.socket('standard'), b = t.socket('agent'); a.open(); b.open();
  b.ack('transactionSubscribe', 4); a.ack('accountSubscribe', 20);
  assert.equal(t.feeds.covers('m1'), false);
  resolve({ context: { slot: 50 }, value: [{}] }); await settle();
  assert.equal(t.feeds.covers('m1'), false);
  a.ack('slotSubscribe', 9);
  assert.equal(t.feeds.covers('m1'), true); assert.equal(t.of('coverage').length, 1);
  await t.feeds.stop();
});

test('make-before-break acknowledges new coverage, ignores standby and obsolete socket notifications', async () => {
  const t = setup(); const [a, b] = await t.bringUp();
  t.feeds.add('m2', 'curve2', false); a.ack('accountSubscribe', 21, 1); await settle(); t.advance(100);
  const c = t.socket('agent'); c.open();
  assert.equal(b.readyState, 1); assert.equal(t.feeds.covers('m2'), false);
  notify(b, 4, transaction('old')); notify(c, 5, transaction('standby'));
  c.ack('transactionSubscribe', 5);
  assert.deepEqual(b.request('transactionUnsubscribe').params, [4]);
  assert.equal(b.readyState, 3); assert.equal(t.feeds.covers('m2'), true);
  notify(b, 4, transaction('obsolete')); notify(c, 5, transaction('new'));
  assert.deepEqual(t.of('tx').map(e => e[1].signature), ['old', 'new']);
  assert.equal(t.of('gap').length, 0);
  t.feeds.remove('m2'); t.advance(100); const d = t.socket('agent'); d.open(); d.ack('transactionSubscribe', 6);
  assert.deepEqual(d.request('transactionSubscribe').params[0].accountInclude, ['curve1']);
  assert.equal(t.feeds.covers('m2'), false);
  await t.feeds.stop();
});

test('replacement failure keeps healthy coverage and retries with bounded backoff', async () => {
  const t = setup(); const [a, b] = await t.bringUp();
  t.feeds.add('m2', 'curve2'); a.ack('accountSubscribe', 21, 1); await settle(); t.advance(100);
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
    const next = t.socket('agent'); next.open();
    next.text({ id: next.request('transactionSubscribe').id, error: { code: -32001, message: 'secret' } });
    assert.equal(b.readyState, 1); assert.equal(t.feeds.covers('m1'), true);
    assert.equal(t.of('gap').length, 0); assert.equal(t.feeds.covers('m2'), false);
    a.text({ method: 'slotNotification', params: { subscription: 9, result: { slot: t.now() } } });
    t.advance(delay - 1); assert.equal(t.socket('agent'), next);
    t.advance(1); assert.notEqual(t.socket('agent'), next);
  }
  const next = t.socket('agent'); next.open(); next.ack('transactionSubscribe', 8);
  assert.equal(t.feeds.covers('m2'), true);
  assert.ok(!JSON.stringify([...t.rows, ...t.events]).includes('secret'));
  await t.feeds.stop();
});

test('active confirmed gap cancels through onGap and rebaselines before coverage returns', async () => {
  let pending;
  const t = setup({ accounts: () => t.calls.length === 1 ? { context: { slot: 50 }, value: [{}] }
    : new Promise(resolve => { pending = resolve; }) });
  const [a, b] = await t.bringUp(); b.terminate();
  assert.equal(t.feeds.covers('m1'), false); assert.equal(t.feeds.isReady(), false);
  assert.deepEqual(t.of('gap'), [['gap', 'agent_disconnected']]);
  assert.equal(a.readyState, 1); assert.equal(t.calls.length, 2);
  t.advance(1000); const c = t.socket('agent'); c.open(); c.ack('transactionSubscribe', 5);
  assert.equal(t.feeds.covers('m1'), false);
  pending({ context: { slot: 51 }, value: [{}] }); await settle();
  assert.equal(t.feeds.covers('m1'), true); assert.equal(t.of('coverage').length, 2);
  assert.equal(t.of('ready').length, 2);
  await t.feeds.stop();
});

test('standard gap forces confirmed reack and ignores stale account baseline generations', async () => {
  const pending = [];
  const t = setup({ accounts: () => new Promise(resolve => pending.push(resolve)) });
  const [a, b] = await t.bringUp(); a.terminate();
  assert.equal(b.readyState, 3); assert.equal(t.feeds.covers('m1'), false);
  t.advance(1000); const a2 = t.socket('standard'); a2.open();
  const b2 = t.socket('agent'); b2.open();
  a2.ack('slotSubscribe', 10); a2.ack('accountSubscribe', 22);
  pending[0]({ context: { slot: 999 }, value: [{}] }); await settle();
  assert.equal(t.of('account').length, 0);
  pending[1]({ context: { slot: 51 }, value: [{}] }); await settle();
  assert.equal(t.feeds.covers('m1'), false);
  b2.ack('transactionSubscribe', 5);
  assert.equal(t.feeds.covers('m1'), true); assert.equal(t.of('gap').length, 1);
  notify(b, 4); assert.equal(t.of('tx').length, 0);
  await t.feeds.stop();
});

test('no watches means no transaction subscription and last removal closes it', async () => {
  const t = setup({ watches: [] }); await t.bringUp();
  assert.deepEqual(t.sockets.map(s => s.kind), ['standard']); assert.equal(t.feeds.isReady(), true);
  t.feeds.add('m1', 'curve1', false); t.advance(100);
  const b = t.socket('agent'); b.open(); b.ack('transactionSubscribe', 4);
  t.feeds.remove('m1'); t.advance(100);
  assert.equal(b.readyState, 3); assert.equal(t.feeds.agent.conn, null);
  await t.feeds.stop(); assert.equal(t.timers.size, 0);
});

test('unacknowledged active subscription timeout gaps; foreign ack does not extend deadline', async () => {
  const t = setup(); t.feeds.start(); const a = t.socket('standard'), b = t.socket('agent');
  a.open(); a.ack('slotSubscribe', 9); a.ack('accountSubscribe', 20); b.open();
  t.advance(14000); b.text({ id: 9999, result: 4 }); t.advance(1000);
  assert.equal(b.readyState, 3); assert.deepEqual(t.of('gap'), [['gap', 'agent_ack_timeout']]);
  await t.feeds.stop();
});

test('heartbeat timeout fails active subscription even when standard slots continue', async () => {
  const t = setup(); const [a, b] = await t.bringUp(); b.autoPong = false;
  t.advance(10000);
  a.text({ method: 'slotNotification', params: { subscription: 9, result: { slot: 60 } } });
  t.advance(10000);
  assert.deepEqual(t.of('gap'), [['gap', 'agent_heartbeat_timeout']]);
  await t.feeds.stop();
});

test('oversized, binary, malformed and invalid subscription responses fail closed', async () => {
  for (const [send, reason] of [
    [b => b.emit('message', Buffer.alloc(MAX_FRAME_BYTES + 1), false), 'oversized_frame'],
    [b => b.emit('message', Buffer.from([1]), true), 'malformed_message'],
    [b => b.emit('message', Buffer.from('{bad'), false), 'malformed_message'],
    [b => notify(b, 4, { ...transaction(), slot: -1 }), 'malformed_message'],
  ]) {
    const t = setup(); const [, b] = await t.bringUp(); send(b);
    assert.equal(b.readyState, 3); assert.deepEqual(t.of('gap'), [['gap', `agent_${reason}`]]);
    assert.equal(t.of('tx').length, 0); await t.feeds.stop();
  }
  const t = setup(); t.feeds.start(); const b = t.socket('agent'); b.open(); b.ack('transactionSubscribe', '4');
  assert.deepEqual(t.of('gap'), [['gap', 'agent_subscribe_failed']]); await t.feeds.stop();
});

test('obsolete pending replacements, timers, resync and stop cannot deliver or resurrect sockets', async () => {
  const t = setup(); await t.bringUp();
  t.feeds.add('m2', 'curve2'); t.advance(100); const b = t.socket('agent'); b.open();
  const staleAck = t.timers.get(t.feeds.agent.next.ackTimer).fn;
  const staleBeat = t.timers.get(t.feeds.agent.next.heartbeat).fn;
  t.feeds.add('m3', 'curve3'); t.advance(100); const c = t.socket('agent'); c.open();
  b.ack('transactionSubscribe', 5); staleAck(); staleBeat();
  assert.equal(b.readyState, 3); assert.equal(c.readyState, 1);
  c.ack('transactionSubscribe', 6);
  assert.deepEqual(c.request('transactionSubscribe').params[0].accountInclude, ['curve1', 'curve2', 'curve3']);
  t.feeds.resync(); assert.equal(c.readyState, 3); assert.equal(t.feeds.covers('m1'), false);
  const count = t.sockets.length;
  await t.feeds.stop(); staleAck(); staleBeat(); notify(c, 6); t.advance(120000);
  assert.equal(t.sockets.length, count); assert.equal(t.timers.size, 0); assert.equal(t.of('gap').length, 0);
  assert.equal(t.of('tx').length, 0);
});

test('twenty configured watches share one bounded filter and churn keeps at most two agent sockets', async () => {
  const watches = Array.from({ length: 20 }, (_, i) => [`m${i}`, `curve${i}`, false]);
  const t = setup({ watches }); await t.bringUp();
  assert.equal(t.socket('agent').request('transactionSubscribe').params[0].accountInclude.length, 20);
  assert.equal(t.of('coverage').length, 20);
  for (let i = 0; i < 20; i++) {
    t.feeds.remove(`m${i}`); t.feeds.add(`new${i}`, `newCurve${i}`, false); t.advance(100);
    const next = t.socket('agent'); next.open();
    assert.ok(t.sockets.filter(s => s.kind === 'agent' && s.readyState !== 3).length <= 2);
    next.ack('transactionSubscribe', 100 + i);
    assert.equal(next.request('transactionSubscribe').params[0].accountInclude.length, 20);
  }
  await t.feeds.stop(); assert.equal(t.timers.size, 0);
});

test('factory failures and replacement ack timeouts retry without stale timer resurrection', async () => {
  const t = setup(); const factory = t.feeds.agent.socketFactory;
  t.feeds.agent.socketFactory = () => { throw Object.assign(new Error('secret credentials'), { code: 'ECONNRESET' }); };
  t.feeds.start(); const a = t.socket('standard'); a.open(); a.ack('slotSubscribe', 9); a.ack('accountSubscribe', 20);
  assert.deepEqual(t.of('gap'), [['gap', 'agent_connect_failed']]);
  const staleRetry = t.timers.get(t.feeds.agent.retry).fn;
  t.feeds.agent.socketFactory = factory; t.advance(1000);
  const b = t.socket('agent'); b.open(); b.ack('transactionSubscribe', 4); await settle();
  staleRetry(); assert.equal(t.sockets.length, 2);
  t.feeds.add('m2', 'curve2'); a.ack('accountSubscribe', 21, 1); t.advance(100);
  const next = t.socket('agent'); next.open(); t.advance(15000);
  assert.equal(next.readyState, 3); assert.equal(b.readyState, 1);
  assert.equal(t.of('gap').length, 1); assert.equal(t.feeds.covers('m1'), true);
  assert.ok(!JSON.stringify([...t.rows, ...t.events]).includes('secret'));
  await t.feeds.stop(); staleRetry(); assert.equal(t.timers.size, 0);
});

test('account baseline failure never grants coverage; a live confirmed state cancels its retry', async () => {
  const t = setup({ accounts: async () => { throw new Error('offline'); } });
  const [a] = await t.bringUp();
  assert.equal(t.feeds.covers('m1'), false); assert.equal(t.of('coverage').length, 0);
  const watch = t.feeds.watches.get('m1'); assert.ok(watch.baselineRetry != null);
  a.text({ method: 'accountNotification', params: { subscription: 20, result: { context: { slot: 60 }, value: {} } } });
  assert.equal(watch.baselineRetry, null); assert.equal(t.feeds.covers('m1'), true);
  assert.deepEqual(t.of('coverage'), [['coverage', 'm1']]);
  await t.feeds.stop();
});

test('confirmed health and usage stay separate from preprocessed and byte billing', async () => {
  const t = setup(); const [, b] = await t.bringUp(); notify(b);
  t.feeds.flushHealth(); t.feeds.flushUsage();
  assert.ok(t.usage.some(row => row[0] === 'websocket' && row[1] === 'paper_agent_received_bytes'));
  assert.deepEqual(t.usage.find(row => row[0] === 'paper_agent'), ['paper_agent', 'transactions', 1]);
  assert.ok(!t.usage.some(row => row[0].startsWith('preprocessed')));
  t.rows.set('feed_health_process', JSON.stringify({ phase: 'running', updatedAt: t.now() }));
  assert.equal(readFeedHealth(t.store, t.now()).agent.state, 'subscribed');
  t.feeds.add('m2', 'curve2', false); t.feeds.flushHealth();
  assert.equal(readFeedHealth(t.store, t.now()).agent.state, 'degraded');
  await t.feeds.stop(); assert.equal(readFeedHealth(t.store, t.now()).agent.state, 'stopped');
});
