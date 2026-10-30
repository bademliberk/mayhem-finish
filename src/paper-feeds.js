import WebSocket from 'ws';
import { PUMP } from './config.js';
import { FeedHealth, SLOT_PROGRESS_MS } from './feed-health.js';

const validSubscription = id => Number.isSafeInteger(id) && id >= 0;
const failureCategory = reason => reason.replace(/^(standard_|preprocessed_)/, '').replace(/^(slot_|account_)subscribe_failed$/, 'subscribe_failed');

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
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
  } = {}) {
    this.store = store; this.rpc = rpc;
    this.callbacks = { onAccount, onTransaction, onGap, onReady, onSlot, onCoverage, onSubscriptionError };
    this.socketFactory = socketFactory; this.setTimer = setTimer; this.clearTimer = clearTimer; this.now = now;
    this.health = { standard: new FeedHealth(store, 'standard', now), preprocessed: new FeedHealth(store, 'preprocessed', now) };
    this.ackDeadlines = new Map(); this.slotWatchdog = null; this.lastSlot = -1;
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
    this.cancelBaseline(watch);
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
  flushHealth() {
    this.health.standard.update({ pendingAcks: this.ackDeadlines.size });
    this.health.preprocessed.update({ pending: [...this.watches.values()].filter(w => w.preprocessed && !this.covers(w.mint)).length });
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
      this.health.standard.stop(); this.health.preprocessed.stop();
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
    const health = this.health.standard;
    health.update({ phase: 'connecting', attempts: health.value.attempts + 1, nextRetryAt: null });
    const socket = (() => {
      try { return this.socketFactory(this.rpc.wsUrl, 'standard'); }
      catch (error) { health.failure('connect_failed', error); return null; }
    })();
    if (!socket) { this.markGap('standard_connect_failed'); this.schedule(link); return; }
    link.socket = socket; link.alive = true;
    socket.on('open', () => { if (link.socket === socket && !this.stopped) this.opened(link); });
    socket.on('message', (raw, isBinary) => {
      if (link.socket !== socket || this.stopped) return;
      const buffer = toBuffer(raw);
      link.bytes += buffer.length; link.alive = true;
      health.update({ lastPayloadAt: this.now() }, false);
      if (buffer.length > MAX_FRAME_BYTES) { this.fail(link, 'standard_oversized_frame'); return; }
      try { this.standardMessage(buffer, isBinary === true); }
      catch { this.fail(link, 'standard_malformed_message'); }
    });
    socket.on('error', error => { if (link.socket === socket) this.fail(link, 'standard_transport_error', error); });
    socket.on('close', code => { if (link.socket === socket) this.fail(link, 'standard_disconnected', { wsCode: code }); });
    socket.on('unexpected-response', (_request, response) => {
      if (link.socket === socket) this.fail(link, 'standard_http_rejected', { httpStatus: response?.statusCode });
    });
    socket.on('pong', () => { if (link.socket === socket) link.alive = true; });
  }
  opened(link) {
    if (this.slotRequest != null || link.acked) return;
    const socket = link.socket;
    this.health.standard.update({ phase: 'subscribing' });
    const beat = () => {
      if (link.socket !== socket || this.stopped) return;
      link.heartbeat = null;
      if (!link.alive) { this.fail(link, 'standard_heartbeat_timeout'); return; }
      link.alive = false;
      try { socket.ping(); } catch { this.fail(link, 'standard_heartbeat_failed'); return; }
      if (link.socket === socket) link.heartbeat = this.setTimer(beat, HEARTBEAT_MS);
    };
    link.heartbeat = this.setTimer(beat, HEARTBEAT_MS);
    this.slotRequest = this.send(link, 'slotSubscribe', []);
    if (link.socket !== socket) return;
    this.ackDeadlines.set(this.slotRequest, this.now() + ACK_TIMEOUT_MS);
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
  // Request deadlines never slide when another account is added, removed or acknowledged.
  armAck(link) {
    this.clearTimer(link.ackTimer); link.ackTimer = null;
    if (!link.socket) return;
    this.health.standard.update({ pendingAcks: this.ackDeadlines.size });
    if (!this.pending(link)) {
      link.attempts = 0; this.health.standard.update({ failureStreak: 0 }); return;
    }
    if (!this.ackDeadlines.size) return;
    const socket = link.socket;
    const deadline = Math.min(...this.ackDeadlines.values());
    const timer = this.setTimer(() => {
      if (link.ackTimer !== timer || link.socket !== socket || this.stopped) return;
      link.ackTimer = null;
      if ([...this.ackDeadlines.values()].some(at => at <= this.now())) this.fail(link, 'standard_ack_timeout');
    }, Math.max(0, deadline - this.now()));
    link.ackTimer = timer;
  }
  armSlotWatchdog() {
    this.clearTimer(this.slotWatchdog);
    const socket = this.standard.socket;
    const timer = this.setTimer(() => {
      if (this.slotWatchdog !== timer || this.standard.socket !== socket || this.stopped) return;
      this.slotWatchdog = null;
      this.fail(this.standard, 'standard_slot_progress_timeout');
    }, SLOT_PROGRESS_MS);
    this.slotWatchdog = timer;
  }
  fail(link, reason, error) {
    const socket = link.socket;
    if (!socket) return;
    this.health.standard.failure(failureCategory(reason), error);
    this.markGap(reason);
    this.drop(link);
    try { socket.terminate(); } catch { /* already closed */ }
  }
  // Forget all per-connection state; the socket itself is terminated by the caller.
  drop(link) {
    this.clearTimer(link.heartbeat); this.clearTimer(link.ackTimer); this.clearTimer(link.retry);
    link.heartbeat = null; link.ackTimer = null; link.retry = null;
    link.socket = null; link.acked = false; link.generation++;
    this.requests.clear(); this.subscriptions.clear(); this.ackDeadlines.clear();
    this.clearTimer(this.slotWatchdog); this.slotWatchdog = null; this.lastSlot = -1;
    this.health.standard.update({ pendingProgress: 1, pendingAcks: 0 });
    this.slotRequest = null; this.slotSubscription = null;
    // lastSlot resets so the baseline after resubscription is always delivered.
    for (const watch of this.watches.values()) {
      this.cancelBaseline(watch);
      watch.request = null; watch.subscription = null; watch.lastSlot = -1;
    }
    this.ready = false;
    if (!this.stopped) this.schedule(link);
  }
  schedule(link) {
    if (this.stopped || link.retry) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(link.attempts, 16));
    link.attempts++;
    this.health.standard.update({ phase: 'backoff', nextRetryAt: this.now() + delay });
    link.retry = this.setTimer(() => { link.retry = null; this.connect(link); }, delay);
  }
  subscribe(watch) {
    if (watch.request != null || watch.subscription != null) return;
    const id = this.send(this.standard, 'accountSubscribe', [watch.curve, { commitment: 'processed', encoding: 'base64' }]);
    if (id == null) return;
    watch.request = id; this.requests.set(id, watch);
    this.ackDeadlines.set(id, this.now() + ACK_TIMEOUT_MS);
    this.armAck(this.standard);
  }
  standardMessage(buffer, isBinary) {
    if (isBinary) throw new Error('Unexpected binary frame');
    const message = JSON.parse(buffer.toString());
    const link = this.standard;
    if (message.id != null) {
      if (message.id === this.slotRequest) {
        this.slotRequest = null; this.ackDeadlines.delete(message.id);
        if (message.error || !validSubscription(message.result)) {
          this.subscriptionError('slotSubscribe', message.error); this.fail(link, 'slot_subscribe_failed', { subscriptionCode: message.error?.code }); return;
        }
        this.slotSubscription = message.result; link.acked = true;
        this.health.standard.update({ phase: 'subscribed', lastAckAt: this.now(), pendingProgress: 1 });
        this.armSlotWatchdog();
        this.armAck(link); this.checkReady();
        return;
      }
      const watch = this.requests.get(message.id);
      if (!watch) return;
      this.requests.delete(message.id); this.ackDeadlines.delete(message.id);
      if (message.error || !validSubscription(message.result)) {
        this.subscriptionError('accountSubscribe', message.error); this.fail(link, 'account_subscribe_failed', { subscriptionCode: message.error?.code }); return;
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
      if (this.slotSubscription == null || message.params?.subscription !== this.slotSubscription) return;
      const slot = message.params?.result?.slot;
      if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('Malformed slot notification');
      if (slot > this.lastSlot) {
        this.lastSlot = slot;
        this.health.standard.update({ lastProgressAt: this.now(), lastSlot: slot, pendingProgress: 0 }, false);
        this.armSlotWatchdog();
      }
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
    // A live valid notification is a full account state: it satisfies the baseline and ends any request or retry.
    this.cancelBaseline(watch);
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
    const health = this.health.preprocessed;
    health.update({ phase: pre.conn ? 'subscribed' : 'connecting', attempts: health.value.attempts + 1, nextRetryAt: null });
    try { socket = this.socketFactory(this.preprocessedUrl, 'preprocessed'); }
    catch (error) { this.connFailed(null, 'preprocessed_connect_failed', error); return; }
    const conn = { socket, key, curves, request: null, acked: false, alive: true, heartbeat: null, ackTimer: null };
    pre.next = conn;
    const live = () => !this.stopped && (pre.conn === conn || pre.next === conn);
    socket.on('open', () => {
      if (!live() || conn.request != null) return;
      health.update({ phase: pre.conn ? 'subscribed' : 'subscribing' });
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
      health.update({ lastPayloadAt: this.now() }, false);
      if (isBinary === true) pre.transactions++;
      if (buffer.length > MAX_FRAME_BYTES) { this.connFailed(conn, 'preprocessed_oversized_frame'); return; }
      try { this.preprocessedMessage(conn, buffer, isBinary === true); }
      catch { this.connFailed(conn, 'preprocessed_malformed_message'); }
    });
    socket.on('error', error => { if (live()) this.connFailed(conn, 'preprocessed_transport_error', error); });
    socket.on('close', code => { if (live()) this.connFailed(conn, 'preprocessed_disconnected', { wsCode: code }); });
    socket.on('unexpected-response', (_request, response) => {
      if (live()) this.connFailed(conn, 'preprocessed_http_rejected', { httpStatus: response?.statusCode });
    });
    socket.on('pong', () => { if (live()) conn.alive = true; });
  }
  preprocessedMessage(conn, buffer, isBinary) {
    const pre = this.preprocessed;
    if (isBinary) {
      if (pre.conn !== conn) return; // only the active connection delivers, so overlap never duplicates frames
      this.health.preprocessed.update({ lastProgressAt: this.now() }, false);
      this.safe('onTransaction', buffer);
      return;
    }
    const message = JSON.parse(buffer.toString());
    if (message.error) {
      this.subscriptionError('preprocessedSubscribe', message.error);
      this.connFailed(conn, 'preprocessed_malformed_message', { subscriptionCode: message.error?.code });
      return;
    }
    if (message.id == null || message.id !== conn.request || conn.acked) return;
    if (!validSubscription(message.result) && !(typeof message.result === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(message.result))) throw new Error('Malformed ack');
    conn.acked = true; pre.attempts = 0;
    this.health.preprocessed.update({ phase: 'subscribed', lastAckAt: this.now(), failureStreak: 0, nextRetryAt: null });
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
    this.health.preprocessed.update({ phase: this.stopped ? 'stopped' : 'idle', nextRetryAt: null });
  }
  // A lost active (or never-live) connection is a gap; a failed replacement alongside a healthy one is not.
  connFailed(conn, reason, error) {
    const pre = this.preprocessed;
    this.health.preprocessed.failure(failureCategory(reason), error);
    const wasActive = conn != null && pre.conn === conn;
    if (wasActive) pre.conn = null;
    else if (conn != null && pre.next === conn) pre.next = null;
    this.closeConn(conn);
    this.health.preprocessed.update({ phase: pre.conn ? 'subscribed' : pre.next ? 'subscribing' : 'backoff' });
    const newGap = !pre.conn && this.markGap(reason);
    // Refresh quiet accounts once per announced gap, including a failed first subscription.
    // Repeated retry failures do not invalidate the recovered baselines again.
    if (newGap && this.standard.socket) {
      for (const watch of this.watches.values()) {
        if (watch.subscription != null) { watch.lastSlot = -1; this.snapshot(watch); }
      }
    }
    if (this.stopped || pre.retry || pre.next) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(pre.attempts, 16));
    pre.attempts++;
    this.health.preprocessed.update({ phase: pre.conn ? 'subscribed' : 'backoff', nextRetryAt: this.now() + delay });
    pre.retry = this.setTimer(() => { pre.retry = null; this.reconcile(); }, delay);
  }
  // Aborts the in-flight baseline request and its retry timer and invalidates any late result.
  cancelBaseline(watch) {
    watch.baseline?.abort(); watch.baseline = null;
    if (watch.baselineRetry != null) this.clearTimer(watch.baselineRetry);
    watch.baselineRetry = null; watch.attempts = 0; watch.seq = (watch.seq ?? 0) + 1;
  }
  // Sanitized counters only (no error text, no URLs).
  baselineUsage(method) {
    try { this.store.usage('paper_baseline', method); } catch { /* store may already be closed */ }
  }
  // One baseline fetch per account acknowledgment (never per notification). A failed fetch retries this watch alone
  // with bounded backoff, at most one request or retry timer at a time; it never drops the healthy socket.
  snapshot(watch, attempts = 0) {
    this.cancelBaseline(watch);
    watch.attempts = attempts;
    const controller = new AbortController(); watch.baseline = controller;
    const link = this.standard;
    const generation = link.generation, subscription = watch.subscription, seq = watch.seq;
    const current = () => !this.stopped && link.generation === generation && watch.seq === seq
      && this.watches.get(watch.mint) === watch && watch.subscription === subscription;
    const task = (async () => {
      try {
        const result = await this.rpc.accounts([watch.curve], {
          commitment: 'processed', deadlineMs: this.now() + 5000, signal: controller.signal,
        });
        const slot = result?.context?.slot;
        if (!Number.isSafeInteger(slot) || !Array.isArray(result.value)) throw new Error('Malformed snapshot');
        if (!current() || controller.signal.aborted) return; // stale generation, or cancelled by a newer state
        if (slot > watch.lastSlot) {
          watch.lastSlot = slot;
          this.safe('onAccount', watch.mint, slot, result.value[0] ?? null);
        }
        watch.attempts = 0;
      } catch {
        if (!current() || controller.signal.aborted) return;
        this.baselineUsage('failed');
        const retries = watch.attempts;
        const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** retries);
        const timer = this.setTimer(() => {
          if (watch.baselineRetry !== timer) return; // superseded or cancelled
          watch.baselineRetry = null;
          if (current()) this.snapshot(watch, retries + 1);
        }, delay);
        watch.baselineRetry = timer;
      } finally {
        if (watch.baseline === controller) watch.baseline = null;
      }
    })();
    this.tasks.add(task);
    task.finally(() => this.tasks.delete(task));
  }
}
