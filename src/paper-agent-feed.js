import WebSocket from 'ws';
import { MAYHEM } from './config.js';
import { FeedHealth, STABLE_CONNECTION_MS } from './feed-health.js';

const MAX_FRAME_BYTES = 1024 * 1024;
const ACK_TIMEOUT_MS = 15000;
const HEARTBEAT_MS = 10000;
const validSubscription = id => Number.isSafeInteger(id) && id >= 0;
const noop = () => {};
const bufferOf = raw => Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw)
  : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.from(String(raw));

export const agentParams = curves => [
  { accountRequired: [MAYHEM], accountInclude: curves, vote: false, failed: false },
  { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 1 },
];

// Helius wraps the RPC-style transaction and metadata inside result.transaction.
export function agentTransaction(result) {
  const nested = result?.transaction;
  const meta = result?.meta ?? nested?.meta;
  const transaction = result?.meta ? nested : nested?.transaction;
  if (typeof result?.signature !== 'string' || !result.signature.length || result.signature.length > 128
    || !Number.isSafeInteger(result.slot) || result.slot < 0 || !meta || !Object.hasOwn(meta, 'err')
    || !Array.isArray(meta.logMessages) || !transaction || typeof transaction !== 'object'
    || Array.isArray(transaction) || !transaction.message) throw new Error('Malformed agent transaction');
  return { signature: result.signature, slot: result.slot, meta, transaction };
}

