# Mayhem Candidate Collector

Read-only Node.js/SQLite research collector. No wallet, orders, private keys, or AMM trading. Requires Node **22.13+**; this Node release labels `node:sqlite` experimental.

## Run

```sh
npm install
# Keep your existing .env; add HELIUS_API_KEY if necessary.
npm test
npm start
```

Stop with Ctrl+C. SQLite persists across restarts. Run only one writer/collector for a database. `npm run report` can read it concurrently.

```sh
npm run inspect -- 9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump
npm run report
# Machine-readable output without npm's banner:
node src/cli.js report > report.json
```

`inspect` is a bounded, read-only network probe: current accounts plus up to 20 recent state-account transactions, stopping at the latest successful Mayhem trade. It does **not** enroll the mint, insert candidates, or assert that the bot is paused. Usage counters are persisted. `start` monitors new creations from its start time, not every historical mint. Restart recovery backfills downtime.

## Rules

Defaults are in `.env.example`; do not overwrite your real `.env`.

- A dedicated async worker repeatedly queries SQLite for monitoring rows where at least **600 seconds have passed since `last_check_at`**, processes them, then sleeps **1.5 seconds**. It uses no per-mint timers and does not overlap evaluations. Retry backoff (`next_check`) is also respected; RPC load can delay actual processing.
- First evaluation: creation + **600 seconds**. Only recently active mints are checked again **600 seconds after the evaluation** (10 minutes); infrastructure failures retry separately.
- Once a mint qualifies as a candidate, mark it `qualified` and **permanently stop its scheduled RPC checks**, even if Mayhem trades resume. Existing candidates also stop polling after upgrading. Activity is refreshed from RPC history at each check, and observation closes at terminal classification; there is no ongoing trade feed.
- Observe until creation + **24 hours** or detection of graduation. Graduation is detected by curve state while polling; detection time is not guaranteed to be its exact on-chain time. Graduated tokens are excluded from candidate evaluation. After qualification, no further liquidity/market-cap/graduation snapshots are fetched; durations reflect history through the final check, not later bot activity. Creation recovery can still encounter an already-recorded mint.
- Trade age **≤20 seconds**: active/recently trading; retry in 10 minutes.
- Trade age **>20 and ≤1,200 seconds**: candidate only when market cap is **0.04–0.5 SOL inclusive**, and real curve liquidity is **strictly >0.005 SOL**. Financial filter failures are saved in `unqualified` with all failing reasons (`market_cap_below_min`, `market_cap_above_max`, `liquidity_at_or_below_min`) and **never rechecked**.
- Trade age **>1,200 seconds**: record in `long_inactive`, with market cap, liquidity and filter result, irrespective of those filters, then **permanently stop polling**. Later activity is not tracked and never restarts checks.
- Each check requests the **latest 20 signatures** for the mint's Mayhem state account, inspects successful transactions newest first, and stops at the first verified Mayhem buy/sell for that mint. Failed transactions count toward the 20-entry window but are not fetched; cached transactions are reused. No older pages are fetched for evaluation.
- No successful Mayhem trade **in that window**: saved in `no_trades`; **never rechecked**. Older cached trades do not override this result. It does not mean the bot never traded. Missing transactions, malformed responses, truncated logs and RPC failures defer the check instead. The internal legacy category remains `never_traded`, but new evaluations record `history_scope=latest_20_transactions`, and reports give reason `no_mayhem_trade_in_last_20_transactions`.
- At most one candidate and one long-inactive summary per mint. Both are terminal polling outcomes, so newly collected mints enter only one; historical records from earlier policies can overlap.

A successful **Pump TradeEvent emitted inside a Mayhem program invocation** qualifies as a Mayhem trade. Ordinary buys/sells, account touches, failed transactions, and Mayhem-enabled flags do not qualify by themselves. Invocation ancestry matters, not just whether a transaction mentions both programs. The decoder uses the public Pump event prefixes and refuses truncated/missing logs rather than claiming complete history.

Market cap is the indicative virtual-reserve price times total curve supply, in SOL. Real liquidity is the curve's real SOL reserve field—not its account balance or virtual SOL reserve. Non-native-SOL quotes are rejected. These are on-chain snapshots, not guaranteed executable prices.

## Database

Default: **one database**, `data/collector.sqlite`, WAL mode. All categories below are tables in that same database, never separate category databases. Earlier smoke-test databases under `data/` are unused test artifacts, preserved rather than silently deleted or merged into real statistics.

