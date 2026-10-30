import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Collector } from '../src/collector.js';
import { Recovery } from '../src/recovery.js';

const cfg = { firstCheck: 600, recheck: 600, horizon: 86400, historyPages: 2 };
const P = 'program';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// Harness: in-memory store, controllable clock, and a scripted collector.scan. `stream` helpers
// write the same websocket_gap rows the real Stream writes.
function harness({ store = new Store(':memory:', cfg), clock = { t: 1000 } } = {}) {
  const calls = [];
  const script = [];
  const collector = {
    scan: (program, cutoff) => {
      const call = { program, cutoff, cursor: store.cursor(program), at: clock.t };
      calls.push(call);
      return (script.shift() ?? (async () => true))(call);
    },
  };
  const recovery = () => new Recovery({ store, collector, programs: [P], retrySeconds: 60, now: () => clock.t, log: () => {} });
  let gap = null;
  const stream = {
    disconnect(at) { clock.t = at; gap = store.coverage('websocket_gap', at, 'Disconnected; backfill required'); },
    // Mirrors Stream: close the gap row, then fire onReady.
    ready(r, at, lastConnected) {
      clock.t = at;
      if (gap == null) gap = store.coverage('websocket_gap', at, 'Awaiting creation discovery subscription');
      store.run('UPDATE coverage SET ended_at=? WHERE id=?', at, gap); gap = null;
      return r.reconnected(lastConnected);
    },
  };
  const rows = kind => store.all('SELECT * FROM coverage WHERE kind=? ORDER BY id', kind);
  const persisted = () => store.get("SELECT value FROM metadata WHERE key='backfill_cutoff'")?.value;
  return { store, clock, calls, script, collector, recovery, stream, rows, persisted };
}

test('startup waits for the live subscription and uses last heartbeat minus 10', async () => {
  const h = harness(); const r = h.recovery();
  r.begin({ lastHeartbeat: 900, now: 1000 });
  assert.equal(await r.run(1000), 'idle');
  assert.equal(h.calls.length, 0);
  assert.equal(h.persisted(), '890');
  h.stream.ready(r, 1003, 900);
  assert.equal(await r.run(1003), 'completed');
  assert.equal(h.calls[0].cutoff, 890);
  assert.equal(h.rows('backfill').length, 1);
  assert.equal(h.rows('backfill')[0].ended_at, 1003);
  assert.equal(h.persisted(), undefined);
  assert.deepEqual(h.store.cursor(P), {});
});

test('fresh reconnect cutoff is the disconnect minus 10, not the prior recovery completion', async () => {
  const h = harness(); const r = h.recovery();
  r.begin({ lastHeartbeat: 1000, now: 1000 });
  h.stream.ready(r, 1001, 1000);
  await r.run(1001);
  h.clock.t = 5000; // long healthy period; the old code used completion time (1001) / now here
  h.stream.disconnect(5000);
  h.stream.ready(r, 5030, 4999);
  assert.equal(await r.run(5030), 'completed');
  assert.equal(h.calls.at(-1).cutoff, 4989); // min(gap start 5000, lastConnected 4999) - 10
  assert.equal(h.rows('backfill').length, 2);
  assert.ok(h.rows('backfill').every(row => row.ended_at != null));
  assert.equal(h.rows('backfill')[1].started_at, 4999);
});

test('stale lastConnected only lowers the cutoff (conservative); disconnect seen by tick yields one record', async () => {
  const h = harness(); const r = h.recovery();
  r.begin({ lastHeartbeat: 1000, now: 1000 });
  h.stream.ready(r, 1001, 1000); await r.run(1001);
  h.stream.disconnect(2000);
  r.disconnected(1990, 2001); r.disconnected(1990, 2002);
  assert.equal(h.rows('backfill').length, 2); // startup + exactly one outage record
  assert.equal(await r.run(2003), 'idle'); // not runnable while disconnected
  h.stream.ready(r, 2010, 1990);
  assert.equal(h.rows('backfill').length, 2);
  await r.run(2010);
  assert.equal(h.calls.at(-1).cutoff, 1980);
});

test('reconnect during an awaited scan survives completion via follow-up new-head scan', async () => {
  const h = harness(); const r = h.recovery();
  r.begin({ lastHeartbeat: 1000, now: 1000 });
  h.stream.ready(r, 1001, 1000);
  const gate = deferred();
  h.script.push(async () => { await gate.promise; return true; });
  const running = r.run(1001);
  // While the scan is awaited: disconnect and reconnect.
  h.stream.disconnect(1100);
  h.stream.ready(r, 1105, 1099);
  gate.resolve();
  assert.equal(await running, 'completed');
  const [startup, outage] = h.rows('backfill');
  assert.notEqual(startup.ended_at, null);
  assert.equal(outage.ended_at, null, 'reconnect during the scan must not be reported complete');
  assert.equal(h.persisted(), '1089');
  assert.equal(r.pending, true);
  h.clock.t = 1106;
  assert.equal(await r.run(1106), 'completed');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].cutoff, 1089);
  assert.equal(h.rows('backfill')[1].ended_at, 1106);
  assert.equal(h.persisted(), undefined);
  assert.equal(await r.run(1107), 'idle');
});

