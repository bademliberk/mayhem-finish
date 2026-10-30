import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { Stream } from '../src/stream.js';
import { Recovery } from '../src/recovery.js';

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 0; this.sent = []; }
  open() { this.readyState = 1; this.emit('open'); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  text(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  ack(result = 42) { this.text({ id: this.sent[0].id, result }); }
  ping() { this.emit('pong'); }
  terminate() { this.readyState = 3; this.emit('close', 1006, Buffer.from('secret close reason')); }
}
function setup(onReady = () => {}) {
  const store = new Store(':memory:', {}), sockets = [], timers = new Map(), logs = [];
  let clock = 1000000, next = 0, ready = 0;
  const stream = new Stream(store, { wsUrl: 'wss://secret.invalid/?api-key=SECRET' }, () => { ready++; onReady(); }, {
    now: () => clock, socketFactory: () => { const s = new Socket(); sockets.push(s); return s; },
    setTimer: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: clock + delay, delay }); return id; },
    clearTimer: id => timers.delete(id), log: value => logs.push(value),
  });
  const advance = ms => {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= clock && timers.delete(id)) timer.fn();
  };
  const health = () => JSON.parse(store.get("SELECT value FROM metadata WHERE key='feed_health_discovery'").value);
  const close = () => { stream.stop(); store.close(); };
  return { store, stream, sockets, timers, logs, advance, health, close, ready: () => ready };
}

test('discovery requires exact request and safe subscription IDs; readiness only once per socket', () => {
  const t = setup(); t.stream.start(); t.stream.start();
  const a = t.sockets[0]; a.open(); a.open();
  assert.equal(a.sent.length, 1);
  for (const id of [99, '1', null]) a.text({ id, result: 42 });
  assert.equal(t.ready(), 0);
  a.ack(0); a.ack(4);
  assert.equal(t.ready(), 1); assert.deepEqual([...t.stream.subscriptions], [0]);
  assert.equal(t.store.get("SELECT ended_at FROM coverage WHERE kind='websocket_gap'").ended_at, null, 'ack is not backfill completion');
  a.terminate(); const retry = [...t.timers.values()][0]; assert.equal(retry.delay, 1000);
  a.emit('error', new Error('SECRET')); a.ack(); a.emit('close');
  assert.equal(t.timers.size, 1); assert.equal(t.ready(), 1);
  t.advance(1000); const b = t.sockets[1]; b.open();
  b.text({ id: 1, result: 9 }); assert.equal(t.ready(), 1);
  b.ack(); assert.equal(t.ready(), 2);
  a.text({ id: b.sent[0].id, result: 9 }); assert.equal(t.ready(), 2);
  t.close(); assert.equal(t.timers.size, 0);
});

test('missing/wrong ack times out at the original deadline and invalid IDs fail safely', () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'secret', {}, null]) {
    const t = setup(); t.stream.start(); const a = t.sockets[0]; a.open(); a.ack(value);
    assert.equal(t.ready(), 0); assert.equal(t.health().lastFailure.category, 'subscribe_failed');
    assert.equal(t.timers.size, 1); t.close();
  }
  const t = setup(); t.stream.start(); const a = t.sockets[0]; a.open();
  t.advance(14000); a.text({ id: 999, result: 42 }); a.emit('pong');
  t.advance(999); assert.equal(a.readyState, 1);
  t.advance(1); assert.equal(a.readyState, 3); assert.equal(t.health().lastFailure.category, 'ack_timeout');
  assert.equal(t.timers.size, 1); t.close();
});

test('failed handshakes retry once with capped backoff and zero billed payload usage, later recover', () => {
  const t = setup(); t.stream.start();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const a = t.sockets.at(-1);
    a.emit('error', Object.assign(new Error('SECRET wss://credentials.invalid'), { code: 'ECONNRESET' }));
    a.emit('close', 1006); a.emit('error', new Error('duplicate SECRET'));
    assert.equal(t.timers.size, 1); assert.equal([...t.timers.values()][0].delay, delay);
    t.advance(delay);
  }
  t.stream.flushUsage();
  assert.equal(t.store.get('SELECT COUNT(*) n FROM usage').n, 0);
  assert.equal(t.health().attempts, 8); assert.equal(t.health().failureStreak, 7);
  assert.equal(t.health().lastFailure.networkCode, 'ECONNRESET');
  assert.equal(t.store.get("SELECT COUNT(*) n FROM coverage WHERE kind='websocket_gap'").n, 1);
  const a = t.sockets.at(-1); a.open(); a.ack();
  assert.equal(t.health().failureStreak, 0); assert.equal(t.health().phase, 'subscribed');
  a.terminate(); assert.equal([...t.timers.values()][0].delay, 1000);
  assert.ok(!JSON.stringify([t.logs, t.health()]).includes('SECRET'));
  t.close();
});