// Only the acknowledged active subscription delivers. A replacement is silent until takeover;
// socket identity plus monotonically increasing request IDs fence all obsolete callbacks.
export class PaperAgentFeed {
  constructor(store, rpc, {
    socketFactory = url => new WebSocket(url, { handshakeTimeout: 10000, maxPayload: MAX_FRAME_BYTES }),
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
    onTransaction = noop, onCoverage = noop, onGap = noop, onSubscriptionError = noop,
  } = {}) {
    Object.assign(this, { store, rpc, socketFactory, setTimer, clearTimer, now });
    this.callbacks = { onTransaction, onCoverage, onGap, onSubscriptionError };
    this.health = new FeedHealth(store, 'agent', now);
    this.conn = null; this.next = null; this.retry = null;
    this.curves = []; this.sequence = 0; this.attempts = 0;
    this.bytes = 0; this.transactions = 0; this.stopped = false;
  }
  safe(name, ...args) {
    try { this.callbacks[name](...args); }
    catch { this.health.failure('callback_failed'); }
  }
  covers(curve) { return this.conn?.curveSet.has(curve) ?? false; }
  setCurves(curves) {
    if (this.stopped) return;
    this.curves = [...new Set(curves)].sort();
    this.reconcile();
  }
  reconcile() {
    if (this.stopped) return;
    const key = this.curves.join(',');
    if (!key) { this.reset(); return; }
    // An immutable in-flight filter must get a chance to acknowledge. Continually
    // replacing it on discovery/rotation can otherwise prevent any coverage forever.
    // Its acknowledgment reconciles once more against the latest desired curves.
    if (this.next || this.retry != null) return;
    if (this.conn?.key === key) { this.safe('onCoverage'); return; }
    this.open([...this.curves], key);
  }
  open(curves, key) {
    const health = this.health;
    health.update({ phase: this.conn ? 'subscribed' : 'connecting', attempts: health.value.attempts + 1, nextRetryAt: null });
    let socket;
    try { socket = this.socketFactory(this.rpc.wsUrl, 'agent'); }
    catch (error) { this.failed(null, 'connect_failed', error); return; }
    const conn = { socket, curves, curveSet: new Set(curves), key, request: null, subscription: null, heartbeat: null, ackTimer: null, stableTimer: null, alive: true };
    this.next = conn;
    const live = () => !this.stopped && (this.conn === conn || this.next === conn);
    socket.on('open', () => {
      if (!live() || conn.request != null) return;
      health.update({ phase: this.conn ? 'subscribed' : 'subscribing' });
      conn.request = ++this.sequence;
      try { socket.send(JSON.stringify({ jsonrpc: '2.0', id: conn.request, method: 'transactionSubscribe', params: agentParams(curves) })); }
      catch { this.failed(conn, 'send_failed'); return; }
      const beat = () => {
        if (!live()) return;
        conn.heartbeat = null;
        if (!conn.alive) { this.failed(conn, 'heartbeat_timeout'); return; }
        conn.alive = false;
        try { socket.ping(); } catch { this.failed(conn, 'heartbeat_failed'); return; }
        if (live()) conn.heartbeat = this.setTimer(beat, HEARTBEAT_MS);
      };
      conn.heartbeat = this.setTimer(beat, HEARTBEAT_MS);
      conn.ackTimer = this.setTimer(() => {
        if (live() && conn.subscription == null) this.failed(conn, 'ack_timeout');
      }, ACK_TIMEOUT_MS);
    });
    socket.on('message', (raw, binary) => {
      if (!live()) return;
      const buffer = bufferOf(raw);
      this.bytes += buffer.length; conn.alive = true;
      health.update({ lastPayloadAt: this.now() }, false);
      if (buffer.length > MAX_FRAME_BYTES) { this.failed(conn, 'oversized_frame'); return; }
      try {
        if (binary === true) throw new Error('Unexpected binary frame');
        this.message(conn, JSON.parse(buffer.toString()));
      } catch { this.failed(conn, 'malformed_message'); }
    });
    socket.on('pong', () => { if (live()) conn.alive = true; });
    socket.on('error', error => { if (live()) this.failed(conn, 'transport_error', error); });
    socket.on('close', code => { if (live()) this.failed(conn, 'disconnected', { wsCode: code }); });
    socket.on('unexpected-response', (_request, response) => {
      if (live()) this.failed(conn, 'http_rejected', { httpStatus: response?.statusCode });
    });
  }
  message(conn, message) {
    if (message.id != null) {
      if (message.id !== conn.request || conn.subscription != null) return;
      if (message.error || !validSubscription(message.result)) {
        this.safe('onSubscriptionError', { method: 'transactionSubscribe', code: Number.isSafeInteger(message.error?.code) ? message.error.code : null });
        this.failed(conn, 'subscribe_failed', { subscriptionCode: message.error?.code }); return;
      }
      conn.subscription = message.result;
      this.clearTimer(conn.ackTimer); conn.ackTimer = null;
      this.clearTimer(this.retry); this.retry = null;
      // Replacement failures share this counter; reset only if nothing failed while this connection was up.
      const attempts = this.attempts;
      conn.stableTimer = this.setTimer(() => {
        conn.stableTimer = null; if (this.conn === conn && !this.stopped && this.attempts === attempts) this.attempts = 0;
      }, STABLE_CONNECTION_MS);
      const old = this.conn;
      this.conn = conn; this.next = null;
      this.close(old);
      this.health.update({ phase: 'subscribed', lastAckAt: this.now(), failureStreak: 0, nextRetryAt: null });
      this.safe('onCoverage');
      this.reconcile();
      return;
    }
    if (message.method !== 'transactionNotification') return;
    this.transactions++; // Received transaction frames include overlap; not an inferred billing charge.
    if (this.conn !== conn || conn.subscription == null || message.params?.subscription !== conn.subscription) return;
    const tx = agentTransaction(message.params.result);
    if (tx.meta.err !== null) return;
    this.health.update({ lastProgressAt: this.now() }, false);
    this.safe('onTransaction', tx);
  }
  failed(conn, category, error) {
    this.health.failure(category, error);
    if (this.conn === conn) this.conn = null;
    if (this.next === conn) this.next = null;
    this.close(conn);
    this.health.update({ phase: this.conn ? 'subscribed' : this.next ? 'subscribing' : 'backoff' });
    if (!this.conn) this.safe('onGap', `agent_${category}`);
    if (this.stopped || this.retry != null || this.next || !this.curves.length) return;
    const delay = Math.min(15000, 1000 * 2 ** Math.min(this.attempts++, 16));
    this.health.update({ phase: this.conn ? 'subscribed' : 'backoff', nextRetryAt: this.now() + delay });
    const timer = this.setTimer(() => {
      if (this.retry !== timer || this.stopped) return;
      this.retry = null; this.reconcile();
    }, delay);
    this.retry = timer;
  }
  close(conn) {
    if (!conn) return;
    this.clearTimer(conn.heartbeat); this.clearTimer(conn.ackTimer); this.clearTimer(conn.stableTimer);
    conn.heartbeat = null; conn.ackTimer = null; conn.stableTimer = null;
    if (conn.subscription != null && conn.socket.readyState === WebSocket.OPEN) {
      try { conn.socket.send(JSON.stringify({ jsonrpc: '2.0', id: ++this.sequence, method: 'transactionUnsubscribe', params: [conn.subscription] })); }
      catch { /* The socket is terminated below regardless. */ }
    }
    try { conn.socket.terminate(); } catch { /* already closed */ }
  }
  reset() {
    const old = [this.conn, this.next];
    this.conn = null; this.next = null;
    this.clearTimer(this.retry); this.retry = null; this.attempts = 0;
    for (const conn of old) this.close(conn);
    this.health.update({ phase: this.stopped ? 'stopped' : 'idle', nextRetryAt: null });
  }
  flushHealth(coverage) { this.health.update(coverage); }
  flushUsage() {
    if (this.bytes) this.store.usage('websocket', 'paper_agent_received_bytes', this.bytes);
    if (this.transactions) this.store.usage('paper_agent', 'transactions', this.transactions);
    this.bytes = 0; this.transactions = 0;
  }
  stop() { this.stopped = true; this.reset(); this.health.stop(); }
}
