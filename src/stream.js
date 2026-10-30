import WebSocket from 'ws';
import { MINT_AUTHORITY, MAYHEM } from './config.js';
import { decodeLogs, recoverableCreations } from './chain.js';
import { FeedHealth, safeFailure } from './feed-health.js';

const ACK_TIMEOUT_MS = 15000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;
const MAX_FRAME_BYTES = 1024 * 1024;
const validSubscription = id => Number.isSafeInteger(id) && id >= 0;

export const discoveryParams = () => [
  { accountRequired: [MAYHEM, MINT_AUTHORITY], vote: false, failed: false },
  { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 1 },
];

export function discoveryEvents(result) {
  if (!result || typeof result.signature !== 'string' || !Number.isSafeInteger(result.slot)) {
    throw new Error('Malformed discovery notification');
  }
  const meta = result.transaction?.meta;
  if (!meta || !Array.isArray(meta.logMessages)) throw new Error('Missing discovery logs');
  if (meta.err !== null) return [];
  if (meta.logMessages.some(line => line.includes('Log truncated'))) throw new Error('Truncated discovery logs');
  const events = decodeLogs(meta.logMessages).map(event => ({ ...event, slot: result.slot }));
  // Address filters narrow discovery, but the event flag is still authoritative.
  return events.some(event => event.type === 'create') ? events : [];
}

// Separate from discoveryEvents (which still throws on truncation): proven creations
// that precede the first truncation marker. Empty when nothing is provable.
export function discoveryRecovery(result) {
  if (!result || typeof result.signature !== 'string' || !Number.isSafeInteger(result.slot)) return [];
  return recoverableCreations({ slot: result.slot, meta: result.transaction?.meta });
}

