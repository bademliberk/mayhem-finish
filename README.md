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

### Controlled paper trials

Normal `npm run paper` keeps the baseline strategy. Opt-in trials use separate databases under `data/paper-trials/`; they do not reuse `DB_PATH`, reset existing holdings, or replay historical discoveries.

| Profile | Curve watches | Drop / lookback | Entry-quality gate |
| --- | ---: | --- | --- |
| `baseline` | 10 | 60% / 5 slots | Measurements only |
| `coverage20` | 20 | 60% / 5 slots | Measurements only |
| `liquidity20` | 20 | 60% / 5 slots | Enabled |
| `drop50` | 20 | 50% / 5 slots | Enabled |
| `window8` | 20 | 60% / 8 slots | Enabled |
| `liquidity-exit100` | 20 | 60% / 5 slots | Enabled; also adds persistent liquidity-risk exits |
| `agent-sell-liquidity` | 20 | Confirmed Mayhem sell; no drop gate | Enabled; liquidity-sized budget, risk and timeout exits |

```sh
# Start ONE selected trial (uses the Helius key already in .env).
npm run paper:trial -- liquidity20
# Read-only comparison; missing trial databases are reported, not created.
npm run paper:compare
npm run paper:compare -- baseline liquidity20 drop50
# A distinct experiment directory preserves earlier results.
PAPER_TRIAL_DIR=data/paper-trials-v2 npm run paper:trial -- drop50
```

Each profile has its own persisted buy cap, positions and usage. Existing profiles default to 25 successful buys; `MAX_TRADE_COUNT` can configure a different cap before creating a fresh trial. `liquidity-exit100` pins its cap to 100 regardless of `MAX_TRADE_COUNT`. Legacy profiles pin their watch limit regardless of `PAPER_MAX_WATCHES`; the agent profile instead accepts `PAPER_AGENT_MAX_WATCHES` (default 20, range 1–1000). Full nonsecret configuration is persisted; mismatched resumes or populated non-trial databases are rejected. Use the same `PAPER_TRIAL_DIR` when reporting a custom experiment. Keep only one writer per trial database. Do not stop an existing paper process with open holdings just to switch trials: a separate trial does not monitor those holdings. Starting multiple trials creates **independent paid feeds**, duplicating discovery traffic and potentially overlapping curve/preprocessed deliveries; no shared-feed experiment runner or automatic launching is provided. Sequential runs differ in market conditions, and concurrent runs still have different admission/latency; this is not a randomized same-feed comparison.

All entries record an isolated post-buy/full-sell round-trip model without changing shared reserves. Guarded profiles initially require pre-buy real SOL >= **twice the swap budget** (0.02 SOL at the legacy fixed 0.01 SOL budget), positive modeled net exit proceeds, and immediate round-trip loss <= **10%**, including modeled swap and network fees both ways. `PAPER_MIN_LIQUIDITY_MULTIPLE` (integer 0–100, default 2) and `PAPER_MAX_ROUND_TRIP_LOSS_BPS` (0–10000, default 1000) can tune those experimental thresholds in a fresh directory. Checks run at signal and confirmed fill; quality rejection reasons are visible in the funnel. These starting thresholds are not empirically optimized and cannot prevent later liquidity depletion. Baseline/coverage20 collect the same measurements without gating entry. For the legacy drawdown profiles, buy budget, profit/floor thresholds and no-holding-timeout behavior are unchanged. `agent-sell-liquidity` instead uses the dynamic budget and holding deadline described below. Window8 extends entry history only: projection freshness and signal validity retain five-slot limits.

`liquidity-exit100` is a separate **paper-only experiment**, not a change to existing profiles. It requests a full-position exit when observed real SOL reserves fall to **at most twice the position's modeled gross sale proceeds**. This compares BigInt reserves against gross output, not net proceeds or entry cost. Once triggered, the exit intent persists even after a rebound, order cancellation, feed gap or restart. Floor exits take priority; liquidity-risk exits override discretionary profit orders. Confirmed reserves, full-exit liquidity, order deadlines and slippage checks still apply. A drained curve remains open/blocked, never assigned invented proceeds. This policy may realize losses earlier and cannot guarantee an exit before abrupt depletion. It adds no partial sells, AMM execution or holding timeout.

