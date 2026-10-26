export function paperPerformance(store, positions) {
  const closed = positions.filter(p => p.status === 'closed').sort((a, b) => a.closed_at_ms - b.closed_at_ms || a.exit_order_id - b.exit_order_id);
  const open = positions.filter(p => p.status === 'open');
  let wins = 0, losses = 0, gains = 0n, lossTotal = 0n, realized = 0n, peak = 0n, drawdown = 0n;
  for (const p of closed) {
    const pnl = BigInt(p.pnl_lamports);
    if (pnl > 0n) { wins++; gains += pnl; }
    if (pnl < 0n) { losses++; lossTotal += pnl; }
    realized += pnl;
    if (realized > peak) peak = realized;
    if (peak - realized > drawdown) drawdown = peak - realized;
  }
  const openCost = open.reduce((s, p) => s + BigInt(p.entry_cost_lamports), 0n);
  const buys = store.get("SELECT COUNT(*) n FROM paper_orders WHERE side='buy' AND status='filled'").n;
  const usage = store.all("SELECT source,SUM(amount) amount FROM usage WHERE source IN ('rpc','websocket','preprocessed') GROUP BY source");
  const credits = usage.reduce((s, r) => s + r.amount * (r.source === 'rpc' ? 1 : r.source === 'websocket' ? 2 / 100000 : 0.1), 0);
  const average = (sum, count) => count ? (sum / BigInt(count)).toString() : null;
  return {
    scope: 'entire_database', closedTrades: closed.length, wins, losses, breakevens: closed.length - wins - losses,
    closedOnlyWinRate: closed.length ? wins / closed.length : null,
    meanWinLamports: average(gains, wins), meanLossLamports: average(lossTotal, losses),
    realizedExpectancyLamportsPerClosedTrade: average(realized, closed.length),
    realizedMaxDrawdownLamports: drawdown.toString(),
    unresolvedPositions: open.length, unresolvedCostLamports: openCost.toString(),
    zeroRecoveryScenarioPnlLamports: (realized - openCost).toString(),
    estimatedCredits: credits, estimatedCreditsPerFilledBuy: buys ? credits / buys : null,
    orderFunnel: store.all('SELECT side,status,error,COUNT(*) count FROM paper_orders GROUP BY side,status,error'),
    signalFunnel: store.all('SELECT outcome,COUNT(*) count FROM paper_signals GROUP BY outcome'),
    note: 'Closed-only statistics exclude unresolved returns. Drawdown is realized-only, not equity drawdown. Zero recovery is a scenario, not a fill. Credits are an application estimate, not an invoice. Averages truncate to whole lamports.',
  };
}
