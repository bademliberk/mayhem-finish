import { safeError } from './download-rpc.js';

const MAX_TRANSACTION_VERSION = 1;
const BLOCK_OPTIONS = {
  commitment: 'finalized', encoding: 'jsonParsed', transactionDetails: 'full',
  rewards: false, maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION,
};

function slotList(slots, first, last) {
  if (!Array.isArray(slots) || slots.some((s, i) => !Number.isSafeInteger(s)
    || s < first || s > last || (i > 0 && s <= slots[i - 1]))) {
    throw new Error('Invalid or unordered block slot listing.');
  }
  return slots;
}

export async function resolveBounds(rpc, start, end) {
  const tip = await rpc.call('getSlot', [{ commitment: 'finalized' }]);
  if (!Number.isSafeInteger(tip) || tip < 0) throw new Error('Invalid finalized slot.');
  async function time(slot) {
    const value = await rpc.call('getBlockTime', [slot]);
    if (!Number.isSafeInteger(value)) throw new Error('Historical block timestamp unavailable; cannot resolve range.');
    return value;
  }
  const tipTime = await time(tip);
  if (tipTime < end) throw new Error('Requested end is not yet finalized.');
  // getFirstAvailableBlock can describe a node's local ledger rather than its
  // backing archive. Probe historical produced blocks to establish a bracket.
  let oldest = tip, distance = 4096;
  while (true) {
    const from = Math.max(0, tip - distance), to = Math.min(tip, from + 4095);
    const slots = slotList(await rpc.call('getBlocks', [from, to, { commitment: 'finalized' }]), from, to);
    if (!slots.length) throw new Error('Historical block listing unavailable; cannot establish archive coverage.');
    oldest = slots[0];
    if (await time(oldest) <= start) break;
    if (from === 0) throw new Error('Provider archive begins after the requested start.');
    distance *= 2;
  }
  async function lowerBound(target) {
    let lo = oldest, hi = tip;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const upper = Math.min(hi, mid + 4095);
      const slots = slotList(await rpc.call('getBlocks', [mid, upper, { commitment: 'finalized' }]), mid, upper);
      if (!slots.length) {
        if (upper === hi) { hi = mid; continue; }
        throw new Error('Long empty slot range during timestamp lookup; cannot safely resolve range.');
      }
      const slot = slots[0];
      if (await time(slot) < target) lo = slot + 1;
      else hi = mid;
    }
    return lo;
  }
  // Block times are estimated timestamps. Padding tolerates short local reversals.
  const first = Math.max(oldest, await lowerBound(start) - 4096);
  const last = Math.min(tip, await lowerBound(end) + 4096);
  const firstSlots = slotList(await rpc.call('getBlocks', [first, Math.min(last, first + 4095), { commitment: 'finalized' }]), first, Math.min(last, first + 4095));
  const lastSlots = slotList(await rpc.call('getBlocks', [Math.max(first, last - 4095), last, { commitment: 'finalized' }]), Math.max(first, last - 4095), last);
  if (!firstSlots.length || !lastSlots.length
    || await time(firstSlots[0]) > start || await time(lastSlots.at(-1)) < end) {
    throw new Error('Could not establish padded timestamp boundaries.');
  }
  return { first, last, finalizedTip: tip, paddingSlots: 4096 };
}

