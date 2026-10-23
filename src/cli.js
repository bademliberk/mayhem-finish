import { setTimeout as sleep } from 'node:timers/promises';
import { config, addresses, MINT_AUTHORITY, MAYHEM } from './config.js';
import { Store } from './store.js';
import { Rpc } from './rpc.js';
import { Collector, nowSeconds } from './collector.js';
import { Stream } from './stream.js';
import { decodeCurve, transactionEvents, classify } from './chain.js';
import { report } from './report.js';
import { checkLoop } from './worker.js';
import { Recovery } from './recovery.js';

const cfg = config();
const command = process.argv[2] ?? 'start';
const store = new Store(cfg.db, cfg);

async function inspect(rpc, mint) {
  if (!mint) throw new Error('Usage: npm run inspect -- <mint>');
  const { state, curve } = addresses(mint);
  const snapshot = await rpc.accounts([state, curve]);
  const metrics = decodeCurve(snapshot.value[1]);
  if (!snapshot.value[0] || snapshot.value[0].owner !== MAYHEM || !metrics.mayhem) throw new Error('Not a Mayhem mint');
  const signatures = await rpc.signatures(state, { limit: 20 });
  let trade = null;
  for (const entry of signatures) {
    if (entry.err) continue;
    const tx = await rpc.transaction(entry.signature);
    if (!tx) throw new Error('Transaction unavailable');
    const events = transactionEvents(tx).filter(e => e.type === 'trade' && e.mint === mint);
    if (events.length) { trade = { ...events.at(-1), signature: entry.signature }; break; }
  }
  const now = nowSeconds();
  console.log(JSON.stringify({ mint, checkedAt: new Date(now * 1000).toISOString(), slot: snapshot.context.slot,
    stateAddress: state, stateBytes: Buffer.from(snapshot.value[0].data[0], 'base64').length,
    ...metrics, lastMayhemTrade: trade,
    screening: trade ? classify(trade.timestamp, now, metrics, cfg) : 'unknown: no trade in latest 20 state transactions',
    note: 'Read-only snapshot; not a decoded pause flag. No candidate inserted. History and account snapshot are not atomic.',
  }, null, 2));
}

async function start(rpc) {
  const now = nowSeconds();
  store.run("INSERT OR IGNORE INTO metadata VALUES('monitoring_started_at',?)", String(now));
  const lastHeartbeat = Number(store.get("SELECT value FROM metadata WHERE key='heartbeat'")?.value ?? now);
  if (lastHeartbeat < now - 5) store.coverage('process_gap', lastHeartbeat, `Restart at ${now}; backfill requested`);
  const session = store.coverage('session', now, 'Collector process heartbeat; not a guarantee of complete event coverage');
  const collector = new Collector(store, rpc, cfg);
  let stopping = false;
  let lastConnected = lastHeartbeat;
  const recovery = new Recovery({ store, collector, programs: [MINT_AUTHORITY], retrySeconds: cfg.backfillSeconds });
  // onReady fires on first connect and every reconnect; recovery derives the cutoff from the
  // actual disconnect (websocket_gap start) / last connected time, never from a prior recovery.
  const stream = new Stream(store, rpc, () => recovery.reconnected(lastConnected));
  recovery.begin({ lastHeartbeat, now });
  const stop = () => { stopping = true; stream.stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  stream.start();
  console.log(JSON.stringify({ event: 'started', database: cfg.db, firstCheckSeconds: cfg.firstCheck,
    recheckSeconds: cfg.recheck, horizonSeconds: cfg.horizon, note: 'Read-only collector; no trading' }));
  let workerError;
  const worker = checkLoop(collector, () => stopping).catch(error => {
    workerError = error;
    stop();
  });
  try {
    while (!stopping) {
      const tick = nowSeconds();
      store.run("INSERT INTO metadata VALUES('heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(tick));
      store.run('UPDATE coverage SET ended_at=? WHERE id=?', tick, session);
      stream.flushUsage();
      if (stream.subscriptions.size === 1 && stream.socket?.readyState === 1) lastConnected = tick;
      else recovery.disconnected(lastConnected, tick);
      await recovery.run(tick);
      await collector.drain();
      if (!stopping) await sleep(1000);
    }
  } finally {
    stopping = true;
    stream.stop();
    await worker;
    store.run('UPDATE coverage SET ended_at=? WHERE id=?', nowSeconds(), session);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  if (workerError) throw workerError;
}

try {
  if (command === 'report') console.log(JSON.stringify(report(store), null, 2));
  else if (command === 'inspect') await inspect(new Rpc(cfg, store), process.argv[3]);
  else if (command === 'start') await start(new Rpc(cfg, store));
  else throw new Error('Commands: start, inspect <mint>, report');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store.close(); }
