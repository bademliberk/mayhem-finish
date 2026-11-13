import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
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
import { paperConfig, liveConfig, PaperStore } from './paper-store.js';
import { PaperFeeds } from './paper-feeds.js';
import { projectTransaction } from './paper-decode.js';
import { trialPath, livePath, bindTrial, preflightTrial, migrateAgentExitPolicy } from './paper-profiles.js';
import { LiveExecutor, liveSettings, loadWallet } from './live-executor.js';

const cfg = config();
const command = process.argv[2] ?? 'start';
// `live-trial agent-sell-liquidity`: the agent strategy with real (or, with LIVE_DRY_RUN=true, simulated) orders.
const live = command === 'live-trial';
const liveArgs = live ? process.argv.slice(4) : [];
const allowedLiveArgs = new Set(['--resume-entries', '--abandon-open-positions', '--reconcile-wallet', '--confirm-offline']);
if (liveArgs.some(arg => !allowedLiveArgs.has(arg)) || new Set(liveArgs).size !== liveArgs.length ||
    (live && process.argv[3] !== 'agent-sell-liquidity')) {
  throw new Error('Usage: live-trial agent-sell-liquidity [--resume-entries] [--abandon-open-positions] OR --reconcile-wallet --confirm-offline');
}
const resumeEntries = liveArgs.includes('--resume-entries');
const abandonOpenPositions = liveArgs.includes('--abandon-open-positions');
const reconcileWallet = liveArgs.includes('--reconcile-wallet');
const confirmOffline = liveArgs.includes('--confirm-offline');
if (live && (reconcileWallet !== confirmOffline || (reconcileWallet && (resumeEntries || abandonOpenPositions)))) {
  throw new Error('Wallet reconciliation requires exactly --reconcile-wallet --confirm-offline; stop all writers first');
}
const trial = command === 'paper-trial' || live;
const profile = trial ? process.argv[3] : null;
const trialArgs = command === 'paper-trial' ? process.argv.slice(4) : [];
const migratePolicy = trialArgs.includes('--migrate-exit-policy');
if (trialArgs.length && !(profile === 'agent-sell-liquidity' && migratePolicy &&
    trialArgs.length === 2 && trialArgs.includes('--confirm-offline'))) {
  throw new Error('Usage: paper-trial <profile> OR paper-trial agent-sell-liquidity --migrate-exit-policy --confirm-offline (stop all trial processes first)');
}
const settings = live ? liveSettings(process.env) : null;
// Validated before any database is opened; the secret is never logged or stored.
const wallet = live ? loadWallet(process.env.AS_WALLET_SECRET) : null;
if (live && !cfg.key) throw new Error('HELIUS_API_KEY is required for live trading');
if (live) cfg.db = livePath(settings.dryRun, process.env.LIVE_TRIAL_DIR, cfg.db);
else if (trial) cfg.db = trialPath(profile, process.env.PAPER_TRIAL_DIR, cfg.db);
cfg.paperMode = command === 'paper' || trial;
// The trial identity holds strategy assumptions only; wallet floor and loss limits are runtime settings.
const paperCfg = live ? liveConfig(process.env) :
  cfg.paperMode || command === 'paper-report' ? paperConfig(process.env, profile) : null;
const engineCfg = live ? { ...paperCfg, live: { minWalletLamports: String(settings.minWalletLamports),
  maxLossLamports: String(settings.maxLossLamports), perTradeReserveLamports: String(settings.perTradeReserveLamports),
  exitSlippageBps: settings.exitSlippageBps, forceSell: settings.forceSell,
  maxBuysInFlight: settings.maxBuysInFlight, checkBalancePerBuy: settings.checkBalancePerBuy,
  burnOnlyAfterFailures: settings.burnOnlyAfterFailures } } : paperCfg;
if (trial && !migratePolicy) preflightTrial(cfg.db, paperCfg);
if (reconcileWallet && !existsSync(cfg.db)) throw new Error('Wallet reconciliation requires an existing live database');
const store = migratePolicy ? null : new Store(cfg.db, cfg);

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

