import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PaperFeeds, preprocessedUrl, MAX_FRAME_BYTES } from '../src/paper-feeds.js';
import { Rpc } from '../src/rpc.js';
import { PUMP } from '../src/config.js';

const KEY = 'secret-key-123';
const STD = `wss://mainnet.helius-rpc.com/?api-key=${KEY}`;
const PRE = `wss://beta.helius-rpc.com/?api-key=${KEY}`;
const CURVE = 'CurveAddress1111111111111111111111111111111';
const settle = () => new Promise(resolve => setImmediate(resolve));

class Socket extends EventEmitter {
  constructor(url, kind) { super(); this.url = url; this.kind = kind; this.readyState = 0; this.sent = []; this.pings = 0; this.autoPong = true; }
  open() { this.readyState = 1; this.emit('open'); }
  send(raw) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(JSON.parse(raw)); }
  text(value) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  binary(buffer) { this.emit('message', buffer, true); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  ping() { this.pings++; if (this.autoPong) this.emit('pong'); }
  find(method, nth = 0) { return this.sent.filter(m => m.method === method)[nth]; }
  ack(method, result = 1, nth = 0) { this.text({ jsonrpc: '2.0', id: this.find(method, nth).id, result }); }
}

function setup({ accounts, watches = [['m1', CURVE]] } = {}) {
  const usage = [], events = [], sockets = [], timers = new Map(), rpcCalls = [];
  let seq = 0, clock = 0;
  const store = { usage: (source, method, amount = 1) => usage.push([source, method, amount]) };
  const rpc = {
    wsUrl: STD,
    accounts: async (...args) => {
      rpcCalls.push(args);
      return accounts ? accounts(...args) : { context: { slot: 50 }, value: [{ lamports: 1 }] };
    },
  };
  const feeds = new PaperFeeds(store, rpc, {
    onAccount: (mint, slot, account) => events.push(['account', mint, slot, account]),
    onTransaction: buffer => events.push(['tx', buffer]),
    onGap: reason => events.push(['gap', reason]),
    onReady: () => events.push(['ready']),
    onSlot: slot => events.push(['slot', slot]),
    onCoverage: mint => events.push(['coverage', mint]),
    socketFactory: (url, kind) => { const s = new Socket(url, kind); sockets.push(s); return s; },
    setTimer: (fn, delay) => { const id = ++seq; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  for (const [mint, curve] of watches) feeds.add(mint, curve);
  const advance = ms => {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= clock && timers.has(id)) { timers.delete(id); timer.fn(); }
  };
  const of = type => events.filter(e => e[0] === type);
  const std = () => sockets.filter(s => s.url === STD);
  const pre = () => sockets.filter(s => s.url === PRE);
  // Bring both streams fully up (slot + preprocessed acked, one account acked).
  const bringUp = async ({ account = true } = {}) => {
    feeds.start();
    const [a, b] = [std().at(-1), pre().at(-1)];
    a.open(); b.open();
    a.ack('slotSubscribe', 9);
    b.ack('preprocessedSubscribe', 3);
    if (account) { a.ack('accountSubscribe', 21); await settle(); }
    return [a, b];
  };
  return { feeds, usage, events, sockets, timers, rpcCalls, advance, of, std, pre, bringUp };
}

test('derives the preprocessed endpoint from the same key without leaking on failure', () => {
  assert.equal(preprocessedUrl(STD), PRE);
  assert.equal(preprocessedUrl(`wss://x.test/?foo=1&api-key=a%20b`), 'wss://beta.helius-rpc.com/?api-key=a+b');
  assert.throws(() => preprocessedUrl('wss://mainnet.helius-rpc.com/?token=SECRETVALUE'), error => !/SECRETVALUE|mainnet/.test(error.message));
  assert.throws(() => preprocessedUrl('not a url SECRETVALUE'), error => !/SECRETVALUE/.test(error.message));
  assert.throws(() => new PaperFeeds({}, { wsUrl: 'wss://x.test/' }), /credentials suppressed/);
});

test('start opens one socket per endpoint and never duplicates them', () => {
  const t = setup();
  t.feeds.start(); t.feeds.start();
  assert.equal(t.std().length, 1); assert.equal(t.pre().length, 1);
  assert.deepEqual(t.sockets.map(s => s.kind).sort(), ['preprocessed', 'standard']);
});

test('connect and acknowledgments: exact subscribe payloads, onReady only after preprocessed AND slot acks', async () => {
  const t = setup({ watches: [['m1', CURVE]] });
  t.feeds.start();
  const [a, b] = [t.std()[0], t.pre()[0]];
  assert.equal(a.sent.length, 0); // nothing sent before open
  a.open(); b.open();
  assert.deepEqual(a.find('slotSubscribe').params, []);
  assert.deepEqual(a.find('accountSubscribe').params, [CURVE, { commitment: 'processed', encoding: 'base64' }]);
  assert.deepEqual(b.sent.length, 1);
  assert.deepEqual(b.find('preprocessedSubscribe').params, { accountInclude: [CURVE], accountExclude: [], accountRequired: [PUMP] });
  a.ack('accountSubscribe', 21);
  assert.equal(t.of('ready').length, 0);
  a.ack('slotSubscribe', 9);
  assert.equal(t.of('ready').length, 0); // preprocessed still missing
  b.ack('preprocessedSubscribe', 3);
  assert.equal(t.of('ready').length, 1);
  assert.equal(t.feeds.isReady(), true);
  await t.feeds.stop();
});

test('onReady does not wait for account acks and fires once', async () => {
  const t = setup({ watches: [['m1', CURVE]] });
  await t.bringUp({ account: false });
  assert.equal(t.of('ready').length, 1);
  t.std()[0].ack('accountSubscribe', 21); await settle();
  assert.equal(t.of('ready').length, 1);
  await t.feeds.stop();
});

test('ack fetches exactly one processed snapshot; notifications and slots need no RPC', async () => {
  const t = setup({ watches: [['m1', CURVE]] });
  const [a] = await t.bringUp();
  assert.equal(t.rpcCalls.length, 1);
  assert.deepEqual(t.rpcCalls[0][0], [CURVE]);
  assert.equal(t.rpcCalls[0][1].commitment, 'processed');
  assert.ok(t.rpcCalls[0][1].signal instanceof AbortSignal);
  assert.ok(t.rpcCalls[0][1].deadlineMs > Date.now());
  assert.deepEqual(t.of('account'), [['account', 'm1', 50, { lamports: 1 }]]);
  for (const slot of [51, 52, 53]) {
    a.text({ method: 'accountNotification', params: { subscription: 21, result: { context: { slot }, value: { lamports: slot } } } });
  }
  a.text({ method: 'slotNotification', params: { subscription: 9, result: { slot: 60 } } });
  a.text({ method: 'slotNotification', params: { subscription: 999, result: { slot: 61 } } }); // foreign subscription
  a.text({ method: 'accountNotification', params: { subscription: 555, result: { context: { slot: 70 }, value: {} } } });
  assert.equal(t.rpcCalls.length, 1);
  assert.deepEqual(t.of('account').map(e => e[2]), [50, 51, 52, 53]);
  assert.deepEqual(t.of('slot'), [['slot', 60]]);
  await t.feeds.stop();
});

test('a snapshot older than an already-delivered notification is discarded', async () => {
  let release;
  const t = setup({ watches: [['m1', CURVE]], accounts: () => new Promise(resolve => { release = resolve; }) });
  const [a] = await t.bringUp();
  a.text({ method: 'accountNotification', params: { subscription: 21, result: { context: { slot: 80 }, value: { fresh: true } } } });
  release({ context: { slot: 70 }, value: [{ fresh: false }] });
  await settle();
  assert.deepEqual(t.of('account'), [['account', 'm1', 80, { fresh: true }]]);
  await t.feeds.stop();
});

test('null account values (missing curve) are passed through', async () => {
  const t = setup({ watches: [['m1', CURVE]], accounts: async () => ({ context: { slot: 5 }, value: [null] }) });
  const [a] = await t.bringUp();
  a.text({ method: 'accountNotification', params: { subscription: 21, result: { context: { slot: 6 }, value: null } } });
  assert.deepEqual(t.of('account'), [['account', 'm1', 5, null], ['account', 'm1', 6, null]]);
  await t.feeds.stop();
});

test('binary frames go raw to onTransaction; text frames are JSON control only; usage is split', async () => {
  const t = setup();
  const [a, b] = await t.bringUp({ account: false });
  const frame = Buffer.from([1, 2, 3, 4, 5]);
  b.binary(frame); b.binary(Buffer.from([9, 9]));
  const txs = t.of('tx');
  assert.equal(txs.length, 2);
  assert.ok(Buffer.isBuffer(txs[0][1]) && txs[0][1].equals(frame));
  b.text({ jsonrpc: '2.0', method: 'noise', params: {} }); // ignored, no gap
  assert.equal(t.of('gap').length, 0);
  assert.equal(t.of('tx').length, 2);
  a.text({ method: 'slotNotification', params: { subscription: 9, result: { slot: 1 } } });
  t.feeds.flushUsage();
  const standardBytes = t.usage.find(u => u[0] === 'websocket' && u[1] === 'paper_account_received_bytes')[2];
  assert.ok(standardBytes > 0);
  assert.deepEqual(t.usage.find(u => u[0] === 'preprocessed' && u[1] === 'transactions'), ['preprocessed', 'transactions', 2]);
  const preBytes = t.usage.find(u => u[0] === 'preprocessed_bytes')[2];
  assert.ok(preBytes >= 7);
  t.usage.length = 0;
  t.feeds.flushUsage(); // counters were reset
  assert.deepEqual(t.usage, []);
  await t.feeds.stop();
});

test('binary frame before ack is ignored; binary frame on the standard socket is a malformed gap', async () => {
  const t = setup();
  t.feeds.start();
  const [a, b] = [t.std()[0], t.pre()[0]];
  a.open(); b.open();
  b.binary(Buffer.from([1]));
  assert.equal(t.of('tx').length, 0);
  a.binary(Buffer.from([1]));
  assert.deepEqual(t.of('gap'), [['gap', 'standard_malformed_message']]);
  assert.equal(a.readyState, 3);
  await t.feeds.stop();
});

test('JSON error or malformed text on a stream is a gap and reconnects', async () => {
  const t = setup();
  const [, b] = await t.bringUp({ account: false });
  b.text({ jsonrpc: '2.0', id: 99, error: { code: -32000, message: 'api-key SECRET' } });
  assert.deepEqual(t.of('gap').map(e => e[1]), ['preprocessed_malformed_message']);
  assert.equal(b.readyState, 3);
  t.advance(1000);
  assert.equal(t.pre().length, 2);
  const c = t.pre()[1];
  c.open(); c.emit('message', Buffer.from('not json'), false);
  assert.equal(c.readyState, 3);
  assert.equal(t.of('gap').length, 1); // second failure while still not ready is not re-reported
  await t.feeds.stop();
});

test('malformed standard text (bad JSON, bad slot) causes gap, close and reconnect', async () => {
  const t = setup();
  const [a] = await t.bringUp({ account: false });
  a.emit('message', Buffer.from('{broken'), false);
  assert.equal(t.of('gap').length, 1);
  assert.equal(a.readyState, 3);
  assert.equal(t.feeds.isReady(), false);
  t.advance(1000);
  const a2 = t.std()[1];
  a2.open(); a2.ack('slotSubscribe', 9);
  a2.text({ method: 'slotNotification', params: { subscription: 9, result: { slot: 'x' } } });
  assert.equal(a2.readyState, 3);
  await t.feeds.stop();
});

test('standard disconnect: gap, backoff reconnect, resubscribe, onReady again', async () => {
  const t = setup({ watches: [['m1', CURVE]] });
  const [a] = await t.bringUp();
  assert.equal(t.of('ready').length, 1);
  a.terminate();
  assert.deepEqual(t.of('gap').map(e => e[1]), ['standard_disconnected']);
  assert.equal(t.feeds.isReady(), false);
  assert.equal(t.std().length, 1); // not reconnected yet
  t.advance(999); assert.equal(t.std().length, 1);
  t.advance(1); assert.equal(t.std().length, 2);
  t.advance(60000); assert.equal(t.std().length, 2); // no duplicate sockets from stray timers
  const a2 = t.std()[1];
  a2.open();
  assert.ok(a2.find('accountSubscribe') && a2.find('slotSubscribe'));
  a2.ack('slotSubscribe', 10);
  assert.equal(t.of('ready').length, 2); // preprocessed stayed up and acked; slot ack completes readiness
  await t.feeds.stop();
});

test('after a standard-only drop onReady returns once the standard slot ack arrives (preprocessed still up)', async () => {
  const t = setup({ watches: [['m1', CURVE]] });
  const [a] = await t.bringUp();
  a.terminate();
  t.advance(1000);
  const a2 = t.std()[1];
  a2.open();
  a2.ack('accountSubscribe', 31); await settle();
  assert.equal(t.of('ready').length, 1);
  a2.ack('slotSubscribe', 10);
  assert.equal(t.of('ready').length, 2);
  assert.equal(t.rpcCalls.length, 2); // fresh baseline per resubscription
  assert.equal(t.of('account').length, 2);
  await t.feeds.stop();
});

test('preprocessed-only disconnect gaps, reconnects, re-baselines subscribed accounts and re-readies', async () => {
  const t = setup({ watches: [['m1', CURVE]] });
  const [a, b] = await t.bringUp();
  assert.equal(t.rpcCalls.length, 1);
  assert.equal(t.of('coverage').length, 1);
  b.terminate();
  assert.equal(t.feeds.covers('m1'), false);
  assert.deepEqual(t.of('gap').map(e => e[1]), ['preprocessed_disconnected']);
  assert.equal(a.readyState, 1); // standard untouched
  await settle();
  assert.equal(t.rpcCalls.length, 2); // quiet accounts regain a baseline
  assert.equal(t.of('account').length, 2);
  t.advance(1000);
  const b2 = t.pre()[1];
  b2.open(); b2.ack('preprocessedSubscribe', 4);
  assert.equal(t.of('ready').length, 2);
  assert.equal(t.of('coverage').length, 2);
  assert.equal(t.feeds.covers('m1'), true);
  assert.equal(t.std().length, 1);
  await t.feeds.stop();
});

test('initial preprocessed failures refresh subscribed baselines only once per gap', async () => {
  const t = setup();
  t.feeds.start();
  const a = t.std()[0], b = t.pre()[0];
  a.open(); a.ack('slotSubscribe', 9); a.ack('accountSubscribe', 21);
  await settle();
  assert.equal(t.rpcCalls.length, 1);
  b.terminate();
  await settle();
  assert.equal(t.rpcCalls.length, 2);
  assert.equal(t.of('account').length, 2);
  t.advance(1000); t.pre()[1].terminate();
  await settle();
  assert.equal(t.of('gap').length, 1);
  assert.equal(t.rpcCalls.length, 2);
  t.advance(2000);
  const retry = t.pre()[2]; retry.open(); retry.ack('preprocessedSubscribe', 4);
  assert.equal(t.feeds.isReady(), true);
  assert.equal(t.of('coverage').length, 1);
  assert.equal(t.feeds.watches.get('m1').subscription, 21);
  await t.feeds.stop();
});

test('idle reactivation socket factory failure refreshes reserves without resubscribing curves', async () => {
  const t = setup();
  const [a] = await t.bringUp();
  t.feeds.setPreprocessed('m1', false); t.advance(100);
  const factory = t.feeds.socketFactory;
  t.feeds.socketFactory = () => { throw new Error('connect failed'); };
  t.feeds.setPreprocessed('m1', true); t.advance(100);
  await settle();
  assert.equal(t.of('gap').length, 1); assert.equal(t.rpcCalls.length, 2);
  assert.equal(t.feeds.covers('m1'), false);
  assert.equal(a.sent.filter(m => m.method === 'accountSubscribe').length, 1);
  t.feeds.socketFactory = factory; t.advance(1000);
  const retry = t.pre().at(-1); retry.open(); retry.ack('preprocessedSubscribe', 4);
  assert.equal(t.feeds.isReady(), true); assert.equal(t.of('coverage').length, 2);
  await t.feeds.stop();
});

test('repeated gaps while not ready are reported once; backoff grows and resets after ack', async () => {
  const t = setup();
  t.feeds.start();
  t.std()[0].terminate();
  t.advance(1000);
  t.std()[1].terminate();
  assert.equal(t.of('gap').length, 1);
  t.advance(1999); assert.equal(t.std().length, 2);
  t.advance(1); assert.equal(t.std().length, 3);
  const a = t.std()[2]; a.open(); a.ack('slotSubscribe', 1); a.ack('accountSubscribe', 21);
  a.terminate();
  t.advance(1000); assert.equal(t.std().length, 4); // reset after ack
  await t.feeds.stop();
});

test('account subscription rejection preserves backoff despite successful slot acknowledgments', async () => {
  const t=setup();const errors=[];t.feeds.callbacks.onSubscriptionError=detail=>errors.push(detail);
  t.feeds.start();
  for(const delay of [1000,2000,4000]) {
    const a=t.std().at(-1);a.open();a.ack('slotSubscribe',9);
    a.text({id:a.find('accountSubscribe').id,error:{code:-32005,message:STD}});
    const count=t.std().length;t.advance(delay-1);assert.equal(t.std().length,count);
    t.advance(1);assert.equal(t.std().length,count+1);
  }
  assert.deepEqual(errors,Array(3).fill({method:'accountSubscribe',code:-32005}));
  assert.ok(!JSON.stringify(errors).includes(KEY));await t.feeds.stop();
});

test('baseline cancellation reaches RPC on replacement, removal and shutdown', async () => {
  const signals=[];
  const t=setup({accounts:(addresses,{signal})=>new Promise((resolve,reject)=>{
    signals.push(signal);signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  })});
  await t.bringUp();
  t.feeds.snapshot(t.feeds.watches.get('m1'));await settle();
  assert.equal(signals[0].aborted,true);assert.equal(t.feeds.tasks.size,1);
  t.feeds.remove('m1');await settle();assert.equal(signals[1].aborted,true);
  assert.equal(t.of('gap').length,0);assert.equal(t.feeds.tasks.size,0);
  await t.feeds.stop();
});

test('reconnect churn removes obsolete baselines from the real RPC queue', async context => {
  let release;
  context.mock.method(globalThis,'fetch',async()=>new Promise(resolve=>{
    release=()=>resolve({ok:true,status:200,json:async()=>({result:{}})});
  }));
  const rpc=new Rpc({key:'test',rpcInterval:0},{usage:()=>{}});
  const blocking=rpc.accounts(['blocker']);
  const t=setup({accounts:(...args)=>rpc.accounts(...args)});
  await t.bringUp();
  for(let i=0;i<30;i++) {
    assert.equal(rpc.queue.length,1);
    t.std().at(-1).terminate();await settle();assert.equal(rpc.queue.length,0);
    t.advance(1000);
    const a=t.std().at(-1);a.open();a.ack('slotSubscribe',9);a.ack('accountSubscribe',21);await settle();
    assert.equal(t.feeds.tasks.size,1);
  }
  await t.feeds.stop();assert.equal(rpc.queue.length,0);assert.equal(t.feeds.tasks.size,0);
  release();await blocking;
});

test('stale snapshot from an old connection generation is discarded', async () => {
  const pending = [];
  const t = setup({ watches: [['m1', CURVE]], accounts: () => new Promise(resolve => pending.push(resolve)) });
  const [a] = await t.bringUp();
  a.terminate();
  t.advance(1000);
  const a2 = t.std()[1];
  a2.open(); a2.ack('slotSubscribe', 10); a2.ack('accountSubscribe', 22); await settle();
  assert.equal(pending.length, 2);
  pending[0]({ context: { slot: 100 }, value: [{ old: true }] }); // old generation resolves late
  await settle();
  assert.equal(t.of('account').length, 0);
  pending[1]({ context: { slot: 101 }, value: [{ old: false }] });
  await settle();
  assert.deepEqual(t.of('account'), [['account', 'm1', 101, { old: false }]]);
  await t.feeds.stop();
});

test('snapshot failure is a gap that reconnects without leaking the error', async () => {
  const logged = [];
  const original = console.error; console.error = (...args) => logged.push(args.join(' '));
  try {
    const t = setup({ watches: [['m1', CURVE]], accounts: async () => { throw new Error(`boom ${STD}`); } });
    const [a] = await t.bringUp();
    assert.deepEqual(t.of('gap').map(e => e[1]), ['snapshot_failed']);
    assert.equal(a.readyState, 3);
    assert.ok(!JSON.stringify(t.events).includes(KEY) && !logged.join().includes(KEY));
    await t.feeds.stop();
  } finally { console.error = original; }
});

test('remove before ack: late acknowledgment is unsubscribed and never baselined', async () => {
  const t = setup({ watches: [['m1', CURVE]] });
  t.feeds.start();
  const a = t.std()[0]; a.open();
  t.feeds.remove('m1');
  a.ack('accountSubscribe', 77); await settle();
  assert.deepEqual(a.find('accountUnsubscribe').params, [77]);
  assert.equal(t.rpcCalls.length, 0);
  a.text({ method: 'accountNotification', params: { subscription: 77, result: { context: { slot: 1 }, value: {} } } });
  assert.equal(t.of('account').length, 0);
  await t.feeds.stop();
});

test('remove then re-add before the old ack: old ack is unsubscribed, new one baselines', async () => {
  const t = setup({ watches: [['m1', CURVE]] });
  t.feeds.start();
  const a = t.std()[0]; a.open();
  t.feeds.remove('m1'); t.feeds.add('m1', CURVE);
  const [first, second] = a.sent.filter(m => m.method === 'accountSubscribe');
  a.text({ id: first.id, result: 5 });
  a.text({ id: second.id, result: 6 }); await settle();
  assert.deepEqual(a.sent.filter(m => m.method === 'accountUnsubscribe').map(m => m.params), [[5]]);
  assert.equal(t.rpcCalls.length, 1);
  await t.feeds.stop();
});

test('remove after ack unsubscribes; dynamic add on an open socket subscribes; same mint add is idempotent', async () => {
  const t = setup();
  const [a] = await t.bringUp({ account: false });
  t.feeds.add('m1', CURVE); t.feeds.add('m1', CURVE);
  assert.equal(a.sent.filter(m => m.method === 'accountSubscribe').length, 1);
  a.ack('accountSubscribe', 44); await settle();
  t.feeds.remove('m1'); t.feeds.remove('m1');
  assert.deepEqual(a.sent.filter(m => m.method === 'accountUnsubscribe').map(m => m.params), [[44]]);
  a.text({ method: 'accountNotification', params: { subscription: 44, result: { context: { slot: 1 }, value: {} } } });
  assert.equal(t.of('account').filter(e => e[2] === 1).length, 0);
  await t.feeds.stop();
});

test('removed watch is not resubscribed after reconnect; unacked snapshot is discarded', async () => {
  let release;
  const t = setup({ watches: [['m1', CURVE]], accounts: () => new Promise(resolve => { release = resolve; }) });
  await t.bringUp();
  t.feeds.remove('m1');
  release({ context: { slot: 3 }, value: [{}] }); await settle();
  assert.equal(t.of('account').length, 0);
  t.std()[0].terminate(); t.advance(1000);
  const a2 = t.std()[1]; a2.open();
  assert.equal(a2.find('accountSubscribe'), undefined);
  await t.feeds.stop();
});

test('resync reconnects both sockets at once, rebaselines, and re-readies without onGap', async () => {
  const t = setup({ watches: [['m1', CURVE]] });
  const [a, b] = await t.bringUp();
  t.feeds.resync();
  assert.equal(a.readyState, 3); assert.equal(b.readyState, 3);
  assert.equal(t.std().length, 2); assert.equal(t.pre().length, 2);
  assert.equal(t.of('gap').length, 0);
  assert.equal(t.feeds.isReady(), false);
  const [a2, b2] = [t.std()[1], t.pre()[1]];
  a2.open(); b2.open();
  a2.ack('slotSubscribe', 10); a2.ack('accountSubscribe', 22); b2.ack('preprocessedSubscribe', 4);
  await settle();
  assert.equal(t.of('ready').length, 2);
  assert.equal(t.of('coverage').length, 2);
  assert.equal(t.rpcCalls.length, 2);
  t.advance(120000);
  assert.equal(t.sockets.length, 4); // no stray reconnect timers
  await t.feeds.stop();
});

test('resync while waiting on a backoff timer still produces exactly one socket per endpoint', async () => {
  const t = setup();
  t.feeds.start();
  t.std()[0].terminate();
  t.feeds.resync();
  t.advance(60000);
  assert.equal(t.std().length, 2); assert.equal(t.pre().length, 2);
  await t.feeds.stop();
});

test('resync before start or after stop is a no-op', async () => {
  const t = setup();
  t.feeds.resync();
  assert.equal(t.sockets.length, 0);
  t.feeds.start(); await t.feeds.stop();
  t.feeds.resync();
  assert.equal(t.sockets.length, 2);
});

test('heartbeat: pings both sockets, missing pong terminates, gaps and reconnects', async () => {
  const t = setup();
  const [a, b] = await t.bringUp();
  t.advance(10000);
  assert.equal(a.pings, 1); assert.equal(b.pings, 1);
  a.autoPong = false;
  t.advance(10000); assert.equal(a.pings, 2);
  assert.equal(t.of('gap').length, 0);
  t.advance(10000);
  assert.deepEqual(t.of('gap').map(e => e[1]), ['standard_heartbeat_timeout']);
  assert.equal(a.readyState, 3);
  assert.equal(b.readyState, 1);
  await t.feeds.stop();
});

test('any inbound frame counts as liveness', async () => {
  const t = setup();
  const [, b] = await t.bringUp();
  b.autoPong = false;
  t.advance(10000);
  b.binary(Buffer.from([1]));
  t.advance(10000);
  assert.equal(t.of('gap').length, 0);
  await t.feeds.stop();
});

test('unacknowledged subscription times out as a gap', async () => {
  const t = setup();
  t.feeds.start();
  t.std()[0].open(); t.pre()[0].open();
  t.advance(15000);
  assert.deepEqual(t.of('gap').map(e => e[1]), ['standard_ack_timeout']);
  assert.equal(t.pre()[0].readyState, 3);
  await t.feeds.stop();
});

test('subscription error responses and transport errors are gaps', async () => {
  const t = setup({ watches: [['m1', CURVE]] });
  t.feeds.start();
  const a = t.std()[0]; a.open();
  a.text({ id: a.find('accountSubscribe').id, error: { code: -32602 } });
  assert.deepEqual(t.of('gap').map(e => e[1]), ['account_subscribe_failed']);
  const b = t.pre()[0]; b.open();
  b.emit('error', new Error(`ECONNRESET ${PRE}`));
  assert.equal(b.readyState, 3);
  assert.ok(!JSON.stringify(t.events).includes(KEY));
  await t.feeds.stop();
});

test('oversized frames are rejected and reconnect', async () => {
  const t = setup();
  const [, b] = await t.bringUp({ account: false });
  b.binary(Buffer.alloc(MAX_FRAME_BYTES + 1));
  assert.equal(t.of('tx').length, 0);
  assert.deepEqual(t.of('gap').map(e => e[1]), ['preprocessed_oversized_frame']);
  assert.equal(b.readyState, 3);
  await t.feeds.stop();
});

test('socket factory failures are gaps with backoff retries', async () => {
  let attempts = 0;
  const events = [], timers = [];
  const feeds = new PaperFeeds({ usage() {} }, { wsUrl: STD, accounts: async () => ({}) }, {
    onGap: reason => events.push(reason),
    socketFactory: () => { attempts++; throw new Error(`cannot connect ${STD}`); },
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimer: () => {},
  });
  feeds.add('m1', CURVE);
  feeds.start();
  assert.equal(attempts, 2);
  assert.deepEqual(events, ['standard_connect_failed']);
  assert.deepEqual(timers.map(t => t.delay), [1000, 1000]);
  await feeds.stop();
});

test('callback exceptions neither leak nor break the transport', async () => {
  const logged = [];
  const original = console.error; console.error = (...args) => logged.push(args.join(' '));
  try {
    const t = setup({ watches: [['m1', CURVE]] });
    const boom = () => { throw new Error(`secret ${STD}`); };
    const feeds = new PaperFeeds({ usage() {} }, { wsUrl: STD, accounts: async () => ({ context: { slot: 1 }, value: [{}] }) }, {
      onAccount: boom, onTransaction: boom, onGap: boom, onReady: boom, onSlot: boom,
      socketFactory: (url, kind) => { const s = new Socket(url, kind); t.sockets.push(s); return s; },
      setTimer: () => 1, clearTimer: () => {},
    });
    feeds.add('m1', CURVE); feeds.start();
    const [a, b] = [t.std()[0], t.pre()[0]];
    a.open(); b.open(); a.ack('slotSubscribe', 9); a.ack('accountSubscribe', 21); b.ack('preprocessedSubscribe', 3);
    await settle();
    b.binary(Buffer.from([1]));
    a.text({ method: 'slotNotification', params: { subscription: 9, result: { slot: 1 } } });
    a.text({ method: 'accountNotification', params: { subscription: 21, result: { context: { slot: 9 }, value: {} } } });
    assert.equal(a.readyState, 1); assert.equal(b.readyState, 1);
    a.terminate(); // onGap throws too
    assert.ok(logged.length >= 5);
    assert.ok(!logged.join().includes(KEY) && !logged.join().includes('secret'));
    await feeds.stop();
  } finally { console.error = original; }
});

test('stop: terminates sockets, no gap or reconnect, discards late snapshots, flushes usage', async () => {
  let release;
  const t = setup({ watches: [['m1', CURVE]], accounts: () => new Promise(resolve => { release = resolve; }) });
  const [a, b] = await t.bringUp();
  b.binary(Buffer.from([1, 2, 3]));
  let stopped = false;
  const stopping = t.feeds.stop().then(() => { stopped = true; });
  await settle();
  assert.equal(stopped, false); // waits for the in-flight snapshot
  assert.equal(a.readyState, 3); assert.equal(b.readyState, 3);
  release({ context: { slot: 9 }, value: [{}] });
  await stopping;
  assert.equal(t.of('gap').length, 0);
  assert.equal(t.of('account').length, 0);
  assert.equal(t.timers.size, 0);
  assert.ok(t.usage.some(u => u[1] === 'paper_account_received_bytes'));
  assert.ok(t.usage.some(u => u[0] === 'preprocessed' && u[2] === 1));
  // inert afterwards
  t.feeds.add('m2', CURVE); t.feeds.start(); t.feeds.resync(); await t.feeds.stop();
  t.advance(60000);
  assert.equal(t.sockets.length, 2);
  a.text({ method: 'slotNotification', params: { subscription: 9, result: { slot: 1 } } });
  b.binary(Buffer.from([1]));
  assert.equal(t.of('slot').length, 0); assert.equal(t.of('tx').length, 1);
});

test('stop while connecting or waiting to reconnect leaves no timers or sockets', async () => {
  const t = setup();
  t.feeds.start();
  t.std()[0].terminate();
  await t.feeds.stop();
  assert.equal(t.timers.size, 0);
  t.advance(60000);
  assert.equal(t.std().length, 1);
});

// ---- candidate-only preprocessed filter and membership changes ----
const preSubs = socket => socket.sent.filter(m => m.method === 'preprocessedSubscribe');
const C2 = 'CurveAddress2222222222222222222222222222222';
const C3 = 'CurveAddress3333333333333333333333333333333';

test('no watchlist means no preprocessed socket; readiness needs only the slot ack', async () => {
  const t = setup({ watches: [] });
  t.feeds.start();
  assert.equal(t.pre().length, 0); assert.equal(t.std().length, 1);
  const a = t.std()[0]; a.open(); a.ack('slotSubscribe', 9);
  assert.equal(t.of('ready').length, 1);
  t.advance(120000);
  assert.equal(t.pre().length, 0);
  await t.feeds.stop();
});

test('first watch opens the filtered stream after the debounce without disturbing readiness', async () => {
  const t = setup({ watches: [] });
  t.feeds.start();
  const a = t.std()[0]; a.open(); a.ack('slotSubscribe', 9);
  t.feeds.add('m2', C2); t.feeds.add('m3', C3); t.feeds.add('m1', CURVE);
  assert.equal(t.pre().length, 0);
  t.advance(99); assert.equal(t.pre().length, 0);
  t.advance(1); assert.equal(t.pre().length, 1);
  const b = t.pre()[0]; b.open();
  assert.deepEqual(preSubs(b)[0].params, { accountInclude: [CURVE, C2, C3].sort(), accountExclude: [], accountRequired: [PUMP] });
  b.ack('preprocessedSubscribe', 3);
  assert.equal(t.of('gap').length, 0);
  assert.equal(t.of('ready').length, 1);
  b.binary(Buffer.from([1]));
  assert.equal(t.of('tx').length, 1);
  await t.feeds.stop();
});

test('membership changes replace the connection make-before-break with no gap, no duplicates', async () => {
  const t = setup();
  const [, b1] = await t.bringUp();
  t.feeds.add('m2', C2); t.feeds.add('m3', C3); t.feeds.remove('m3');
  assert.equal(t.pre().length, 1);
  t.advance(100);
  assert.equal(t.pre().length, 2); // one replacement for the coalesced changes
  const b2 = t.pre()[1]; b2.open();
  assert.deepEqual(preSubs(b2)[0].params.accountInclude, [CURVE, C2].sort());
  assert.equal(b1.readyState, 1); // old keeps serving until the new one acks
  b1.binary(Buffer.from([1])); b2.binary(Buffer.from([9]));
  assert.equal(t.of('tx').length, 1); // standby frames are not delivered
  b2.ack('preprocessedSubscribe', 8);
  assert.equal(b1.readyState, 3);
  b1.binary(Buffer.from([2])); b2.binary(Buffer.from([3]));
  assert.deepEqual(t.of('tx').map(e => e[1][0]), [1, 3]);
  assert.equal(t.of('gap').length, 0);
  assert.equal(t.of('ready').length, 1);
  t.advance(120000);
  assert.equal(t.pre().length, 2);
  await t.feeds.stop();
});

test('removing a watch narrows the filter; removing the last closes the stream silently', async () => {
  const t = setup({ watches: [['m1', CURVE], ['m2', C2]] });
  const [a, b1] = await t.bringUp({ account: false });
  a.ack('accountSubscribe', 21, 0); a.ack('accountSubscribe', 22, 1); await settle();
  t.feeds.remove('m2'); t.advance(100);
  const b2 = t.pre()[1]; b2.open();
  assert.deepEqual(preSubs(b2)[0].params.accountInclude, [CURVE]);
  b2.ack('preprocessedSubscribe', 5);
  t.feeds.remove('m1'); t.advance(100);
  assert.equal(b2.readyState, 3);
  assert.equal(t.pre().length, 2);
  t.advance(120000);
  assert.equal(t.pre().length, 2); // nothing reconnects
  assert.equal(t.of('gap').length, 0);
  t.feeds.add('m3', C3); t.advance(100);
  assert.equal(t.pre().length, 3);
  assert.equal(b1.readyState, 3);
  await t.feeds.stop();
});

test('re-adding an identical membership within the debounce opens nothing', async () => {
  const t = setup();
  await t.bringUp();
  t.feeds.add('m1', CURVE); t.feeds.remove('m1'); t.feeds.add('m1', CURVE); t.advance(100);
  assert.equal(t.pre().length, 1);
  await t.feeds.stop();
});

test('a failing replacement keeps the healthy stream, raises no gap and retries with backoff', async () => {
  const t = setup();
  const [, b1] = await t.bringUp();
  t.feeds.add('m2', C2); t.advance(100);
  const b2 = t.pre()[1]; b2.open();
  b2.text({ jsonrpc: '2.0', id: b2.sent[0].id, error: { code: -1 } });
  assert.equal(b2.readyState, 3);
  assert.equal(b1.readyState, 1);
  assert.equal(t.of('gap').length, 0);
  b1.binary(Buffer.from([7]));
  assert.equal(t.of('tx').length, 1);
  t.advance(999); assert.equal(t.pre().length, 2);
  t.advance(1); assert.equal(t.pre().length, 3);
  const b3 = t.pre()[2]; b3.open(); b3.ack('preprocessedSubscribe', 6);
  assert.equal(b1.readyState, 3);
  assert.deepEqual(preSubs(b3)[0].params.accountInclude, [CURVE, C2].sort());
  assert.equal(t.rpcCalls.length, 1); // a failed replacement never clears or refreshes existing reserves
  assert.deepEqual(t.of('coverage'), [['coverage', 'm1'], ['coverage', 'm2']]);
  await t.feeds.stop();
});

test('replacement ack timeout is silent too', async () => {
  const t = setup();
  const [a, b1] = await t.bringUp();
  t.feeds.add('m2', C2); t.advance(100);
  a.ack('accountSubscribe', 31, 1);
  t.pre()[1].open();
  t.advance(15000);
  assert.equal(t.pre()[1].readyState, 3);
  assert.equal(b1.readyState, 1);
  assert.equal(t.of('gap').length, 0);
  await t.feeds.stop();
});

test('membership changing while a replacement connects supersedes the pending connection', async () => {
  const t = setup();
  await t.bringUp();
  t.feeds.add('m2', C2); t.advance(100);
  const b2 = t.pre()[1]; b2.open();
  t.feeds.add('m3', C3); t.advance(100);
  assert.equal(t.pre().length, 3); // stale pending replacement dropped, fresh one opened
  assert.equal(b2.readyState, 3);
  const b3 = t.pre()[2]; b3.open(); b3.ack('preprocessedSubscribe', 2);
  assert.deepEqual(preSubs(b3)[0].params.accountInclude, [CURVE, C2, C3].sort());
  assert.equal(t.of('gap').length, 0);
  await t.feeds.stop();
});

test('membership moving after a replacement subscribed triggers a follow-up replacement', async () => {
  const t = setup();
  await t.bringUp();
  t.feeds.add('m2', C2); t.advance(100);
  const b2 = t.pre()[1]; b2.open();
  t.feeds.add('m3', C3); // debounce armed but ack lands first
  b2.ack('preprocessedSubscribe', 2);
  t.advance(100);
  assert.equal(t.pre().length, 3);
  await t.feeds.stop();
});

test('losing the active stream while a replacement is pending gaps once; replacement then readies', async () => {
  const t = setup();
  const [a, b1] = await t.bringUp();
  t.feeds.add('m2', C2); t.advance(100);
  const b2 = t.pre()[1]; b2.open();
  b1.terminate();
  assert.deepEqual(t.of('gap').map(e => e[1]), ['preprocessed_disconnected']);
  await settle();
  assert.equal(t.rpcCalls.length, 2); // baselines refreshed for subscribed accounts
  b2.ack('preprocessedSubscribe', 3);
  assert.equal(t.of('ready').length, 2);
  assert.equal(a.readyState, 1);
  assert.equal(t.pre().length, 2);
  await t.feeds.stop();
});

test('removing the last watch while a gap is pending releases readiness', async () => {
  const t = setup();
  const [, b] = await t.bringUp();
  b.terminate();
  assert.equal(t.feeds.isReady(), false);
  t.feeds.remove('m1');
  assert.equal(t.of('ready').length, 2);
  t.advance(120000);
  assert.equal(t.pre().length, 1);
  await t.feeds.stop();
});

test('reconnect after the active stream drops uses the current membership', async () => {
  const t = setup();
  const [, b1] = await t.bringUp();
  t.feeds.add('m2', C2);
  b1.terminate(); // before the debounce fires
  t.advance(1100); // debounce, then the 1s reconnect backoff
  const b2 = t.pre()[1]; b2.open();
  assert.deepEqual(preSubs(b2)[0].params.accountInclude, [CURVE, C2].sort());
  t.advance(60000);
  assert.equal(t.pre().length, 2);
  await t.feeds.stop();
});

test('connection count stays bounded during churn', async () => {
  const t = setup();
  await t.bringUp();
  const live = () => t.sockets.filter(s => s.readyState !== 3).length;
  let peak = 0;
  for (let i = 0; i < 20; i++) {
    t.feeds.add(`x${i}`, `Curve${i}`); t.advance(100);
    const latest = t.pre().at(-1); latest.open(); peak = Math.max(peak, live());
    latest.ack('preprocessedSubscribe', i + 10);
  }
  assert.ok(peak <= 3);
  assert.equal(live(), 2);
  await t.feeds.stop();
});

test('resync with an empty watchlist reconnects only the standard socket; stop clears pending sync', async () => {
  const t = setup({ watches: [] });
  t.feeds.start();
  const a = t.std()[0]; a.open(); a.ack('slotSubscribe', 9);
  t.feeds.resync();
  assert.equal(t.std().length, 2); assert.equal(t.pre().length, 0);
  t.std()[1].open(); t.std()[1].ack('slotSubscribe', 10);
  assert.equal(t.of('ready').length, 2);
  t.feeds.add('m1', CURVE);
  await t.feeds.stop();
  assert.equal(t.timers.size, 0);
  t.advance(1000);
  assert.equal(t.pre().length, 0);
});

test('stop closes active and pending preprocessed connections', async () => {
  const t = setup();
  const [, b1] = await t.bringUp();
  t.feeds.add('m2', C2); t.advance(100);
  const b2 = t.pre()[1]; b2.open();
  await t.feeds.stop();
  assert.equal(b1.readyState, 3); assert.equal(b2.readyState, 3);
  assert.equal(t.timers.size, 0);
  assert.equal(t.of('gap').length, 0);
});

test('curve-only watch can activate and idle preprocessed without losing account subscription', async () => {
  const t = setup({ watches: [] });
  const covered = []; t.feeds.callbacks.onCoverage = mint => covered.push(mint);
  t.feeds.add('m1', CURVE, false);t.feeds.start();
  const a=t.std()[0];a.open();a.ack('slotSubscribe',9);a.ack('accountSubscribe',21);await settle();
  assert.equal(t.pre().length,0);assert.equal(t.feeds.isReady(),true);
  t.feeds.setPreprocessed('m1',true);t.advance(100);
  const b=t.pre()[0];b.open();assert.equal(t.feeds.covers('m1'),false);
  b.ack('preprocessedSubscribe',3);assert.equal(t.feeds.covers('m1'),true);
  assert.deepEqual(covered,['m1']);
  t.feeds.setPreprocessed('m1',false);assert.equal(t.feeds.covers('m1'),false);t.advance(100);
  assert.equal(b.readyState,3);assert.equal(a.readyState,1);
  assert.equal(a.find('accountUnsubscribe'),undefined);
  a.text({method:'accountNotification',params:{subscription:21,result:{context:{slot:60},value:{lamports:2}}}});
  assert.equal(t.of('account').at(-1)[2],60);
  t.feeds.setPreprocessed('m1',true);t.advance(100);
  const b2=t.pre()[1];b2.open();b2.ack('preprocessedSubscribe',4);
  assert.deepEqual(covered,['m1','m1']);await t.feeds.stop();
});

test('handover dropping a reactivated mint resets only its interrupted coverage', async () => {
  const t = setup({ watches: [['m1', CURVE], ['m2', C2]] });
  const [a] = await t.bringUp();
  t.feeds.setPreprocessed('m1', false); t.advance(100);
  const removal = t.pre()[1]; removal.open();
  a.terminate(); t.advance(1000);
  const a2 = t.std()[1]; a2.open();
  t.feeds.setPreprocessed('m1', true);
  a2.ack('slotSubscribe', 10); // recovery acknowledges coverage on the old filter
  assert.equal(t.feeds.covers('m1'), true);
  assert.deepEqual(t.of('coverage'), [
    ['coverage', 'm1'], ['coverage', 'm2'], ['coverage', 'm1'], ['coverage', 'm2'],
  ]);
  removal.ack('preprocessedSubscribe', 4); // the in-flight filter still excludes m1
  assert.equal(t.feeds.covers('m1'), false);
  assert.equal(t.feeds.watches.get('m1').covered, false);
  assert.equal(t.feeds.covers('m2'), true);
  t.advance(100);
  const restored = t.pre()[2]; restored.open(); restored.ack('preprocessedSubscribe', 5);
  assert.equal(t.feeds.covers('m1'), true);
  assert.deepEqual(t.of('coverage').slice(4), [['coverage', 'm1']]);
  assert.equal(t.of('gap').length, 1); // no global gap for the continuously covered mint
  await t.feeds.stop();
});

test('preprocessedSubscribe params is an object, not an array', async () => {
  const t = setup();
  await t.bringUp();
  const params = preSubs(t.pre()[0])[0].params;
  assert.ok(!Array.isArray(params) && typeof params === 'object');
  assert.deepEqual(Object.keys(params).sort(), ['accountExclude', 'accountInclude', 'accountRequired']);
  await t.feeds.stop();
});

test('every received binary frame is billed, including overlap and undelivered frames', async () => {
  const t = setup();
  const [, b1] = await t.bringUp();
  t.feeds.add('m2', C2); t.advance(100);
  const b2 = t.pre()[1]; b2.open();
  b1.binary(Buffer.from([1, 1]));
  b2.binary(Buffer.from([1, 1, 1])); // overlap duplicate before takeover: billed, not delivered
  b2.ack('preprocessedSubscribe', 8);
  b2.binary(Buffer.from([2]));
  assert.deepEqual(t.of('tx').map(e => e[1].length), [2, 1]);
  t.feeds.flushUsage();
  assert.deepEqual(t.usage.find(u => u[0] === 'preprocessed'), ['preprocessed', 'transactions', 3]);
  await t.feeds.stop();
});
