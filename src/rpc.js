import { setTimeout as sleep } from 'node:timers/promises';

export class Rpc {
  constructor(cfg, store) {
    this.store = store;
    if (!cfg.key) throw new Error('Set HELIUS_API_KEY in .env');
    this.url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(cfg.key)}`;
    this.wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(cfg.key)}`;
    this.interval = cfg.rpcInterval;
    this.next = Promise.resolve();
  }
  call(method, params = []) {
    const run = async () => {
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          let response;
          try {
            this.store?.usage('rpc', method);
            response = await fetch(this.url, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
              signal: AbortSignal.timeout(30000),
            });
          } catch {
            if (attempt === 3) throw new Error(`RPC ${method}: network failure (credentials suppressed)`);
            await sleep(1000 * 2 ** attempt); continue;
          }
          if (response.status === 429 || response.status >= 500) {
            if (attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
          }
          if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);
          const body = await response.json();
          if (body.error) throw new Error(`RPC ${method}: error code ${body.error.code}`);
          return body.result;
        }
      } finally { await sleep(this.interval); }
    };
    const task = this.next.then(run, run);
    this.next = task.catch(() => {});
    return task;
  }
  transaction(signature) {
    return this.call('getTransaction', [signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 }]);
  }
  signatures(address, options = {}) {
    return this.call('getSignaturesForAddress', [address, { commitment: 'confirmed', limit: 1000, ...options }]);
  }
  accounts(addresses) {
    return this.call('getMultipleAccounts', [addresses, { commitment: 'confirmed', encoding: 'base64' }]);
  }
}
