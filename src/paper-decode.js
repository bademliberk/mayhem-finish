import { PUMP, addresses } from './config.js';
import { decodeFrame, unsupported } from './paper-wire.js';
import { buyTokens, buyExactInput, sell } from './paper-math.js';

// Official pump-public-docs/idl/pump.json. Unknown/changed layouts fail closed.
const BUY = Buffer.from([102,6,61,18,1,218,235,234]);
const SELL = Buffer.from([51,230,133,164,1,127,131,173]);
const BUY_V3 = Buffer.from([7,5,29,196,245,23,101,80]);
const SELL_V3 = Buffer.from([28,146,222,119,38,196,105,213]);
const BUY_EXACT = Buffer.from([56,252,116,8,158,223,205,95]);
const BUY_EXACT_V3 = Buffer.from([225,247,80,30,213,179,132,136]);
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';

export function projectTransaction(raw, states, cfg, resolveLookup, now = Date.now()) {
  const frame = decodeFrame(raw, resolveLookup);
  try { return projectFrame(frame, states, cfg, now); }
  catch (error) {
    error.details = { slot: frame.slot, signature: frame.signature, version: frame.version,
      instructions: frame.instructions.slice(0,8).map(ix => ({ program: ix.program, discriminator: ix.data.subarray(0,8).toString('hex'), accounts: ix.accounts.length, bytes: ix.data.length })) };
    throw error;
  }
}
function projectFrame(frame, states, cfg, now) {
  const pumps = frame.instructions.filter(ix => ix.program === PUMP);
  if (pumps.length !== 1) throw unsupported('cpi_or_multi_swap');
  const ix = pumps[0], disc = ix.data.subarray(0, 8);
  const exact = disc.equals(BUY_EXACT) || disc.equals(BUY_EXACT_V3);
  const buy = exact || disc.equals(BUY) || disc.equals(BUY_V3);
  const v3 = disc.equals(BUY_EXACT_V3) || disc.equals(BUY_V3) || disc.equals(SELL_V3);
  if (!buy && !disc.equals(SELL) && !disc.equals(SELL_V3)) throw unsupported('instruction_variant');
  const expected = v3 ? 17 : buy ? 16 : 14;
  if (ix.accounts.length !== expected || ix.data.length < 24 || ix.data.length > (buy ? (v3 ? 25 : 26) : 24)) throw unsupported('instruction_layout');
  // Partial fills make exact-token projection ambiguous; reject rather than silently assume full execution.
  if (buy && ix.data.length > 24) {
    const flags = ix.data.subarray(24);
    if (flags.some(flag => flag > 1) || (v3 ? flags[0] : flags[1]) === 1) throw unsupported('partial_fill');
  }
  const mint = ix.accounts[v3 ? 1 : 2], curve = ix.accounts[v3 ? 5 : 3];
  const latest = states.get(mint);
  if (!latest) throw unsupported('unwatched_mint');
  if (!Number.isSafeInteger(latest.slot) || latest.slot > frame.slot) throw unsupported('reserve_after_signal');
  const fallback = latest.slot === frame.slot;
  const row = fallback ? (latest.history ?? []).filter(sample => Number.isSafeInteger(sample.slot) &&
    sample.slot < frame.slot && sample.slot >= frame.slot - cfg.windowSlots + 1)
    .reduce((best, sample) => !best || sample.slot >= best.slot ? sample : best, null) : latest;
  if (!row || !Number.isFinite(row.at) || row.at > now || now - row.at > cfg.maxStateAgeMs ||
      row.slot < frame.slot - cfg.windowSlots + 1) throw unsupported('no_fresh_prior_slot_reserves');
  if (curve !== addresses(mint).curve || ix.accounts[v3 ? 16 : 11] !== PUMP) throw unsupported('curve_accounts');
  const tokenProgram = ix.accounts[v3 ? 3 : buy ? 8 : 9];
  if (!TOKEN.has(tokenProgram)) throw unsupported('token_program');
  if (v3 && (ix.accounts[2] !== WSOL || ix.accounts[4] !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')) throw unsupported('non_sol_quote');
  if (v3 && row.state.cashback) throw unsupported('v3_cashback');
  if (ix.accounts[v3 ? 14 : 7] !== SYSTEM) throw unsupported('curve_accounts');
  for (const other of frame.instructions) {
    if (other === ix) continue;
    // No routers or other token operations: their CPI/account effects are not visible pre-execution.
    if (other.program === COMPUTE) continue;
    // A leading durable nonce advance touches only nonce state, not swap reserves.
    if (other === frame.instructions[0] && other.program === SYSTEM && other.data.length === 4 &&
        other.data.readUInt32LE(0) === 4 && other.accounts.length === 3 &&
        other.accounts[1] === 'SysvarRecentB1ockHashes11111111111111111111' &&
        !ix.accounts.includes(other.accounts[0])) continue;
    // Only a post-sell close of the user's base-token account into the user wallet.
    if (!buy && frame.instructions.indexOf(other) > frame.instructions.indexOf(ix) && other.program === tokenProgram &&
        other.data.length === 1 && other.data[0] === 9 && other.accounts.length === 3 &&
        other.accounts[0] === ix.accounts[v3 ? 9 : 5] && other.accounts[1] === ix.accounts[v3 ? 8 : 6] &&
        other.accounts[2] === ix.accounts[v3 ? 8 : 6] && other.accounts[0] !== ix.accounts[v3 ? 6 : 4]) continue;
    if (other.program === ATA && other.data.length === 1 && other.data[0] === 1 && !other.accounts.includes(curve)) continue;
    if (other.program === SYSTEM && other.data.length === 12 && other.data.readUInt32LE(0) === 2 &&
        !other.accounts.some(key => ix.accounts.includes(key) && key !== ix.accounts[v3 ? 8 : 6])) continue;
    throw unsupported('other_instruction_effects');
  }
  const amount = ix.data.readBigUInt64LE(8), limit = ix.data.readBigUInt64LE(16);
  let projected;
  try { projected = exact ? buyExactInput(row.state, amount, cfg.swapFeeBps, v3) : buy ? buyTokens(row.state, amount, cfg.swapFeeBps) : sell(row.state, amount, cfg.swapFeeBps); }
  catch { throw unsupported('reserve_or_amount_limit'); }
  if (buy && projected.tokens >= row.state.realTokens) throw unsupported('inventory_exhaustion');
  if ((exact && projected.tokens < limit) || (buy && !exact && projected.cost > limit) || (!buy && projected.net < limit)) throw unsupported('modeled_instruction_slippage');
  return { signature: frame.signature, slot: frame.slot, mint, state: projected.state, side: buy ? 'buy' : 'sell',
    base: { slot: row.slot, at: row.at, model: fallback ? 'isolated_prior_slot' : 'latest_prior_slot' } };
}
