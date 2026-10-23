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

- A dedicated async worker queries due monitoring rows, processes them serially, then sleeps **1.5 seconds**. Evaluations do not overlap. Retry backoff (`next_check`) is respected; RPC load can delay actual processing.
- First evaluation: creation + **30 seconds**. Only recently active mints are checked again **30 seconds after the evaluation**; infrastructure failures retry separately.
- A qualified candidate permanently stops ordinary history polling, but gets one **30-second bonding-curve account observation** (details below). Later Mayhem trades do not restart screening. Bot activity-duration tracking closes at terminal classification.
- Observe monitoring mints until creation + **24 hours** or detection of graduation. Graduated tokens are excluded from candidate evaluation. Creation recovery can still encounter an already-recorded mint.
- Trade age **≤5 seconds**: active/recently trading; recheck in 30 seconds.
- Trade age **>5 and ≤60 seconds**: candidate only when market cap is **2–5 SOL inclusive**, and real curve liquidity is **strictly >0.005 SOL**. Financial filter failures are saved in `unqualified` with all failing reasons (`market_cap_below_min`, `market_cap_above_max`, `liquidity_at_or_below_min`) and **never rechecked**.
- Trade age **>60 seconds**: record in `long_inactive`, with market cap, liquidity and filter result, irrespective of those filters, then **permanently stop polling**. Later activity never restarts checks.
- Each check requests the **latest 20 signatures** for the mint's Mayhem state account, inspects successful transactions newest first, and stops at the first verified Mayhem buy/sell for that mint. Failed transactions count toward the 20-entry window but are not fetched; cached transactions are reused. No older pages are fetched for evaluation.
- No successful Mayhem trade **in that window**: saved in `no_trades`; **never rechecked**. Older cached trades do not override this result. It does not mean the bot never traded. Missing transactions, malformed responses, truncated logs and RPC failures defer the check instead. The internal legacy category remains `never_traded`, but new evaluations record `history_scope=latest_20_transactions`, and reports give reason `no_mayhem_trade_in_last_20_transactions`.
- At most one candidate and one long-inactive summary per mint. Both are terminal polling outcomes, so newly collected mints enter only one; historical records from earlier policies can overlap.

A successful **Pump TradeEvent emitted inside a Mayhem program invocation** qualifies as a Mayhem trade. Ordinary buys/sells, account touches, failed transactions, and Mayhem-enabled flags do not qualify by themselves. Invocation ancestry matters, not just whether a transaction mentions both programs. The decoder uses the public Pump event prefixes and refuses truncated/missing logs rather than claiming complete history.

Market cap is the indicative virtual-reserve price times total curve supply, in SOL. Real liquidity is the curve's real SOL reserve field—not its account balance or virtual SOL reserve. Non-native-SOL quotes are rejected. These are on-chain snapshots, not guaranteed executable prices.

## Candidate price observation

Only newly qualifying mints are subscribed. One separate shared standard WebSocket uses `accountSubscribe` on each candidate's **bonding-curve PDA**, confirmed/base64—not the token mint account or full transaction history. After acknowledgment, one initial `getMultipleAccounts` snapshot seeds that window; subsequent MC and liquidity come directly from notifications, without per-update RPC. No candidate subscriptions are opened before qualification.

The window ends **30 seconds after qualification**, regardless of connection/snapshot delays. Independent timers unsubscribe promptly even while the screening worker awaits RPC. A reconnect resumes only the remaining window without another baseline RPC in that process. Restart recovery marks an interruption and resumes still-open windows with a fresh subscription/baseline; expired windows are closed incomplete, never replayed. Shutdown leaves unfinished windows durable. No AMM tracking follows graduation.

`candidates` stores the screening entry MC and real liquidity directly. `candidate_samples` stores accepted account samples, source, slot and local receipt time. Reports derive observed peak, minimum and final MC, liquidity at peak/final, percentage changes from entry and milliseconds to peak. Entry is not mixed into the sample extrema. Final means **last accepted sample**, not an exact deadline price; peak is **highest observed**, not a guaranteed on-chain maximum. Subscription setup delay, interruption, sample count and last sample time expose quality. No samples yield null metrics, not an invented flat return. A completed window means an acknowledged, uninterrupted feed with at least one sample—not proof of exhaustive chain coverage.

