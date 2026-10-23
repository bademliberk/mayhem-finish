import WebSocket from 'ws';
import { decodeCurve } from './chain.js';
import { Observations } from './observations.js';

export class CandidateTracker {
  constructor(store, rpc, { socketFactory = url => new WebSocket(url, { handshakeTimeout: 10000 }),
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.store = store; this.rpc = rpc; this.observations = new Observations(store);
    this.socketFactory = socketFactory; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.windows = new Map(); this.requests = new Map(); this.subscriptions = new Map();
    this.tasks = new Set(); this.sequence = 0; this.receivedBytes = 0; this.stopped = false;
  }
  recover() {
    for (const row of this.observations.pending()) {
      this.observations.interrupted(row.mint, 'Process restart interrupted observation');
      this.add(row.mint);
    }
  }
  add(mint) {
    if (this.windows.has(mint)) return;
    const row = this.observations.get(mint);
    if (!row || row.status !== 'tracking') return;
    if (this.stopped) { this.observations.interrupted(mint, 'Collector stopped'); return; }
    if (this.now() >= row.deadline_ms) { this.observations.finish(mint, row.deadline_ms); return; }
    const address = this.store.get('SELECT curve_address FROM mints WHERE mint=?', mint).curve_address;
    const window = { mint, address, deadline: row.deadline_ms };
    this.windows.set(mint, window);
    window.timer = this.setTimer(() => this.expire(mint), row.deadline_ms - this.now());
    if (this.socket?.readyState === WebSocket.OPEN) this.subscribe(window);
    else this.connect();
  }
  connect() {
    if (this.stopped || this.socket || this.retry || !this.windows.size) return;
    const socket = this.socket = this.socketFactory(this.rpc.wsUrl);
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      for (const window of this.windows.values()) this.subscribe(window);
    });
    socket.on('message', raw => {
      if (this.socket !== socket || this.stopped) return;
      this.receivedBytes += raw.length;
      try { this.message(JSON.parse(raw.toString())); }
      catch {
        for (const mint of this.windows.keys()) this.observations.interrupted(mint, 'Malformed account subscription message');
        socket.terminate();
      }
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null; this.requests.clear(); this.subscriptions.clear();
      for (const window of this.windows.values()) {
        window.subscription = null; window.request = null;
        this.observations.interrupted(window.mint, 'Account subscription disconnected');
      }
      if (!this.stopped && this.windows.size) this.retry = this.setTimer(() => {
        this.retry = null; this.connect();
      }, 1000);
    });
    socket.on('pong', () => { this.alive = true; });
    this.alive = true;
    const heartbeat = () => {
      if (this.socket !== socket || this.stopped) return;
      if (socket.readyState === WebSocket.OPEN) {
        if (!this.alive) { socket.terminate(); return; }
        this.alive = false; socket.ping();
      }
      this.heartbeat = this.setTimer(heartbeat, 5000);
    };
    this.clearTimer(this.heartbeat);
    this.heartbeat = this.setTimer(heartbeat, 5000);
  }
  send(method, params) {
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return id;
  }
  subscribe(window) {
    if (window.request != null || window.subscription != null) return;
    if (this.now() >= window.deadline) { this.expire(window.mint); return; }
    window.request = this.send('accountSubscribe', [window.address, { commitment: 'confirmed', encoding: 'base64' }]);
    this.requests.set(window.request, window.mint);
  }
  message(message) {
    if (message.id != null) {
      const mint = this.requests.get(message.id);
      if (!mint) return;
      this.requests.delete(message.id);
      if (message.error || !Number.isSafeInteger(message.result)) throw new Error('Account subscription failed');
      const window = this.windows.get(mint);
      if (!window || this.now() >= window.deadline) {
        this.send('accountUnsubscribe', [message.result]);
        if (window) this.expire(mint);
        return;
      }
      window.subscription = message.result;
      this.subscriptions.set(message.result, mint);
      this.observations.subscribed(mint, this.now());
      // Exactly one baseline RPC after the first acknowledgment, never per notification.
      if (!window.snapshotStarted) {
        window.snapshotStarted = true;
        const task = this.snapshot(window);
        this.tasks.add(task);
        task.finally(() => this.tasks.delete(task));
      }
      return;
    }
    if (message.method !== 'accountNotification') return;
    const mint = this.subscriptions.get(message.params?.subscription);
    if (!mint) return;
    const result = message.params.result;
    this.sample(mint, result?.context?.slot, result?.value, 'subscription');
  }
  async snapshot(window) {
    try {
      const result = await this.rpc.accounts([window.address], { deadlineMs: window.deadline });
      if (!this.stopped && this.windows.get(window.mint) === window) {
        this.sample(window.mint, result?.context?.slot, result?.value?.[0], 'snapshot');
        window.snapshotDone = true;
      }
    } catch {
      if (!this.stopped && this.windows.get(window.mint) === window) {
        this.observations.interrupted(window.mint, 'Initial curve snapshot failed');
      }
    }
  }
  sample(mint, slot, account, source) {
    const window = this.windows.get(mint);
    if (!window) return;
    if (this.now() >= window.deadline) { this.expire(mint); return; }
    const curve = decodeCurve(account);
    if (!curve.mayhem) throw new Error('Curve is not Mayhem-enabled');
    const accepted = this.observations.sample(mint, this.now(), slot, source, account, curve);
    if (accepted && curve.complete) this.remove(mint);
  }
  expire(mint) {
    const window = this.windows.get(mint);
    if (!window) return;
    if (!window.snapshotDone) this.observations.interrupted(mint, 'Initial curve snapshot unavailable before deadline');
    this.observations.finish(mint, window.deadline);
    this.remove(mint);
  }
  remove(mint) {
    const window = this.windows.get(mint);
    if (!window) return;
    this.clearTimer(window.timer);
    if (window.subscription != null) {
      this.subscriptions.delete(window.subscription);
      if (this.socket?.readyState === WebSocket.OPEN) this.send('accountUnsubscribe', [window.subscription]);
    }
    this.windows.delete(mint);
    if (!this.windows.size) {
      this.clearTimer(this.retry); this.retry = null;
      this.clearTimer(this.heartbeat);
      const socket = this.socket; this.socket = null;
      this.requests.clear(); this.subscriptions.clear();
      socket?.terminate();
      this.flushUsage();
    }
  }
  flushUsage() {
    if (this.receivedBytes) this.store.usage('websocket', 'candidate_received_bytes', this.receivedBytes);
    this.receivedBytes = 0;
  }
  async stop() {
    this.stopped = true;
    for (const mint of [...this.windows.keys()]) {
      this.observations.interrupted(mint, 'Collector shutdown interrupted observation');
      this.remove(mint);
    }
    this.clearTimer(this.retry); this.clearTimer(this.heartbeat);
    this.flushUsage();
    await Promise.allSettled([...this.tasks]);
  }
}