```sh
# Future explicit launch after deploying the tested code; not run by installation/tests.
PAPER_TRIAL_DIR=data/paper-trials-exit-v1 npm run paper:trial -- liquidity-exit100
PAPER_TRIAL_DIR=data/paper-trials-exit-v1 npm run paper:compare -- liquidity-exit100
```

Use a fresh directory for a new cohort; never change an existing trial's stored identity or copy its positions into this experiment. The 100-buy ceiling does not guarantee 100 fills: unresolved holdings still consume admission capacity. Reaching the cap stops entries, not exit management. Historical profiles retain their exact configuration identity and do not acquire this exit policy on upgrade.

Reports include closed-only win rate, average wins/losses, realized expectancy and drawdown, open cost basis, an explicitly hypothetical zero-recovery scenario, order/signal funnels and estimated credits per filled buy. Metrics cover the entire database, not only the latest process session; compare observation dates and unresolved positions as well as wins. Realized drawdown is not marked-to-market equity drawdown. Saved quotes are not live executable prices. Synthetic tests establish mechanics, not profitability. Rebound entries and changes to legacy drawdown sizing/profit targets remain deferred. The confirmed agent-sell profile below uses decoded event ancestry, not speculative CPI/multi-swap projection.

### Confirmed agent-sell liquidity trial

`agent-sell-liquidity` is an isolated, opt-in **paper-only** strategy. The existing default and legacy profiles retain their rules and configuration identities. It tests an association observed in a selected wallet's latest 40 traded tokens: all 58 sampled curve buys followed a Mayhem-agent sell within 0–2 slots, and 55 budgets matched 12% of post-sell real SOL. That selected sample does **not** establish an exact wallet algorithm, a universal budget cap, profitability or an exact replication. Confirmation latency, watch selection and missed deliveries can change which opportunities this implementation sees.

```sh
# Example for a future explicit paid-feed run; do not start merely to install or test.
PAPER_TRIAL_DIR=data/paper-trials-agent-v1 npm run paper:trial -- agent-sell-liquidity
# Read-only report for that isolated directory.
PAPER_TRIAL_DIR=data/paper-trials-agent-v1 npm run paper:compare -- agent-sell-liquidity
```

No live trading, signing, transaction submission or AMM execution is enabled. The launch command does start provider feeds and can incur charges; neither documentation nor offline tests authorizes or starts a paid run. Keep one writer per trial database and use a fresh directory to change assumptions. Separate trials are not synchronized A/B experiments: they have independent subscriptions, admission, latency and possibly different market periods.

**Existing agent trials: explicit offline policy migration.** The terminal-liquidation policy uses configuration version `agent_sell_liquidity_v3_terminal_exit`. Resuming a saved v1 or `agent_sell_liquidity_v2_event_only` trial is rejected rather than silently changing its assumptions. Legacy profile identities are unchanged. To retain an existing agent trial's holdings, stop **all processes writing to that trial**, keep the same `PAPER_TRIAL_DIR` and otherwise identical configuration, then explicitly run:

```sh
npm run paper:trial -- agent-sell-liquidity --migrate-exit-policy --confirm-offline
```

This command performs only a one-time v1-to-v3 or v2-to-v3 migration and exits without starting feeds or liquidating holdings. `--confirm-offline` is your assertion that writers are stopped, not an automatic process check. It preserves positions, watch state, historical orders/quotes and any prior v1-to-v2 audit, cancels old pending orders with `exit_policy_migration`, and records a new old/new configuration, timestamp and order boundary. Reports expose the chronological history as `policyMigrations`; aggregate performance after migration spans **multiple policies**, not a pure terminal-liquidation trial. Other configuration changes—including buy-count, exposure or watch limits—are rejected by this migration. Restarting the trial afterward is a separate, explicit paid-feed action. Do not move to an empty directory merely to bypass the version check while leaving holdings behind.

**Entry and coverage.** The default watch limit is **20** mints; set `PAPER_AGENT_MAX_WATCHES=1000` for up to **1,000** (allowed range 1–1000). This includes held positions. Higher limits increase WebSocket traffic, baseline RPC backlog and memory use; provider capacity at 1,000 watches is not live-tested. This setting changes the saved trial identity and cannot silently apply to an existing trial. Entry requires a successful **confirmed** Pump sell emitted under actual Mayhem invocation ancestry, with every ancestor succeeding and complete, correctly nested, non-truncated logs. A Mayhem-enabled mint or an unrelated Mayhem invocation in the same transaction is not enough. Within one transaction the last qualifying sell per mint wins; a last sell missing usable reserves invalidates the quote rather than falling back to an earlier sell. Buy events never trigger entry. Distinct sell transactions in the same slot have unknown order: cancel the pending entry and skip that ambiguous slot, resuming on a higher sell slot. A newer sell supersedes an older pending buy, including during reconciliation.

