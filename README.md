# Mayhem Candidate Collector

Read-only Node.js/SQLite research collector. No wallet, orders, private keys, or AMM trading. Requires Node **22.13+**; this Node release labels `node:sqlite` experimental.

## Run

```sh
npm install
# Keep your existing .env; add HELIUS_API_KEY if necessary.
npm test
npm start
```

Stop with Ctrl+C. SQLite persists across restarts. Run only one collector per database. `npm run report` can run concurrently.

```sh
npm run inspect -- 9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump
npm run report
# Machine-readable output without npm's banner:
node src/cli.js report > report.json
```

`inspect` fetches the current state/curve accounts and shows financial screening. It does **not** look up trades, enroll the mint, insert a candidate or infer whether the bot is paused. Usage counters are persisted. `start` monitors new creations; restart recovery backfills missed creation history.

## Financial-only screening

Defaults are in `.env.example`; do not overwrite your API key. Explicit environment values override timing and financial defaults.

- First evaluation: creation + **30 seconds**.
- **No last-trade lookup or trade-age condition.** Screening makes no state-account signature requests, transaction-history requests or latest-signature race check.
- A non-graduated Mayhem mint qualifies if market cap is **2–5 SOL inclusive** and real curve liquidity is **strictly >0.005 SOL**.
- Passing mints become terminal `qualified` candidates and receive the 30-second curve observation below. They are never screened again.
- Financial failures become terminal `unqualified`, saving every failing reason: `market_cap_below_min`, `market_cap_above_max`, `liquidity_at_or_below_min`.
- Completed curves become terminal `graduated`, without fabricating a market cap from zeroed reserves.
- No new `active`, `long_inactive` or `no_trades` classifications are generated. There are **no activity-based rechecks**.
- Missing/malformed account data and RPC failures leave the mint unresolved and retry after **30 seconds**. `RECHECK_SECONDS` now controls that retry delay. Unresolved mints stop at creation + **24 hours**; this is a research cutoff, not a bot shutdown flag.
- A dedicated async worker processes due database rows serially, then sleeps **1.5 seconds**. Passes do not overlap. Queue and network load can delay actual checks.

Market cap is indicative virtual-reserve price times total curve supply:

```text
market_cap_sol = virtual_quote_reserves × token_total_supply / virtual_token_reserves / 1e9
liquidity_sol  = real_quote_reserves / 1e9
```

Real liquidity is the curve's real SOL reserve field—not its account balance or virtual SOL reserve. Non-native-SOL quotes and non-Mayhem curves are rejected. These snapshots are not guaranteed executable prices. A candidate does **not** imply that Mayhem has paused.

## Candidate price observation

Only newly qualifying mints are subscribed. One separate shared standard WebSocket uses `accountSubscribe` on each candidate's **bonding-curve PDA**, confirmed/base64—not the token mint account or full transactions. After acknowledgment, one initial `getMultipleAccounts` snapshot seeds the window; subsequent MC and liquidity come directly from notifications, without per-update RPC.

The window ends **30 seconds after qualification**, regardless of connection/snapshot delays. Independent timers unsubscribe while the screening worker awaits RPC. A reconnect resumes only the remaining window without another baseline RPC in that process. Restart recovery marks an interruption and resumes still-open windows with a fresh subscription/baseline; expired windows close incomplete, never replayed. Shutdown leaves unfinished windows durable. No AMM tracking follows graduation.

`candidates` stores screening entry MC and liquidity directly. `candidate_samples` stores accepted samples with source, slot and local receipt time. Reports derive observed peak, minimum and final MC, liquidity at peak/final, percentage changes from entry and milliseconds to peak. Entry is not mixed into sample extrema. Final means **last accepted sample**, not an exact deadline price; peak is **highest observed**, not a guaranteed on-chain maximum.

Subscription setup delay, interruption, sample count and last sample time expose quality. No samples yield null metrics, not an invented flat return. A completed window means an acknowledged, uninterrupted feed with a baseline completed before the deadline and at least one sample—not proof of exhaustive chain coverage. Lower-slot samples and late same-slot RPC snapshots after notifications are ignored. Consecutive identical same-slot payloads are deduplicated; distinct same-slot changes, including reversals, are retained in arrival order because notifications have no intra-slot transaction index. Reconnects, malformed data and missing baselines mark the window incomplete.