| Table/view | Purpose |
|---|---|
| `mints` | Creation time, Mayhem/curve addresses, `last_check_at`, next check, observation deadline, errors, state snapshot |
| `mayhem_trades` | Successful bot trades, deduplicated by transaction signature and event log index |
| `mayhem_activity` | Creation baseline, sampled first/last trade, observed trade count and observation end |
| `activity_durations` | `last-first` trading span and `last-creation` duration |
| `evaluations` | Historical observations, raw state bytes, slot, liquidity, cap, category and history search scope |
| `candidates` | Unique mint's first qualifying evaluation |
| `no_trades` | Terminal no-successful-trade observation and evaluation reference |
| `unqualified` | Terminal financial-filter failure, evaluation reference and JSON reason list |
| `long_inactive` | Unique mint's first/latest stale observation and last recovery time |
| `queue`, `processed`, `cursors` | Durable event ingestion, replay deduplication and pagination checkpoints |
| `coverage` | Process sessions, disconnects and backfill records |
| `usage` | RPC attempts by method/day and received WebSocket payload bytes |

`mints.last_check_at` starts at the on-chain creation timestamp as a scheduling baseline (not proof of a completed RPC check). Each successful evaluation updates it; only active mints remain eligible at `last_check_at + 600`. RPC failures leave it unchanged and schedule a retry separately. The existing mint/account row is updated, not deleted/reinserted. Existing databases automatically backfill it from the latest evaluation, or creation time if never evaluated.

The long-inactive table is a per-mint summary, not a complete pause-episode ledger. Evaluations and trades preserve the observations underneath it. `initial_state_base64` means the first fetched state, **not a reconstructed creation-slot state**.

Durations use **creation as the assumed activation/first-trade time**: `first_trade_at = created_at`; `observed_first_trade_at` preserves the earliest successful bot trade actually collected, **not necessarily the bot's true first trade**. `trade_count` is the number of stored observed events, not total lifetime trades. `trading_span_seconds` and `last_trade_age_from_creation_seconds` both equal `last_trade_at - created_at`. This is a sampled, assumed-baseline activity span, not cumulative uptime. The baseline does not increment trade count or invent a last trade. With no trade ever collected, duration stays null; an older stored trade can leave a historical duration even when the current window yields `no_trades`. Evaluation decisions use only the current window, not that aggregate. Legacy `history_complete` flags are retained but are not set by bounded checks or treated as coverage failures. Reports group evaluations by `history_scope`; pre-upgrade evaluations are labeled `legacy`. The 24-hour horizon is a research cutoff, not a verified bot shutdown flag.

## Recovery and coverage

One enhanced creation-discovery subscription delivers transaction logs. Successful Mayhem creation events are committed using on-chain event timestamps. A bounded recent-transaction search runs through RPC when a mint is due. Malformed/truncated discovery notifications enter a retry queue. After the account snapshot, the collector checks the latest signature again; a changed head defers classification to avoid using an outdated trade. Errors within the sampled window are not interpreted as inactivity; trades outside it are deliberately not searched.

### Creation discovery subscription

Discovery now follows the separate `analyze_5K3N/mayhem_pattern/src/live.js` implementation: one enhanced Helius `transactionSubscribe` using `accountRequired: [MAYHEM, MINT_AUTHORITY]`, `failed: false`, `vote: false`, full JSON-parsed details and transaction version 1. This collector uses **confirmed** rather than the reference's processed commitment. The decoded CreateEvent must still have `is_mayhem_mode=true`; ordinary creations can match the address filter.

**There is no global Mayhem trade subscription and no global Mayhem backfill.** Reconnection recovery scans mint-authority history for missed creations. Each due mint's state-account history supplies actual successful Mayhem trades via RPC. After a terminal classification, activity observation closes at that check; durations/trade counts are not continuously refreshed afterward.

The live 12-second subscription check was acknowledged by Helius and received **8 transactions, 4 accepted Mayhem creations, 230,804 bytes**. This confirms the endpoint works with the configured key, and that the address filter is not an exact Mayhem-enabled flag filter. Enhanced subscription availability depends on the Helius plan; subscription errors do not silently fall back to the old global feeds.

On startup/reconnect, address-history backfill covers the downtime for the mint-authority PDA only. Creation history includes non-Mayhem creations, so recovery still fetches some irrelevant transactions. If Pump changes creation accounts, this filter must be revisited. Logs can be large, and provider retention or inaccessible/truncated history may leave a mint unclassifiable. No system here promises exhaustive coverage under arbitrary throughput or failures. Review backlog, due-check lag, errors and coverage before trusting daily counts. A crash can lose the last few seconds of usage counters but persisted queue entries survive.

