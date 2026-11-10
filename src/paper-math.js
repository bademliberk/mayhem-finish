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
// Stop-loss: the full-sale net (after swap and network fees) has fallen to entry cost × (1 − stopLossBps).
// Off unless cfg.stopLossBps is set. An unquotable full sale (no output after fees, or more than the curve's
// real SOL) is at least as bad as any stop, so it triggers too.
export function stopLoss(state, position, cfg) {
  if (!cfg.stopLossBps || state.complete) return false;
  let net;
  // Only the sale math decides, never market cap or other fields: an unrelated error must not trigger a stop.
  try { net = sell(state, BigInt(position.tokens_raw), cfg.swapFeeBps).net - BigInt(cfg.networkFeeLamports); }
  catch (error) { return ['insufficient_real_liquidity', 'fees_exceed_output'].includes(error.message); }
  return net * BPS <= BigInt(position.entry_cost_lamports) * (BPS - BigInt(cfg.stopLossBps));
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
// True when the fraction-based budget reaches the swap cap (the uncapped fraction is at least the cap).
export function budgetCapped(realSol, cfg) {
  return realSol * BigInt(cfg.fractionBps) / BPS >= BigInt(cfg.maxSwapBudgetLamports);
}
export function liquidityBudget(realSol, cfg) {
  const fraction = realSol * BigInt(cfg.fractionBps) / BPS;
  const maximum = BigInt(cfg.maxSwapBudgetLamports);
  return fraction < maximum ? fraction : maximum;
}
export function entryQuote(state, cfg, budget = BigInt(cfg.buyLamports)) {
  const result = buyBudget(state, budget, cfg.swapFeeBps);
  return { tokens: result.tokens.toString(), swapCost: result.cost.toString(),
    cost: (result.cost + BigInt(cfg.networkFeeLamports)).toString(), mc: cap(state) };
}
export function entryQuality(state, cfg, budget = BigInt(cfg.buyLamports)) {
  const buy = buyBudget(state, budget, cfg.swapFeeBps);
  const cost = buy.cost + BigInt(cfg.networkFeeLamports);
  const quality = { model: 'isolated_post_buy_round_trip', preBuyRealSolLamports: state.realSol.toString(),
    minimumRealSolLamports: (budget * BigInt(cfg.minEntryLiquidityMultiple ?? 2)).toString(),
    postBuyRealSolLamports: buy.state.realSol.toString(), fullExitSupported: false,
    roundTripNetLamports: null, roundTripLossLamports: null, roundTripLossBps: null,
    residualRealSolLamports: null, buyImpactBps: Number((buy.state.virtualSol * state.virtualTokens -
      state.virtualSol * buy.state.virtualTokens) * BPS / (state.virtualSol * buy.state.virtualTokens)),
    rejection: null };
  // Exhausting inventory would complete the curve; this profile has no AMM exit model.
  if (cfg.strategy === 'agent-sell-liquidity' && buy.tokens >= state.realTokens) {
    quality.rejection = 'entry_inventory_exhaustion'; return quality;
  }
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
// Terminal settlement is intentionally separate from strict full-sale/entry math.
function terminalInteger(value, error) {
  if (typeof value !== 'bigint' && !(typeof value === 'string' && /^\d+$/.test(value)) &&
      !(typeof value === 'number' && Number.isSafeInteger(value))) throw new Error(error);
  const result = BigInt(value);
  if (result < 0n) throw new Error(error);
  return result;
}
function terminalPositionTokens(position) {
  if (typeof position?.tokens_raw !== 'string') throw new Error('invalid_terminal_position');
  const tokens = terminalInteger(position.tokens_raw, 'invalid_terminal_position');
  if (tokens <= 0n) throw new Error('invalid_terminal_position');
  return tokens;
}
export function writeOffQuote(position, cfg, reason) {
  terminalPositionTokens(position);
  const networkFee = terminalInteger(cfg?.networkFeeLamports, 'invalid_terminal_network_fee');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('invalid_write_off_reason');
  return { tokens: position.tokens_raw, originalTokens: position.tokens_raw,
    soldTokens: '0', burnedTokens: position.tokens_raw, remainingTokens: '0',
    gross: '0', swapFee: '0', networkFee: networkFee.toString(), net: (-networkFee).toString(),
    accountClosed: true, entryOrderId: position.entry_order_id, terminalOutcome: 'write_off',
    model: 'hypothetical_zero_recovery_write_off', writeOffReason: reason };
}
export function terminalExitQuote(state, position, cfg) {
  const original = terminalPositionTokens(position);
  const networkFee = terminalInteger(cfg?.networkFeeLamports, 'invalid_terminal_network_fee');
  const swapFeeBps = terminalInteger(cfg?.swapFeeBps, 'invalid_terminal_swap_fee');
  if (swapFeeBps > BPS) throw new Error('invalid_terminal_swap_fee');
  if (!state || state.complete !== false ||
      ['realSol', 'realTokens', 'virtualSol', 'virtualTokens'].some(key =>
        typeof state[key] !== 'bigint' || state[key] < 0n) ||
      state.virtualSol === 0n || state.virtualTokens === 0n) throw new Error('invalid_terminal_reserves');
  const evidence = { reserveEvidence: { realSol: state.realSol.toString(), realTokens: state.realTokens.toString(),
    virtualSol: state.virtualSol.toString(), virtualTokens: state.virtualTokens.toString() } };
  if (typeof state.supply === 'bigint' && state.supply > 0n) {
    const mc = cap(state);
    if (Number.isFinite(mc)) evidence.mc = mc;
  }
  // Search gross only: sell() also rejects fee dust, which is not a monotone predicate.
  let low = 0n, high = original;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (fullSaleGross(state, mid) <= state.realSol) low = mid;
    else high = mid - 1n;
  }
  const gross = low === 0n ? 0n : fullSaleGross(state, low);
  if (gross === 0n || fee(gross, swapFeeBps) >= gross) {
    return { ...writeOffQuote(position, cfg, gross === 0n ? 'insufficient_real_liquidity' : 'fees_exceed_output'),
      ...evidence };
  }
  const result = sell(state, low, swapFeeBps);
  return { tokens: position.tokens_raw, originalTokens: position.tokens_raw,
    soldTokens: low.toString(), burnedTokens: (original - low).toString(), remainingTokens: '0',
    gross: result.gross.toString(), swapFee: (result.gross - result.net).toString(),
    networkFee: networkFee.toString(), net: (result.net - networkFee).toString(),
    accountClosed: true, entryOrderId: position.entry_order_id,
    terminalOutcome: low === original ? 'full_sale' : 'partial_sale',
    model: 'hypothetical_terminal_liquidation', writeOffReason: null, ...evidence };
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
