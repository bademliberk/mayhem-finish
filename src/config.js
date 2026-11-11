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
  // Blank values (e.g. `DB_PATH=`) mean unset: '' would otherwise be 0, or an anonymous temporary database.
  const env = name => (process.env[name]?.trim() ? process.env[name] : undefined);
  const positive = (name, fallback) => {
    const value = Number(env(name) ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    key: env('HELIUS_API_KEY') ?? env('HELIUS_KEY'),
    // Trading feeds' WebSocket host: 'mainnet' (default) or 'beta' (Helius Gatekeeper, beta). Discovery stays on mainnet.
    wsHost: (() => { const h = (env('HELIUS_WS_HOST') ?? 'mainnet').trim().toLowerCase();
      if (!['mainnet', 'beta'].includes(h)) throw new Error('Invalid HELIUS_WS_HOST (mainnet or beta)'); return h; })(),
    db: env('DB_PATH') ?? 'data/collector.sqlite',
    firstCheck: positive('FIRST_CHECK_SECONDS', 30),
    recheck: positive('RECHECK_SECONDS', 30),
    horizon: positive('OBSERVATION_SECONDS', 86400),
    trackingSeconds: 30,
    minCap: positive('MIN_MARKET_CAP_SOL', 2),
    maxCap: positive('MAX_MARKET_CAP_SOL', 5),
    minLiquidity: positive('MIN_LIQUIDITY_SOL', 0.005),
    rpcInterval: positive('RPC_INTERVAL_MS', 150),
    historyPages: positive('HISTORY_PAGES_PER_PASS', 10),
    backfillSeconds: positive('BACKFILL_SECONDS', 60),
  };
}
// Stable, secret-free description of the screening policy actually in force.
export function screeningPolicy(cfg) {
  return JSON.stringify({
    version: 'financial_only_v1',
    tradeHistory: 'not_checked',
    firstCheck: cfg.firstCheck,
    recheck: cfg.recheck,
    minCap: cfg.minCap,
    maxCap: cfg.maxCap,
    minLiquidity: cfg.minLiquidity,
    trackingSeconds: cfg.trackingSeconds,
  });
}