The scoped confirmed transaction feed requires Mayhem and includes watched curves; there is no transaction subscription when no curves are watched. Curve accounts also use **confirmed** commitment in this profile. It does not connect to the preprocessed endpoint or use speculative transaction projection. Creation discovery remains unchanged. Recovered/backfilled trades and saved triggers never generate entries; gaps cancel pending buys and require fresh baselines plus acknowledged live coverage. Valid native-SOL Mayhem account state establishes eligibility/supply; it does not replace the event's post-sell reserves. There are **no market-cap activation, entry floor/ceiling, peak/drop or market-cap-floor exit gates**.

**Sizing.** Real reserves size the swap; virtual reserves determine the curve quote. Freeze the lamport budget at signal time using integer flooring:

```text
budget = min(maxSwapBudgetLamports, eventRealSolLamports * fractionBps / 10000)
```

| Setting | Default | Environment override |
| --- | ---: | --- |
| Concurrent watched mints (1–1000) | 20 | `PAPER_AGENT_MAX_WATCHES=20` |
| Fraction of post-sell real SOL | 12% | `PAPER_AGENT_FRACTION_BPS=1200` |
| Maximum swap budget | 0.01 SOL | `PAPER_AGENT_MAX_SWAP_LAMPORTS=10000000` |
| Minimum real SOL at signal and fill | 0.01 SOL | `PAPER_AGENT_MIN_REAL_SOL_LAMPORTS=10000000` |
| Open entry cost plus pending-buy reservations | 0.05 SOL | `PAPER_AGENT_MAX_EXPOSURE_LAMPORTS=50000000` |
| Holding deadline from confirmed entry-fill snapshot | 80 slots | `PAPER_AGENT_HOLD_SLOTS=80` |
| Net profit target | +30% | `PAPER_AGENT_PROFIT_BPS=3000` |
| Full-sale gross liquidity-risk multiple | 2× | `PAPER_AGENT_EXIT_MULTIPLE=2` |
| Modeled swap fee | 125 bps | `PAPER_SWAP_FEE_BPS=125` |

These are configurable experimental choices, not inferred wallet parameters. An explicit `PAPER_SWAP_FEE_BPS` wins, including `200` already present in an existing `.env`; with no override, legacy profiles still use 200 bps and this profile uses 125 bps. No minimum agent sell-size threshold is imposed.

The frozen budget includes modeled swap fees but excludes network fees and refundable rent. It never increases or resizes at fill: cancel if fresh confirmed liquidity is below the minimum or its allowed fraction no longer supports the original budget. Entry-quality gates require a modeled full exit, positive net proceeds, the configured liquidity multiple and at most **10% modeled round-trip loss** by default. Recheck quality and token slippage at confirmed fill. Buys that would exhaust real token inventory are rejected: they would complete the curve, so a subsequent bonding-curve exit cannot be assumed. Pending buys reserve budget **plus modeled network fees**; open positions contribute actual entry cost. Pending sells do not release exposure. Thus five 0.01 SOL buys can exceed the 0.05 SOL exposure cap once fees are counted. Exposure is checked atomically at admission and again at fill.

The existing successful-buy limit, one successful entry per mint, network-fee/slippage assumptions, **five-slot signal validity** and **10-second order TTL** still apply. The reconciler reconfirms the actual signature and exact signal slot, then requires a confirmed reserve snapshot at least as new as the trigger and latest account observation. Newer sells invalidate pending entry decisions. Account updates invalidate an in-flight snapshot from the same or an older slot; a strictly newer confirmed snapshot can supersede them. The confirmed snapshot slot must itself remain inside the signal horizon, even when the local slot feed lags. A filled entry retains its confirmed account observation so older pre-entry data cannot trigger a false risk exit. No prior-slot projection fallback or peak-history warm-up applies here.

**Exits and restart.** Account updates evaluate the +30% net profit target and the **2× full-sale-gross liquidity-risk guard**; slot/tick progress evaluates the **80-slot holding deadline**, even without trades or changing account data. Priority is **graduation > timeout > liquidity risk > profit**. Timeout and liquidity-risk intents persist through rebounds, cancellation, feed gaps and restart. Profit exits still require a profitable full sale and normal sell slippage checks.

