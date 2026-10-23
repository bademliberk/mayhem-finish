import { AddressLookupTableAccount } from '@solana/web3.js';

const OWNER = 'AddressLookupTab1e1111111111111111111111111';
const MAX_TABLES = 128, MAX_PENDING = 2, TTL_MS = 60000;
export class LookupCache {
  constructor(rpc, count = () => {}, now = Date.now) {
    this.rpc = rpc; this.count = count; this.now = now;
    this.cache = new Map(); this.loads = []; this.tasks = new Set(); this.pending = new Set(); this.epoch = 0; this.stopped = false;
  }
  resolve(address, slot, indexes) {
    const row = this.cache.get(address);
    if (row && this.now() - row.at < TTL_MS) {
      if (!row.state) return null;
      const state = row.state;
      // Do not project with a table snapshot from after the observed transaction, or a deactivated table.
      if (row.slot > slot || state.lastExtendedSlot > slot || state.deactivationSlot !== 18446744073709551615n) return null;
      const length = slot > state.lastExtendedSlot ? state.addresses.length : state.lastExtendedSlotStartIndex;
      if (indexes.every(i => i < length)) return state.addresses.slice(0,length).map(key => key.toBase58());
      return null;
    }
    this.load(address); return null;
  }
  load(address) {
    this.loads = this.loads.filter(at => this.now() - at < TTL_MS);
    if (this.stopped || this.pending.has(address) || this.tasks.size >= MAX_PENDING || this.loads.length >= 30) return;
    this.loads.push(this.now());
    this.pending.add(address);
    const epoch = this.epoch;
    const task = (async () => {
      let row = { at: this.now(), state: null };
      try {
        this.count('lookup_rpc');
        const result = await this.rpc.accounts([address], { commitment: 'confirmed', deadlineMs: this.now() + 3000 });
        const account = result?.value?.[0], bytes = Buffer.from(account?.data?.[0] ?? '', 'base64');
        if (account?.owner !== OWNER || !Number.isSafeInteger(result?.context?.slot) || bytes.length < 56 ||
            (bytes.length - 56) % 32 || bytes.length > 56 + 256 * 32) throw new Error('invalid_lookup');
        row = { at: this.now(), slot: result.context.slot, state: AddressLookupTableAccount.deserialize(bytes) };
      } catch { this.count('lookup_unavailable'); }
      if (this.stopped || this.epoch !== epoch) return;
      this.cache.delete(address); this.cache.set(address,row);
      while (this.cache.size > MAX_TABLES) this.cache.delete(this.cache.keys().next().value);
    })();
    this.tasks.add(task);
    task.finally(() => { this.tasks.delete(task); this.pending.delete(address); });
  }
  clear() { this.epoch++; this.cache.clear(); }
  async stop() { this.stopped = true; this.clear(); await Promise.allSettled([...this.tasks]); }
}
