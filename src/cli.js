import { setTimeout as sleep } from 'node:timers/promises';
import { config, addresses, MINT_AUTHORITY, MAYHEM } from './config.js';
import { Store } from './store.js';
import { Rpc } from './rpc.js';
import { Collector, nowSeconds } from './collector.js';
import { Stream } from './stream.js';
import { decodeCurve, transactionEvents, classify } from './chain.js';
import { report } from './report.js';
import { checkLoop } from './worker.js';

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
  let backfillNeeded = true;
  let backfillCutoff = Math.max(0, lastHeartbeat - 10);
  let lastConnected = lastHeartbeat;
  const stream = new Stream(store, rpc, () => {
    backfillNeeded = true;
    backfillCutoff = Math.min(backfillCutoff, lastConnected - 10);
  });
  let recovery = store.coverage('backfill', now, 'Startup/reconnection reconciliation');
  // Persist unfinished recovery across restarts; never jump its lower bound forward.
  const pending = store.get("SELECT value FROM metadata WHERE key='backfill_cutoff'");
  if (pending) backfillCutoff = Math.min(backfillCutoff, Number(pending.value));
  for (const program of [MINT_AUTHORITY]) store.setCursor(program, {});
  const stop = () => { stopping = true; stream.stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  stream.start();
  let nextBackfill = 0;
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
      if (backfillNeeded && tick >= nextBackfill) {
        store.run("INSERT INTO metadata VALUES('backfill_cutoff',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(backfillCutoff));
        try {
          const results = [];
          for (const program of [MINT_AUTHORITY]) results.push(await collector.scan(program, backfillCutoff));
          if (results.every(Boolean)) {
            backfillNeeded = false;
            store.run('UPDATE coverage SET ended_at=? WHERE id=?', nowSeconds(), recovery);
            store.run("DELETE FROM metadata WHERE key='backfill_cutoff'");
            store.run("UPDATE coverage SET ended_at=? WHERE kind='process_gap' AND ended_at IS NULL", nowSeconds());
            backfillCutoff = nowSeconds();
            // The next reconnect needs only the disconnected interval, not all live traffic.
            for (const program of [MINT_AUTHORITY]) store.setCursor(program, {});
          }
        } catch (error) { console.error(`Backfill deferred: ${error.message}`); }
        nextBackfill = tick + cfg.backfillSeconds;
      }
      if (!backfillNeeded && stream.gap !== null) {
        backfillNeeded = true; backfillCutoff = lastConnected - 10;
        recovery = store.coverage('backfill', tick, 'Reconnection reconciliation');
      }
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
