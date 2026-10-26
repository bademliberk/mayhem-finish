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
import { startHousekeeping } from './housekeeping.js';
import { CandidateTracker } from './tracker.js';
import { PaperEngine } from './paper-engine.js';
import { paperConfig, PaperStore } from './paper-store.js';
import { PaperFeeds } from './paper-feeds.js';
import { projectTransaction } from './paper-decode.js';
import { trialPath, bindTrial, preflightTrial } from './paper-profiles.js';

const cfg = config();
const command = process.argv[2] ?? 'start';
const trial = command === 'paper-trial';
const profile = trial ? process.argv[3] : null;
if (trial) cfg.db = trialPath(profile, process.env.PAPER_TRIAL_DIR, cfg.db);
cfg.paperMode = command === 'paper' || trial;
const paperCfg = cfg.paperMode || command === 'paper-report' ? paperConfig(process.env, profile) : null;
if (trial) preflightTrial(cfg.db, paperCfg);
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
  if (trial) { new PaperStore(store, paperCfg); bindTrial(store, paperCfg); }
  else if (store.get("SELECT 1 FROM metadata WHERE key='paper_trial_config'")) {
    throw new Error('Trial database must be resumed with paper-trial and its original profile');
  }
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
  const lastConnected = { value: lastHeartbeat };
  const recovery = new Recovery({ store, collector, programs: [MINT_AUTHORITY], retrySeconds: cfg.backfillSeconds });
  // onReady fires on first connect and every reconnect; recovery derives the cutoff from the
  // actual disconnect (websocket_gap start) / last connected time, never from a prior recovery.
  const stream = new Stream(store, rpc, () => recovery.reconnected(lastConnected.value));
  recovery.begin({ lastHeartbeat, now });
  let trackerStopped;
  const stop = () => { stopping = true; stream.stop(); trackerStopped ??= tracker.stop(); rpc.stop(); };
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
  let housekeepingError;
  const stopHousekeeping = startHousekeeping({ store, session, stream, tracker, recovery,
    paperMode: cfg.paperMode, lastConnected, onError: error => { housekeepingError = error; stop(); } });
  try {
    while (!stopping) {
      const tick = nowSeconds();
      store.run("INSERT INTO metadata VALUES('discovery_started_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(tick));
      await recovery.run(tick);
      if (!stopping) await collector.drain();
      if (!stopping) store.run("INSERT INTO metadata VALUES('discovery_completed_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(nowSeconds()));
      if (!stopping) await sleep(1000);
    }
  } finally {
    stop();
    try { stopHousekeeping(); }
    finally {
      await worker;
      await paperWorker;
      await trackerStopped;
    }
    stream.flushUsage();
    if (cfg.paperMode) tracker.feeds.flushUsage(); else tracker.flushUsage();
    store.run('UPDATE coverage SET ended_at=? WHERE id=?', nowSeconds(), session);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  if (housekeepingError) throw housekeepingError;
  if (workerError) throw workerError;
  if (paperError) throw paperError;
}

try {
  if (command === 'report') console.log(JSON.stringify(report(store), null, 2));
  else if (command === 'inspect') await inspect(new Rpc(cfg, store), process.argv[3]);
  else if (command === 'paper-report') {
    const saved = store.get("SELECT value FROM metadata WHERE key='paper_trial_config'")?.value;
    console.log(JSON.stringify(new PaperStore(store, saved ? JSON.parse(saved) : paperCfg).report(), null, 2));
  }
  else if (command === 'start' || command === 'paper' || trial) await start(new Rpc(cfg, store));
  else throw new Error('Commands: start, paper, paper-trial <profile>, paper-report, inspect <mint>, report');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store.close(); }
