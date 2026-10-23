import { decodeCurve } from './chain.js';

const BPS = 10000n;
const ceilDiv = (a, b) => (a + b - 1n) / b;
export function reserves(account) {
  const metrics = decodeCurve(account), bytes = Buffer.from(account.data[0], 'base64');
  if (!metrics.mayhem) throw new Error('not_mayhem');
  return { ...metrics, cashback: bytes.length > 82 && bytes[82] !== 0,
    virtualTokens: bytes.readBigUInt64LE(8), virtualSol: bytes.readBigUInt64LE(16),
    realTokens: bytes.readBigUInt64LE(24), realSol: bytes.readBigUInt64LE(32), supply: bytes.readBigUInt64LE(40) };
}
export function cap(state) {
  if (state.complete || state.virtualTokens <= 0n) throw new Error('graduated_or_invalid_reserves');
  return Number(state.virtualSol * state.supply / state.virtualTokens) / 1e9;
}
const fee = (lamports, bps) => ceilDiv(lamports * BigInt(bps), BPS);
export function sell(state, tokens, feeBps) {
  if (state.complete || tokens <= 0n || state.virtualTokens <= 0n) throw new Error('invalid_sell');
  const gross = tokens * state.virtualSol / (state.virtualTokens + tokens);
  if (gross <= 0n || gross > state.realSol) throw new Error('insufficient_real_liquidity');
  const charges = fee(gross, feeBps);
  if (charges >= gross) throw new Error('fees_exceed_output');
  return { gross, net: gross - charges, tokens,
    state: { ...state, virtualTokens: state.virtualTokens + tokens, virtualSol: state.virtualSol - gross,
      realTokens: state.realTokens + tokens, realSol: state.realSol - gross } };
}
export function buyTokens(state, tokens, feeBps) {
  if (state.complete || tokens <= 0n || tokens >= state.virtualTokens || tokens > state.realTokens) throw new Error('insufficient_real_tokens');
  const gross = state.virtualSol * tokens / (state.virtualTokens - tokens) + 1n;
  return { gross, cost: gross + fee(gross, feeBps), tokens,
    state: { ...state, virtualTokens: state.virtualTokens - tokens, virtualSol: state.virtualSol + gross,
      realTokens: state.realTokens - tokens, realSol: state.realSol + gross } };
}
export function buyBudget(state, budget, feeBps) {
  if (budget <= 0n || state.complete || state.virtualTokens <= 1n) throw new Error('invalid_buy');
  let low = 0n, high = state.realTokens < state.virtualTokens ? state.realTokens : state.virtualTokens - 1n;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (buyTokens(state, mid, feeBps).cost <= budget) low = mid;
    else high = mid - 1n;
  }
  if (!low) throw new Error('budget_too_small');
  return buyTokens(state, low, feeBps);
}
export function entryQuote(state, cfg) {
  const result = buyBudget(state, BigInt(cfg.buyLamports), cfg.swapFeeBps);
  return { tokens: result.tokens.toString(), swapCost: result.cost.toString(),
    cost: (result.cost + BigInt(cfg.networkFeeLamports)).toString(), mc: cap(state) };
}
export function exitQuote(state, position, cfg) {
  const result = sell(state, BigInt(position.tokens_raw), cfg.swapFeeBps);
  return { tokens: position.tokens_raw, gross: result.gross.toString(),
    net: (result.net - BigInt(cfg.networkFeeLamports)).toString(), mc: cap(state) };
}
export function profitable(quote, position, cfg) {
  return BigInt(quote.net) * BPS > BigInt(position.entry_cost_lamports) * (BPS + BigInt(cfg.profitBps));
}
export function meetsDrop(current, high, cfg) {
  // Compare rational reserve prices; supply is unchanged for the same watched mint.
  return current.virtualSol * high.virtualTokens * BPS <=
    high.virtualSol * current.virtualTokens * (BPS - BigInt(cfg.dropBps));
}
export function higher(a, b) { return a.virtualSol * b.virtualTokens > b.virtualSol * a.virtualTokens; }