test('late reconnect keeps the head cursor, but an older late cutoff forces a full rescan', async () => {
  const h = harness(); const r = h.recovery();
  r.begin({ lastHeartbeat: 1000, now: 1000 });
  h.stream.ready(r, 1001, 1000);
  const gate = deferred();
  h.script.push(async () => { await gate.promise; h.store.setCursor(P, { head: 'H', headSlot: 77 }); return true; });
  const running = r.run(1001);
  h.stream.disconnect(1100); h.stream.ready(r, 1105, 1100);
  gate.resolve(); await running;
  await r.run(1106);
  assert.deepEqual(h.calls[1].cursor, { head: 'H', headSlot: 77 }); // new-head scan only

  const g = harness(); const q = g.recovery();
  q.begin({ lastHeartbeat: 1000, now: 1000 });
  g.stream.ready(q, 1001, 1000);
  const gate2 = deferred();
  g.script.push(async () => { await gate2.promise; g.store.setCursor(P, { head: 'H', headSlot: 77 }); return true; });
  const running2 = q.run(1001);
  const late = g.stream.ready(q, 1002, 400); // reconnect whose outage started before the covered window
  assert.equal(late.cutoff, 390);
  gate2.resolve(); await running2;
  await q.run(1003);
  assert.deepEqual(g.calls[1].cursor, {});
  assert.equal(g.calls[1].cutoff, 390);
});

test('failure and partial scans never complete coverage and retry with the same chain', async () => {
  const h = harness(); const r = h.recovery();
  r.begin({ lastHeartbeat: 1000, now: 1000 });
  h.stream.ready(r, 1001, 1000);
  h.script.push(async () => { throw new Error('rpc down'); }, async () => false);
  assert.equal(await r.run(1001), 'failed');
  assert.equal(h.rows('backfill')[0].ended_at, null);
  assert.equal(h.persisted(), '990');
  assert.equal(await r.run(1010), 'waiting');
  assert.equal(h.calls.length, 1);
  h.clock.t = 1062;
  assert.equal(await r.run(1062), 'partial');
  assert.equal(h.rows('backfill')[0].ended_at, null);
  assert.equal(await r.run(1100), 'waiting');
  h.clock.t = 1123;
  assert.equal(await r.run(1123), 'completed');
  assert.deepEqual(h.calls.map(c => c.cutoff), [990, 990, 990]);
  assert.equal(h.rows('backfill')[0].ended_at, 1123);
});

test('reconnect between failed attempts is late: failed chain completion does not close it', async () => {
  const h = harness(); const r = h.recovery();
  r.begin({ lastHeartbeat: 1000, now: 1000 });
  h.stream.ready(r, 1001, 1000);
  h.script.push(async () => { throw new Error('boom'); });
  await r.run(1001);
  h.stream.disconnect(1020); h.stream.ready(r, 1025, 1019);
  h.clock.t = 1070;
  assert.equal(await r.run(1070), 'completed');
  assert.equal(h.calls[1].cutoff, 990);
  assert.equal(h.rows('backfill')[1].ended_at, null);
  assert.equal(await r.run(1071), 'completed');
  assert.equal(h.calls[2].cutoff, 1009);
  assert.ok(h.rows('backfill').every(row => row.ended_at != null));
});

test('restart preserves unfinished cutoff and adopts and closes unfinished coverage rows', async () => {
  const h = harness(); let r = h.recovery();
  r.begin({ lastHeartbeat: 1000, now: 1000 });
  h.stream.ready(r, 1001, 1000);
  h.script.push(async () => { throw new Error('crash'); });
  await r.run(1001);
  h.store.run("INSERT INTO metadata VALUES('heartbeat','1500')");
  // Process restarts 500s later (new Recovery instance, same database).
  h.store.coverage('process_gap', 1500, 'Restart at 2000; backfill requested');
  h.clock.t = 2000;
  r = h.recovery();
  r.begin({ lastHeartbeat: 1500, now: 2000 });
  assert.equal(h.persisted(), '990', 'lower bound must not move forward');
  h.stream.ready(r, 2002, 1500);
  assert.equal(await r.run(2002), 'completed');
  assert.equal(h.calls.at(-1).cutoff, 990);
  assert.equal(h.persisted(), undefined);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM coverage WHERE kind IN ('backfill','process_gap') AND ended_at IS NULL").n, 0);
  assert.deepEqual(h.store.cursor(P), {});
});

test('restart while a reconnect awaits connection keeps the outage bound', async () => {
  const h = harness(); let r = h.recovery();
  r.begin({ lastHeartbeat: 1000, now: 1000 });
  h.stream.ready(r, 1001, 1000);
  await r.run(1001);
  h.stream.disconnect(3000);
  r.disconnected(2999, 3001); // persisted before the process dies, heartbeat keeps advancing
  assert.equal(h.persisted(), '2989');
  r = h.recovery();
  r.begin({ lastHeartbeat: 3600, now: 3700 });
  assert.equal(r.cutoff, 2989);
});

