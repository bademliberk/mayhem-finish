import { setTimeout as sleep } from 'node:timers/promises';
import { config, addresses, MINT_AUTHORITY, MAYHEM } from './config.js';
import { Store } from './store.js';
import { Rpc } from './rpc.js';
import { Collector, nowSeconds } from './collector.js';
import { Stream } from './stream.js';
import { decodeCurve, classify } from './chain.js';
import { report } from './report.js';
import { checkLoop } from './worker.js';
import { Recovery } from './recovery.js';
import { CandidateTracker } from './tracker.js';
import { PaperEngine } from './paper-engine.js';
import { paperConfig, PaperStore } from './paper-store.js';
import { PaperFeeds } from './paper-feeds.js';
import { projectTransaction } from './paper-decode.js';

const cfg = config();
const command = process.argv[2] ?? 'start';
cfg.paperMode = command === 'paper';
const paperCfg = ['paper', 'paper-report'].includes(command) ? paperConfig() : null;
const store = new Store(cfg.db, cfg);

async function inspect(rpc, mint) {
  if (!mint) throw new Error('Usage: npm run inspect -- <mint>');
  const { state, curve } = addresses(mint);
  const snapshot = await rpc.accounts([state, curve]);
  const metrics = decodeCurve(snapshot.value[1]);
  if (!snapshot.value[0] || snapshot.value[0].owner !== MAYHEM || !metrics.mayhem) throw new Error('Not a Mayhem mint');
  const now = nowSeconds();
  console.log(JSON.stringify({ mint, checkedAt: new Date(now * 1000).toISOString(), slot: snapshot.context.slot,
    stateAddress: state, stateBytes: Buffer.from(snapshot.value[0].data[0], 'base64').length,
    ...metrics, tradeHistory: 'not_checked',
    screening: classify(metrics, cfg),
    note: 'Read-only financial snapshot; bot activity is not checked. No candidate inserted.',
  }, null, 2));
}

async function start(rpc) {
  const now = nowSeconds();
  store.run("INSERT OR IGNORE INTO metadata VALUES('monitoring_started_at',?)", String(now));
  const lastHeartbeat = Number(store.get("SELECT value FROM metadata WHERE key='heartbeat'")?.value ?? now);
  if (lastHeartbeat < now - 5) store.coverage('process_gap', lastHeartbeat, `Restart at ${now}; backfill requested`);
  const session = store.coverage('session', now, 'Collector process heartbeat; not a guarantee of complete event coverage');
  if (!cfg.paperMode) store.activatePolicy(now);
  const tracker = cfg.paperMode
    ? new PaperEngine(store, rpc, paperCfg, { project: projectTransaction })
    : new CandidateTracker(store, rpc);
  if (cfg.paperMode) {
    tracker.attach(new PaperFeeds(store, rpc, {
      onAccount: (...args) => tracker.onAccount(...args), onTransaction: raw => tracker.enqueue(raw),
      onGap: reason => tracker.gap(reason), onReady: () => tracker.onReady(), onSlot: slot => tracker.onSlot(slot),
      onCoverage: mint => tracker.coverage(mint),
      onSubscriptionError: detail => tracker.paper.rejection('subscription_error', detail, Date.now()),
    }));
    store.onDiscovery = () => tracker.discover();
    tracker.start();
  } else tracker.recover();
  const collector = new Collector(store, rpc, cfg, mint => tracker.add(mint));
  let stopping = false;
  let lastConnected = lastHeartbeat;
  const recovery = new Recovery({ store, collector, programs: [MINT_AUTHORITY], retrySeconds: cfg.backfillSeconds });
  // onReady fires on first connect and every reconnect; recovery derives the cutoff from the
  // actual disconnect (websocket_gap start) / last connected time, never from a prior recovery.
  const stream = new Stream(store, rpc, () => recovery.reconnected(lastConnected));
  recovery.begin({ lastHeartbeat, now });
  let trackerStopped;
  const stop = () => { stopping = true; stream.stop(); trackerStopped ??= tracker.stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  stream.start();
  console.log(JSON.stringify({ event: 'started', database: cfg.db, firstCheckSeconds: cfg.firstCheck,
    recheckSeconds: cfg.recheck, horizonSeconds: cfg.horizon,
    note: cfg.paperMode ? 'Paper trading only; no signing or transaction submission' : 'Read-only collector; no trading' }));
  let paperError;
  const paperWorker = cfg.paperMode ? (async () => {
    while (!stopping) { await tracker.tick(); if (!stopping) await sleep(100); }
  })().catch(error => { paperError = error; stop(); }) : Promise.resolve();
  let workerError;
  const worker = cfg.paperMode ? Promise.resolve() : checkLoop(collector, () => stopping).catch(error => {
    workerError = error;
    stop();
  });
  try {
    while (!stopping) {
      const tick = nowSeconds();
      store.run("INSERT INTO metadata VALUES('heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(tick));
      store.run('UPDATE coverage SET ended_at=? WHERE id=?', tick, session);
      stream.flushUsage();
      if (cfg.paperMode) tracker.feeds.flushUsage();
      else tracker.flushUsage();
      if (stream.subscriptions.size === 1 && stream.socket?.readyState === 1) lastConnected = tick;
      else recovery.disconnected(lastConnected, tick);
      await recovery.run(tick);
      await collector.drain();
      if (!stopping) await sleep(1000);
    }
  } finally {
    stop();
    await worker;
    await paperWorker;
    await trackerStopped;
    store.run('UPDATE coverage SET ended_at=? WHERE id=?', nowSeconds(), session);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  if (workerError) throw workerError;
  if (paperError) throw paperError;
}

try {
  if (command === 'report') console.log(JSON.stringify(report(store), null, 2));
  else if (command === 'inspect') await inspect(new Rpc(cfg, store), process.argv[3]);
  else if (command === 'paper-report') console.log(JSON.stringify(new PaperStore(store, paperCfg).report(), null, 2));
  else if (command === 'start' || command === 'paper') await start(new Rpc(cfg, store));
  else throw new Error('Commands: start, paper, paper-report, inspect <mint>, report');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store.close(); }