Under v3, mandatory exits use **terminal paper liquidation**: sell the largest token quantity whose rounded curve proceeds are supported by freshly confirmed real SOL, model burning the remainder, and close the modeled account/position. The final supported quantity is recomputed from the accepted confirmation. **Mandatory liquidation accepts that confirmed recovery even when it is below the earlier quote; it does not apply the ordinary whole-position proceeds slippage threshold.** Entry-quality checks remain strict full-exit checks. Swap fees apply only to tokens sold, and one configured network fee models the combined sell/burn/close operation. There is no rent credit. Recovery after fees may be negative.

A mandatory exit with stale, missing or invalid reserves becomes an explicit **zero-recovery write-off**, not a sale estimated from old reserves. Zero/dust liquidity burns the full modeled balance; graduation is also written off with no AMM proceeds. These are paper assumptions: no actual tokens are burned, no account is closed on-chain and no transaction is submitted. Reports record sold/burned quantities, recovery, fees and write-off reasons. `written_off` orders are distinct from sell fills; their losses count in total P&L, win/loss statistics and drawdown. Terminal settlement releases exposure once and stops that holding's subscriptions.

**There is no fallback account polling.** Initial/reconnection baselines and confirmed RPC reads for event-authorized sale attempts remain. An accepted live account notification or subscription baseline authorizes at most one mandatory attempt; internal confirmation snapshots do not create another authorization. Ticks can settle a zero-recovery loss, but cannot repeatedly fetch reserves. A stale cache does not preempt an in-flight confirmation before its normal deadline. Account validity, position identity, snapshot ordering, TTL, gap/shutdown and late-response protections remain. Existing bounded transport retries remain separately billable.

Restart cancels pending orders, retains positions/deadlines/intents and never replays entry triggers. An empty startup cache alone does not trigger liquidation of ordinary holdings. Restored mandatory exits get up to one order TTL (10 seconds by default) for an initial baseline; without usable data after that grace, they are written off without an extra fetch. Known graduated holdings need no baseline and receive zero-recovery closure. This deliberately differs from the v1/v2 policy of keeping blocked positions unresolved indefinitely.

Modeled results omit refundable rent and costs of real failed/non-filled attempts, and do not model guaranteed ordering or execution. Reports should be interpreted using each run's saved assumptions, trigger/fill reserves, budgets, costs, exposure, delay/cancellation evidence and unresolved holdings—not current environment values or realized wins alone. The small sampled association, confirmed-feed delay and independent trial coverage prevent a claim of exact wallet replication or proven returns.

### Partial discovery recovery

For successful transactions with truncated logs, discovery can recover only creation events whose emitting invocation and every ancestor demonstrably completed successfully before the first truncation marker. Failed/open scopes, malformed nesting and partial trades are not inferred. Recovered creations are persisted alongside quarantine rather than marking the transaction fully processed; incomplete history remains visible. A later complete replay deduplicates existing creations and can resolve quarantine. This upgrade does not automatically replay the historical quarantine or bulk-enroll old mints.

`partial_creations` records each recovered event and its eventual resolution. Usage counters under source `recovery` distinguish `partial_creations_new` from `partial_creations_duplicate`; these are diagnostic counts, not billed RPC calls.

### Legacy drawdown strategy

The baseline and legacy trial profiles implement a **paper-only, short-window drawdown strategy on native-SOL-quoted Mayhem bonding curves**. This section does not describe `agent-sell-liquidity`, whose confirmed trigger, sizing and exits are specified above. These strategies buy tokens using a SOL budget; they do not trade USDC-quoted curves or submit real transactions. Discovery may find unsupported assets, but discovery is not entry eligibility. `npm run paper` uses the baseline rules below; `liquidity-exit100` uses the same entry range/drop rules with entry-quality gating, 20 watches, a 100-buy cap and the additional liquidity-risk exit.