Lower-slot samples and a late same-slot RPC snapshot after notifications are ignored. Consecutive identical same-slot payloads are deduplicated; distinct same-slot changes, including reversals, are retained in arrival order because account notifications have no intra-slot transaction index. Reconnects, malformed data and failed baselines mark the window incomplete. All observation `*_ms` timestamps are milliseconds; existing screening timestamps remain seconds.

Existing candidates retain their original evaluation metrics, labeled `legacy` / `not_tracked`; they are **not** retroactively subscribed. New evaluations and candidates store a secret-free screening-policy JSON including actual configured thresholds. On `start`, a policy change reschedules only monitoring rows without explicit errors; terminal outcomes and error backoffs remain intact. Reports show policy-specific counts and suppress the pooled mean when multiple policies are present.

## Database

Default: **one database**, `data/collector.sqlite`, WAL mode. All categories below are tables in that same database, never separate category databases. Earlier smoke-test databases under `data/` are unused test artifacts, preserved rather than silently deleted or merged into real statistics.

| Table/view | Purpose |
|---|---|
| `mints` | Creation time, Mayhem/curve addresses, `last_check_at`, next check, observation deadline, errors, state snapshot |
| `mayhem_trades` | Successful bot trades, deduplicated by transaction signature and event log index |
| `mayhem_activity` | Creation baseline, sampled first/last trade, observed trade count and observation end |
| `activity_durations` | `last-first` trading span and `last-creation` duration |
| `evaluations` | Historical observations, raw state bytes, slot, liquidity, cap, category and history search scope |
| `candidates` | Unique qualifying evaluation, entry market cap/liquidity and screening policy |
| `candidate_observations` | Fixed tracking deadline, subscription/setup times, outcome and quality flags |
| `candidate_samples` | Candidate curve MC/liquidity samples with slot, source and receipt time |
| `no_trades` | Terminal no-successful-trade observation and evaluation reference |
| `unqualified` | Terminal financial-filter failure, evaluation reference and JSON reason list |
| `long_inactive` | Unique mint's first/latest stale observation and last recovery time |
| `graduations` | Detection timestamp/slot and raw curve/state snapshots; no invented market cap for zeroed reserves |
| `quarantined_transactions` | Unresolved truncated RPC transactions, original queue time, failed attempts and reason; excluded from routine retries |
| `queue`, `processed`, `cursors` | Durable event ingestion, replay deduplication and pagination checkpoints |
| `coverage` | Process sessions, disconnects and backfill records |
| `usage` | RPC attempts by method/day and received WebSocket payload bytes |

`mints.last_check_at` starts at the on-chain creation timestamp as a scheduling baseline (not proof of a completed RPC check). Each successful evaluation updates it; only active mints remain eligible at `last_check_at + 30`. RPC failures leave it unchanged and schedule a retry separately. The existing mint/account row is updated, not deleted/reinserted. Existing databases automatically backfill it from the latest evaluation, or creation time if never evaluated.

The long-inactive table is a per-mint summary, not a complete pause-episode ledger. Evaluations and trades preserve the observations underneath it. `initial_state_base64` means the first fetched state, **not a reconstructed creation-slot state**.

Durations use **creation as the assumed activation/first-trade time**: `first_trade_at = created_at`; `observed_first_trade_at` preserves the earliest successful bot trade actually collected, **not necessarily the bot's true first trade**. `trade_count` is the number of stored observed events, not total lifetime trades. `trading_span_seconds` and `last_trade_age_from_creation_seconds` both equal `last_trade_at - created_at`. This is a sampled, assumed-baseline activity span, not cumulative uptime. The baseline does not increment trade count or invent a last trade. With no trade ever collected, duration stays null; an older stored trade can leave a historical duration even when the current window yields `no_trades`. Evaluation decisions use only the current window, not that aggregate. Legacy `history_complete` flags are retained but are not set by bounded checks or treated as coverage failures. Reports group evaluations by `history_scope`; pre-upgrade evaluations are labeled `legacy`. The 24-hour horizon is a research cutoff, not a verified bot shutdown flag.

## Recovery and coverage

