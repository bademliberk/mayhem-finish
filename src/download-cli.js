import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, openSync, closeSync, writeSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { DownloadStore, acquireLock } from './download-store.js';
import { DownloadRpc, safeError } from './download-rpc.js';
import { scan } from './download-scan.js';

const DEFAULTS = {
  mint: 'DvjbEsdca43oQcw2h3HW1CT7N3x5vRcr3QrvTUHnXvgV',
  start: '2026-10-18T00:00:00Z', end: '2026-10-22T00:00:00Z',
  db: 'data/downloads/dood-oct18-22.sqlite',
};
const HELP = `Resumable Helius token-history block scanner

npm run download -- run [options]
npm run download -- status [--db PATH]
npm run download -- export --out PATH.jsonl [--db PATH]

Options:
  --mint ADDRESS        Default: DOOD (${DEFAULTS.mint})
  --start ISO_TIMESTAMP Default: ${DEFAULTS.start} (inclusive)
  --end ISO_TIMESTAMP   Default: ${DEFAULTS.end} (exclusive)
  --db PATH             Default: ${DEFAULTS.db}
  --rps NUMBER          Aggregate requests/sec, default 8, maximum 10
  --concurrency NUMBER  In-flight blocks, default 3, maximum 8
  --max-credits NUMBER  Cumulative job request budget, initially 900000
  --out PATH            New JSONL export file (never overwritten)
  --help                Show help; no requests

Reads HELIUS_API_KEY from .env.download in the current directory.
Ctrl+C pauses; rerun the same command to resume. Status and export are offline.
Full-chain block scanning can take days and substantial bandwidth. No $100 filter.
Estimated credits count request attempts, not actual remaining account balance.
`;