- Watch until executed MC **≤0.1 SOL**, graduation, a completed simulated round trip, or idle rotation to admit a new mint. No fixed maximum watch age.
- Begin with **curve-only coverage**. Enable preprocessed coverage when observed MC is **strictly below 2 SOL** (and above the floor). Once enabled, a rebound above 2 SOL alone does not disable it.
- After **10 seconds without curve-account data changes**, disable preprocessed coverage for an unheld mint and cancel pending entries; retain its curve subscription. Identical notifications and unchanged reconnect snapshots do not reset this timer. Renewed changes below 2 SOL reactivate preprocessed coverage. This is curve inactivity, not verified Mayhem-bot inactivity.
- When all watch slots are occupied, a new eligible discovery replaces the oldest idle, unheld watch with no pending order after at least 60 seconds without curve changes. Unsampled watches use enrollment time. The old watch is retained as `stopped` / `idle_rotation`; its curve and preprocessed membership are removed before the new curve is subscribed. Held positions, pending orders and recently changing watches are never evicted. If none is eligible, the new mint is skipped rather than queued.
- Held positions keep preprocessed coverage regardless of inactivity. Activation/resumption waits for subscription acknowledgement and a fresh five-slot observation window before entry. The first returning trade or a rapid drop before setup completes can be missed.
- Buy budget **0.01 SOL**, including modeled swap fees but excluding modeled network cost.
- Entry requires predicted MC **strictly >0.1 and <0.5 SOL**, and a price decline **at least 60%** from the highest executed price observed in slots `[signalSlot-4, signalSlot]`. The triggering transaction's projected post-state is the comparison price. **Either a buy or a sell can trigger entry**: a buy after a dump can still leave price at least 60% below the recent peak. The trigger need not itself cause the decline. This is an observed peak, not a guarantee every chain state was received.
- One successful paper buy per mint. Default **25 successful buys total**, persisted across restarts; pending buys reserve capacity atomically. Canceled/failed reservations release capacity. Closed positions still count toward 25. Changing settings never resets orders or positions. There is no automatic counter reset.
- Profit exit when modeled net sale proceeds for the full held token amount are **strictly >130% of modeled entry cost**, after swap and network costs and own sell price impact.
- Executed MC **≤0.1 SOL** stops new entry and requests a floor exit if holding. An illiquid exit stays open/blocked; it is not assigned fictional proceeds. The floor exit remains requested even if price subsequently rebounds.
- `liquidity-exit100` additionally requests a full exit when observed real SOL is **≤2× modeled full-sale gross proceeds**. Intent persists after rebounds; priority is **floor > liquidity risk > profit**. Baseline `npm run paper` does not enable this liquidity-risk exit.
- Graduation stops entry; an existing position remains **exit-blocked/manual attention**, not magically sold. AMM execution is outside this implementation. There is no partial exit or maximum holding timeout.
- `PAPER_ENTRIES_ENABLED=false` disables entries but does not block exits. The trade cap likewise never blocks exits.

### Legacy predictions versus hypothetical fills

The following projection path applies only to the legacy drawdown profiles, not `agent-sell-liquidity`.