RPC transactions with truncated logs are **quarantined**, not repeatedly downloaded. Existing queued truncation failures migrate automatically while retaining their original queue time and attempt counts. Missing transactions and network failures still retry. Quarantined signatures cannot be re-enqueued by discovery/backfill; a valid complete live replay can resolve them. If a bounded evaluation encounters one, it remains unresolved rather than becoming `no_trades`. Reports distinguish active backlog from quarantine; unresolved quarantine conservatively excludes affected and subsequent days from clean-day averages. Quarantine does not recover missing creations.

Completed curves are recognized before reserve division and before transaction decoding. Graduation is recorded separately without fabricating a market cap from zero reserves, then polling stops. The deadline is checked before RPC, so permanently unavailable history cannot keep a mint alive past its observation horizon.

Fresh reconnect recovery uses the disconnected interval rather than time since the prior recovery. Pending recovery retains its earliest cutoff across restarts; another reconnect during a scan requires a follow-up head scan. A completed signature scan does not mean all queued or quarantined transactions were successfully decoded.

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

A stable completed non-graduation evaluation uses **3 base RPC requests**: one signature list (`limit: 20`), one account snapshot and one latest-signature race check (`limit: 1`). Add **0–20 `getTransaction` requests**, stopping at the first verified bot trade and reusing cached transactions. Thus the evaluation costs approximately **3–23 credits before retries** under the pricing assumption above. If the newest transaction is an uncached successful bot trade, it costs **4 credits**. Successful complete creation notifications are decoded directly. Graduation detection uses two requests (signature list and accounts), with no transaction fetches; an already-expired observation uses none. Truncated transactions are fetched at most once after upgrade before quarantine, unless a complete replay resolves them; quarantined entries retained from the old run require no migration fetch.

```text
RPC requests/day ≈ 3 × completed evaluations/day
                 + uncached sampled transactions fetched/day
                 + creation-recovery requests
                 + candidate baseline snapshots (normally one per new candidate)
                 + failed/deferred evaluation requests and retries

WebSocket credits/day ≈ received_GB/day × 20,000
```

| Completed evaluations/day | Newest entry is an uncached bot trade | Full 20 uncached entries searched |
|---:|---:|---:|
| 100 | ~400 credits | ~2,300 credits |
| 1,000 | ~4,000 credits | ~23,000 credits |
| 10,000 | ~40,000 credits | ~230,000 credits |

These exclude creation recovery, retries and streaming. **3–23 is not an all-in cap**: changing history or infrastructure errors can cause repeated attempts. A terminal first-check result has no further scheduled history checks. Candidates add normally one baseline RPC plus 30 seconds of compact account notifications; WebSocket usage includes these payloads separately as `candidate_received_bytes`. Only active mints continue every 30 seconds; a continuously active mint could approach 2,880 checks over 24 hours (~11,520 credits at four requests/check). Worker/network delays reduce actual check counts. These are scenarios, not measured mint volumes or a claim about plan allowance. A 30-second schedule and 20-entry window can still miss activity and qualification opportunities.

The initial implementation serializes RPC with `RPC_INTERVAL_MS=150` (at most ~6.7 requests/sec before network latency). This is deliberately conservative; **30-second checks make capacity more demanding**, and recovery plus candidate baselines share the serialized RPC queue. A baseline queued past its observation deadline is skipped, and a missing baseline is not represented as a flat price. Before treating results as a whole-market daily estimate, measure traffic and backlog. Higher scale needs a higher-throughput plan and a revised concurrent/batched or streaming-account architecture—not just assuming the default loop keeps up.

Never infer a full-day opportunity count from a run whose queue or due-check lag keeps growing. No paid continuous run is started automatically by installation or tests.

## Dependencies and tests

`npm test` uses synthetic events, mock RPC and in-memory SQLite. A live `inspect` verifies the configured Helius key and supplied mint without starting collection. `.env`, databases and logs are ignored by Git.

The pinned WebSocket dependency includes current security patches. The installed `@solana/web3.js` 1.x dependency tree still has moderate npm advisories in its transitive RPC/JSON dependencies; this project uses its public-key/PDA utilities, not its RPC client. Review `npm audit` before deployment; do not blindly apply a major-version forced fix.