## Daily counts

`report` includes UTC discovery-day counts, creation-day cohorts, candidate lists, prolonged inactivity, overlap, coverage, and usage. Zero-candidate days are included only when actually observed; days before collection are not invented. The mean/median/range use complete UTC days meeting the report's coverage checks. Creation cohorts remain provisional through their observation horizon. Late recovery can shift first discovery to a later day; it cannot recover a missed historical liquidity/price snapshot. Run for at least 7–14 complete days before interpreting the average.

## Helius usage and capacity

According to [Helius credit documentation](https://www.helius.dev/docs/billing/credits), checked during implementation:

- These standard RPC methods: **1 credit/request** (`getTransaction`, `getSignaturesForAddress`, `getMultipleAccounts`).
- Standard WebSocket: **2 credits per 0.1 MB** before compression, or approximately **20,000 credits per GB** (decimal units).
- Provider dashboard billing is authoritative. Pricing can change; retries and error requests may not be billed exactly like the local estimate.

The collector records RPC attempts and received, decompressed WebSocket payload bytes. `report.usage` gives a local credit estimate. WebSocket traffic now includes full creation-discovery transactions matching the AND filter, including ordinary creations rejected locally. There is no global Mayhem-trade stream.

### Short live measurement

The current discovery-only smoke test received **230,804 bytes over ~12 seconds**. At unchanged traffic this would extrapolate to ~1.66 GB/day or ~33,000 streaming credits/day. This is only a short sample, not a reliable daily forecast. The earlier two-feed measurements no longer describe this architecture. RPC transaction-history costs increase because normal trades are no longer ingested live.

### Estimate formula

A stable completed evaluation uses **3 base RPC requests**: one signature list (`limit: 20`), one account snapshot and one latest-signature race check (`limit: 1`). Add **0–20 `getTransaction` requests**, stopping at the first verified bot trade and reusing cached transactions. Thus the evaluation costs approximately **3–23 credits before retries** under the pricing assumption above. If the newest transaction is an uncached successful bot trade, it costs **4 credits**. Successful complete creation notifications are decoded directly.

```text
RPC requests/day ≈ 3 × completed evaluations/day
                 + uncached sampled transactions fetched/day
                 + creation-recovery requests
                 + failed/deferred evaluation requests and retries

WebSocket credits/day ≈ received_GB/day × 20,000
```

| Completed evaluations/day | Newest entry is an uncached bot trade | Full 20 uncached entries searched |
|---:|---:|---:|
| 100 | ~400 credits | ~2,300 credits |
| 1,000 | ~4,000 credits | ~23,000 credits |
| 10,000 | ~40,000 credits | ~230,000 credits |

These exclude creation recovery, retries and streaming. **3–23 is not an all-in cap**: changing history or infrastructure errors can cause repeated attempts. A terminal first-check result has no further scheduled checks. Only active mints continue every 10 minutes; roughly 144 checks over a 24-hour horizon would cost ~576 credits when each finds a fresh bot trade immediately. Worker/network delays change actual check counts. These are scenarios, not measured mint volumes or a claim about your plan allowance. A 10-minute schedule and a 20-entry window can miss activity and qualification opportunities.

The initial implementation serializes RPC with `RPC_INTERVAL_MS=150` (at most ~6.7 requests/sec before network latency). This is deliberately conservative; sufficiently large populations still exceed capacity even with 10-minute checks. Recovery competes for that capacity. Before treating results as a whole-market daily estimate, measure traffic and backlog. Higher scale needs a higher-throughput plan and a revised concurrent/batched or streaming-account architecture—not just assuming the default loop keeps up.

Never infer a full-day opportunity count from a run whose queue or due-check lag keeps growing. No paid continuous run is started automatically by installation or tests.

## Dependencies and tests

`npm test` uses synthetic events, mock RPC and in-memory SQLite. A live `inspect` verifies the configured Helius key and supplied mint without starting collection. `.env`, databases and logs are ignored by Git.

The pinned WebSocket dependency includes current security patches. The installed `@solana/web3.js` 1.x dependency tree still has moderate npm advisories in its transitive RPC/JSON dependencies; this project uses its public-key/PDA utilities, not its RPC client. Review `npm audit` before deployment; do not blindly apply a major-version forced fix.