test('diagnostics whitelist HTTP/network/WebSocket/subscription codes, never provider strings', () => {
  const t = setup(); t.stream.start();
  t.sockets[0].emit('unexpected-response', { url: 'SECRET' }, { statusCode: 429, headers: { secret: 'SECRET' }, statusMessage: 'SECRET' });
  assert.equal(t.health().lastFailure.httpStatus, 429);
  t.advance(1000); let a = t.sockets.at(-1); a.open();
  a.text({ id: a.sent[0].id, error: { code: -32005, message: 'SECRET', data: { secret: 'SECRET' } } });
  assert.equal(t.health().lastFailure.subscriptionCode, -32005);
  t.advance(2000); a = t.sockets.at(-1); a.open(); a.ack();
  a.emit('close', 1008, 'SECRET'); assert.equal(t.health().lastFailure.wsCode, 1008);
  t.advance(1000); a = t.sockets.at(-1);
  a.emit('error', { code: 'ECONNRESET SECRET', message: 'SECRET' });
  assert.equal(t.health().lastFailure.networkCode, undefined);
  assert.ok(!JSON.stringify([t.logs, t.health()]).includes('SECRET'));
  assert.equal(t.store.get("SELECT COUNT(*) n FROM metadata WHERE key LIKE 'feed_health_%'").n, 1);
  t.close();
});

test('stop during connect, ack wait or backoff clears every timer and ignores late callbacks', () => {
  for (const mode of ['connecting', 'subscribing', 'backoff']) {
    const t = setup(); t.stream.start(); const a = t.sockets[0];
    if (mode !== 'connecting') a.open();
    if (mode === 'backoff') a.terminate();
    const late = [...t.timers.values()].map(timer => timer.fn);
    t.stream.stop(); for (const fn of late) fn();
    a.emit('open'); a.text({ id: 1, result: 8 }); a.emit('error', new Error('SECRET'));
    assert.equal(t.ready(), 0); assert.equal(t.sockets.length, 1); assert.equal(t.timers.size, 0);
    assert.equal(t.health().phase, 'stopped'); t.close();
  }
});

test('synchronous socket creation failure and a stalled handshake remain retryable and unbilled', () => {
  const t = setup(); const factory = t.stream.socketFactory;
  t.stream.socketFactory = () => { throw { code: 'ENOTFOUND', message: 'SECRET' }; };
  t.stream.start(); assert.equal(t.health().lastFailure.networkCode, 'ENOTFOUND');
  assert.equal(t.health().lastFailure.category, 'connect_failed'); assert.equal(t.timers.size, 1);
  t.stream.socketFactory = factory; t.advance(1000);
  t.advance(35000); assert.equal(t.sockets[0].readyState, 3);
  assert.equal(t.health().lastFailure.category, 'ack_timeout');
  t.stream.flushUsage(); assert.equal(t.store.get('SELECT COUNT(*) n FROM usage').n, 0);
  assert.ok(!t.logs.join().includes('SECRET')); t.close();
});

test('restart adopts oldest unfinished discovery gap; ack leaves original rows open until backfill', async () => {
  let recovery;
  const t = setup(() => recovery.reconnected(999, 1000));
  const old = t.store.coverage('websocket_gap', 100, 'original interrupted gap');
  const finished = t.store.coverage('websocket_gap', 50, 'historical completed row');
  t.store.run('UPDATE coverage SET ended_at=70 WHERE id=?', finished);
  let scan = false;
  recovery = new Recovery({ store: t.store, collector: { scan: async () => scan }, programs: ['P'], now: () => 1000, retrySeconds: 0 });
  recovery.begin({ lastHeartbeat: 999, now: 1000 }); t.stream.start();
  assert.equal(t.stream.gap, old); assert.equal(recovery.cutoff, 90);
  const a = t.sockets[0]; a.open(); a.ack(); a.ack();
  assert.equal(recovery.episodes.length, 1);
  assert.equal(t.store.get('SELECT ended_at FROM coverage WHERE id=?', old).ended_at, null);
  assert.equal(await recovery.run(1000), 'partial');
  assert.equal(t.store.get('SELECT ended_at FROM coverage WHERE id=?', old).ended_at, null);
  scan = true; assert.equal(await recovery.run(1000), 'completed');
  assert.equal(t.store.get('SELECT ended_at FROM coverage WHERE id=?', old).ended_at, 1000);
  assert.equal(t.store.get('SELECT ended_at FROM coverage WHERE id=?', finished).ended_at, 70);
  assert.equal(t.store.get('SELECT detail FROM coverage WHERE id=?', old).detail, 'original interrupted gap');
  t.close();
});