test('real collector: follow-up scan reads only entries newer than the first scan head', async () => {
  const store = new Store(':memory:', cfg); const clock = { t: 1000 };
  let entries = [{ signature: 'b', slot: 20, blockTime: 995, err: null }, { signature: 'a', slot: 10, blockTime: 900, err: null }];
  const gate = deferred(); let first = true; const seen = [];
  const rpc = { signatures: async () => { if (first) { first = false; await gate.promise; } seen.push(entries.map(e => e.signature).join()); return entries; } };
  const collector = new Collector(store, rpc, cfg);
  const r = new Recovery({ store, collector, programs: [P], now: () => clock.t, log: () => {} });
  r.begin({ lastHeartbeat: 1000, now: 1000 });
  r.reconnected(1000);
  const running = r.run(1000);
  const outage = store.coverage('websocket_gap', 1001, 'gap'); store.run('UPDATE coverage SET ended_at=1002 WHERE id=?', outage);
  clock.t = 1002; r.reconnected(1000);
  entries = [{ signature: 'c', slot: 30, blockTime: 1001, err: null }, ...entries];
  gate.resolve();
  assert.equal(await running, 'completed');
  assert.equal(r.pending, true);
  assert.equal(await r.run(1003), 'completed');
  const queued = store.all('SELECT signature FROM queue ORDER BY slot').map(row => row.signature);
  assert.ok(queued.includes('c'));
  assert.equal(r.pending, false);
  assert.deepEqual(store.cursor(P), {});
});

test('restart adopts all unfinished websocket gaps without changing historical completed rows', async () => {
  const h = harness();
  const earliest = h.store.coverage('websocket_gap', 100, 'original');
  const later = h.store.coverage('websocket_gap', 500, 'later');
  const complete = h.store.coverage('websocket_gap', 20, 'already complete');
  h.store.run('UPDATE coverage SET ended_at=30 WHERE id=?', complete);
  h.store.run("INSERT INTO metadata VALUES('backfill_cutoff','50')");
  const r = h.recovery(); r.begin({ lastHeartbeat: 900, now: 1000 });
  assert.equal(r.cutoff, 50);
  r.reconnected(900, 1000);
  assert.equal(h.store.get('SELECT ended_at FROM coverage WHERE id=?', earliest).ended_at, null);
  h.script.push(async () => false); assert.equal(await r.run(1000), 'partial');
  assert.equal(h.store.get('SELECT ended_at FROM coverage WHERE id=?', later).ended_at, null);
  h.clock.t = 1061; assert.equal(await r.run(1061), 'completed');
  assert.equal(h.store.get('SELECT ended_at FROM coverage WHERE id=?', earliest).ended_at, 1061);
  assert.equal(h.store.get('SELECT ended_at FROM coverage WHERE id=?', later).ended_at, 1061);
  assert.deepEqual({ ...h.store.get('SELECT started_at,ended_at,detail FROM coverage WHERE id=?', complete) }, { started_at: 20, ended_at: 30, detail: 'already complete' });
});

test('a reconnect during backfill owns its own open transport row until a follow-up scan', async () => {
  const h = harness(); const r = h.recovery();
  const first = h.store.coverage('websocket_gap', 900, 'first');
  r.begin({ lastHeartbeat: 900, now: 1000 }); r.reconnected(900, 1000);
  const gate = deferred(); h.script.push(async () => { await gate.promise; return true; });
  const running = r.run(1000);
  const second = h.store.coverage('websocket_gap', 1001, 'second');
  h.clock.t = 1002; r.reconnected(1000, 1002);
  gate.resolve(); await running;
  assert.equal(h.store.get('SELECT ended_at FROM coverage WHERE id=?', first).ended_at, 1002);
  assert.equal(h.store.get('SELECT ended_at FROM coverage WHERE id=?', second).ended_at, null);
  await r.run(1002);
  assert.equal(h.store.get('SELECT ended_at FROM coverage WHERE id=?', second).ended_at, 1002);
});

test('recovery failures never persist or log raw provider errors', async () => {
  const h = harness(), logged = [];
  const r = new Recovery({ store: h.store, collector: h.collector, programs: [P], now: () => h.clock.t,
    log: value => logged.push(value) });
  r.begin({ lastHeartbeat: 900 }); r.reconnected(900);
  h.script.push(async () => { throw Object.assign(new Error('https://SECRET.invalid/?api-key=SECRET'), { code: 'ETIMEDOUT' }); });
  assert.equal(await r.run(1000), 'failed');
  const saved = h.store.get("SELECT value FROM metadata WHERE key='feed_health_recovery'").value;
  assert.ok(!JSON.stringify([saved, logged]).includes('SECRET'));
  assert.equal(JSON.parse(saved).lastFailure.networkCode, 'ETIMEDOUT');
  assert.equal(h.rows('backfill')[0].ended_at, null);
});