All observation `*_ms` timestamps use milliseconds; screening timestamps use seconds.

## Database and historical data

Default: **one database**, `data/collector.sqlite`, WAL mode. Categories are tables in that database, not separate files. Existing databases and earlier smoke-test artifacts are never silently deleted or merged.

| Table/view | Purpose |
|---|---|
| `mints` | Creation time, state/curve addresses, scheduling, status, errors and initial state snapshot |
| `evaluations` | Financial snapshots, slot, category, history scope and screening policy |
| `candidates` | Unique qualifying evaluation, entry MC/liquidity and screening policy |
| `candidate_observations` | Fixed deadline, subscription/setup times, outcome and quality flags |
| `candidate_samples` | Curve MC/liquidity samples with slot, source and receipt time |
| `unqualified` | Financial-filter failures and all reasons |
| `graduations` | Screening graduation detection with raw curve/state snapshots |
| `no_trades`, `long_inactive` | Preserved historical trade-based outcomes; no new screening entries |
| `mayhem_trades`, `mayhem_activity`, `activity_durations` | Preserved historical/incidental observed trades and sampled spans; not used for screening |
| `quarantined_transactions` | Unresolved truncated creation-recovery transactions excluded from routine retry |
| `queue`, `processed`, `cursors` | Durable ingestion, deduplication and recovery pagination |
| `coverage` | Sessions, disconnects, backfill and delayed/failed evaluation records |
| `usage`, `metadata` | RPC attempts/WS bytes and durable operational metadata |

`mints.last_check_at` starts at creation as a scheduling baseline, not proof of an RPC check. A successful evaluation updates it and is terminal. Failures preserve it and set `next_check` to the retry time. `initial_state_base64` is the first fetched state, not a reconstructed creation-slot state.

New evaluations use `history_scope=not_checked`, with **null `last_trade_at` and `trade_age_seconds`** even if old trades exist in the database. The `financial_only_v1` screening-policy JSON includes actual configured financial/timing values and explicitly says trade history is not checked. Earlier policy labels and metrics remain unchanged. On `start`, a changed policy reschedules only monitoring rows without explicit errors; existing terminal outcomes and error backoffs remain intact.

Old candidates without tracking retain their original entry metrics and `legacy` / `not_tracked` labels; they are never retroactively subscribed. Candidates from the previous tracking policy retain their observations.

Historical activity spans remain `last_trade_at - created_at`, using creation as an assumed activation baseline. These are **sampled spans, not cumulative uptime or exact bot shutdown times**. The former latest-20 scanner usually stored only the newest matching trade. Existing durations and trade counts are not rewritten. Creation ingestion can still incidentally capture valid Mayhem trade events, but the financial-only collector does not deliberately gather trade history or claim to measure current bot activity duration. Missing observed trades leave duration null, not zero. Historical `no_trades` means no match in that evaluation's sampled window, not proof the bot never traded.

## Creation discovery, recovery and coverage

One enhanced Helius `transactionSubscribe` uses `accountRequired: [MAYHEM, MINT_AUTHORITY]`, `failed: false`, `vote: false`, full JSON-parsed details and transaction version 1, at **confirmed** commitment. The decoded CreateEvent must still have `is_mayhem_mode=true`; ordinary creations can match the address filter. This follows the separate `analyze_5K3N/mayhem_pattern/src/live.js` discovery approach. Enhanced subscription availability depends on the Helius plan.

**There is no global Mayhem trade subscription or global Mayhem backfill.** Creation recovery still uses mint-authority signature history and transaction RPC. Removing last-trade screening does not remove these discovery/recovery requests. The event decoder only accepts successful Pump trade events within a Mayhem invocation when such events are incidentally present; it excludes failed transactions and failed CPI events.

Malformed/truncated discovery notifications enter the durable retry queue. RPC transactions with truncated logs are quarantined, retaining original queue times/attempts. They are not repeatedly downloaded or re-enqueued; a complete live replay can resolve them. Missing transactions/network failures still retry. Quarantine can hide missed creations and conservatively prevents clean-day averages, but it **does not block financial screening of a known mint**.