export function inspectBlock(block, mint, start, end) {
  if (!block || !Array.isArray(block.transactions)) throw new Error('Block unavailable or malformed.');
  if (!Number.isSafeInteger(block.blockTime)) throw new Error('Block timestamp missing.');
  const matches = [], issues = [];
  if (block.blockTime < start || block.blockTime >= end) return { matches, issues };
  for (const [index, entry] of block.transactions.entries()) {
    const transaction = entry?.transaction;
    const signature = transaction?.signatures?.[0];
    const label = typeof signature === 'string' ? signature : `index:${index}`;
    const reasons = new Set();
    const meta = entry?.meta;
    if (!meta || !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) {
      issues.push(`${label}: missing token balance metadata`);
    }
    if (meta && !Array.isArray(meta.innerInstructions)) {
      issues.push(`${label}: inner instruction metadata unavailable`);
    }
    if (entry?.version !== undefined && entry.version !== 'legacy'
      && (!Number.isInteger(entry.version) || entry.version < 0 || entry.version > MAX_TRANSACTION_VERSION)) {
      issues.push(`${label}: unsupported transaction version`);
    }
    for (const balance of [...(meta?.preTokenBalances ?? []), ...(meta?.postTokenBalances ?? [])]) {
      if (balance.mint === mint) reasons.add('token-balance-mint');
      if (typeof balance.mint !== 'string') issues.push(`${label}: malformed token balance`);
    }
    const keys = transaction?.message?.accountKeys;
    if (!Array.isArray(keys) || typeof signature !== 'string') issues.push(`${label}: missing transaction structure`);
    if (keys?.some(key => (typeof key === 'string' ? key : key.pubkey) === mint)) reasons.add('mint-account-reference');
    if (meta?.loadedAddresses && [...(meta.loadedAddresses.writable ?? []), ...(meta.loadedAddresses.readonly ?? [])].includes(mint)) {
      reasons.add('loaded-mint-reference');
    }
    const instructions = [...(transaction?.message?.instructions ?? []),
      ...(meta?.innerInstructions ?? []).flatMap(group => group.instructions ?? [])];
    if (instructions.some(ix => ix.parsed?.info?.mint === mint)) reasons.add('parsed-instruction-mint');
    // A token account created and closed in one transaction may appear in neither
    // balance list; parsed initialize-account instructions supply its mint.
    for (const ix of instructions) {
      const tokenProgram = ['spl-token', 'spl-token-2022'].includes(ix.program)
        || ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(ix.programId);
      if (tokenProgram && !ix.parsed) {
        issues.push(`${label}: unparsed token instruction`);
      }
    }
    if (reasons.size && typeof signature === 'string') matches.push({ signature, reasons: [...reasons], data: entry });
  }
  return { matches, issues: [...new Set(issues)] };
}

export async function scan({ store, rpc, config, concurrency = 3, signal, onProgress = () => {} }) {
  let job = store.job();
  if (!job.bounds) {
    store.setBounds(await resolveBounds(rpc, config.start, config.end));
    job = store.job();
  }
  const bounds = JSON.parse(job.bounds);
  let fatal, consecutiveFailures = 0;
  async function drain() {
    async function worker() {
      while (!signal?.aborted && !fatal) {
        const slot = store.claim();
        if (slot === undefined) return;
        try {
          const block = await rpc.call('getBlock', [slot, BLOCK_OPTIONS]);
          const { matches, issues } = inspectBlock(block, config.mint, config.start, config.end);
          store.complete(slot, block.blockTime, matches, issues);
          consecutiveFailures = 0;
        } catch (error) {
          const code = signal?.aborted ? 'PAUSED' : safeError(error);
          if (['PAUSED', 'CREDIT_BUDGET', 'PROVIDER_QUOTA', 'AUTH_OR_ACCESS_DENIED'].includes(code)) {
            store.pending(slot);
            fatal ??= new Error(code);
          } else {
            store.fail(slot, code === 'DOWNLOAD_FAILURE' ? 'BLOCK_INSPECTION_OR_AVAILABILITY_FAILURE' : code);
            if (++consecutiveFailures >= 10) fatal ??= new Error('REPEATED_BLOCK_FAILURES');
            // Stop on unsupported versions or invalid request formats rather than
            // spending the rest of the budget on the same deterministic failure.
            if (['RPC_-32015', 'RPC_-32602', 'RPC_-32601'].includes(code)) fatal ??= new Error(code);
          }
        }
        onProgress();
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
  await drain();
  while (!signal?.aborted && !fatal && !store.job().discovery_done) {
    const cursor = store.job().cursor;
    const last = Math.min(bounds.last, cursor + 999);
    const slots = slotList(await rpc.call('getBlocks', [cursor, last, { commitment: 'finalized' }]), cursor, last);
    store.discover(slots, last + 1, last === bounds.last);
    await drain();
  }
  if (fatal) throw fatal;
  if (signal?.aborted) throw new Error('PAUSED');
  return store.status();
}
