import WebSocket from 'ws';
import { PUMP } from './config.js';

// Upper bound for any single frame we are willing to buffer (account JSON or raw transaction bytes).
export const MAX_FRAME_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 10000;
const ACK_TIMEOUT_MS = 15000;
const SYNC_DEBOUNCE_MS = 100;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;
const PREPROCESSED_HOST = 'wss://beta.helius-rpc.com/';

// Same API key, different Helius host; never echoes the source URL in errors.
export function preprocessedUrl(wsUrl) {
  let key = null;
  try { key = new URL(wsUrl).searchParams.get('api-key'); } catch { key = null; }
  if (!key) throw new Error('Cannot derive preprocessed endpoint from rpc.wsUrl (credentials suppressed)');
  const url = new URL(PREPROCESSED_HOST);
  url.searchParams.set('api-key', key);
  return url.toString();
}

const toBuffer = raw => {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return Buffer.from(String(raw));
};
const noop = () => {};
const newLink = kind => ({
  kind, socket: null, retry: null, heartbeat: null, ackTimer: null, alive: true,
  attempts: 0, generation: 0, acked: false, bytes: 0, transactions: 0,
});

// Preprocessed stream: `conn` is the active (acked) connection, `next` a replacement still subscribing.
const newPreprocessed = () => ({
  kind: 'preprocessed', conn: null, next: null, retry: null, attempts: 0, bytes: 0, transactions: 0,
});

// Transport only: raw account updates, raw preprocessed transaction frames, slots and gap/readiness signals.
// Decoding, paper accounting and gap policy live in the caller.
export class PaperFeeds {
  constructor(store, rpc, {
    onAccount = noop, onTransaction = noop, onGap = noop, onReady = noop, onSlot = noop, onCoverage = noop, onSubscriptionError = noop,
    socketFactory = url => new WebSocket(url, { handshakeTimeout: 10000, maxPayload: MAX_FRAME_BYTES }),
    setTimer = setTimeout, clearTimer = clearTimeout,
  } = {}) {
    this.store = store; this.rpc = rpc;
    this.callbacks = { onAccount, onTransaction, onGap, onReady, onSlot, onCoverage, onSubscriptionError };
    this.socketFactory = socketFactory; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.preprocessedUrl = preprocessedUrl(rpc.wsUrl);
    this.standard = newLink('standard');
    this.preprocessed = newPreprocessed(); this.syncTimer = null;
    this.watches = new Map();        // mint -> watch
    this.requests = new Map();       // request id -> watch (standard socket, pending ack)
    this.subscriptions = new Map();  // subscription id -> watch
    this.slotRequest = null; this.slotSubscription = null;
    this.sequence = 0; this.tasks = new Set();
    this.started = false; this.stopped = false; this.ready = false; this.gapPending = false;
  }

