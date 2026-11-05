"""Offline buy-size analysis. Read-only SQLite snapshot and previously decoded wallet CSVs."""
import argparse
import csv
import hashlib
import json
import math
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

LAMPORTS = 1_000_000_000
BOUNDS = [0, 1_000_000, 2_500_000, 5_000_000, 7_500_000, 10_000_000, 25_000_000, 50_000_000, None]


def utc(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat() if seconds is not None else None


def lamports(value):
    exact = Decimal(value) * LAMPORTS
    if exact != exact.to_integral_value():
        raise ValueError(f'Nonintegral lamport value: {value}')
    return int(exact)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def aggregate(rows):
    closed = [r for r in rows if r['net_lamports'] is not None]
    wins = sum(r['net_lamports'] > 0 for r in closed)
    losses = sum(r['net_lamports'] < 0 for r in closed)
    n = len(closed)
    interval = None
    if n:
        p, z = wins / n, 1.959963984540054
        center = (p + z * z / (2 * n)) / (1 + z * z / n)
        half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
        interval = [center - half, center + half]
    return {
        'entries': len(rows), 'closed': n, 'excluded_or_open': len(rows) - n,
        'wins': wins, 'losses': losses, 'breakeven': n - wins - losses,
        'win_rate': wins / n if n else None, 'loss_rate': losses / n if n else None,
        'win_rate_wilson_95': interval,
        'net_lamports': str(sum(r['net_lamports'] for r in closed)),
        'closed_entry_cost_lamports': str(sum(r['entry_cost_lamports'] for r in closed)),
        'unresolved_entry_cost_lamports': str(sum(r['entry_cost_lamports'] for r in rows if r['net_lamports'] is None)),
        'exit_outcomes': dict(Counter(r['exit_outcome'] for r in closed)),
    }


def breakdown(rows):
    bins = []
    for low, high in zip(BOUNDS, BOUNDS[1:]):
        subset = [r for r in rows if r['principal_lamports'] >= low and (high is None or r['principal_lamports'] < high)]
        bins.append({'lower_lamports_inclusive': str(low), 'upper_lamports_exclusive': str(high) if high is not None else None,
                     **aggregate(subset)})
    assert sum(b['entries'] for b in bins) == len(rows)
    return {'total': aggregate(rows), 'bins': bins}


def current_rows(path):
    # Input must be a completed, self-contained backup, never a live WAL database.
    con = sqlite3.connect(path.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA query_only=ON')
    con.execute('PRAGMA trusted_schema=OFF')
    check = con.execute('PRAGMA quick_check').fetchall()
    if [r[0] for r in check] != ['ok']:
        raise ValueError('Snapshot integrity check failed')
    meta = dict(con.execute("SELECT key,value FROM metadata WHERE key IN ('paper_trial_config','monitoring_started_at','heartbeat')"))
    cfg = json.loads(meta['paper_trial_config'])
    sessions = [dict(r) for r in con.execute("SELECT id,started_at,ended_at FROM coverage WHERE kind='session' ORDER BY started_at,id")]
    rows = []
    for p in con.execute('''SELECT p.*,b.side buy_side,b.status buy_status,b.fill_json buy_fill,
        b.assumptions_json buy_assumptions,s.reason exit_reason,s.status sell_status,s.fill_json sell_fill
        FROM paper_positions p JOIN paper_orders b ON b.id=p.entry_order_id
        LEFT JOIN paper_orders s ON s.id=p.exit_order_id ORDER BY p.opened_at_ms,p.entry_order_id'''):
        assert p['buy_side'] == 'buy' and p['buy_status'] == 'filled'
        buy = json.loads(p['buy_fill'])
        assumptions = json.loads(p['buy_assumptions'])
        fee_bps = int(assumptions.get('swapFeeBps', cfg['swapFeeBps']))
        swap_cost = int(buy['swapCost'])
        cost = int(p['entry_cost_lamports'])
        assert int(buy['cost']) == cost
        assert cost - swap_cost == int(assumptions.get('networkFeeLamports', cfg['networkFeeLamports']))
        # Invert the production buy cost: principal + ceil(principal * fee_bps / 10000).
        principal = swap_cost * 10000 // (10000 + fee_bps)
        assert principal + (principal * fee_bps + 9999) // 10000 == swap_cost
        sell = json.loads(p['sell_fill']) if p['sell_fill'] else {}
        assert p['status'] in ('closed', 'open')
        net = int(p['pnl_lamports']) if p['status'] == 'closed' else None
        if net is not None:
            assert net == int(p['exit_net_lamports']) - cost
        rows.append({'source': 'current_trial', 'id': str(p['entry_order_id']), 'mint': p['mint'],
            'principal_lamports': principal, 'swap_cost_lamports': swap_cost, 'entry_cost_lamports': cost,
            'net_lamports': net, 'opened_at_ms': p['opened_at_ms'], 'closed_at_ms': p['closed_at_ms'],
            'venue': 'curve', 'exit_reason': p['exit_reason'],
            'exit_outcome': sell.get('terminalOutcome', p['sell_status'] or 'open')})
    position_count = con.execute('SELECT COUNT(*) FROM paper_positions').fetchone()[0]
    assert position_count == len(rows)
    buy_count = con.execute("SELECT COUNT(*) FROM paper_orders WHERE side='buy' AND status='filled'").fetchone()[0]
    assert buy_count == len(rows)
    con.close()
    return rows, {'config': cfg, 'sessions': sessions, 'monitoring_started_utc': utc(int(meta['monitoring_started_at'])) if meta.get('monitoring_started_at') else None,
        'heartbeat_utc': utc(int(meta['heartbeat'])) if meta.get('heartbeat') else None,
        'first_entry_utc': utc(rows[0]['opened_at_ms'] / 1000) if rows else None,
        'last_entry_utc': utc(rows[-1]['opened_at_ms'] / 1000) if rows else None}


def history_rows(latest, older):
    result = []
    for source, path in [('wallet_nov4', latest), ('wallet_oct26', older)]:
        with path.open() as stream:
            for r in csv.DictReader(stream):
                if source == 'wallet_nov4':
                    principal, cost = lamports(r['buy_sol']), lamports(r['spend_sol'])
                    net = lamports(r['net_sol']) if r['exact_round_trip'] == 'True' and r['net_sol'] else None
                    identity, timestamp = r['signature'], int(r['bt']) * 1000
                else:
                    principal, cost = int(r['buy_principal_lamports']), int(r['buy_spend_ex_rent_lamports'])
                    net, identity = int(r['net_lamports']), r['buy_signature']
                    timestamp = int(datetime.fromisoformat(r['buy_utc']).timestamp() * 1000)
                result.append({'source': source, 'id': identity, 'mint': r['mint'], 'principal_lamports': principal,
                    'entry_cost_lamports': cost, 'net_lamports': net, 'opened_at_ms': timestamp,
                    'venue': r['venue'], 'exit_outcome': 'exact_wallet_round_trip' if net is not None else 'not_exact_or_unresolved'})
    identities = [(r['id'], r['mint']) for r in result]
    assert len(set(identities)) == len(identities), 'Overlapping historical trades'
    return result


def percent(value):
    return 'N/A' if value is None else f'{value * 100:.1f}%'


def report(result):
    lines = ['# Buy Size Outcomes', '', 'Buy size means SOL principal before swap and network fees. Win/loss uses net outcome after recorded or modeled filled-trade fees, excluding refundable rent.', '',
        'Current data is paper-trading output, not real wallet fills. Wallet history contains actual decoded round trips. Do not pool the paper and wallet datasets.', '',
        f"Snapshot SHA-256: {result['sources']['snapshot']['sha256']}", '',
        f"Trial monitoring start: {result['current']['monitoring_started_utc']}; snapshot heartbeat: {result['current']['heartbeat_utc']}.", '',
        f"Latest process-session start: {result['latest_session_start_utc']}. Latest-session rows are entries opened since that start, not all exits that happened during it.", '']
    for name, data in result['datasets'].items():
        lines += [f'## {name}', '', '| Buy principal SOL | Closed | Wins | Losses | Win rate | Loss rate | Open / excluded | Net SOL (closed only) |',
                  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
        for b in data['bins']:
            if not b['entries']:
                continue
            low = int(b['lower_lamports_inclusive']) / LAMPORTS
            high = b['upper_lamports_exclusive']
            label = f'{low:g}–<{int(high) / LAMPORTS:g}' if high is not None else f'≥{low:g}'
            lines.append(f"| {label} | {b['closed']} | {b['wins']} | {b['losses']} | {percent(b['win_rate'])} | {percent(b['loss_rate'])} | {b['excluded_or_open']} | {int(b['net_lamports']) / LAMPORTS:.9f} |")
        t = data['total']
        lines += [f"| **Total** | **{t['closed']}** | **{t['wins']}** | **{t['losses']}** | **{percent(t['win_rate'])}** | **{percent(t['loss_rate'])}** | **{t['excluded_or_open']}** | **{int(t['net_lamports']) / LAMPORTS:.9f}** |", '',
                  f"Breakevens: {t['breakeven']}. Closed exit outcomes: {json.dumps(t['exit_outcomes'])}.", '']
    lines += ['## Limits', '',
        '- Rates use closed/exact outcomes only. Open positions and non-exact historical inventory sequences are excluded, not counted as losses or wins.',
        '- Explicit paper write-offs are modeled closed losses, not actual wallet trades.',
        '- All dataset tables are separate views; latest-session entries are a subset of the trial, and pooled history is the union of the two wallet windows. Do not add these table totals together.',
        '- Wallet history was selected for buys below 0.01 SOL; it cannot estimate results for larger buys. Repeated trades in a mint are separate round trips, not independent market samples.',
        '- Buy size is correlated with liquidity and entry conditions. These observational buckets do not establish that changing buy size causes a higher win rate.',
        '- Sparse buckets are uncertain. Wilson 95% intervals are supplied in results.json as descriptive binomial intervals; trade dependence and selection bias remain.',
        '- Wallet net excludes refundable rent and includes filled-transaction fees, but omitted failed/probe costs are not allocated. Paper fees and exits remain modeled assumptions.', '']
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('latest_history', type=Path)
    parser.add_argument('older_history', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    current, metadata = current_rows(args.snapshot)
    history = history_rows(args.latest_history, args.older_history)
    latest_start = metadata['sessions'][-1]['started_at'] if metadata['sessions'] else None
    groups = {'current_trial_all_entries': current}
    if latest_start is not None:
        groups['current_latest_session_entries'] = [r for r in current if r['opened_at_ms'] >= latest_start * 1000]
    for source in ['wallet_nov4', 'wallet_oct26']:
        groups[source] = [r for r in history if r['source'] == source]
    groups['wallet_history_pooled'] = history
    groups['wallet_history_curve_only'] = [r for r in history if r['venue'] == 'curve']
    sources = {name: {'path': str(path.resolve()), 'sha256': sha256(path)} for name, path in
               [('snapshot', args.snapshot), ('latest_history', args.latest_history), ('older_history', args.older_history)]}
    result = {'created_utc': datetime.now(timezone.utc).isoformat(), 'sources': sources,
        'size_basis': 'principal_before_swap_and_network_fees', 'current': metadata,
        'latest_session_start_utc': utc(latest_start), 'datasets': {name: breakdown(rows) for name, rows in groups.items()}}
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
    (args.output / 'trades.json').write_text(json.dumps(current + history, indent=2) + '\n')
    (args.output / 'report.md').write_text(report(result))
    print(json.dumps({'output': str(args.output), 'current': metadata,
                      'totals': {name: data['total'] for name, data in result['datasets'].items()}}, indent=2))


if __name__ == '__main__':
    main()