Reconnect recovery uses the actual disconnected interval, not time since a prior recovery. Pending recovery retains its earliest cutoff across restart; reconnect during an in-flight scan requires a follow-up scan. Completed signature pagination does not mean all queued/quarantined transactions were decoded. Recovery can fetch non-Mayhem creations and cannot reconstruct missed historical MC/liquidity snapshots.

No system here promises exhaustive coverage under arbitrary throughput or failures. Review backlog, due-check lag, errors and coverage before trusting daily counts. Crashes may lose the last few seconds of usage counters; durable queues survive.

## Reports

`report` includes UTC candidate counts, creation-day cohorts, candidate financial metrics/observations, policy-specific counts, historical categories, coverage and usage. The pooled mean/median/range use only full UTC days passing coverage checks and are suppressed if multiple screening policies are present. Zero-candidate days are included only when actually observed. Creation cohorts remain provisional through their observation horizon. Historical and financial-only opportunities must not be treated as the same strategy.

## Helius usage and capacity

Local estimates use the [Helius credit documentation](https://www.helius.dev/docs/billing/credits) assumptions below; actual provider dashboard billing is authoritative:

- Standard RPC methods used here: approximately **1 credit/request**.
- Standard WebSocket: **2 credits per 0.1 MB**, approximately **20,000 credits per GB** (decimal units).
- Retries and failed requests are counted locally; pricing and provider billing may differ.

A normal screening evaluation now costs **one `getMultipleAccounts` request**, including graduation detection. No per-mint `getSignaturesForAddress` or `getTransaction` requests are made. An already-expired mint costs zero RPC. A new candidate normally adds **one initial account snapshot**, then 30 seconds of account notifications. There are no active-mint repeated checks; only unresolved failures retry.

```text
RPC requests/day ≈ screening account requests
                 + candidate baseline snapshots
                 + creation-recovery requests
                 + retries
WebSocket credits/day ≈ received_GB/day × 20,000
```

At 1,000 successful first screenings/day and 100 candidates, screening/tracking baselines total roughly **1,100 RPC credits**, excluding recovery/retries and streaming. Account payload bytes are recorded as `candidate_received_bytes`; creation-discovery transactions remain the larger streaming feed. An earlier 12-second discovery-only smoke test received 230,804 bytes; that is not a reliable current daily forecast or a live verification of candidate tracking.

RPC is serialized with `RPC_INTERVAL_MS=150` (at most ~6.7 requests/sec before network latency). Recovery and candidate baselines share that queue. A baseline queued beyond its observation deadline is skipped, and missing data is never represented as a flat price. Under load, the 30-second first-check target may slip. Measure backlog rather than assuming whole-market coverage. Installation/tests do not start a paid continuous run.

## Paper trading

```sh
# Explicit opt-in; keep only one process/writer per database.
npm run paper
npm run paper-report
```

`npm start` remains monitor-only. `npm run paper` uses the same Mayhem creation discovery, but **subscribes to each newly discovered mint's curve immediately after discovery is stored**, without waiting for the 30-second financial screening or requiring a candidate row. Paper mode does not run the financial screening worker. Discovery is confirmed, not instantaneous at transaction submission; RPC-recovered creations are enrolled when recovered. A durable handoff resumes missed enrollments after a crash. Historical mints are not bulk-enrolled. Existing paper watches/positions survive upgrades and restarts. No private key, wallet loading, signing or `sendTransaction` exists in this mode. No live trades are placed.

### Strategy

- Watch until executed MC **≤0.1 SOL**, graduation, or a completed simulated round trip. No 30-second expiry or maximum watch age.
- Begin with **curve-only coverage**. Enable preprocessed coverage when observed MC is **strictly below 2 SOL** (and above the floor). Once enabled, a rebound above 2 SOL alone does not disable it.
- After **60 seconds without curve-account data changes**, disable preprocessed coverage for an unheld mint and cancel pending entries; retain its curve subscription. Identical notifications and unchanged reconnect snapshots do not reset this timer. Renewed changes below 2 SOL reactivate preprocessed coverage. This is curve inactivity, not verified Mayhem-bot inactivity.
- Held positions keep preprocessed coverage regardless of inactivity. Activation/resumption waits for subscription acknowledgement and a fresh five-slot observation window before entry. The first returning trade or a rapid drop before setup completes can be missed.
- Buy budget **0.01 SOL**, including modeled swap fees but excluding modeled network cost.
- Entry requires predicted MC **strictly >0.1 and <0.5 SOL**, and a price decline **at least 60%** from the highest executed price observed in slots `[signalSlot-4, signalSlot]`. The triggering transaction's projected post-state is the comparison price. This is an observed peak, not a guarantee every chain state was received.
- One successful paper buy per mint. Default **25 successful buys total**, persisted across restarts; pending buys reserve capacity atomically. Canceled/failed reservations release capacity. Closed positions still count toward 25. Changing settings never resets orders or positions. There is no automatic counter reset.
- Profit exit when modeled net sale proceeds for the full held token amount are **strictly >130% of modeled entry cost**, after swap and network costs and own sell price impact.
- Executed MC **≤0.1 SOL** stops new entry and requests a floor exit if holding. An illiquid exit stays open/blocked; it is not assigned fictional proceeds. The floor exit remains requested even if price subsequently rebounds.
- Graduation stops entry; an existing position remains **exit-blocked/manual attention**, not magically sold. AMM execution is outside this implementation.
- `PAPER_ENTRIES_ENABLED=false` disables entries but does not block exits. The trade cap likewise never blocks exits.

### Predictions versus hypothetical fills

The [Helius preprocessed feed](https://www.helius.dev/docs/preprocessed-transactions/preprocessed-subscribe) sends binary transaction frames **before execution** on the beta WebSocket endpoint. It has no outcome, logs, inner instructions or account states. The paper feed filters to preprocessed-enabled curve accounts plus the Pump program; curve-only watches are excluded, and it is not an unrestricted global Pump feed. Filter changes use a brief make-before-break replacement, with at most two preprocessed connections during the handover. Actual feed gaps invalidate rolling signal history; overlapping deliveries are deduplicated for strategy processing but still counted for billing.

A separate `processed` curve account feed plus slot notifications supplies executed reserve snapshots. Reconnects/overflow invalidate entry readiness; fresh baselines and five-slot history are required before entry. Old, already-applied/same-slot, duplicate, unresolved or unsupported signals are rejected and counted. Predictions are never added cumulatively to the executed reserve cache. Account notifications can still come from a fork; they are not finality guarantees.

The decoder supports **one direct `buy`, `sell`, `buy_exact_sol_in`, `buy_v3`, `sell_v3` or `buy_exact_quote_in_v3` instruction**, using the [public Pump IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json). Pinned Solana 8.5.0 codecs handle **legacy/v0/v1** wire formats. The canonical Token-2022 ID is case-sensitive (`...BqCX...`). Safe leading nonce advances and post-sell user token-account cleanup are accepted; curve-mutating extras are not. Exact-input estimates use integer rounding with the configured aggregate fee model, not an authoritative dynamic fee quote.

V0 address lookup tables resolve through a validated cache: 128 entries, 60-second TTL, two concurrent loads, at most 30 loads/minute (RPC retries may cost extra). Cold misses are skipped while tables load in the background; no delayed replay of old predictions. Owner, layout, index bounds, snapshot slot, extension visibility and deactivation are checked. Feed gaps clear the cache.

Partial fills, inventory-exhausting buys, v2 variants, v3 cashback curves, routed/CPI swaps, multiple swaps and unrecognized surrounding account effects remain **skipped**, not inferred. Coverage is still incomplete. Token-2022 extension effects are not loaded; estimates assume plain token transfers. MC uses the curve's recorded supply, not a separately fetched mint supply.

Orders initially stay **pending**, without creating a position. The reconciler waits for a confirmed successful triggering signature, fetches a subsequent confirmed curve snapshot, and rechecks bounds, drop, slippage and liquidity. Signals with unknown/failed execution, changed slots, timeout or invalidated entry conditions cancel. Entries also expire after the five-slot signal horizon. Pending orders on restart cancel as unreconciled; already-filled paper positions remain durable. All fills are **hypothetical later-state simulations**, not on-chain holdings, priority ordering guarantees or realizable returns. This conservative model may miss very short-lived opportunities.

### Cost assumptions and operating limits

`.env.example` lists paper settings. Default modeled swap fee is **200 bps**, network cost **10,000 lamports per side**, and buy/sell slippage tolerance **500 bps**. These are configurable **simulation assumptions**, not verified dynamic Pump/Mayhem fee schedules, wallet rent, tips, fee quotes or a live execution recommendation. Each order retains the complete assumption set. Entry budget includes modeled swap fees, so actual modeled reserve input can be below 0.01 SOL.

Concurrent watched mints are capped at **10** by default and at most (`PAPER_MAX_WATCHES=1..10`), including curve-only watches and held positions. Change any existing `.env` value above 10 before launch; larger values are rejected. On restart, open positions needing curve monitoring take priority, followed by the newest enrolled unheld watches. Excess unheld watches are marked `stopped` with reason `subscription_cap`; their records and metrics are retained, not deleted or automatically reenrolled. If held positions needing monitoring alone exceed the limit, startup fails before opening sockets and requires manual reconciliation. Graduated blocked positions remain recorded without curve subscriptions. This limit counts mint curves, not discovery/slot subscriptions or the temporary preprocessed handover connections.

Defaults cap queued frames at 1,000, state age at 5 seconds and pending-order lifetime at 10 seconds. Creation-time curve subscriptions cover more mints than the former candidate gate; idle preprocessed suspension reduces transaction-delivery costs but does not impose a credit budget. Quiet curve watches remain allocated and count toward the watch cap. Enrollment skipped due to limits is counted and marked handled (not retried automatically). The persistent trade count limits cumulative modeled entries, not a claim that losses cannot exceed principal once fees are considered. No maximum holding timeout is imposed; positions can remain blocked/open indefinitely when no exit is available.

Preprocessed delivery costs **0.1 credit per delivered transaction** according to Helius documentation; it is counted separately from byte-based standard WebSocket traffic. Status reconciliation and fresh fill snapshots add RPC usage beyond monitoring. A shared serialized RPC queue can miss short windows; it now holds at most 100 waiting requests, rejects overflow, and removes canceled or expired work immediately. Paper baselines have a five-second deadline and are canceled on replacement, removal, reconnect or shutdown. Standard reconnect backoff resets only after slot and all requested account subscriptions acknowledge. These bounds reduce recovery amplification; they are not proof of the prior OOM's exact cause or a guarantee against provider limits. Monitor pending/canceled orders and queue counters before interpreting results. Paid-plan access is required. Tests do not start feeds or consume live RPC credits.

`paper-report` lists assumptions, capacity, order counts, positions, realized simulated P&L per closed position, blocked exits, rejection/gap counters, and each active watch's preprocessed eligibility and last curve-change time (eligibility is not proof of a live connection). SQL tables are `paper_discoveries`, `paper_watches`, `paper_signals`, `paper_orders`, `paper_positions`, and `paper_counters`, in the same database as monitoring records. Raw quantities/costs use decimal integer strings; paper timestamps use milliseconds. Historical monitoring records are preserved.

`paper-report` also exposes `frames_processed`, `projections_decoded`, and recent rejection metadata. Subscription failures retain only the subscription method and numeric provider error code in those bounded samples, never raw error messages. The aggregate `stale_or_already_executed` outcome remains, with separate `stale:slot_behind`, `stale:slot_ahead`, `stale:slot_heartbeat_stale`, `stale:reserve_stale`, and `stale:already_applied` counters; multiple causes can apply to one signal. `paper_signals.detail` records the associated slots and ages. `rpc_queue` usage counters describe overflow/cancellation/expiry events, not billed RPC calls. `paper_rejections` retains at most 100 samples with public signature/slot and bounded program/discriminator metadata, never full raw frames or RPC error strings. Zero orders with zero decoded projections is a decoder-coverage failure, not evidence of no opportunities. The two public confirmed transaction fixtures test actual legacy/v1 layouts offline against synthetic reserves; they are not historical signal/fill replays.

## Dependencies and tests

`npm test` uses synthetic events, mock RPC/WebSockets/clocks and SQLite. Tests cover financial-only evaluation without history calls, filter boundaries, retry/terminal behavior, legacy preservation, creation recovery and candidate-window lifecycle. `.env`, databases and logs are ignored by Git.

The pinned WebSocket dependency includes security patches. The installed `@solana/web3.js` 1.x tree still has moderate transitive RPC/JSON advisories; this project uses its public-key/PDA utilities, not its RPC client. Review `npm audit` before deployment; do not blindly apply a forced major-version upgrade.
