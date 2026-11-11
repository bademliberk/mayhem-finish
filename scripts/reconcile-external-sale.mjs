// One-off repair: close a live position whose tokens another bot sold from the same wallet, at the real
// on-chain proceeds, under the distinct exit reason `external_sale`. Then clear the entry halt it caused.
// Stop the live trial first. Writes a backup of the database before changing anything.
// Usage: node scripts/reconcile-external-sale.mjs <mint> <sale-signature>
import { loadEnvFile } from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { ownerDelta } from '../src/live-executor.js';

loadEnvFile();
const [MINT, SALE] = process.argv.slice(2);
if (!MINT || !SALE) throw new Error('Usage: node scripts/reconcile-external-sale.mjs <mint> <sale-signature>  (stop the bot first)');
const DB = `${process.env.LIVE_TRIAL_DIR || 'data/live-trials'}/agent-sell-liquidity.sqlite`;
let running = '';
try { running = execSync('pgrep -f "cli.js live-trial"', { encoding: 'utf8' }).trim(); } catch { /* none running */ }
if (running) throw new Error('The live trial is running; stop it before reconciling');

const raw = String(process.env.AS_WALLET_SECRET ?? '').trim();
const owner = Keypair.fromSecretKey(raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw)).publicKey.toBase58();
const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction',
    params: [SALE, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }] }) });
const tx = (await res.json()).result;
const d = ownerDelta(tx, owner, MINT);
if (!d || d.err) throw new Error('Sale transaction not found, failed, or not from this wallet');

const db = new DatabaseSync(DB);
const pos = db.prepare("SELECT * FROM paper_positions WHERE mint=? AND status='open'").get(MINT);
if (!pos) throw new Error('Position is not open; nothing to do');
if (-d.tokens !== BigInt(pos.tokens_raw)) throw new Error(`Token mismatch: sale moved ${-d.tokens}, position holds ${pos.tokens_raw}`);
if (db.prepare("SELECT COUNT(*) n FROM paper_orders WHERE status='pending'").get().n) throw new Error('Pending orders exist; stop the bot first');

const backup = DB.replace(/\.sqlite$/, `.backup-${new Date().toISOString().replace(/[-:.]/g, '')}.sqlite`);
db.exec(`VACUUM INTO '${backup}'`);

// Same convention as live fills: refundable token-account rent is excluded from proceeds.
const net = d.lamports + d.ataLamports, pnl = net - BigInt(pos.entry_cost_lamports), at = tx.blockTime * 1000;
const fill = { model: 'external_sale', note: 'Sold by another bot sharing the wallet; recorded at real on-chain proceeds.',
  signature: SALE, slot: tx.slot, tokens: pos.tokens_raw, net: net.toString(), solDeltaLamports: d.lamports.toString(),
  ataLamports: d.ataLamports.toString(), transactionFeeLamports: d.fee.toString(), tokensDelta: d.tokens.toString() };
const assumptions = db.prepare('SELECT assumptions_json FROM paper_orders WHERE id=?').get(pos.entry_order_id).assumptions_json;
db.exec('BEGIN IMMEDIATE');
try {
  const id = Number(db.prepare(`INSERT INTO paper_orders (mint,side,status,created_at_ms,expires_at_ms,reason,quote_json,
      assumptions_json,settled_at_ms,fill_json,diagnostics_json) VALUES(?,'sell','filled',?,?,'external_sale',?,?,?,?,?)`)
    .run(MINT, at, at, JSON.stringify({ model: 'external_sale' }), assumptions, at, JSON.stringify(fill),
      JSON.stringify({ stage: 'filled', liveSignature: SALE, liveStatus: 'ok' })).lastInsertRowid);
  db.prepare("UPDATE paper_positions SET status='closed',exit_order_id=?,closed_at_ms=?,exit_net_lamports=?,pnl_lamports=? WHERE mint=? AND status='open'")
    .run(id, at, net.toString(), pnl.toString(), MINT);
  db.prepare("UPDATE paper_watches SET status='closed',reason='external_sale' WHERE mint=?").run(MINT);
  db.prepare("DELETE FROM metadata WHERE key='live_halted'").run();
  db.exec('COMMIT');
  console.log(JSON.stringify({ closed: MINT, reason: 'external_sale', exitOrderId: id, netLamports: net.toString(),
    pnlLamports: pnl.toString(), haltCleared: true, backup }));
} catch (error) { db.exec('ROLLBACK'); throw error; }
