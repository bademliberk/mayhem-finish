import test from 'node:test';
import assert from 'node:assert/strict';
import { startHousekeeping } from '../src/housekeeping.js';
import { Store } from '../src/store.js';
import { Rpc } from '../src/rpc.js';
import { Collector } from '../src/collector.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { FeedHealth, readFeedHealth } from '../src/feed-health.js';

test('housekeeping stays live during blocked discovery and stops all writes on cleanup', async () => {
  const writes=[],gaps=[];let tick,time=100,flushes=0,cleared=false;
  const store={run:(...args)=>writes.push(args)};
  const stream={subscriptions:new Set([1]),socket:{readyState:1},flushUsage:()=>flushes++};
  const tracker={feeds:{flushUsage:()=>flushes++}};
  const lastConnected={value:90};
  const stop=startHousekeeping({store,session:1,stream,tracker,paperMode:true,lastConnected,
    recovery:{disconnected:(...args)=>gaps.push(args)},now:()=>time,onError:error=>{throw error;},
    setTimer:callback=>{tick=callback;return 1;},clearTimer:id=>{assert.equal(id,1);cleared=true;}});
  let release;const discovery=new Promise(resolve=>{release=resolve;});
  time=101;tick();time=102;tick();
  assert.equal(writes.filter(w=>w[0].includes("'heartbeat'")).length,3);
  assert.equal(flushes,6);assert.equal(lastConnected.value,102);
  assert.equal(writes.some(w=>w[0].includes('discovery_completed_at')),false);
  stream.socket.readyState=3;time=103;tick();assert.deepEqual(gaps,[[102,103]]);
  stop();assert.equal(cleared,true);assert.equal(flushes,10);
  const count=writes.length;tick();stop();assert.equal(writes.length,count);assert.equal(flushes,10);
  release();await discovery;
});

test('real discovery draining times out while housekeeping keeps persisting usage',async t=>{
  const store=new Store(':memory:',{firstCheck:30,recheck:30,horizon:86400});
  const rpc=new Rpc({key:'test',rpcInterval:0,requestTimeoutMs:50},store);
  t.mock.method(globalThis,'fetch',()=>new Promise(()=>{}));
  store.enqueue('blocked',1,100);
  const collector=new Collector(store,rpc,{});
  const session=store.coverage('session',100,'test');
  let tick,time=100;
  const stop=startHousekeeping({store,session,paperMode:true,lastConnected:{value:100},
    stream:{subscriptions:new Set([1]),socket:{readyState:1},flushUsage:()=>store.usage('websocket','test',1)},
    tracker:{feeds:{flushUsage:()=>store.usage('preprocessed','test',1)}},
    recovery:{disconnected:()=>assert.fail('connected')},now:()=>time,
    onError:error=>{throw error;},setTimer:callback=>{tick=callback;return 1;},clearTimer:()=>{}});
  try {
    const draining=collector.drain();
    await sleep(5);time=101;tick();
    assert.equal(store.get("SELECT value FROM metadata WHERE key='heartbeat'").value,'101');
    assert.equal(store.get("SELECT amount FROM usage WHERE source='websocket' AND method='test'").amount,2);
    await draining;
    assert.equal(store.get('SELECT attempts FROM queue').attempts,1);
  } finally {stop();rpc.stop();await sleep(5);store.close();}
});

test('housekeeping reports errors and supports monitor usage flushing',()=>{
  let error;let flushed=0;
  const stop=startHousekeeping({store:{run:()=>{}},session:1,
    stream:{subscriptions:new Set(),flushUsage:()=>{}},tracker:{flushUsage:()=>flushed++},
    recovery:{disconnected:()=>{throw new Error('failure');}},paperMode:false,lastConnected:{value:1},
    onError:value=>{error=value;},setTimer:()=>1,clearTimer:()=>{}});
  assert.equal(error.message,'failure');assert.equal(flushed,1);stop();assert.equal(flushed,2);
});

