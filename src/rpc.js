import { setTimeout as sleep } from 'node:timers/promises';

export const MAX_RPC_QUEUE = 100;

export class Rpc {
  constructor(cfg, store) {
    this.store = store;
    if (!cfg.key) throw new Error('Set HELIUS_API_KEY in .env');
    this.url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(cfg.key)}`;
    this.wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(cfg.key)}`;
    this.interval = cfg.rpcInterval;
    this.queue = []; this.running = false;
  }
  call(method, params = [], { deadlineMs = Infinity, signal } = {}) {
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
        try { this.finish(job, null, await this.execute(job)); }
        catch (error) { this.finish(job, error); }
        await sleep(this.interval);
      }
    } finally { this.running = false; }
  }
  async execute({ method, params, deadlineMs, controller }) {
    const signal = controller.signal;
    const wait = ms => sleep(ms, undefined, { signal });
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      if (Date.now() >= deadlineMs) throw new Error(`RPC ${method}: observation deadline reached`);
      let response;
      try {
        this.store?.usage('rpc', method);
        response = await fetch(this.url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });
      } catch {
        signal.throwIfAborted();
        if (attempt === 3) throw new Error(`RPC ${method}: network failure (credentials suppressed)`);
        await wait(1000 * 2 ** attempt); continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < 3) {
          try { await response.body?.cancel(); } catch { /* response no longer readable */ }
          await wait(1000 * 2 ** attempt); continue;
        }
      }
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* response no longer readable */ }
        throw new Error(`RPC ${method}: HTTP ${response.status}`);
      }
      let body;
      try { body = await response.json(); }
      catch { throw new Error(`RPC ${method}: invalid response (details suppressed)`); }
      if (body.error) {
        const code = Number.isSafeInteger(body.error.code) ? body.error.code : 'unknown';
        throw new Error(`RPC ${method}: error code ${code}`);
      }
      return body.result;
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