  // ---- public API ----
  add(mint, curveAddress, preprocessed = true) {
    if (this.stopped) return;
    const existing = this.watches.get(mint);
    if (existing) {
      if (existing.curve === curveAddress) return;
      this.remove(mint);
    }
    const watch = { mint, curve: curveAddress, preprocessed, covered: false, request: null, subscription: null, lastSlot: -1, seq: 0 };
    this.watches.set(mint, watch);
    if (this.standard.socket?.readyState === WebSocket.OPEN) this.subscribe(watch);
    this.scheduleSync();
  }
  setPreprocessed(mint, enabled) {
    const watch = this.watches.get(mint);
    if (!watch || watch.preprocessed === enabled) return;
    watch.preprocessed = enabled;
    if (!enabled) watch.covered = false;
    this.scheduleSync(); this.checkReady();
  }
  covers(mint) {
    const watch = this.watches.get(mint);
    return Boolean(watch?.preprocessed && watch.covered && this.preprocessed.conn?.curves.includes(watch.curve));
  }
  notifyCoverage() {
    for (const watch of this.watches.values()) {
      const included = watch.preprocessed && this.preprocessed.conn?.curves.includes(watch.curve);
      if (!included) watch.covered = false;
      else if (!watch.covered) {
        watch.covered = true; this.safe('onCoverage', watch.mint);
      }
    }
  }
  remove(mint) {
    const watch = this.watches.get(mint);
    if (!watch) return;
    watch.baseline?.abort();
    this.watches.delete(mint);
    // A still-pending request stays in this.requests so a late acknowledgment is unsubscribed.
    if (watch.subscription != null) {
      this.subscriptions.delete(watch.subscription);
      const id = watch.subscription; watch.subscription = null;
      this.send(this.standard, 'accountUnsubscribe', [id]);
    }
    this.scheduleSync();
    if (!this.curves().length) this.checkReady(); // curve-only watches do not require preprocessed coverage
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.connect(this.standard); this.reconcile();
  }
  isReady() { return this.ready; }
  // Caller-initiated resynchronization (e.g. its binary queue overflowed): drops both sockets, reconnects at once
  // and re-baselines every account. onReady fires again after the fresh acknowledgments. onGap is not invoked.
  resync() {
    if (!this.started || this.stopped) return;
    this.ready = false; this.gapPending = true;
    const { standard } = this;
    const socket = standard.socket;
    this.drop(standard);
    this.clearTimer(standard.retry); standard.retry = null; standard.attempts = 0;
    this.closePreprocessed();
    try { socket?.terminate(); } catch { /* already closed */ }
    this.connect(standard); this.reconcile();
  }
  flushUsage() {
    const { standard, preprocessed } = this;
    if (standard.bytes) this.store.usage('websocket', 'paper_account_received_bytes', standard.bytes);
    if (preprocessed.transactions) this.store.usage('preprocessed', 'transactions', preprocessed.transactions);
    if (preprocessed.bytes) this.store.usage('preprocessed_bytes', 'received_bytes', preprocessed.bytes);
    standard.bytes = 0; preprocessed.bytes = 0; preprocessed.transactions = 0;
  }
  async stop() {
    if (!this.stopped) {
      this.stopped = true; this.ready = false;
      const socket = this.standard.socket;
      this.drop(this.standard);
      try { socket?.terminate(); } catch { /* already closed */ }
      this.closePreprocessed();
      this.watches.clear();
      try { this.flushUsage(); } catch { /* store may already be closed */ }
    }
    await Promise.allSettled([...this.tasks]);
  }