test('fresh process heartbeat does not imply healthy discovery, slots, preprocessed or recovery', () => {
  const store = new Store(':memory:', {}); let time = 100;
  const discovery = new FeedHealth(store, 'discovery', () => time * 1000);
  const standard = new FeedHealth(store, 'standard', () => time * 1000);
  const preprocessed = new FeedHealth(store, 'preprocessed', () => time * 1000);
  discovery.update({ phase: 'backoff', nextRetryAt: 101000 });
  standard.update({ phase: 'subscribed', lastAckAt: 100000 }); // no initial progress
  preprocessed.update({ phase: 'subscribing' });
  const gap = store.coverage('websocket_gap', 90, 'unfinished');
  store.run("INSERT INTO metadata VALUES('backfill_cutoff','80')");
  let tick;
  const stop = startHousekeeping({ store, session: store.coverage('session', time, 'test'),
    stream: { subscriptions: new Set(), flushUsage() {}, flushHealth: () => discovery.flush() },
    tracker: { feeds: { flushUsage() {}, flushHealth: () => { standard.flush(); preprocessed.flush(); } } },
    recovery: { disconnected() {} }, paperMode: true, lastConnected: { value: 90 }, now: () => time,
    onError: error => { throw error; }, setTimer: fn => { tick = fn; return 1; }, clearTimer() {},
  });
  let health = readFeedHealth(store, 100000);
  assert.equal(health.process.state, 'running'); assert.equal(health.discovery.state, 'degraded');
  assert.equal(health.standard.state, 'degraded'); assert.equal(health.preprocessed.state, 'degraded');
  assert.equal(health.recovery.state, 'incomplete'); assert.equal(health.recovery.cutoff, 80);
  discovery.update({ phase: 'subscribed', lastAckAt: 100000 });
  standard.update({ lastProgressAt: 100000, lastSlot: 50 }); preprocessed.update({ phase: 'idle' });
  health = readFeedHealth(store, 100000);
  assert.equal(health.discovery.state, 'subscribed'); assert.equal(health.standard.state, 'healthy');
  assert.equal(health.preprocessed.state, 'idle'); assert.equal(health.recovery.state, 'incomplete');
  time = 131; tick(); health = readFeedHealth(store, 131000);
  assert.equal(health.process.state, 'running'); assert.equal(health.standard.state, 'degraded');
  assert.equal(health.discovery.state, 'subscribed', 'quiet mint feed alone is not a failed subscription');
  health = readFeedHealth(store, 137000);
  for (const name of ['process', 'discovery', 'standard', 'preprocessed', 'recovery']) assert.equal(health[name].state, 'stale');
  stop(); health = readFeedHealth(store, 131000);
  for (const name of ['process', 'discovery', 'standard', 'preprocessed', 'recovery']) assert.equal(health[name].state, 'stopped');
  assert.equal(health.recovery.pending, 1); assert.equal(store.get('SELECT ended_at FROM coverage WHERE id=?', gap).ended_at, null);
  store.close();
});

test('old databases, malformed saved health and unknown components are not presented as live', () => {
  const store = new Store(':memory:', {});
  assert.equal(readFeedHealth(store, 100000).process.state, 'unavailable');
  store.run("INSERT INTO metadata VALUES('heartbeat','100')");
  store.run('INSERT INTO metadata VALUES(?,?)', 'feed_health_discovery', JSON.stringify({
    phase: 'subscribed', updatedAt: 100000, rawError: 'SECRET', url: 'SECRET',
    lastFailure: { category: 'SECRET', networkCode: 'SECRET', httpStatus: 'SECRET', at: 100000 },
  }));
  let result = readFeedHealth(store, 100000);
  assert.equal(result.process.state, 'unavailable'); assert.equal(result.discovery.state, 'stale');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  store.run("INSERT INTO metadata VALUES('feed_health_standard','broken json SECRET')");
  result = readFeedHealth(store, 100000); assert.equal(result.standard.state, 'unavailable');
  assert.throws(() => new FeedHealth(store, 'SECRET'), /Unknown feed health component/);
  store.close();
});