The [Helius preprocessed feed](https://www.helius.dev/docs/preprocessed-transactions/preprocessed-subscribe) sends binary transaction frames **before execution** on the beta WebSocket endpoint. It has no outcome, logs, inner instructions or account states. The paper feed filters to preprocessed-enabled curve accounts plus the Pump program; curve-only watches are excluded, and it is not an unrestricted global Pump feed. Filter changes use a brief make-before-break replacement, with at most two preprocessed connections during the handover. Actual feed gaps invalidate rolling signal history; overlapping deliveries are deduplicated for strategy processing but still counted for billing.

A separate `processed` curve account feed plus slot notifications supplies executed reserve snapshots. Reconnects/overflow invalidate entry readiness; fresh baselines and five-slot history are required before entry. Old, duplicate, unresolved or unsupported signals are rejected and counted. If the latest reserve observation is in the signal's slot, projection uses the latest observed reserve snapshot strictly before that slot, within the five-slot horizon and freshness limit. Missing usable prior state or a latest observation from a later slot still rejects the signal. This `isolated_prior_slot` model applies the swap once to earlier reserves; it does **not** reconstruct intervening transactions or exact within-slot ordering. Entry peak references for this fallback exclude same-slot observations to avoid look-ahead. The order quote records `projectionBase` and the counter `projection_prior_slot_fallback` records accepted fallback processing. Predictions are never added cumulatively to the executed reserve cache. Account notifications can still come from a fork; they are not finality guarantees.

The decoder supports **one direct `buy`, `sell`, `buy_exact_sol_in`, `buy_v3`, `sell_v3` or `buy_exact_quote_in_v3` instruction**, using the [public Pump IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json). Pinned Solana 8.5.0 codecs handle **legacy/v0/v1** wire formats. The canonical Token-2022 ID is case-sensitive (`...BqCX...`). Safe leading nonce advances and post-sell user token-account cleanup are accepted; curve-mutating extras are not. Exact-input estimates use integer rounding with the configured aggregate fee model, not an authoritative dynamic fee quote.

V0 address lookup tables resolve through a validated cache: 128 entries, 60-second TTL, two concurrent loads, at most 30 loads/minute (RPC retries may cost extra). Cold misses are skipped while tables load in the background; no delayed replay of old predictions. Owner, layout, index bounds, snapshot slot, extension visibility and deactivation are checked. Feed gaps clear the cache.

Partial fills, inventory-exhausting buys, v2 variants, v3 cashback curves, routed/CPI swaps, multiple swaps and unrecognized surrounding account effects remain **skipped**, not inferred. Coverage is still incomplete. Token-2022 extension effects are not loaded; estimates assume plain token transfers. MC uses the curve's recorded supply, not a separately fetched mint supply.

Orders initially stay **pending**, without creating a position. The reconciler waits for a confirmed successful triggering signature, fetches a subsequent confirmed curve snapshot, and rechecks bounds, drop, slippage and liquidity. Signals with unknown/failed execution, changed slots, timeout or invalidated entry conditions cancel. Entries have two separate deadlines: the **five-slot signal horizon** (valid through `signalSlot + 4`, expired at `signalSlot + 5`) and the **10-second wall-clock TTL**; whichever arrives first wins. The five-slot historical lookback, five-slot signal validity and wall-clock TTL are separate settings/concepts. Fast slot progression can leave roughly one second for confirmation and reserve checks; increasing wall-clock TTL does not extend slot validity. Slot notifications cancel expired buys even during an RPC wait, aborting their requests; every asynchronous reconciliation stage rechecks validity before more RPC or a fill. Deliberate cancellations are not provider failures. The confirmed snapshot must still be at least as new as the relevant latest processed observation; active curves may outrun confirmed snapshots and remain unfilled. This safety rule is not relaxed. Pending orders on graceful stop are canceled, and unknown pending orders on restart cancel as unreconciled; already-filled paper positions remain durable. All fills are **hypothetical later-state simulations**, not on-chain holdings, priority ordering guarantees or realizable returns. This conservative model may miss very short-lived opportunities.

### Cost assumptions and operating limits

`.env.example` lists paper settings. Default modeled swap fee is **200 bps for legacy profiles** or **125 bps for `agent-sell-liquidity`** unless explicitly overridden; network cost is **10,000 lamports per side** and buy/sell slippage tolerance **500 bps**. These are configurable **simulation assumptions**, not verified dynamic Pump/Mayhem fee schedules, wallet rent, tips, fee quotes or a live execution recommendation. Each order retains the complete assumption set. Entry budget includes modeled swap fees, so actual modeled reserve input can be below 0.01 SOL.

For baseline paper mode, concurrent watched mints are capped at **10** by default, configurable up to **20** (`PAPER_MAX_WATCHES=1..20`), including curve-only watches and held positions. Legacy named profiles pin 10 or 20 watches. The agent profile uses its separate `PAPER_AGENT_MAX_WATCHES=1..1000` setting, default **20**; larger values are rejected. On restart, open positions needing curve monitoring take priority, followed by the newest enrolled unheld watches. Excess unheld watches are marked `stopped` with reason `subscription_cap`; their records and metrics are retained, not deleted or automatically reenrolled. If held positions needing monitoring alone exceed the limit, startup fails before opening sockets and requires manual reconciliation. Graduated blocked positions remain recorded without curve subscriptions. This limit counts mint curves, not discovery/slot subscriptions or the temporary preprocessed handover connections.

Defaults cap queued frames at 1,000, state age at 5 seconds and pending-order lifetime at 10 seconds. Creation-time curve subscriptions cover more mints than the former candidate gate; idle preprocessed suspension reduces transaction-delivery costs but does not impose a credit budget. Quiet curve watches count toward the cap until an eligible new discovery rotates them out. Enrollment skipped when no idle unheld slot is replaceable or other limits apply is counted and marked handled (not retried automatically). The persistent trade count limits cumulative modeled entries, not a claim that losses cannot exceed principal once fees are considered. Legacy profiles impose no maximum holding timeout. `agent-sell-liquidity` requests a timeout exit at its configured slot deadline. Legacy and v1/v2 agent policies can remain blocked/open indefinitely when no supported exit is available; v3 agent mandatory exits instead use the terminal liquidation/write-off policy described above.

Preprocessed delivery costs **0.1 credit per delivered transaction** according to Helius documentation; it is counted separately from byte-based standard WebSocket traffic. Status reconciliation and fresh fill snapshots add RPC usage beyond monitoring. A shared serialized RPC queue can miss short windows; it holds at most 100 waiting requests, rejects overflow, and removes canceled or expired work immediately. Every call has a queue-inclusive maximum lifetime of 120 seconds (earlier caller deadlines win), with a 30-second attempt timeout covering both headers and response-body reading. Explicit cancellation races release the worker even if the transport does not settle after abort; shutdown cancels active and queued calls. `rpc_queue` usage includes expired, canceled and attempt-timeout counts. Paper baselines retain a five-second deadline. A failed baseline retries only that watch after 1, 2, 4, 8, then at most 15 seconds; it does not reconnect a healthy WebSocket. Live account notifications cancel redundant baseline requests/retries, and removal, reconnect, resync and shutdown clean them up. Failures increment the credential-free `paper_baseline / failed` usage counter. Watches without usable reserves still cannot generate paper fills. Standard reconnect backoff resets only after slot and all requested account subscriptions acknowledge. These bounds reduce recovery amplification; they are not proof of the prior OOM or stalled transport's exact cause or a guarantee against provider limits. Monitor pending/canceled orders and queue counters before interpreting results. Paid-plan access is required. Tests do not start feeds or consume live RPC credits.

Heartbeat/session updates, WebSocket usage flushing and discovery-connection bookkeeping run independently every second, not behind discovery RPC work. Metadata `discovery_started_at` and `discovery_completed_at` separately track discovery-loop progress (Unix seconds); a fresh `heartbeat` alone does not prove discovery or trading is healthy. Shutdown stops housekeeping and flushes final usage before database closure.

Reports expose `feedHealth` separately from heartbeat: discovery subscription, standard account/slot transport, the strategy's transaction transport (legacy preprocessed or confirmed agent-sell) and unfinished recovery. Bounded persisted diagnostics record attempts, failure streaks, progress/acknowledgement timestamps and next retries, with only fixed failure categories, allowlisted network codes and validated numeric status codes. URLs, credentials, raw errors, response bodies and close reasons are never retained. These diagnostics are not billed RPC usage. A process can keep heartbeating while repeatedly failing to connect; reports must not present that as healthy coverage. Old databases without these diagnostics report missing evidence, not inferred health.

Discovery requires the matching subscription acknowledgement within a deadline; stale or duplicate acknowledgements cannot complete recovery twice. Reconnects use capped backoff. Paper subscription deadlines are tied to each outstanding request so churn cannot postpone a missing acknowledgement indefinitely. A **30-second slot-progress watchdog** reconnects/rebaselines when no increasing valid slot arrives, even if the socket still pongs. Quiet individual curves or preprocessed transaction streams alone do not trigger that watchdog. Historical unfinished gaps retain their original recovery cutoff across restart; successful subscription and historical backfill are separate milestones.

A bad curve payload clears only that mint's cached reserves/history and cancels only its pending orders; other watches are not reset or reconnected. Missing, malformed and other potentially transient observations retain curve coverage for recovery; a valid observation rebuilds entry warm-up. A definitively unsupported quote or validated non-Mayhem curve with **no held position** is instead stopped and unsubscribed immediately, freeing watch capacity while retaining its fault evidence. Held positions and mandatory exit intent are always preserved; an unsupported/invalid observation never fabricates a sale. Older out-of-order payloads are ignored before validation. `account:*` counters and bounded `invalid_account` samples distinguish missing accounts, wrong owners, invalid data/layout, non-Mayhem curves and internal processing errors without retaining raw payloads or error text. `paper_watches.account_error` persists until a valid observation arrives. `paper_account_faults` separately retains the newest 100 sanitized account-fault samples, exposed as `recentAccountFaults`; decoder rejection churn cannot evict them. Fixed validation subtypes distinguish layout/length, unsupported quote mint, invalid flags and zero virtual token reserves. On upgrade, only still-retained safe legacy fault samples are copied once; missing historical details are not reconstructed.

Quote-layout evidence is pinned in [the schema fixture](test/fixtures/pump-curve-prefix.json) to official Pump revision `639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22`. Its documented curve prefix places `quote_mint` at byte 83; native SOL uses the zero public key. Wrapped SOL as a V3 **instruction account** does not authorize a wrapped-SOL quote value in the curve. Decoder acceptance remains fail-closed for nonzero curve quotes. Fault samples may include `quoteMintObserved`, a discriminator match and a documented-prefix label, not raw payloads. A 166-byte length or an observed key at that offset does not establish the historical schema. Old rows retain unknown evidence; synthetic fixture tests do not reproduce lost historical bytes.

`paper-report` includes `openPositionHealth`: holding age, entry cost, persisted/pending exit reasons, last observation/change times and ages, last observed MC, real SOL reserves, modeled full-sale gross requirement and whether a full modeled exit is supported by saved reserves. `liquidityCoverageBps` is an integer string for real reserves / gross requirement × 10,000, not a recovery guarantee. These are explicitly saved-state diagnostics, not live quotes. Performance groups unresolved exposure by exit state/reason and separates it from realized returns. Confirmed graduation overrides an older apparently liquid saved fingerprint. Missing/invalid state or insufficient liquidity is reported rather than assigned fictional exit proceeds. These diagnostics introduce no forced sale or legacy holding timeout; the agent-sell profile's explicit timeout still requires a supported full exit.

`paper-report` lists assumptions, capacity, order counts, positions, realized simulated P&L per closed position, blocked exits, rejection/gap counters, and each active watch's preprocessed eligibility and last curve-change time (eligibility is not proof of a live connection). SQL tables are `paper_discoveries`, `paper_watches`, `paper_signals`, `paper_orders`, `paper_positions`, and `paper_counters`, in the same database as monitoring records. Raw quantities/costs use decimal integer strings; paper timestamps use milliseconds. Historical monitoring records are preserved.

`recentOrders[].diagnostics` exposes bounded reconciliation evidence: slot-versus-clock expiry, last reconciliation stage, relevant slots, confirmation status, safe numeric instruction/custom error codes, and the actual cap/drop checks when a confirmed entry is rejected. Status/account elapsed times include RPC queueing and retries, not just network latency. Fixed counters expose waiting statuses and snapshots behind the required observation. The original cancellation names remain stable; a failed trigger is the observed chain transaction failing, not the app submitting a failed buy. Historical orders without evidence report `null`; read-only reports can inspect databases before migration. New signal provenance distinguishes the trigger's buy/sell side and actual selected peak slot from `quote.reference.slot`, which remains the **lookback-window start**, not necessarily the peak's slot.

`accountFaultSummary.totalEvents` counts rejected observations, not distinct mints: 100 rejected updates for one mint are 100 events. `retainedSamples` and `distinctMintsInRetainedSamples` cover only the newest 100 fault samples. They do not reconstruct the all-run number of affected mints.

`paper-report` also exposes `frames_processed`, `projections_decoded`, and recent rejection metadata. Subscription failures retain only the subscription method and numeric provider error code in those bounded samples, never raw error messages. The aggregate `stale_or_already_executed` outcome remains, with separate `stale:slot_behind`, `stale:slot_ahead`, `stale:slot_heartbeat_stale`, `stale:reserve_stale`, and `stale:already_applied` counters; multiple causes can apply to one signal. `paper_signals.detail` records the associated slots and ages. `rpc_queue` usage counters describe overflow/cancellation/expiry events, not billed RPC calls. `paper_rejections` retains at most 100 samples with public signature/slot and bounded program/discriminator metadata, never full raw frames or RPC error strings. Zero orders with zero decoded projections is a decoder-coverage failure, not evidence of no opportunities. The two public confirmed transaction fixtures test actual legacy/v1 layouts offline against synthetic reserves; they are not historical signal/fill replays.

## Dependencies and tests

`npm test` uses synthetic events, mock RPC/WebSockets/clocks and SQLite. Tests cover financial-only evaluation without history calls, filter boundaries, retry/terminal behavior, legacy preservation, creation recovery and candidate-window lifecycle. `.env`, databases and logs are ignored by Git.

The pinned WebSocket dependency includes security patches. The installed `@solana/web3.js` 1.x tree still has moderate transitive RPC/JSON advisories; this project uses its public-key/PDA utilities, not its RPC client. Review `npm audit` before deployment; do not blindly apply a forced major-version upgrade.
