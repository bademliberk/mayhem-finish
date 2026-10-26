import { setTimeout as sleep } from 'node:timers/promises';

export class DownloadError extends Error {
  constructor(code, retryable = false, retryAfter = 0) {
    super(code);
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

export class DownloadRpc {
  constructor({ key, backupKey, store, signal, rps = 8, timeoutMs = 60000, retries = 5, fetchFn = fetch }) {
    this.keys = [...new Set([key, backupKey].filter(Boolean))];
    this.keyIndex = 0;
    this.exhaustedKeys = new Set();
    Object.assign(this, { store, signal, timeoutMs, retries, fetchFn });
    this.interval = Math.ceil(1000 / rps);
    this.next = 0;
    this.cooldown = 0;
    this.gate = Promise.resolve();
  }
  async wait() {
    const previous = this.gate;
    let release;
    this.gate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      while (true) {
        this.signal?.throwIfAborted();
        const delay = Math.max(this.next, this.cooldown) - Date.now();
        if (delay <= 0) break;
        await sleep(delay, undefined, { signal: this.signal });
      }
      this.next = Date.now() + this.interval;
    } finally { release(); }
  }
  async call(method, params = []) {
    for (let attempt = 0; ; attempt++) {
      await this.wait();
      this.signal?.throwIfAborted();
      const keyIndex = this.keyIndex;
      if (this.exhaustedKeys.has(keyIndex)) throw new DownloadError('PROVIDER_QUOTA');
      const reservation = this.store.reserve(method);
      try {
        const result = await this.request(method, params, keyIndex);
        this.store.settle?.(reservation, result);
        return result;
      }
      catch (error) {
        if (this.signal?.aborted) throw new DownloadError('PAUSED');
        if (!(error instanceof DownloadError)) throw new DownloadError('TRANSPORT_FAILURE', true);
        if (error.message === 'PROVIDER_QUOTA') {
          this.exhaustedKeys.add(keyIndex);
          const next = this.keys.findIndex((_, index) => !this.exhaustedKeys.has(index));
          if (next < 0) throw error;
          this.keyIndex = next;
          attempt = -1;
          continue;
        }
        if (!error.retryable || attempt >= this.retries) throw error;
        const delay = Math.max(error.retryAfter, Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250));
        this.cooldown = Math.max(this.cooldown, Date.now() + delay);
      }
    }
  }
  async request(method, params, keyIndex = this.keyIndex) {
    const controller = new AbortController();
    const signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
    let timer, cancel;
    const canceled = new Promise((_, reject) => {
      cancel = () => reject(new DownloadError(this.signal?.aborted ? 'PAUSED' : 'REQUEST_TIMEOUT', true));
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    });
    const operation = (async () => {
      let response;
      try {
        response = await this.fetchFn(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.keys[keyIndex])}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (!response.ok) {
          const retry = response.headers?.get('retry-after');
          const retryAfter = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry ?? '') - Date.now()) || 0;
          if (response.status === 429) {
            let detail;
            try { detail = await response.json(); } catch { /* A plain rate limit still backs off. */ }
            const message = detail?.error?.message ?? detail?.message ?? (typeof detail?.error === 'string' ? detail.error : '');
            if (/credits?|quota|payment|billing/i.test(String(message))) throw new DownloadError('PROVIDER_QUOTA');
          }
          try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* Best effort. */ }
          if ([401, 403].includes(response.status)) throw new DownloadError('AUTH_OR_ACCESS_DENIED');
          if (response.status === 402) throw new DownloadError('PROVIDER_QUOTA');
          throw new DownloadError(`HTTP_${response.status}`, response.status === 429 || response.status >= 500, retryAfter);
        }
        const body = await response.json();
        if (body.error) {
          const code = Number(body.error.code);
          // Inspect provider text only for classification; never persist or print it.
          const message = String(body.error.message ?? '');
          if (/credit|quota|payment|billing/i.test(message)) throw new DownloadError('PROVIDER_QUOTA');
          if (/unauthorized|forbidden|api.?key/i.test(message)) throw new DownloadError('AUTH_OR_ACCESS_DENIED');
          if (code === 429 || /rate.limit|too many requests/i.test(message)) throw new DownloadError('RATE_LIMIT', true);
          throw new DownloadError(`RPC_${Number.isFinite(code) ? code : 'ERROR'}`, [-32005, -32603].includes(code));
        }
        if (!Object.hasOwn(body, 'result')) throw new DownloadError('INVALID_RPC_RESPONSE', true);
        return body.result;
      } catch (error) {
        if (error instanceof DownloadError) throw error;
        throw new DownloadError('TRANSPORT_OR_JSON_FAILURE', true);
      }
    })();
    try { return await Promise.race([operation, canceled]); }
    finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  }
}

export function safeError(error) {
  const code = error?.message;
  const boundaryErrors = {
    'Invalid finalized slot.': 'BOUNDARY_UNAVAILABLE',
    'Historical block timestamp unavailable; cannot resolve range.': 'BOUNDARY_UNAVAILABLE',
    'Requested end is not yet finalized.': 'RANGE_NOT_FINALIZED',
    'Historical block listing unavailable; cannot establish archive coverage.': 'ARCHIVE_UNAVAILABLE',
    'Provider archive begins after the requested start.': 'ARCHIVE_UNAVAILABLE',
    'Long empty slot range during timestamp lookup; cannot safely resolve range.': 'BOUNDARY_UNAVAILABLE',
    'Could not establish padded timestamp boundaries.': 'BOUNDARY_UNAVAILABLE',
    'Invalid or unordered block slot listing.': 'INVALID_BLOCK_LIST',
  };
  if (Object.hasOwn(boundaryErrors, code)) return boundaryErrors[code];
  return typeof code === 'string' && /^(?:PAUSED|CREDIT_BUDGET|PROVIDER_QUOTA|AUTH_OR_ACCESS_DENIED|REQUEST_TIMEOUT|TRANSPORT_FAILURE|TRANSPORT_OR_JSON_FAILURE|INVALID_RPC_RESPONSE|REPEATED_BLOCK_FAILURES|BOUNDARY_UNAVAILABLE|ARCHIVE_UNAVAILABLE|RANGE_NOT_FINALIZED|INVALID_BLOCK_LIST|RATE_LIMIT|HTTP_\d+|RPC_(?:-?\d+|ERROR))$/.test(code)
    ? code : 'DOWNLOAD_FAILURE';
}
