# DOOD transaction downloader

Standalone Node.js CLI; it does not change the existing collector. Requires the project's Node >=22.13 runtime. Reads `HELIUS_API_KEY` from `.env.download` in the working directory (an already-set environment variable takes precedence). That file and `data/` are gitignored. Do not paste credentials into command-line arguments.

## Backup API key

Both downloaders read optional `HELIUS_API_KEY_2` from `.env.download`. When the provider reports quota exhaustion (HTTP 402, an explicit quota/credit RPC error, or a quota-bearing HTTP 429), the same request is retried with the backup. Subsequent requests use that backup for the rest of the run. On process restart, the primary is tried again so replenished monthly allowances can be used. No keys are logged or stored in the download database.

Ordinary rate limits back off without changing keys. Authentication failures do not trigger failover. If both keys are exhausted, downloading stops with checkpoints intact. Keys sharing the same account may share the same credit allowance. This does not enable a paid upgrade or autoscaling.

The local `--max-credits` limit is still enforced across both keys; reaching it never triggers failover. Each outgoing attempt, including the failed primary attempt, is conservatively counted under the existing job's accounting rules.

## Recommended: 1,000-per-page pool history

This is a separate, faster retrieval path for candidate discovery. It preserves the original block-scan database. It downloads history for configured addresses, **not complete token-wide history**, and does not yet rank wallets or classify swaps.

```sh
# Start, or resume exactly where committed pages stopped
npm run download:pools -- run --max-credits 2000
# Ctrl+C pauses. Run the same command to resume.
npm run download:pools -- status
npm run download:pools -- export --out data/downloads/dood-pools.jsonl
# Explicitly raise this job's cumulative budget if necessary
npm run download:pools -- run --max-credits 10000
```

Uses `.env.download`, full `jsonParsed` transactions, legacy/v0/v1 support, finalized commitment, **limit 1000**, newest-first pagination, and server-side October 18–22 UTC filtering (end exclusive). Each address's pages run sequentially, at most 2 requests/sec. Newest-first applies within each pool, not globally across all pools. The provider may return fewer than 1,000 rows; only an explicit null next-page token marks completion. Malformed responses or cursor loops stop without advancing the checkpoint.

Default addresses, from the pools identified in this investigation (not guaranteed exhaustive or dominant historically):

- Raydium DOOD/USDC: `5KXE8RMF7iW9Ptn665AHfzsMFjYb4LV2Ta8eZEtsTwWC`
- Orca DOOD/USDC: `5wRj5DPdM6Jd84B7reRwUMmerEk4T2PFsZDJQ5boYsic`
- Meteora DOOD/SOL: `G756EBoowvTzgstJwZj7Z4W35doavq8FcYpRNVjvk9DK`

All returned transactions are retained, including failures and non-swap pool activity, with source-address provenance. Signatures are deduplicated across pages and pools. No $100 filter or mint-participant server filter is applied. Null metadata is retained as returned; finished retrieval is not proof the data is sufficient to classify every trade. Do not treat fee payer as necessarily the trader.

The new database is `data/downloads/dood-pools-oct18-22.sqlite`. Export includes a status header, transaction rows with `sourceAddresses` and original fields, and an `export-complete` trailer; incomplete jobs may be exported. Status/export are offline and read-only; exports never overwrite existing files.

**Credit accounting differs from block downloads:** a full 1,000-row page is currently 100 credits. Successful pages settle at 10 credits per started group of 100, minimum 10. Before each attempt the script reserves 100; uncertain/failed attempts retain that conservative reservation even though documented failed API responses are unbilled. A crash after receiving a response may require downloading the page again. Credits and budget persist across restarts, and fewer than 100 remaining stops dispatch, even if the next page might be small. The ledger is separate from the old block job and other applications; it is not your Helius account balance.

**Free-plan access remains unverified until a live run.** If unavailable, the script stops with a safe API error; it never upgrades a plan or falls back to an expensive block scan.

Custom `--address` options replace defaults. Repeat for multiple pools, and choose a different database for a different address list/range. For wallet follow-up use `--token-accounts balanceChanged` to include owned token-account activity:

```sh
npm run download:pools -- run \
  --address WALLET_ADDRESS --token-accounts balanceChanged \
  --start 2026-10-18T00:00:00Z --end 2026-10-22T00:00:00Z \
  --db data/downloads/candidate-wallet.sqlite --max-credits 2000
npm run download:pools -- --help
```

Resume custom jobs with the same address/range/token-account arguments. Do not run competing writers against the same database. The shared lock mechanism below applies. Tests: `node --test test/download.test.js test/download-pools.test.js`.