export function options(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, mint: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
    db: { type: 'string' }, rps: { type: 'string' }, concurrency: { type: 'string' },
    'max-credits': { type: 'string' }, out: { type: 'string' },
  } });
  if (values.help) return { help: true };
  const command = positionals[0] ?? 'status';
  if (positionals.length > 1 || !['run', 'status', 'export'].includes(command)) throw new Error('Use run, status, or export.');
  if (command !== 'run' && ['mint', 'start', 'end', 'rps', 'concurrency', 'max-credits'].some(k => values[k] !== undefined)) {
    throw new Error('Scan configuration options apply only to run.');
  }
  if (command !== 'export' && values.out !== undefined) throw new Error('--out applies only to export.');
  if (command === 'export' && !values.out) throw new Error('Export requires --out PATH.');
  function number(name, fallback, max = Number.MAX_SAFE_INTEGER, integer = true) {
    const value = Number(values[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isSafeInteger(value))) {
      throw new Error(`Invalid --${name}.`);
    }
    return value;
  }
  const mint = values.mint ?? DEFAULTS.mint;
  try { new PublicKey(mint); } catch { throw new Error('Invalid mint address.'); }
  const timestamp = name => {
    const value = values[name] ?? DEFAULTS[name];
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new Error(`--${name} requires an ISO timestamp with seconds and explicit timezone.`);
    }
    const result = Date.parse(value) / 1000;
    if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid --${name}.`);
    return result;
  };
  const start = timestamp('start'), end = timestamp('end');
  if (start >= end) throw new Error('--end must be after --start.');
  return { command, db: resolve(values.db ?? DEFAULTS.db), out: values.out ? resolve(values.out) : undefined,
    config: { format: 1, mint, start, end }, rps: number('rps', 8, 10, false),
    concurrency: number('concurrency', 3, 8),
    maxCredits: values['max-credits'] === undefined ? undefined : number('max-credits', 900000) };
}

export function exportJsonl(store, path) {
  const fd = openSync(path, 'wx');
  // A read transaction keeps the header and records on the same SQLite snapshot.
  store.db.exec('BEGIN');
  let count = 0;
  try {
    const line = value => {
      const buffer = Buffer.from(`${JSON.stringify(value)}\n`);
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
    };
    line({ type: 'download-status', ...store.status() });
    for (const row of store.db.prepare('SELECT * FROM transactions ORDER BY slot,signature').iterate()) {
      line({ type: 'transaction', signature: row.signature, slot: row.slot,
        blockTime: row.block_time, reasons: JSON.parse(row.reasons), ...JSON.parse(row.data) });
      count++;
    }
    line({ type: 'export-complete', transactions: count });
    store.db.exec('COMMIT');
    return count;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  } finally { closeSync(fd); }
}

export async function main(args = process.argv.slice(2)) {
  const opts = options(args);
  if (opts.help) { console.log(HELP); return; }
  if (opts.command !== 'run') {
    if (!existsSync(opts.db)) throw new Error('Download database does not exist.');
    const store = new DownloadStore(opts.db);
    try {
      if (opts.command === 'status') console.log(JSON.stringify(store.status(), null, 2));
      else console.log(`Exported ${exportJsonl(store, opts.out)} transactions to ${opts.out}`);
    } finally { store.close(); }
    return;
  }
  try { loadEnvFile('.env.download'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load .env.download.'); }
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('Set HELIUS_API_KEY in .env.download or the environment.');
  const release = acquireLock(opts.db);
  let store, timer;
  const controller = new AbortController();
  const pause = () => { console.log('Pausing; saving completed work…'); controller.abort(); };
  process.on('SIGINT', pause);
  process.on('SIGTERM', pause);
  try {
    store = new DownloadStore(opts.db);
    store.initialize(opts.config, opts.maxCredits);
    const rpc = new DownloadRpc({ key, backupKey: process.env.HELIUS_API_KEY_2, store, signal: controller.signal, rps: opts.rps });
    const began = Date.now();
    const initial = store.get("SELECT count(*) AS n FROM blocks WHERE status='done'").n;
    const progress = () => {
      const s = store.status(), elapsed = (Date.now() - began) / 1000;
      console.log(`blocks=${s.blocks.done ?? 0} pending=${s.blocks.pending ?? 0} inflight=${s.blocks.inflight ?? 0} errors=${s.blocks.error ?? 0} matches=${s.matchingTransactions} coverage-issues=${s.coverageIssueBlocks} credits≈${s.estimatedCredits}/${s.maxCredits} elapsed=${Math.floor(elapsed)}s blocks/s=${((s.blocks.done - initial || 0) / Math.max(1, elapsed)).toFixed(2)}`);
    };
    console.log(`Scanning ${opts.config.mint}, ${new Date(opts.config.start * 1000).toISOString()} through ${new Date(opts.config.end * 1000).toISOString()} (exclusive).`);
    console.log('All finalized blocks in this range must be downloaded. Ctrl+C pauses. No dollar-value filter.');
    progress();
    timer = setInterval(progress, 10000);
    try {
      const status = await scan({ store, rpc, config: opts.config, concurrency: opts.concurrency, signal: controller.signal });
      store.run('UPDATE job SET last_stop=? WHERE id=1', status.inspectionComplete ? 'FINISHED' : 'COVERAGE_GAPS');
      console.log(status.inspectionComplete ? 'Scan finished without detected inspection gaps.' : 'Scan stopped with unresolved blocks or inspection gaps; see status.');
      if (!status.inspectionComplete) process.exitCode = 2;
    } catch (error) {
      const code = controller.signal.aborted ? 'PAUSED' : safeError(error);
      store.run('UPDATE job SET last_stop=? WHERE id=1', code);
      console.log(`Stopped: ${code}. Progress is saved; rerun to resume. Use status to inspect coverage.`);
      if (code !== 'PAUSED') process.exitCode = 2;
    }
    progress();
  } finally {
    clearInterval(timer);
    process.off('SIGINT', pause);
    process.off('SIGTERM', pause);
    store?.close();
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Setup errors contain local validation only. RPC errors are sanitized above.
    console.error(`Downloader: ${error.message}`);
    process.exitCode = 1;
  });
}
