import { PUMP, addresses } from './config.js';
import { decodeFrame, unsupported } from './paper-wire.js';
import { buyTokens, sell } from './paper-math.js';

// Official pump-public-docs/idl/pump.json. Unknown/changed layouts fail closed.
const BUY = Buffer.from([102,6,61,18,1,218,235,234]);
const SELL = Buffer.from([51,230,133,164,1,127,131,173]);
const BUY_V3 = Buffer.from([7,5,29,196,245,23,101,80]);
const SELL_V3 = Buffer.from([28,146,222,119,38,196,105,213]);
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCxEpPxuEb']);
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';

export function projectTransaction(raw, states, cfg) {
  const frame = decodeFrame(raw);
  const pumps = frame.instructions.filter(ix => ix.program === PUMP);
  if (pumps.length !== 1) throw unsupported('cpi_or_multi_swap');
  const ix = pumps[0], disc = ix.data.subarray(0, 8);
  const buy = disc.equals(BUY) || disc.equals(BUY_V3);
  const v3 = disc.equals(BUY_V3) || disc.equals(SELL_V3);
  if (!buy && !disc.equals(SELL) && !disc.equals(SELL_V3)) throw unsupported('instruction_variant');
  const expected = v3 ? 17 : buy ? 16 : 14;
  if (ix.accounts.length !== expected || ix.data.length < 24 || ix.data.length > (buy ? (v3 ? 25 : 26) : 24)) throw unsupported('instruction_layout');
  // Partial fills make exact-token projection ambiguous; reject rather than silently assume full execution.
  if (buy && ix.data.length > 24) {
    const flags = ix.data.subarray(24);
    if (flags.some(flag => flag > 1) || (v3 ? flags[0] : flags[1]) === 1) throw unsupported('partial_fill');
  }
  const mint = ix.accounts[v3 ? 1 : 2], curve = ix.accounts[v3 ? 5 : 3];
  const row = states.get(mint);
  if (!row) throw unsupported('unwatched_mint');
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
    if (other.program === ATA && other.data.length === 1 && other.data[0] === 1 && !other.accounts.includes(curve)) continue;
    if (other.program === SYSTEM && other.data.length === 12 && other.data.readUInt32LE(0) === 2 &&
        !other.accounts.some(key => ix.accounts.includes(key) && key !== ix.accounts[v3 ? 8 : 6])) continue;
    throw unsupported('other_instruction_effects');
  }
  const amount = ix.data.readBigUInt64LE(8), limit = ix.data.readBigUInt64LE(16);
  let projected;
  try { projected = buy ? buyTokens(row.state, amount, cfg.swapFeeBps) : sell(row.state, amount, cfg.swapFeeBps); }
  catch { throw unsupported('reserve_or_amount_limit'); }
  if ((buy && projected.cost > limit) || (!buy && projected.net < limit)) throw unsupported('modeled_instruction_slippage');
  return { signature: frame.signature, slot: frame.slot, mint, state: projected.state, side: buy ? 'buy' : 'sell' };
}