Reference: [Helius getTransactionsForAddress](https://www.helius.dev/docs/rpc/gettransactionsforaddress).

## Original block scanner: start and resume

From the repository root:

```sh
npm run download -- run
```

Defaults:

- Mint: `DvjbEsdca43oQcw2h3HW1CT7N3x5vRcr3QrvTUHnXvgV`
- UTC interval: **2026-10-18 00:00:00 inclusive to 2026-10-22 00:00:00 exclusive**.
- Database: `data/downloads/dood-oct18-22.sqlite`
- Aggregate request rate: 8/sec; at most 3 block requests in flight.
- Cumulative estimated credit budget: 900,000 requests, including discovery and retries.

Press **Ctrl+C** to pause. Run the same command to resume. Completed blocks are not downloaded again. Pending/in-flight blocks and failed blocks are retried on the next run. Successful transaction inserts and block completion commit together. A hard kill may cause an in-flight request to be repeated, but not duplicate saved transactions.

For a smaller first run to check provider access and throughput:

```sh
npm run download -- run --max-credits 2000
```

This stops automatically at its request budget. To continue that same job with a larger cumulative limit:

```sh
npm run download -- run --max-credits 900000
```

**Restarting does not reset usage or the budget.** Omitting `--max-credits` retains the stored limit. The limit counts all requests since this job began, not requests in this execution or calendar month. After a monthly allowance reset, increasing it requires an explicit command. New databases have independent ledgers; their budgets do not protect a shared account from aggregate usage.

## Status and export

These commands make no network requests and need no API key:

```sh
npm run download -- status
npm run download -- export --out data/downloads/dood-transactions.jsonl
```

Export writes a new file only; existing files are never overwritten. Its first JSONL row is a `download-status` snapshot, followed by `transaction` rows containing signature, slot, blockTime, match reasons, and the original RPC transaction entry (including `transaction`, `meta`, and `version` when returned). Its final row is `export-complete`; a missing final row indicates an interrupted export. Metadata is from `jsonParsed` RPC encoding, not the original serialized transaction bytes.

Exports can run during a scan and use a consistent database snapshot. A long export can grow the SQLite WAL while a downloader writes. Only matching transactions and coverage/checkpoint metadata persist; unrelated full blocks are discarded.

Status fields:

- `discoveryDone`: slot enumeration reached the padded end boundary.
- `blocks`: counts of pending, in-flight, done, and error blocks.
- `scanFinished`: discovery finished and no pending/in-flight/error blocks remain.
- `coverageIssueBlocks`: blocks with missing or unsupported inspection data.
- `inspectionComplete`: scan finished with no **detected** inspection gaps; not an independent proof of provider completeness.
- `errorExamples` / `coverageExamples`: first ten outstanding issues; all are in SQLite `blocks` / `coverage`.
- `estimatedCredits` / `usage`: conservatively reserved outgoing request attempts.

Blocks with downloaded-but-incomplete metadata remain marked done with coverage issues, to avoid repeatedly paying for unchanged responses. Rerunning retries failed downloads, not these metadata gaps. Investigate those gaps before asserting completeness; a different source or parser may be needed.

## Other options

```sh
npm run download -- --help
npm run download -- run --rps 4 --concurrency 2
npm run download -- run \
  --start 2026-10-20T00:00:00Z \
  --end 2026-10-22T00:00:00Z \
  --db data/downloads/dood-oct20-22.sqlite
npm run download -- status --db data/downloads/dood-oct20-22.sqlite
```

Use a different database for a different mint/range. An existing database rejects conflicting configuration; when resuming a custom range, supply the same mint/range arguments. Dates require an explicit timezone and seconds. `--rps` cannot exceed 10; concurrency cannot exceed 8.

One writer may run per database. A lock directory records local host/PID and is released on normal exit. An exited local owner's lock can be recovered. Locks with missing/invalid metadata, foreign owners, or interrupted recovery require manual inspection before removal. Never remove a lock belonging to a live downloader. Do not run a shared database across machines.

## Coverage and cost

A mint-address signature lookup does **not** enumerate every historical SPL-token transfer. The scanner instead locates a padded finalized slot range, enumerates produced blocks, downloads every block, then checks every transaction for:

- DOOD pre/post token balances;
- mint references in transaction accounts (including versioned loaded accounts);
- parsed outer/inner instructions naming the mint.

Block timestamps apply the exact UTC interval. Timestamp lookup assumes broadly chronological Solana block times and adds 4,096 slots on each side to tolerate small local timestamp reversals. This is not a mathematical guarantee against arbitrarily non-monotonic timestamps or incomplete provider results. Missing blocks/timestamps, missing token/inner-instruction metadata, unsupported versions, and recognized unparsed token instructions are reported, not silently treated as complete coverage.

The result is **mint-related transactions**, not a list of decoded transfers or classified buys/sells. One transaction can include multiple transfers; failed transactions are preserved with `meta.err`, but are not successful trades. Account initialization, liquidity actions, and mint-account references may be included. Do not equate the output count with the explorer's 206,838 transfer rows. There is **no $100 minimum filter**.

Four days at a rough 400ms slot duration represent about **864,000 slot positions**, plus boundary padding. Skipped slots reduce actual block requests; enumeration, timestamp lookups, and retries add requests. At 8 requests/sec the approximate request-rate floor alone is **30 hours**. Whole-block payloads can mean **hundreds of GB or more of network traffic**, and bandwidth/CPU/provider latency may make the scan much slower. Persistent disk size depends on matching transaction volume and coverage records, not total downloaded block bytes.

Helius currently lists ordinary historical RPC calls such as `getBlock` at one credit/request. The script conservatively counts every attempted request, even when a provider may not bill a failed attempt. It does not query your balance or know other applications' consumption. Pricing/access can change; check the Helius dashboard. A free plan's nominal one-million-credit allowance is not a guarantee this scan fits your remaining allowance or finishes in one month.

If the existing collector uses the same API key, its usage competes with this downloader. Stop it or lower downloader RPS/budget. Retry-After/backoff is shared across this downloader's workers, not across other processes. Authentication/quota errors stop the scan; other exhausted block failures remain visible for retry. Ten consecutive block failures also stop dispatch to avoid wasting credits during an outage. No paid upgrade or autoscaling is enabled by this code.

References: [Helius credits](https://www.helius.dev/docs/billing/credits), [Helius plans](https://www.helius.dev/pricing), [Solana getBlocks](https://solana.com/docs/rpc/http/getblocks).

## Validation

```sh
node --test test/download.test.js
npm test
```

Tests mock RPC and use local temporary databases. They spend no Helius credits. A live archival scan must be started explicitly by you; implementation tests do not establish real provider availability or measured download speed.
