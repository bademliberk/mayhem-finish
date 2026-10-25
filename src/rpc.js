import { setTimeout as sleep } from 'node:timers/promises';

export const MAX_RPC_QUEUE = 100;
const REQUEST_TIMEOUT_MS = 120000;
const ATTEMPT_TIMEOUT_MS = 30000;

// Do not rely on a transport/body promise settling when its signal is aborted.
function abortable(work, signal) {
  if (signal.aborted) return Promise.reject(new Error('RPC operation aborted'));
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(value);
    };
    const aborted = () => finish(new Error('RPC operation aborted'));
    signal.addEventListener('abort', aborted, { once: true });
    try { Promise.resolve(work()).then(value => finish(null, value), error => finish(error)); }
    catch (error) { finish(error); }
  });
}

export class Rpc {
  constructor(cfg, store) {
    this.store = store;
    if (!cfg.key) throw new Error('Set HELIUS_API_KEY in .env');
    this.url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(cfg.key)}`;
    this.wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(cfg.key)}`;
    this.interval = cfg.rpcInterval;
    this.requestTimeoutMs = cfg.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.attemptTimeoutMs = cfg.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
    this.queue = []; this.running = false; this.stopped = false; this.active = null;
  }
  call(method, params = [], { deadlineMs = Infinity, signal } = {}) {
    if (this.stopped) return Promise.reject(new Error('RPC stopped'));
    deadlineMs = Math.min(deadlineMs, Date.now() + this.requestTimeoutMs);
    if (signal?.aborted) return Promise.reject(new Error(`RPC ${method}: canceled`));
    if (Date.now() >= deadlineMs) return Promise.reject(new Error(`RPC ${method}: observation deadline reached`));
    if (this.queue.length >= MAX_RPC_QUEUE) {
      this.store?.usage('rpc_queue', 'overflow');
      return Promise.reject(new Error(`RPC ${method}: queue full`));
    }
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const job = { method, params, deadlineMs, controller, resolve, reject, done: false, timer: null };
      const cancel = reason => {
        if (job.done) return;
        const index = this.queue.indexOf(job);
        if (index !== -1) this.queue.splice(index, 1);
        this.store?.usage('rpc_queue', reason === 'canceled' ? 'canceled' : 'expired');
        controller.abort();
        this.finish(job, new Error(`RPC ${method}: ${reason}`));
      };
      const aborted = () => cancel('canceled');
      job.cleanup = () => { clearTimeout(job.timer); signal?.removeEventListener('abort', aborted); };
      signal?.addEventListener('abort', aborted, { once: true });
      if (Number.isFinite(deadlineMs)) {
        job.timer = setTimeout(() => cancel('observation deadline reached'), Math.max(1, deadlineMs - Date.now()));
      }
      this.queue.push(job);
      void this.drain();
    });
  }
  finish(job, error, result) {
    if (job.done) return;
    job.done = true; job.cleanup();
    if (error) job.reject(error);
    else job.resolve(result);
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        this.active = job;
        try { this.finish(job, null, await abortable(() => this.execute(job), job.controller.signal)); }
        catch (error) { this.finish(job, error); }
        finally { this.active = null; }
        if (!this.stopped) await sleep(this.interval);
      }
    } finally { this.running = false; }
  }
  async execute({ method, params, deadlineMs, controller }) {
    const signal = controller.signal;
    const wait = ms => sleep(ms, undefined, { signal });
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      if (Date.now() >= deadlineMs) throw new Error(`RPC ${method}: observation deadline reached`);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), this.attemptTimeoutMs);
      const attemptSignal = AbortSignal.any([signal, timeout.signal]);
      let response;
      try {
        this.store?.usage('rpc', method);
        response = await abortable(() => fetch(this.url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: attemptSignal,
        }), attemptSignal);
        if (!response.ok) {
          // Cancel best-effort; a stuck error-body cancellation must not hold the worker.
          void Promise.resolve().then(() => response.body?.cancel()).catch(() => {});
          if ((response.status === 429 || response.status >= 500) && attempt < 3) {
            clearTimeout(timer);
            await wait(1000 * 2 ** attempt); continue;
          }
          throw new Error(`RPC ${method}: HTTP ${response.status}`);
        }
        let body;
        try { body = await abortable(() => response.json(), attemptSignal); }
        catch {
          if (attemptSignal.aborted) throw new Error('RPC operation aborted');
          throw new Error(`RPC ${method}: invalid response (details suppressed)`);
        }
        if (!body || typeof body !== 'object') throw new Error(`RPC ${method}: invalid response (details suppressed)`);
        if (body.error) {
          const code = Number.isSafeInteger(body.error.code) ? body.error.code : 'unknown';
          throw new Error(`RPC ${method}: error code ${code}`);
        }
        return body.result;
      } catch (error) {
        signal.throwIfAborted();
        if (timeout.signal.aborted) this.store?.usage('rpc_queue', 'attempt_timeout');
        if (response && !timeout.signal.aborted) throw error;
        if (attempt === 3) throw new Error(`RPC ${method}: network failure (credentials suppressed)`);
      } finally { clearTimeout(timer); timeout.abort(); }
      await wait(1000 * 2 ** attempt);
    }
  }
  stop() {
    this.stopped = true;
    for (const job of [this.active, ...this.queue.splice(0)].filter(Boolean)) {
      job.controller.abort();
      this.finish(job, new Error('RPC stopped'));
    }
  }
  transaction(signature) {
    return this.call('getTransaction', [signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 }]);
  }
  signatures(address, options = {}) {
    return this.call('getSignaturesForAddress', [address, { commitment: 'confirmed', limit: 1000, ...options }]);
  }
  accounts(addresses, { commitment = 'confirmed', ...options } = {}) {
    return this.call('getMultipleAccounts', [addresses, { commitment, encoding: 'base64' }], options);
  }
}
