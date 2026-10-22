import { loadEnvFile } from 'node:process';
import { PublicKey } from '@solana/web3.js';

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const MAYHEM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';
// Pump creation instructions require this PDA; ordinary swaps do not.
export const MINT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('mint-authority')], new PublicKey(PUMP),
)[0].toBase58();
export function addresses(mint) {
  const key = new PublicKey(mint);
  const derive = (seed, program) => PublicKey.findProgramAddressSync(
    [Buffer.from(seed), key.toBuffer()], new PublicKey(program),
  )[0].toBase58();
  return { state: derive('mayhem-state', MAYHEM), curve: derive('bonding-curve', PUMP) };
}
export function config() {
  try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const positive = (name, fallback) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    key: process.env.HELIUS_API_KEY ?? process.env.HELIUS_KEY,
    db: process.env.DB_PATH ?? 'data/collector.sqlite',
    firstCheck: positive('FIRST_CHECK_SECONDS', 600),
    recheck: positive('RECHECK_SECONDS', 600),
    horizon: positive('OBSERVATION_SECONDS', 86400),
    activeAge: 20,
    staleAge: 1200,
    minCap: positive('MIN_MARKET_CAP_SOL', 0.04),
    maxCap: positive('MAX_MARKET_CAP_SOL', 0.5),
    minLiquidity: positive('MIN_LIQUIDITY_SOL', 0.005),
    rpcInterval: positive('RPC_INTERVAL_MS', 150),
    historyPages: positive('HISTORY_PAGES_PER_PASS', 10),
    backfillSeconds: positive('BACKFILL_SECONDS', 60),
  };
}