export class Stream {
  // Keep the original callback API; optional dependencies make clocks and sockets deterministic in tests.
  constructor(store, rpc, onReady = () => {}, {
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    socketFactory = url => new WebSocket(url, { handshakeTimeout: 20000, maxPayload: MAX_FRAME_BYTES }),
    log = console.error,
  } = {}) {
    this.store = store; this.rpc = rpc; this.onReady = onReady;
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer; this.socketFactory = socketFactory; this.log = log;
    this.stopped = false; this.gap = null; this.subscriptions = new Set();
    this.receivedBytes = 0; this.sequence = 0; this.failures = 0;
    this.socket = null; this.timer = null; this.heartbeat = null; this.ackTimer = null;
    this.health = new FeedHealth(store, 'discovery', now);
  }
  seconds() { return Math.floor(this.now() / 1000); }
  ensureGap() {
    this.gap ??= this.store.coverage('websocket_gap', this.seconds(), 'Discovery unavailable; backfill required');
  }
  start() {
    if (this.stopped || this.socket || this.timer) return;
    // Adopt the outstanding transport row on the first attempt; Recovery owns its eventual completion.
    if (!this.sequence) this.gap = this.store.get?.("SELECT id FROM coverage WHERE kind='websocket_gap' AND ended_at IS NULL ORDER BY started_at,id LIMIT 1")?.id ?? null;
    this.ensureGap();
    const request = ++this.sequence;
    this.health.update({ phase: 'connecting', attempts: request, nextRetryAt: null });
    let socket;
    try { socket = this.socketFactory(this.rpc.wsUrl); }
    catch (error) { this.failed(null, 'connect_failed', error); return; }
    this.socket = socket; this.subscriptions.clear();
    let ready = false, opened = false, alive = true;
    const current = () => !this.stopped && this.socket === socket;
    // Also bound a factory/socket that never emits open or error.
    this.ackTimer = this.setTimer(() => { if (current()) this.failed(socket, 'ack_timeout'); }, 20000 + ACK_TIMEOUT_MS);
    socket.on('open', () => {
      if (!current() || opened) return;
      opened = true;
      this.health.update({ phase: 'subscribing' });
      this.clearTimer(this.ackTimer);
      this.ackTimer = this.setTimer(() => { if (current() && !ready) this.failed(socket, 'ack_timeout'); }, ACK_TIMEOUT_MS);
      try { socket.send(JSON.stringify({ jsonrpc: '2.0', id: request, method: 'transactionSubscribe', params: discoveryParams() })); }
      catch (error) { this.failed(socket, 'send_failed', error); return; }
      const beat = () => {
        if (!current()) return;
        this.heartbeat = null;
        if (!alive) { this.failed(socket, 'heartbeat_timeout'); return; }
        alive = false;
        try { socket.ping(); } catch (error) { this.failed(socket, 'heartbeat_failed', error); return; }
        if (current()) this.heartbeat = this.setTimer(beat, 15000);
      };
      if (current()) this.heartbeat = this.setTimer(beat, 15000);
    });
    socket.on('message', raw => {
      if (!current()) return;
      this.receivedBytes += raw.length;
      this.health.update({ lastPayloadAt: this.now() }, false);
      if (raw.length > MAX_FRAME_BYTES) { this.failed(socket, 'oversized_frame'); return; }
      try {
        const message = JSON.parse(raw.toString());
        if (message.id != null) {
          if (!opened || message.id !== request || ready) return;
          if (message.error || !validSubscription(message.result)) {
            this.failed(socket, 'subscribe_failed', { subscriptionCode: message.error?.code }); return;
          }
          ready = true; this.failures = 0;
          this.subscriptions.add(message.result);
          this.clearTimer(this.ackTimer); this.ackTimer = null;
          this.health.update({ phase: 'subscribed', lastAckAt: this.now(), failureStreak: 0, nextRetryAt: null });
          // An ack proves a live subscription, not completed historical backfill.
          this.gap = null;
          try { this.onReady(); } catch { this.failed(socket, 'callback_failed'); }
          return;
        }
        if (!ready || message.method !== 'transactionNotification') return;
        // Some existing provider fixtures omit subscription; reject explicitly foreign identities.
        if (message.params?.subscription != null && !this.subscriptions.has(message.params.subscription)) return;
        const notification = message.params?.result;
        try {
          const events = discoveryEvents(notification);
          if (events.length) this.store.apply(notification.signature, notification.slot, events);
        } catch {
          const partial = discoveryRecovery(notification);
          if (partial.length) {
            this.store.quarantinePartial(notification.signature, notification.slot, this.seconds(), partial);
            this.health.update({ lastProgressAt: this.now() }, false);
            return;
          }
          if (typeof notification?.signature !== 'string' || !Number.isSafeInteger(notification.slot)) throw new Error('Missing discovery identity');
          this.store.enqueue(notification.signature, notification.slot, this.seconds());
        }
        this.health.update({ lastProgressAt: this.now() }, false);
      } catch { this.failed(socket, 'malformed_message'); }
    });
    socket.on('error', error => { if (current()) this.failed(socket, 'transport_error', error); });
    socket.on('unexpected-response', (_request, response) => {
      if (current()) this.failed(socket, 'http_rejected', { httpStatus: response?.statusCode });
    });
    socket.on('close', code => { if (current()) this.failed(socket, 'disconnected', { wsCode: code }); });
    socket.on('pong', () => { if (current()) alive = true; });
  }
  failed(socket, category, error) {
    if (this.stopped || this.socket !== socket || this.timer) return;
    this.socket = null; this.subscriptions.clear();
    this.clearTimer(this.heartbeat); this.clearTimer(this.ackTimer);
    this.heartbeat = null; this.ackTimer = null;
    this.ensureGap();
    this.health.failure(category, error);
    this.log(JSON.stringify({ event: 'discovery_failure', ...safeFailure(category, error, this.now()) }));
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(this.failures++, 16));
    this.health.update({ phase: 'backoff', nextRetryAt: this.now() + delay });
    this.timer = this.setTimer(() => { this.timer = null; this.start(); }, delay);
    try { socket?.terminate(); } catch { /* identity invalidated before close/error */ }
  }
  flushHealth() { this.health.flush(); }
  flushUsage() {
    if (this.receivedBytes) this.store.usage('websocket', 'received_bytes', this.receivedBytes);
    this.receivedBytes = 0;
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer(this.timer); this.clearTimer(this.heartbeat); this.clearTimer(this.ackTimer);
    this.timer = null; this.heartbeat = null; this.ackTimer = null;
    const socket = this.socket; this.socket = null; this.subscriptions.clear();
    try { socket?.terminate(); } catch { /* already closed */ }
    this.health.stop(); this.flushUsage();
  }
}
