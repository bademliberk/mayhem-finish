import WebSocket from 'ws';
import { MINT_AUTHORITY, MAYHEM } from './config.js';
import { decodeLogs, recoverableCreations } from './chain.js';
import { nowSeconds } from './collector.js';

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
  constructor(store, rpc, onReady = () => {}) {
    this.store = store; this.rpc = rpc; this.onReady = onReady;
    this.stopped = false; this.gap = null; this.subscriptions = new Set();
    this.receivedBytes = 0;
  }
  start() {
    this.gap ??= this.store.coverage('websocket_gap', nowSeconds(), 'Awaiting creation discovery subscription');
    const socket = this.socket = new WebSocket(this.rpc.wsUrl, { handshakeTimeout: 20000 });
    this.subscriptions.clear();
    socket.on('open', () => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionSubscribe', params: discoveryParams() }));
    });
    socket.on('message', raw => {
      this.receivedBytes += raw.length;
      try {
        const message = JSON.parse(raw.toString());
        if (message.error) { console.error(`WebSocket subscription error code ${message.error.code}`); socket.close(); return; }
        if (message.id && typeof message.result === 'number') {
          this.subscriptions.add(message.id);
          if (this.subscriptions.size === 1) {
            this.store.run('UPDATE coverage SET ended_at=? WHERE id=?', nowSeconds(), this.gap);
            this.gap = null;
            this.onReady();
          }
          return;
        }
        if (message.method !== 'transactionNotification') return;
        const notification = message.params?.result;
        try {
          const events = discoveryEvents(notification);
          if (events.length) this.store.apply(notification.signature, notification.slot, events);
        } catch {
          const partial = discoveryRecovery(notification);
          if (partial.length) {
            this.store.quarantinePartial(notification.signature, notification.slot, nowSeconds(), partial);
            return;
          }
          if (typeof notification?.signature !== 'string' || !Number.isSafeInteger(notification.slot)) throw new Error('Missing discovery identity');
          this.store.enqueue(notification.signature, notification.slot, nowSeconds());
        }
      } catch {
        console.error('WebSocket message processing failed; reconnecting for backfill');
        socket.close();
      }
    });
    socket.on('error', () => { console.error('WebSocket transport error (credentials suppressed)'); socket.terminate(); });
    socket.on('close', () => {
      clearInterval(this.heartbeat);
      if (!this.stopped) {
        this.gap ??= this.store.coverage('websocket_gap', nowSeconds(), 'Disconnected; backfill required');
        this.timer = setTimeout(() => this.start(), 3000);
      }
    });
    let alive = true;
    socket.on('pong', () => { alive = true; });
    this.heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!alive) { socket.terminate(); return; }
      alive = false; socket.ping();
    }, 15000);
  }
  flushUsage() {
    if (this.receivedBytes) this.store.usage('websocket', 'received_bytes', this.receivedBytes);
    this.receivedBytes = 0;
  }
  stop() {
    this.flushUsage();
    this.stopped = true; clearTimeout(this.timer); clearInterval(this.heartbeat);
    this.socket?.terminate();
  }
}
