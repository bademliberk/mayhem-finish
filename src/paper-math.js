import { decodeCurve } from './chain.js';

const BPS = 10000n;
const ceilDiv = (a, b) => (a + b - 1n) / b;
export function reserves(account) {
  // RPC reconciliation must enforce the same encoding contract as streamed observations.
  if (!Array.isArray(account?.data) || account.data[1] !== 'base64' || typeof account.data[0] !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(account.data[0])) throw new Error('invalid_data');
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
// The requirement is useful even when real reserves cannot fund the full sale.
export function fullSaleGross(state, tokens) {
  if (state.complete || tokens <= 0n || state.virtualTokens <= 0n || state.virtualSol <= 0n) throw new Error('invalid_sell');
  return tokens * state.virtualSol / (state.virtualTokens + tokens);
}
export function liquidityRisk(state, position, cfg) {
  // Missing guard fields deliberately leave historical profiles unchanged.
  return cfg.liquidityExitEnabled === true && !state.complete &&
    state.realSol <= BigInt(cfg.liquidityExitMultiple ?? 2) * fullSaleGross(state, BigInt(position.tokens_raw));
}
export function sell(state, tokens, feeBps) {
  const gross = fullSaleGross(state, tokens);
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
export function buyExactInput(state, budget, feeBps, v3 = false) {
  if (budget <= 1n || state.complete || state.virtualTokens <= 1n) throw new Error('invalid_buy');
  let net = (v3 ? budget : budget - 1n) * BPS / (BPS + BigInt(feeBps));
  if (v3) {
    const excess = net + fee(net, feeBps) - budget;
    if (excess > 0n) net -= excess;
  }
  const input = v3 ? net - 1n : net;
  if (input <= 0n) throw new Error('budget_too_small');
  const tokens = input * state.virtualTokens / (state.virtualSol + input);
  // No partial-fill or synthetic-pool inference for Mayhem.
  if (tokens <= 0n || tokens >= state.realTokens) throw new Error('inventory_exhaustion');
  const quote = buyTokens(state, tokens, feeBps);
  if (quote.cost > budget) throw new Error('budget_exceeded');
  return quote;
}
export function entryQuote(state, cfg) {
  const result = buyBudget(state, BigInt(cfg.buyLamports), cfg.swapFeeBps);
  return { tokens: result.tokens.toString(), swapCost: result.cost.toString(),
    cost: (result.cost + BigInt(cfg.networkFeeLamports)).toString(), mc: cap(state) };
}
export function entryQuality(state, cfg) {
  const buy = buyBudget(state, BigInt(cfg.buyLamports), cfg.swapFeeBps);
  const cost = buy.cost + BigInt(cfg.networkFeeLamports);
  const quality = { model: 'isolated_post_buy_round_trip', preBuyRealSolLamports: state.realSol.toString(),
    minimumRealSolLamports: (BigInt(cfg.buyLamports) * BigInt(cfg.minEntryLiquidityMultiple ?? 2)).toString(),
    postBuyRealSolLamports: buy.state.realSol.toString(), fullExitSupported: false,
    roundTripNetLamports: null, roundTripLossLamports: null, roundTripLossBps: null,
    residualRealSolLamports: null, buyImpactBps: Number((buy.state.virtualSol * state.virtualTokens -
      state.virtualSol * buy.state.virtualTokens) * BPS / (state.virtualSol * buy.state.virtualTokens)),
    rejection: null };
  try {
    const exit = sell(buy.state, buy.tokens, cfg.swapFeeBps);
    const net = exit.net - BigInt(cfg.networkFeeLamports), loss = cost - net;
    quality.fullExitSupported = net > 0n;
    quality.roundTripNetLamports = net.toString();
    quality.roundTripLossLamports = loss.toString();
    quality.roundTripLossBps = Number(ceilDiv(loss * BPS, cost));
    quality.residualRealSolLamports = exit.state.realSol.toString();
    if (net <= 0n) quality.rejection = 'entry_exit_unavailable';
    else if (loss * BPS > cost * BigInt(cfg.maxRoundTripLossBps ?? 1000)) quality.rejection = 'entry_round_trip_loss';
  } catch { quality.rejection = 'entry_exit_unavailable'; }
  if (state.realSol < BigInt(quality.minimumRealSolLamports)) quality.rejection = 'entry_real_liquidity';
  return quality;
}
export function exitQuote(state, position, cfg) {
  const result = sell(state, BigInt(position.tokens_raw), cfg.swapFeeBps);
  const net = result.net - BigInt(cfg.networkFeeLamports);
  if (net <= 0n) throw new Error('fees_exceed_output');
  return { tokens: position.tokens_raw, gross: result.gross.toString(), net: net.toString(), mc: cap(state) };
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