async function startLive() {
  // Wallet and API key are read here only, and never logged or stored.
  const executor = new LiveExecutor({ wallet, apiKey: cfg.key, settings });
  try {
    await executor.init();
    console.log(JSON.stringify({ event: 'live_wallet', wallet: executor.owner, dryRun: settings.dryRun, database: cfg.db,
      minWalletLamports: String(settings.minWalletLamports), maxLossLamports: String(settings.maxLossLamports) }));
    if (reconcileWallet) {
      new PaperStore(store, paperCfg); bindTrial(store, paperCfg);
      const tracker = new PaperEngine(store, {}, engineCfg, { project: projectTransaction, executor });
      const before = store.get("SELECT COUNT(*) n FROM paper_positions WHERE status='open'").n;
      const result = await tracker.liveReconcileWallet({ allowForeign: true });
      const after = store.get("SELECT COUNT(*) n FROM paper_positions WHERE status='open'").n;
      console.log(JSON.stringify({ event: 'live_wallet_reconciled', database: cfg.db, before, after, ...result }));
    } else await start(new Rpc(cfg, store), executor);
  } finally { executor.stop(); }
}

async function start(rpc, executor = null) {
  if (trial) { new PaperStore(store, paperCfg); bindTrial(store, paperCfg); }
  else if (store.get("SELECT 1 FROM metadata WHERE key='paper_trial_config'")) {
    throw new Error('Trial database must be resumed with paper-trial and its original profile');
  }
  const tracker = cfg.paperMode
    ? new PaperEngine(store, rpc, engineCfg, { project: projectTransaction, executor })
    : new CandidateTracker(store, rpc);
  // Wallet and database must agree before any session, feed or order starts.
  if (executor) {
    try { await tracker.liveStartupChecks({ resume: resumeEntries, allowForeign: abandonOpenPositions }); } catch (error) { rpc.stop(); throw error; }
  }
  const now = nowSeconds();
  store.run("INSERT OR IGNORE INTO metadata VALUES('monitoring_started_at',?)", String(now));
  const lastHeartbeat = Number(store.get("SELECT value FROM metadata WHERE key='heartbeat'")?.value ?? now);
  if (lastHeartbeat < now - 5) store.coverage('process_gap', lastHeartbeat, `Restart at ${now}; backfill requested`);
  const session = store.coverage('session', now, 'Collector process heartbeat; not a guarantee of complete event coverage');
  if (!cfg.paperMode) store.activatePolicy(now);
  let stopping = false, draining = false, stream = null, trackerStopped, stopError, drainError, drainTimer;
  // Every component that may already own sockets/timers is stopped, even if a later one failed to construct,
  // and one failing stop step (e.g. SQLite busy) never skips the others or escapes a signal listener.
  const stopStep = fn => { try { fn(); } catch (error) { stopError ??= error; } };
  const hardStop = () => {
    stopping = true;
    if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
    stopStep(() => stream?.stop());
    stopStep(() => { trackerStopped ??= Promise.resolve(tracker.stop()).catch(error => { stopError ??= error; }); });
    stopStep(() => rpc.stop());
  };
  const signalStop = () => {
    if (!executor || settings.shutdownDrainMs <= 0) { hardStop(); return; }
    if (draining) {
      const mints = tracker.recordDrainFailure('shutdown_forced');
      const manual = tracker.drainStatus().manualPositions.map(row => row.mint);
      drainError = new Error(`Forced shutdown; ${mints.length} unresolved exit(s), ${manual.length} graduated position(s) need manual sale: ${[...mints, ...manual].join(',')}`);
      hardStop(); return;
    }
    draining = true;
    const deadline = Date.now() + settings.shutdownDrainMs;
    tracker.beginDrain();
    const poll = () => {
      const status = tracker.drainStatus();
      if (!status.actionablePositions && !status.pendingExits && !status.submitted) {
        if (status.manualPositions.length) {
          drainError = new Error(`Shutdown reached manual-action positions requiring sale on PumpSwap: ${status.manualPositions.map(row => row.mint).join(',')}`);
        }
        hardStop(); return;
      }
      if (Date.now() >= deadline) {
        const mints = tracker.recordDrainFailure('shutdown_drain_timeout');
        const manual = tracker.drainStatus().manualPositions.map(row => row.mint);
        drainError = new Error(`Shutdown drain timed out with ${mints.length} unresolved exit(s), ${manual.length} graduated position(s) needing manual sale: ${[...mints, ...manual].join(',')}`);
        hardStop();
      }
    };
    drainTimer = setInterval(poll, 250); drainTimer.unref?.(); poll();
  };
  process.on('SIGINT', signalStop); process.on('SIGTERM', signalStop);
  let paperError, workerError, housekeepingError;
  let worker = Promise.resolve(), paperWorker = Promise.resolve(), stopHousekeeping = () => {};
  try {
    if (cfg.paperMode) {
      tracker.attach(new PaperFeeds(store, rpc, {
        agentMode: paperCfg.strategy === 'agent-sell-liquidity', commitment: paperCfg.feedCommitment ?? 'confirmed',
        onAgentTransaction: tx => tracker.agentTransaction(tx),
        onAccount: (...args) => tracker.onAccount(...args), onTransaction: raw => tracker.enqueue(raw),
        onGap: reason => tracker.gap(reason), onReady: () => tracker.onReady(), onSlot: slot => tracker.onSlot(slot),
        onCoverage: mint => tracker.coverage(mint),
        onSubscriptionError: detail => tracker.paper.rejection('subscription_error', detail, Date.now()),
      }));
      store.onDiscovery = () => tracker.discover();
      tracker.start();
    } else tracker.recover();
    const collector = new Collector(store, rpc, cfg, mint => tracker.add(mint));
    const lastConnected = { value: lastHeartbeat };
    const recovery = new Recovery({ store, collector, programs: [MINT_AUTHORITY], retrySeconds: cfg.backfillSeconds });
    // onReady fires on first connect and every reconnect; recovery derives the cutoff from the
    // actual disconnect (websocket_gap start) / last connected time, never from a prior recovery.
    stream = new Stream(store, rpc, () => recovery.reconnected(lastConnected.value));
    recovery.begin({ lastHeartbeat, now });
    if (!stopping) stream.start();
    console.log(JSON.stringify({ event: 'started', database: cfg.db, firstCheckSeconds: cfg.firstCheck,
      recheckSeconds: cfg.recheck, horizonSeconds: cfg.horizon,
      note: !executor ? (cfg.paperMode ? 'Paper trading only; no signing or transaction submission' : 'Read-only collector; no trading')
        : settings.dryRun ? 'LIVE DRY RUN: buys simulated against mainnet, nothing broadcast' : 'LIVE TRADING: real transactions are signed and sent' }));
    paperWorker = cfg.paperMode ? (async () => {
      while (!stopping) { await tracker.tick(); if (!stopping) await sleep(100); }
    })().catch(error => { paperError = error; hardStop(); }) : Promise.resolve();
    worker = cfg.paperMode ? Promise.resolve() : checkLoop(collector, () => stopping).catch(error => {
      workerError = error;
      hardStop();
    });
    stopHousekeeping = startHousekeeping({ store, session, stream, tracker, recovery,
      paperMode: cfg.paperMode, lastConnected, onError: error => { housekeepingError = error; hardStop(); } });
    while (!stopping) {
      const tick = nowSeconds();
      store.run("INSERT INTO metadata VALUES('discovery_started_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(tick));
      await recovery.run(tick);
      if (!stopping) await collector.drain(cfg.paperMode ? 5 : 50, {
        maxDurationMs: cfg.paperMode ? 1000 : Infinity, shouldStop: () => stopping,
      });
      if (!stopping) store.run("INSERT INTO metadata VALUES('discovery_completed_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(nowSeconds()));
      if (!stopping) await sleep(1000);
    }
  } finally {
    hardStop();
    stopStep(stopHousekeeping);
    await worker;
    await paperWorker;
    await trackerStopped;
    // Durable usage and the session end are recorded even if a stop step failed.
    stopStep(() => stream?.flushUsage());
    stopStep(() => { if (cfg.paperMode) tracker.feeds?.flushUsage(); else tracker.flushUsage(); });
    stopStep(() => store.run('UPDATE coverage SET ended_at=? WHERE id=?', nowSeconds(), session));
    process.removeListener('SIGINT', signalStop); process.removeListener('SIGTERM', signalStop);
  }
  if (housekeepingError) throw housekeepingError;
  if (workerError) throw workerError;
  if (paperError) throw paperError;
  if (stopError) throw stopError;
  if (drainError) throw drainError;
}

try {
  if (migratePolicy) console.log(JSON.stringify({ event: 'paper_trial_policy_migrated', database: cfg.db,
    migration: migrateAgentExitPolicy(cfg.db, paperCfg, { confirmOffline: true }) }, null, 2));
  else if (command === 'report') console.log(JSON.stringify(report(store), null, 2));
  else if (command === 'inspect') await inspect(new Rpc(cfg, store), process.argv[3]);
  else if (command === 'paper-report') {
    const saved = store.get("SELECT value FROM metadata WHERE key='paper_trial_config'")?.value;
    console.log(JSON.stringify(new PaperStore(store, saved ? JSON.parse(saved) : paperCfg).report(), null, 2));
  }
  else if (live) await startLive();
  else if (command === 'start' || command === 'paper' || trial) await start(new Rpc(cfg, store));
  else throw new Error('Commands: start, paper, paper-trial <profile>, live-trial agent-sell-liquidity, paper-report, inspect <mint>, report');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store?.close(); }
