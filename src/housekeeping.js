// Housekeeping must not wait for discovery RPC or reconciliation work.
export function startHousekeeping({ store, session, stream, tracker, recovery, paperMode,
  lastConnected, now = () => Math.floor(Date.now() / 1000), onError,
  setTimer = setInterval, clearTimer = clearInterval }) {
  let stopped = false;
  const flush = () => {
    stream.flushUsage();
    if (paperMode) tracker.feeds.flushUsage(); else tracker.flushUsage();
  };
  const tick = () => {
    if (stopped) return;
    try {
      const time = now();
      store.run("INSERT INTO metadata VALUES('heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(time));
      store.run('UPDATE coverage SET ended_at=? WHERE id=?', time, session);
      flush();
      if (stream.subscriptions.size === 1 && stream.socket?.readyState === 1) lastConnected.value = time;
      else recovery.disconnected(lastConnected.value, time);
    } catch (error) { onError(error); }
  };
  const timer = setTimer(tick, 1000);
  tick();
  return () => {
    if (stopped) return;
    stopped = true; clearTimer(timer); flush();
  };
}