  // ---- internals ----
  safe(name, ...args) {
    try { this.callbacks[name](...args); }
    catch { console.error(`PaperFeeds ${name} callback failed (details suppressed)`); }
  }
  subscriptionError(method, error) {
    this.safe('onSubscriptionError', { method, code: Number.isSafeInteger(error?.code) ? error.code : null });
  }
  markGap(reason) {
    this.ready = false;
    for (const watch of this.watches.values()) watch.covered = false;
    if (this.gapPending) return false;
    this.gapPending = true;
    this.safe('onGap', reason);
    return true;
  }
  checkReady() {
    if (this.stopped || this.ready) return;
    if (!this.standard.acked) return;
    if (this.curves().length && !this.preprocessed.conn) return;
    this.notifyCoverage();
    this.ready = true; this.gapPending = false;
    this.safe('onReady');
  }
  connect(link) {
    if (this.stopped || !this.started || link.socket || link.retry) return;
    const socket = (() => {
      try { return this.socketFactory(this.rpc.wsUrl, 'standard'); }
      catch { return null; }
    })();
    if (!socket) { this.markGap('standard_connect_failed'); this.schedule(link); return; }
    link.socket = socket; link.alive = true;
    socket.on('open', () => { if (link.socket === socket && !this.stopped) this.opened(link); });
    socket.on('message', (raw, isBinary) => {
      if (link.socket !== socket || this.stopped) return;
      const buffer = toBuffer(raw);
      link.bytes += buffer.length; link.alive = true;
      if (buffer.length > MAX_FRAME_BYTES) { this.fail(link, 'standard_oversized_frame'); return; }
      try { this.standardMessage(buffer, isBinary === true); }
      catch { this.fail(link, 'standard_malformed_message'); }
    });
    socket.on('error', () => { if (link.socket === socket) this.fail(link, 'standard_transport_error'); });
    socket.on('close', () => { if (link.socket === socket) this.fail(link, 'standard_disconnected'); });
    socket.on('pong', () => { if (link.socket === socket) link.alive = true; });
  }
  opened(link) {
    const socket = link.socket;
    const beat = () => {
      link.heartbeat = null;
      if (link.socket !== socket || this.stopped) return;
      if (!link.alive) { this.fail(link, 'standard_heartbeat_timeout'); return; }
      link.alive = false;
      try { socket.ping(); } catch { this.fail(link, 'standard_heartbeat_failed'); return; }
      if (link.socket === socket) link.heartbeat = this.setTimer(beat, HEARTBEAT_MS);
    };
    link.heartbeat = this.setTimer(beat, HEARTBEAT_MS);
    this.slotRequest = this.send(link, 'slotSubscribe', []);
    for (const watch of this.watches.values()) this.subscribe(watch);
    if (link.socket === socket) this.armAck(link);
  }
  send(link, method, params) {
    const id = ++this.sequence;
    try { link.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); return id; }
    catch { this.fail(link, 'standard_send_failed'); return null; }
  }
  pending(link) {
    return !link.acked || this.requests.size > 0;
  }
  // Fails a connection whose subscription is never acknowledged.
  armAck(link) {
    this.clearTimer(link.ackTimer); link.ackTimer = null;
    if (!link.socket) return;
    if (!this.pending(link)) { link.attempts = 0; return; }
    const socket = link.socket;
    link.ackTimer = this.setTimer(() => {
      link.ackTimer = null;
      if (link.socket === socket && this.pending(link)) this.fail(link, 'standard_ack_timeout');
    }, ACK_TIMEOUT_MS);
  }
  fail(link, reason) {
    const socket = link.socket;
    if (!socket) return;
    this.markGap(reason);
    this.drop(link);
    try { socket.terminate(); } catch { /* already closed */ }
  }
  // Forget all per-connection state; the socket itself is terminated by the caller.
  drop(link) {
    this.clearTimer(link.heartbeat); this.clearTimer(link.ackTimer); this.clearTimer(link.retry);
    link.heartbeat = null; link.ackTimer = null; link.retry = null;
    link.socket = null; link.acked = false; link.generation++;
    this.requests.clear(); this.subscriptions.clear();
    this.slotRequest = null; this.slotSubscription = null;
    // lastSlot resets so the baseline after resubscription is always delivered.
    for (const watch of this.watches.values()) {
      watch.baseline?.abort();
      watch.request = null; watch.subscription = null; watch.lastSlot = -1;
    }
    this.ready = false;
    if (!this.stopped) this.schedule(link);
  }
  schedule(link) {
    if (this.stopped || link.retry) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** link.attempts);
    link.attempts++;
    link.retry = this.setTimer(() => { link.retry = null; this.connect(link); }, delay);
  }
  subscribe(watch) {
    if (watch.request != null || watch.subscription != null) return;
    const id = this.send(this.standard, 'accountSubscribe', [watch.curve, { commitment: 'processed', encoding: 'base64' }]);
    if (id == null) return;
    watch.request = id; this.requests.set(id, watch);
    this.armAck(this.standard);
  }
  standardMessage(buffer, isBinary) {
    if (isBinary) throw new Error('Unexpected binary frame');
    const message = JSON.parse(buffer.toString());
    const link = this.standard;
    if (message.id != null) {
      if (message.id === this.slotRequest) {
        this.slotRequest = null;
        if (message.error || !Number.isSafeInteger(message.result)) {
          this.subscriptionError('slotSubscribe', message.error); this.fail(link, 'slot_subscribe_failed'); return;
        }
        this.slotSubscription = message.result; link.acked = true;
        this.armAck(link); this.checkReady();
        return;
      }
      const watch = this.requests.get(message.id);
      if (!watch) return;
      this.requests.delete(message.id);
      if (message.error || !Number.isSafeInteger(message.result)) {
        this.subscriptionError('accountSubscribe', message.error); this.fail(link, 'account_subscribe_failed'); return;
      }
      if (this.watches.get(watch.mint) !== watch || watch.request !== message.id) {
        this.send(link, 'accountUnsubscribe', [message.result]); // removed or replaced while the ack was in flight
        this.armAck(link);
        return;
      }
      watch.request = null; watch.subscription = message.result;
      this.subscriptions.set(message.result, watch);
      this.armAck(link);
      this.snapshot(watch);
      return;
    }
    if (message.method === 'slotNotification') {
      if (message.params?.subscription !== this.slotSubscription) return;
      const slot = message.params?.result?.slot;
      if (!Number.isSafeInteger(slot)) throw new Error('Malformed slot notification');
      this.safe('onSlot', slot);
      return;
    }
    if (message.method !== 'accountNotification') return;
    const watch = this.subscriptions.get(message.params?.subscription);
    if (!watch) return;
    const result = message.params.result;
    const slot = result?.context?.slot;
    if (!Number.isSafeInteger(slot) || result.value === undefined) throw new Error('Malformed account notification');
    watch.lastSlot = Math.max(watch.lastSlot, slot);
    this.safe('onAccount', watch.mint, slot, result.value);
  }
  // ---- preprocessed stream: one candidate-only filtered connection, replaced make-before-break ----
  scheduleSync() {
    if (!this.started || this.stopped || this.syncTimer) return;
    this.syncTimer = this.setTimer(() => { this.syncTimer = null; this.reconcile(); }, SYNC_DEBOUNCE_MS);
  }
  curves() { return [...new Set([...this.watches.values()].filter(watch => watch.preprocessed).map(watch => watch.curve))].sort(); }
  // Brings the preprocessed connection in line with the current watchlist.
  reconcile() {
    if (this.stopped || !this.started) return;
    const pre = this.preprocessed;
    this.clearTimer(this.syncTimer); this.syncTimer = null;
    const curves = this.curves(), key = curves.join(',');
    if (!curves.length) { this.closePreprocessed(); this.checkReady(); return; }
    if (pre.conn?.key === key) {
      this.notifyCoverage();
      if (pre.next) { const stale = pre.next; pre.next = null; this.closeConn(stale); }
      return;
    }
    if (pre.next?.key === key || pre.retry) return;
    if (pre.next) { const stale = pre.next; pre.next = null; this.closeConn(stale); }
    this.openConn(curves, key);
  }
  openConn(curves, key) {
    const pre = this.preprocessed;
    let socket = null;
    try { socket = this.socketFactory(this.preprocessedUrl, 'preprocessed'); } catch { socket = null; }
    if (!socket) { this.connFailed(null, 'preprocessed_connect_failed'); return; }
    const conn = { socket, key, curves, request: null, acked: false, alive: true, heartbeat: null, ackTimer: null };
    pre.next = conn;
    const live = () => !this.stopped && (pre.conn === conn || pre.next === conn);
    socket.on('open', () => {
      if (!live()) return;
      const beat = () => {
        conn.heartbeat = null;
        if (!live()) return;
        if (!conn.alive) { this.connFailed(conn, 'preprocessed_heartbeat_timeout'); return; }
        conn.alive = false;
        try { socket.ping(); } catch { this.connFailed(conn, 'preprocessed_heartbeat_failed'); return; }
        if (live()) conn.heartbeat = this.setTimer(beat, HEARTBEAT_MS);
      };
      conn.heartbeat = this.setTimer(beat, HEARTBEAT_MS);
      conn.request = ++this.sequence;
      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: conn.request, method: 'preprocessedSubscribe', params:
          // Helius documents params as an OBJECT here (not the usual JSON-RPC array); lists hold up to 5000 each.
          { accountInclude: curves, accountExclude: [], accountRequired: [PUMP] } }));
      } catch { this.connFailed(conn, 'preprocessed_send_failed'); return; }
      conn.ackTimer = this.setTimer(() => {
        conn.ackTimer = null;
        if (live() && !conn.acked) this.connFailed(conn, 'preprocessed_ack_timeout');
      }, ACK_TIMEOUT_MS);
    });
    socket.on('message', (raw, isBinary) => {
      if (!live()) return;
      const buffer = toBuffer(raw);
      // Every binary frame received is billed, including overlap duplicates and frames that are not delivered.
      pre.bytes += buffer.length; conn.alive = true;
      if (isBinary === true) pre.transactions++;
      if (buffer.length > MAX_FRAME_BYTES) { this.connFailed(conn, 'preprocessed_oversized_frame'); return; }
      try { this.preprocessedMessage(conn, buffer, isBinary === true); }
      catch { this.connFailed(conn, 'preprocessed_malformed_message'); }
    });
    socket.on('error', () => { if (live()) this.connFailed(conn, 'preprocessed_transport_error'); });
    socket.on('close', () => { if (live()) this.connFailed(conn, 'preprocessed_disconnected'); });
    socket.on('pong', () => { if (live()) conn.alive = true; });
  }
  preprocessedMessage(conn, buffer, isBinary) {
    const pre = this.preprocessed;
    if (isBinary) {
      if (pre.conn !== conn) return; // only the active connection delivers, so overlap never duplicates frames
      this.safe('onTransaction', buffer);
      return;
    }
    const message = JSON.parse(buffer.toString());
    if (message.error) {
      this.subscriptionError('preprocessedSubscribe', message.error);
      throw new Error('Preprocessed stream error');
    }
    if (message.id == null || message.id !== conn.request || conn.acked) return;
    if (typeof message.result !== 'number' && typeof message.result !== 'string') throw new Error('Malformed ack');
    conn.acked = true; pre.attempts = 0;
    this.clearTimer(conn.ackTimer); conn.ackTimer = null;
    // Make-before-break: the replacement takes over only now, then the old connection is closed silently.
    const old = pre.conn;
    pre.conn = conn; pre.next = null;
    this.closeConn(old);
    this.notifyCoverage();
    this.checkReady();
    if (this.curves().join(',') !== conn.key) this.scheduleSync(); // membership moved while connecting
  }
  closeConn(conn) {
    if (!conn) return;
    this.clearTimer(conn.heartbeat); this.clearTimer(conn.ackTimer);
    conn.heartbeat = null; conn.ackTimer = null;
    try { conn.socket.terminate(); } catch { /* already closed */ }
  }
  closePreprocessed() {
    const pre = this.preprocessed;
    const conns = [pre.conn, pre.next];
    for (const watch of this.watches.values()) watch.covered = false;
    pre.conn = null; pre.next = null;
    this.clearTimer(pre.retry); pre.retry = null; pre.attempts = 0;
    this.clearTimer(this.syncTimer); this.syncTimer = null;
    for (const conn of conns) this.closeConn(conn);
  }
  // A lost active (or never-live) connection is a gap; a failed replacement alongside a healthy one is not.
  connFailed(conn, reason) {
    const pre = this.preprocessed;
    const wasActive = conn != null && pre.conn === conn;
    if (wasActive) pre.conn = null;
    else if (conn != null && pre.next === conn) pre.next = null;
    this.closeConn(conn);
    const newGap = !pre.conn && this.markGap(reason);
    // Refresh quiet accounts once per announced gap, including a failed first subscription.
    // Repeated retry failures do not invalidate the recovered baselines again.
    if (newGap && this.standard.socket) {
      for (const watch of this.watches.values()) {
        if (watch.subscription != null) { watch.lastSlot = -1; this.snapshot(watch); }
      }
    }
    if (this.stopped || pre.retry || pre.next) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** pre.attempts);
    pre.attempts++;
    pre.retry = this.setTimer(() => { pre.retry = null; this.reconcile(); }, delay);
  }
  // One baseline fetch per account acknowledgment (never per notification).
  snapshot(watch) {
    watch.baseline?.abort();
    const controller = new AbortController(); watch.baseline = controller;
    const link = this.standard;
    const generation = link.generation, subscription = watch.subscription, seq = watch.seq = (watch.seq ?? 0) + 1;
    const current = () => !this.stopped && link.generation === generation && watch.seq === seq
      && this.watches.get(watch.mint) === watch && watch.subscription === subscription;
    const task = (async () => {
      try {
        const result = await this.rpc.accounts([watch.curve], {
          commitment: 'processed', deadlineMs: Date.now() + 5000, signal: controller.signal,
        });
        const slot = result?.context?.slot;
        if (!Number.isSafeInteger(slot) || !Array.isArray(result.value)) throw new Error('Malformed snapshot');
        if (!current() || slot <= watch.lastSlot) return; // stale generation, or a newer notification already won
        watch.lastSlot = slot;
        this.safe('onAccount', watch.mint, slot, result.value[0] ?? null);
      } catch {
        if (current() && !controller.signal.aborted) this.fail(link, 'snapshot_failed');
      } finally {
        if (watch.baseline === controller) watch.baseline = null;
      }
    })();
    this.tasks.add(task);
    task.finally(() => this.tasks.delete(task));
  }
}
