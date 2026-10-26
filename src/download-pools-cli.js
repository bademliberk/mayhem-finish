import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, openSync, closeSync, writeSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { acquireLock } from './download-store.js';
import { DownloadRpc, safeError } from './download-rpc.js';
import { PoolStore, scanPools } from './download-pools.js';

export const DEFAULT_POOLS = [
  '5KXE8RMF7iW9Ptn665AHfzsMFjYb4LV2Ta8eZEtsTwWC',
  '5wRj5DPdM6Jd84B7reRwUMmerEk4T2PFsZDJQ5boYsic',
  'G756EBoowvTzgstJwZj7Z4W35doavq8FcYpRNVjvk9DK',
];
const HELP = `Resumable 1,000-per-page full pool/address history
npm run download:pools -- run [options]
npm run download:pools -- status [--db PATH]
npm run download:pools -- export --out PATH.jsonl [--db PATH]

--address ADDRESS     Repeat to replace default Raydium/Orca/Meteora DOOD pools
--start ISO_TIMESTAMP Default 2026-10-18T00:00:00Z, inclusive
--end ISO_TIMESTAMP   Default 2026-10-22T00:00:00Z, exclusive
--token-accounts MODE none (default for pools), balanceChanged, or all
--db PATH             Default data/downloads/dood-pools-oct18-22.sqlite
--max-credits N       Cumulative job budget; initially 2000; reserves 100 per attempt
--rps N               Default 2, maximum 10; one page in flight
--out PATH            New export file, never overwritten
--help                No requests

Reads .env.download. Ctrl+C pauses; repeat command to resume.
All returned full transactions are saved, deduplicated across addresses.
This is NOT complete token-wide coverage, and does not rank trader candidates.
Free-plan endpoint access must be checked when run; no paid fallback.
`;

export function poolOptions(args) {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    address: { type: 'string', multiple: true }, start: { type: 'string' }, end: { type: 'string' },
    'token-accounts': { type: 'string' }, db: { type: 'string' }, 'max-credits': { type: 'string' },
    rps: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (v.help) return { help: true };
  const command = positionals[0] ?? 'status';
  if (positionals.length > 1 || !['run', 'status', 'export'].includes(command)) throw new Error('Use run, status or export.');
  if (command !== 'run' && ['address', 'start', 'end', 'token-accounts', 'max-credits', 'rps'].some(k => v[k] !== undefined)) {
    throw new Error('Scan options apply only to run.');
  }
  if (command === 'export' ? !v.out : v.out !== undefined) throw new Error('--out is required for export and only valid for export.');
  const addresses = [...new Set(v.address ?? DEFAULT_POOLS)];
  for (const address of addresses) { try { new PublicKey(address); } catch { throw new Error('Invalid address.'); } }
  function timestamp(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('Dates require seconds and an explicit timezone.');
    const time = Date.parse(value) / 1000;
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid date.');
    return time;
  }
  const start = timestamp(v.start ?? '2026-10-18T00:00:00Z'), end = timestamp(v.end ?? '2026-10-22T00:00:00Z');
  if (end <= start) throw new Error('End must be after start.');
  const tokenAccounts = v['token-accounts'] ?? 'none';
  if (!['none', 'balanceChanged', 'all'].includes(tokenAccounts)) throw new Error('Invalid token-accounts mode.');
  const rps = Number(v.rps ?? 2), budget = v['max-credits'] === undefined ? undefined : Number(v['max-credits']);
  if (!Number.isFinite(rps) || rps <= 0 || rps > 10) throw new Error('RPS must be greater than zero and at most 10.');
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 100)) throw new Error('Budget must be an integer of at least 100.');
  return { command, db: resolve(v.db ?? 'data/downloads/dood-pools-oct18-22.sqlite'),
    out: v.out ? resolve(v.out) : undefined, rps, budget,
    config: { format: 1, addresses, start, end, tokenAccounts, pageSize: 1000, sortOrder: 'desc', maxVersion: 1 } };
}

export function exportPools(store, path) {
  const fd = openSync(path, 'wx');
  try {
    store.db.exec('BEGIN');
    try {
      const line = row => {
        const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      };
      line({ type: 'download-status', ...store.status() });
      let count = 0;
      for (const row of store.db.prepare('SELECT * FROM history ORDER BY slot,signature').iterate()) {
        const addresses = store.all('SELECT address FROM history_sources WHERE signature=? ORDER BY address', row.signature).map(r => r.address);
        line({ type: 'transaction', signature: row.signature, sourceAddresses: addresses, ...JSON.parse(row.data) });
        count++;
      }
      line({ type: 'export-complete', transactions: count });
      store.db.exec('COMMIT');
      return count;
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  } finally { closeSync(fd); }
}

export async function main(args = process.argv.slice(2)) {
  const opts = poolOptions(args);
  if (opts.help) { console.log(HELP); return; }
  if (opts.command !== 'run') {
    if (!existsSync(opts.db)) throw new Error('Pool history database does not exist.');
    const store = new PoolStore(opts.db, true);
    try {
      if (opts.command === 'status') console.log(JSON.stringify(store.status(), null, 2));
      else console.log(`Exported ${exportPools(store, opts.out)} unique transactions.`);
    } finally { store.close(); }
    return;
  }
  try { loadEnvFile('.env.download'); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load .env.download.'); }
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('Set HELIUS_API_KEY in .env.download or the environment.');
  const release = acquireLock(opts.db), controller = new AbortController();
  const pause = () => { console.log('Pausing pool history…'); controller.abort(); };
  let store;
  process.on('SIGINT', pause); process.on('SIGTERM', pause);
  try {
    store = new PoolStore(opts.db);
    store.initialize(opts.config, opts.budget);
    const rpc = new DownloadRpc({ key, backupKey: process.env.HELIUS_API_KEY_2, store, signal: controller.signal, rps: opts.rps, timeoutMs: 120000 });
    const progress = s => console.log(`pages=${s.pages} returned=${s.returnedTransactions} unique=${s.uniqueTransactions} addresses-done=${s.sources.filter(r => r.done).length}/${s.sources.length} credits≈${s.estimatedCredits}/${s.maxCredits}`);
    console.log('Fetching full address history, up to 1000 per page; not exhaustive token-wide coverage.');
    progress(store.status());
    try {
      await scanPools({ store, rpc, signal: controller.signal, onPage: progress });
      store.run("UPDATE pool_job SET last_stop='FINISHED' WHERE id=1");
      console.log('Finished configured address histories. Use export for the deduplicated transactions.');
    } catch (error) {
      const known = ['INVALID_HISTORY_PAGE', 'HISTORY_CURSOR_LOOP', 'HISTORY_CURSOR_CONFLICT'];
      const code = controller.signal.aborted ? 'PAUSED' : known.includes(error.message) ? error.message : safeError(error);
      store.run('UPDATE pool_job SET last_stop=? WHERE id=1', code);
      console.log(`Stopped: ${code}. Page checkpoints saved. No paid fallback attempted.`);
      if (code !== 'PAUSED') process.exitCode = 2;
    }
    progress(store.status());
  } finally {
    process.off('SIGINT', pause); process.off('SIGTERM', pause);
    store?.close(); release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Pool downloader: ${error.message}`); process.exitCode = 1; });
}
