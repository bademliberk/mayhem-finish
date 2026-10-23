import { Observations } from './observations.js';

const DAY = 86400;
const date = seconds => new Date(seconds * 1000).toISOString().slice(0, 10);

export function report(store, now = Math.floor(Date.now() / 1000)) {
  const started = Number(store.get("SELECT value FROM metadata WHERE key='monitoring_started_at'")?.value);
  const sessions = store.all("SELECT started_at,ended_at FROM coverage WHERE kind='session' ORDER BY started_at");
  const daily = [];
  if (started) for (let day = Math.floor(started / DAY) * DAY; day <= now; day += DAY) {
    const end = day + DAY;
    let covered = 0, lastEnd = day;
    for (const session of sessions) {
      const a = Math.max(day, session.started_at, lastEnd);
      const b = Math.min(end, session.ended_at ?? session.started_at, now);
      if (b > a) { covered += b - a; lastEnd = b; }
    }
    const scalar = (sql, ...args) => store.get(sql, ...args).n;
    const unresolved = scalar(`SELECT COUNT(*) n FROM queue WHERE queued_at<?`, end);
    const quarantined = scalar('SELECT COUNT(*) n FROM quarantined_transactions WHERE queued_at<?', end);
    const gaps = scalar(`SELECT COUNT(*) n FROM coverage WHERE kind!='session'
      AND started_at<? AND COALESCE(ended_at,?)>?`, end, now, day);
    const lateChecks = scalar(`SELECT COUNT(*) n FROM mints WHERE status='monitoring' AND next_check<?`, now - store.cfg.recheck);
    const creationCount = scalar('SELECT COUNT(*) n FROM mints WHERE created_at>=? AND created_at<?', day, end);
    const cohortCandidates = scalar(`SELECT COUNT(*) n FROM candidates c JOIN mints m USING(mint)
      WHERE m.created_at>=? AND m.created_at<?`, day, end);
    daily.push({
      date: date(day),
      creations: creationCount,
      uniqueCandidates: scalar('SELECT COUNT(*) n FROM candidates WHERE first_seen>=? AND first_seen<?', day, end),
      candidatesByPolicy: store.all(`SELECT screening_policy,COUNT(*) count FROM candidates
        WHERE first_seen>=? AND first_seen<? GROUP BY screening_policy`, day, end),
      uniqueLongInactive: scalar('SELECT COUNT(*) n FROM long_inactive WHERE first_seen>=? AND first_seen<?', day, end),
      noTrades: scalar('SELECT COUNT(*) n FROM no_trades WHERE checked_at>=? AND checked_at<?', day, end),
      unqualified: scalar('SELECT COUNT(*) n FROM unqualified WHERE checked_at>=? AND checked_at<?', day, end),
      creationCohortCandidates: cohortCandidates,
      cohortMatured: end + store.cfg.horizon <= now,
      sessionCoverageSeconds: covered,
      pendingTransactions: unresolved,
      quarantinedTransactions: quarantined,
      coverageGaps: gaps,
      overdueChecksNow: lateChecks,
      fullObservedDay: end <= now && covered === DAY && unresolved === 0 && quarantined === 0 && gaps === 0 && lateChecks === 0,
    });
  }
  const policies = store.all('SELECT DISTINCT screening_policy FROM evaluations').map(row => row.screening_policy);
  const counts = (policies.length <= 1 ? daily.filter(d => d.fullObservedDay) : [])
    .map(d => d.uniqueCandidates).sort((a, b) => a - b);
  const middle = Math.floor(counts.length / 2);
  const usage = store.all('SELECT * FROM usage ORDER BY day,source,method');
  const rpcRequests = usage.filter(row => row.source === 'rpc').reduce((sum, row) => sum + row.amount, 0);
  const wsBytes = usage.filter(row => row.source === 'websocket').reduce((sum, row) => sum + row.amount, 0);
  const preprocessedTransactions = usage.filter(row => row.source === 'preprocessed' && row.method === 'transactions').reduce((sum, row) => sum + row.amount, 0);
  return {
    usage: { rows: usage, rpcRequests, websocketBytes: wsBytes, preprocessedTransactions,
      estimatedCredits: rpcRequests + wsBytes / 100000 * 2 + preprocessedTransactions * 0.1,
      note: 'Estimate: standard RPC methods 1 credit/request; standard WebSocket 2 credits/0.1 MB; preprocessed feed 0.1 credit/delivered transaction (not also byte-billed here). Local received payload bytes approximate uncompressed billed bytes. Actual dashboard billing is authoritative. Retries included.' },
    generatedAt: new Date(now * 1000).toISOString(), daily,
    average: counts.length ? {
      days: counts.length, mean: counts.reduce((a, b) => a + b, 0) / counts.length,
      median: counts.length % 2 ? counts[middle] : (counts[middle - 1] + counts[middle]) / 2,
      min: counts[0], max: counts.at(-1),
    } : null,
    caveat: 'Counts are observed, not guaranteed exhaustive. Current screening checks only curve market cap and real liquidity; it does not query last trades or infer bot inactivity. New evaluations have null trade timestamps/ages and history_scope=not_checked. Historical trade-derived outcomes and sampled activity spans are retained, not recomputed. Inspect coverage gaps, backlog, quarantine and late detections. Only fully covered session days without queued or quarantined transactions enter the average; mixed screening policies suppress pooled averages.',
    screeningPolicies: policies,
    averageSuppressedForMixedPolicies: policies.length > 1,
    candidatesByPolicy: store.all('SELECT screening_policy,COUNT(*) count FROM candidates GROUP BY screening_policy'),
    candidateObservations: new Observations(store).summaries(),
    candidateObservationNote: 'Peak/min/final are observed curve samples, not guaranteed intrawindow extrema or an exact deadline price. Percent changes use the screening entry snapshot. Interrupted/no-sample windows are incomplete; legacy candidates are not_tracked. All *_ms timestamps use milliseconds.',
    monitoring: store.all('SELECT status,COUNT(*) count FROM mints GROUP BY status'),
    evaluationHistoryScopes: store.all('SELECT history_scope,COUNT(*) count FROM evaluations GROUP BY history_scope'),
    backlog: store.get('SELECT COUNT(*) count FROM queue').count,
    quarantine: store.get('SELECT COUNT(*) count,SUM(attempts) failedAttempts FROM quarantined_transactions'),
    graduations: store.all('SELECT mint,detected_at,slot FROM graduations ORDER BY detected_at'),
    coverage: store.all('SELECT * FROM coverage ORDER BY started_at'),
    overlap: store.get('SELECT COUNT(*) count FROM candidates JOIN long_inactive USING(mint)').count,
    candidates: store.all(`SELECT c.mint,m.created_at,c.first_seen,c.market_cap_sol,c.liquidity_sol,c.screening_policy,e.last_trade_at,
      e.trade_age_seconds,e.slot FROM candidates c JOIN mints m USING(mint) JOIN evaluations e ON e.id=c.evaluation_id ORDER BY c.first_seen`),
    noTrades: store.all(`SELECT n.*,e.history_scope FROM no_trades n
      JOIN evaluations e ON e.id=n.evaluation_id ORDER BY n.checked_at`)
      .map(row => ({ ...row, reason: row.history_scope === 'latest_20_transactions'
        ? 'no_mayhem_trade_in_last_20_transactions' : 'legacy_no_trade_observation' })),
    unqualified: store.all(`SELECT u.*,e.market_cap_sol,e.liquidity_sol FROM unqualified u
      JOIN evaluations e ON e.id=u.evaluation_id ORDER BY u.checked_at`)
      .map(({ reasons_json, ...row }) => ({ ...row, reasons: JSON.parse(reasons_json) })),
    longInactive: store.all(`SELECT l.*,e.market_cap_sol,e.liquidity_sol,e.passes_filters FROM long_inactive l
      JOIN evaluations e ON e.id=l.evaluation_id ORDER BY l.first_seen`),
  };
}
