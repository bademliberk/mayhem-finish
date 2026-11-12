// Burns this wallet's whole balance of one mint and closes the token account (rent back). Simulates only;
// pass --yes to send. --keep-account burns without closing. Works for SPL Token and Token-2022 mints.
// Adapted from analyze_5K3N/auto-sell/tools/burn.mjs to use this project's LiveExecutor and .env.
//   node scripts/burn.mjs <mint> [--yes] [--keep-account]
// Stop the live trial first if it still holds an open position in this mint.
import { loadEnvFile } from 'node:process';
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { LiveExecutor, liveSettings, loadWallet } from '../src/live-executor.js';

const require = createRequire(import.meta.url);
const { createBurnCheckedInstruction, createCloseAccountInstruction } = require('@solana/spl-token');

loadEnvFile();
const args = process.argv.slice(2);
const mintArg = args.find(a => !a.startsWith('--'));
if (!mintArg) throw new Error('usage: node scripts/burn.mjs <mint> [--yes] [--keep-account]');
const send = args.includes('--yes');
const close = !args.includes('--keep-account');
const mint = new PublicKey(mintArg);

const ex = new LiveExecutor({ wallet: loadWallet(process.env.AS_WALLET_SECRET), apiKey: process.env.HELIUS_API_KEY,
  settings: { ...liveSettings(process.env), dryRun: false }, log: () => {} });
const owner = ex.user;
const accounts = (await ex.conn.getParsedTokenAccountsByOwner(owner, { mint }, 'confirmed')).value;
if (!accounts.length) {
  console.log(`wallet ${owner.toBase58().slice(0, 8)} has no token account for ${mint.toBase58()}`);
  process.exit(0);
}

const ixs = [];
for (const { pubkey, account } of accounts) {
  const info = account.data.parsed.info;
  const program = account.owner; // SPL Token or Token-2022
  const amount = BigInt(info.tokenAmount.amount);
  const decimals = info.tokenAmount.decimals;
  console.log(`account ${pubkey.toBase58()}  balance ${info.tokenAmount.uiAmountString}  rent ${account.lamports / 1e9} SOL  program ${program.toBase58().slice(0, 8)}`);
  if (info.state === 'frozen') throw new Error(`${pubkey.toBase58()} is frozen: it can't be burned or closed`);
  if (amount > 0n) ixs.push(createBurnCheckedInstruction(pubkey, mint, owner, amount, decimals, [], program));
  if (close) ixs.push(createCloseAccountInstruction(pubkey, owner, owner, [], program));
}
if (!ixs.length) {
  console.log('nothing to do (zero balance and --keep-account)');
  process.exit(0);
}

const burns = ixs.length - (close ? accounts.length : 0);
const action = [burns && 'burn', close && 'close'].filter(Boolean).join(' + ');
await ex.refreshBlockhash();
const units = 20_000 + 10_000 * ixs.length;
const { tx } = ex.compile(ixs, units);
const sim = await ex.rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'),
  { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }]);
console.log('simulation', sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : 'ok', 'units', sim.value.unitsConsumed);
if (sim.value.err) {
  console.log((sim.value.logs || []).slice(-8).join('\n'));
  process.exit(1);
}
if (!send) {
  console.log(`dry run: would ${action} the above. Re-run with --yes to send (irreversible).`);
  process.exit(0);
}

await ex.init();
const prepared = ex.prepare(ixs, mint.toBase58(), units, {}, ex.priorityPrice());
const r = await ex.submit(prepared);
ex.stop();
const ok = r.status === 'ok';
console.log(ok ? `${action} done: ${r.signature} (slot ${r.slot}, wallet ${r.lamports >= 0n ? '+' : ''}${Number(r.lamports) / 1e9} SOL)`
  : `${r.status.toUpperCase()} ${r.signature}${r.err ? ': ' + JSON.stringify(r.err) : ''}`);
process.exit(ok ? 0 : 1);
