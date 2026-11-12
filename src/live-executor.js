// Real-money execution for live trials: Pump bonding-curve buys and sells through Helius Sender.
// Ported from analyze_5K3N/auto-sell (executor.js, market.js; curve only, no AMM). Differences on purpose:
//  - results come only from CONFIRMED transactions (getTransaction balance deltas), never processed streams;
//  - the blockhash comes from RPC on a timer, never from third-party wallet transactions;
//  - a send that is not seen before its deadline is `unknown`, never assumed filled or failed;
//  - balance reads throw on RPC errors instead of returning 0.
// Secrets (wallet key, API key) are never logged or stored; errors are reduced to codes.
import { createRequire } from 'node:module';
import BN from 'bn.js';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';

const require = createRequire(import.meta.url);
const { PUMP_SDK, OnlinePumpSdk, bondingCurvePda, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } = require('@pump-fun/pump-sdk');
const { getAssociatedTokenAddressSync, createCloseAccountInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TIPS = [ // Helius Sender mainnet tip accounts
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ', '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn', '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF', '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT', '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
].map(a => new PublicKey(a));
const SENDER_REGIONS = ['slc', 'ewr', 'lon', 'fra', 'ams', 'sg', 'tyo'].map(r => `http://${r}-sender.helius-rpc.com`);
const big = x => BigInt(x.toString());
const bn = x => new BN(x.toString());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Wallet from a base58 secret or a solana-keygen JSON array. Never logged. */
export function loadWallet(secret) {
  const raw = String(secret ?? '').trim();
  if (!raw) throw new Error('Set AS_WALLET_SECRET for live trading');
  try { return Keypair.fromSecretKey(raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw)); }
  catch { throw new Error('AS_WALLET_SECRET is not a valid secret key (value suppressed)'); }
}

const num = (env, name, fallback, min, max) => {
  const raw = env[name];
  const value = Number(raw == null || String(raw).trim() === '' ? fallback : raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
};
const flag = (env, name, fallback) => {
  const raw = String(env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`Invalid ${name}`);
};
/** Nonsecret execution settings; shared env names with the auto-sell bot. */
export function liveSettings(env = process.env) {
  const dry = String(env.LIVE_DRY_RUN ?? '').trim().toLowerCase();
  if (!['', 'false', '0', 'true', '1'].includes(dry)) throw new Error('Invalid LIVE_DRY_RUN');
  return {
    dryRun: ['true', '1'].includes(dry),
    senderUrl: String(env.AS_SENDER_URL ?? '').trim() || 'auto',
    tipLamports: Math.round(num(env, 'AS_TIP_SOL', 0.000005, 0, 0.01) * 1e9),
    // Fixed price when set; otherwise a Helius estimate for the curve's accounts at AS_PRIORITY_LEVEL, capped.
    // AS_PRIORITY_FEES_ENABLED=false: no estimate calls and a 1-microlamport price (under 1 lamport per transaction).
    // The compute-unit price instruction stays, because Helius Sender rejects transactions without one.
    priorityFeesEnabled: flag(env, 'AS_PRIORITY_FEES_ENABLED', true),
    priorityMicroLamports: !flag(env, 'AS_PRIORITY_FEES_ENABLED', true) ? (() => {
      if (String(env.AS_PRIORITY_MICROLAMPORTS ?? '').trim() !== '') {
        throw new Error('AS_PRIORITY_MICROLAMPORTS cannot be set when AS_PRIORITY_FEES_ENABLED=false');
      }
      return 1;
    })() : String(env.AS_PRIORITY_MICROLAMPORTS ?? '').trim() === '' ? null
      : num(env, 'AS_PRIORITY_MICROLAMPORTS', 0, 0, 10_000_000),
    priorityLevel: (() => {
      const level = String(env.AS_PRIORITY_LEVEL ?? '').trim() || 'High';
      if (!['Low', 'Medium', 'High', 'VeryHigh'].includes(level)) throw new Error('Invalid AS_PRIORITY_LEVEL');
      return level;
    })(),
    // Ceiling on the dynamic price: at 150k CU, 2,000,000 microlamports is 0.0003 SOL per transaction.
    maxPriorityMicroLamports: num(env, 'AS_MAX_PRIORITY_MICROLAMPORTS', 2_000_000, 0, 10_000_000),
    priorityFloorMicroLamports: num(env, 'AS_MIN_PRIORITY_MICROLAMPORTS', 10_000, 0, 10_000_000),
    buyUnits: num(env, 'AS_CURVE_BUY_CU', 150_000, 50_000, 1_400_000),
    sellUnits: num(env, 'AS_CURVE_SELL_CU', 90_000, 50_000, 1_400_000),
    confirmTimeoutMs: num(env, 'AS_CONFIRM_TIMEOUT_MS', 20_000, 5_000, 120_000),
    minWalletLamports: Math.round(num(env, 'LIVE_MIN_WALLET_SOL', 0.05, 0, 1_000) * 1e9),
    maxLossLamports: Math.round(num(env, 'LIVE_MAX_LOSS_SOL', 0.1, 0.000001, 1_000) * 1e9),
    // Kept free beyond the worst-case buy cost: token-account rent (~0.00204 SOL), tip, fees.
    perTradeReserveLamports: Math.round(num(env, 'LIVE_TRADE_RESERVE_SOL', 0.003, 0, 1) * 1e9),
    // Minimum accepted on a mandatory (timeout / liquidity-risk) exit: fresh quote less this many bps.
    exitSlippageBps: num(env, 'LIVE_EXIT_SLIPPAGE_BPS', 2000, 0, 10000),
    // Every sell (profit, stop-loss, timeout, liquidity) goes out with a zero minimum: it cannot fail on slippage,
    // and it accepts whatever the curve pays when it lands, including a sandwich.
    forceSell: flag(env, 'LIVE_FORCE_SELL', false),
    // Buys allowed in flight at once (1 keeps wallet and exposure checks exact).
    maxBuysInFlight: num(env, 'LIVE_MAX_BUYS_IN_FLIGHT', 1, 1, 4),
    // false: no balance RPC per buy; a cached balance (refreshed every 5 s and after each fill) guards the floor instead.
    checkBalancePerBuy: flag(env, 'LIVE_CHECK_BALANCE_PER_BUY', true),
  };
}

/** Largest token amount (<= `tokens`) whose curve sale needs at most 99% of the curve's real SOL. */
export function payableTokens(bc, tokens) {
  const vs = big(bc.virtualQuoteReserves ?? bc.virtualSolReserves), vt = big(bc.virtualTokenReserves);
  const real = big(bc.realQuoteReserves ?? bc.realSolReserves) * 99n / 100n;
  const gross = t => t * vs / (vt + t);
  if (gross(tokens) <= real) return tokens;
  if (vs <= real) return tokens;
  // gross(t) <= real  <=>  t <= real * vt / (vs - real)
  const limit = real * vt / (vs - real);
  return limit < tokens ? limit : tokens;
}

/** Lamport/token deltas for `owner` in a confirmed jsonParsed transaction (auto-sell detect.js ownerDelta). */
export function ownerDelta(tx, owner, mint) {
  const keys = (tx?.transaction?.message?.accountKeys ?? []).map(k => typeof k === 'string' ? k : k.pubkey?.toString?.() ?? String(k.pubkey));
  const i = keys.indexOf(owner);
  const meta = tx?.meta;
  if (i < 0 || !meta) return null;
  const owned = rows => (rows ?? []).filter(b => b.owner === owner && b.mint === mint);
  const sum = rows => owned(rows).reduce((s, b) => s + BigInt(b.uiTokenAmount?.amount ?? '0'), 0n);
  const accounts = new Set([...owned(meta.preTokenBalances), ...owned(meta.postTokenBalances)].map(b => b.accountIndex));
  let ataLamports = 0n;
  for (const a of accounts) ataLamports += BigInt(meta.postBalances[a] ?? 0) - BigInt(meta.preBalances[a] ?? 0);
  return {
    lamports: BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]),
    ataLamports, tokens: sum(meta.postTokenBalances) - sum(meta.preTokenBalances),
    postTokens: sum(meta.postTokenBalances), fee: BigInt(meta.fee ?? 0), err: meta.err ?? null,
  };
}

async function pingSenders(fetchFn, tries = 3) {
  const out = await Promise.all(SENDER_REGIONS.map(async base => {
    const ms = [];
    for (let i = 0; i < tries; i++) {
      const t0 = performance.now();
      try { await fetchFn(`${base}/ping`, { signal: AbortSignal.timeout(2000) }); ms.push(performance.now() - t0); } catch { /* unreachable */ }
    }
    return ms.length ? { base, ms: ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)] } : null;
  }));
  return out.filter(Boolean).sort((a, b) => a.ms - b.ms);
}

export class LiveExecutor {
  constructor({ wallet, apiKey, settings, log = console.error, fetchFn = fetch, connection = null, sdk = null }) {
    if (!apiKey) throw new Error('HELIUS_API_KEY is required for live trading');
    this.wallet = wallet; this.user = wallet.publicKey; this.owner = this.user.toBase58();
    this.settings = settings; this.log = log; this.fetch = fetchFn; this.apiKey = apiKey;
    this.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    this.conn = connection ?? new Connection(this.rpcUrl, { commitment: 'confirmed' });
    this.sdk = sdk ?? new OnlinePumpSdk(this.conn);
    this.blockhash = null; this.fees = null; this.timers = []; this.stopped = false; this.mints = new Map();
  }
  async init() {
    let base = this.settings.senderUrl;
    if (base === 'auto') {
      const ranked = await pingSenders(this.fetch);
      if (!ranked.length) throw new Error('No Helius Sender region reachable');
      base = ranked[0].base;
      this.log(JSON.stringify({ event: 'live_sender', region: base.slice(7, 10), pingMs: Math.round(ranked[0].ms) }));
    }
    base = base.replace(/\/(fast|ping)?(\?.*)?$/, '');
    this.pingUrl = `${base}/ping`;
    const url = new URL(`${base}/fast`);
    url.searchParams.set('swqos_only', 'true');
    url.searchParams.set('api-key', this.apiKey);
    this.senderUrl = url.toString();
    await Promise.all([this.refreshBlockhash(), this.refreshFees(), this.refreshPriority().catch(() => {})]);
    this.timers.push(setInterval(() => this.refreshPriority().catch(() => {}), 5_000));
    await this.refreshBalance().catch(() => {});
    this.timers.push(setInterval(() => this.refreshBalance().catch(() => {}), 5_000));
    this.timers.push(setInterval(() => this.refreshBlockhash().catch(() => {}), 10_000));
    this.timers.push(setInterval(() => this.refreshFees().catch(() => {}), 300_000));
    this.timers.push(setInterval(() => this.fetch(this.pingUrl).catch(() => {}), 5_000));
    for (const timer of this.timers) timer.unref?.();
  }
  stop() { this.stopped = true; for (const timer of this.timers) clearInterval(timer); this.timers = []; }
  async refreshBlockhash() {
    const b = await this.conn.getLatestBlockhash('confirmed');
    this.blockhash = { blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight, at: Date.now() };
  }
  async refreshFees() {
    const [global, feeConfig] = await Promise.all([this.sdk.fetchGlobal(), this.sdk.fetchFeeConfig()]);
    this.fees = { global, feeConfig };
  }
  /** Wallet SOL in lamports at confirmed commitment; throws on RPC failure. */
  async balance() { return BigInt(await this.conn.getBalance(this.user, 'confirmed')); }
  /** Background balance, so a buy need not wait on a balance RPC. Stale after 15 s. */
  async refreshBalance() { this.cachedBalance = { lamports: await this.balance(), at: Date.now() }; }
  balanceCached() { return this.cachedBalance && Date.now() - this.cachedBalance.at <= 15_000 ? this.cachedBalance.lamports : null; }
  /** Raw token balance of our ATA for `mint`; 0 only when the account does not exist. Throws on RPC failure. */
  async tokenBalance(mint, tokenProgram) {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), this.user, true, new PublicKey(tokenProgram));
    const info = await this.conn.getAccountInfo(ata, 'confirmed');
    if (!info) return 0n;
    return info.data.readBigUInt64LE(64);
  }
  /** Mints (both token programs) where this wallet holds a nonzero balance. Throws on RPC failure. */
  async heldMints() {
    const held = new Set();
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const res = await this.conn.getParsedTokenAccountsByOwner(this.user, { programId }, 'confirmed');
      for (const { account } of res.value) {
        const info = account.data?.parsed?.info;
        if (info && BigInt(info.tokenAmount?.amount ?? '0') > 0n) held.add(info.mint);
      }
    }
    return held;
  }
  /** Owner program of the mint account (SPL Token or Token-2022). Throws on RPC failure or a missing mint. */
  async mintTokenProgram(mint) {
    const info = await this.conn.getAccountInfo(new PublicKey(mint), 'confirmed');
    if (!info) throw new Error('mint_missing');
    return info.owner.toBase58();
  }
  /** Token program and supply never change for a Pump mint after creation: read once per mint. */
  async mintInfo(mintKey) {
    const id = mintKey.toBase58();
    if (!this.mints.has(id)) {
      const info = await this.conn.getAccountInfo(mintKey, 'confirmed');
      if (!info) throw new Error('mint_missing');
      // Mayhem mints carry their real supply on the mint (u64 at 36); fee tiers use it.
      this.mints.set(id, { tokenProgram: info.owner, mintSupply: info.data.readBigUInt64LE(36) });
      if (this.mints.size > 5000) this.mints.delete(this.mints.keys().next().value);
    }
    return this.mints.get(id);
  }
  /**
   * Curve state for quoting. `confirmed` ({ owner, data: [base64, 'base64'] }) is the engine's own confirmed snapshot:
   * reusing it avoids a second read between the fill decision and the send.
   */
  async curve(mint, confirmed = null) {
    const mintKey = new PublicKey(mint), curveKey = bondingCurvePda(mintKey);
    let curveInfo;
    if (confirmed?.data?.[1] === 'base64') {
      curveInfo = { data: Buffer.from(confirmed.data[0], 'base64'), owner: new PublicKey(confirmed.owner),
        lamports: confirmed.lamports ?? 0, executable: false };
    } else {
      curveInfo = await this.conn.getAccountInfo(curveKey, 'confirmed');
      if (!curveInfo) throw new Error('curve_missing');
    }
    const bc = PUMP_SDK.decodeBondingCurve(curveInfo);
    if (bc.complete) throw new Error('curve_complete');
    const { tokenProgram, mintSupply } = await this.mintInfo(mintKey);
    return { mintKey, curveInfo, bc, tokenProgram, mintSupply };
  }
  /** Refresh the cached Helius estimate for Pump program traffic. Estimates older than 60 s are not used. */
  async refreshPriority() {
    if (this.settings.priorityMicroLamports != null) return;
    const result = await this.rpc('getPriorityFeeEstimate', [{ accountKeys: [PUMP_PROGRAM],
      options: { priorityLevel: this.settings.priorityLevel, recommended: true, lookbackSlots: 50 } }], 3000);
    if (Number.isFinite(result?.priorityFeeEstimate) && result.priorityFeeEstimate >= 0) {
      this.priority = { microLamports: result.priorityFeeEstimate, at: Date.now() };
    }
  }
  /** Compute-unit price: fixed, or the cached estimate clamped to [floor, max]. No network call; never throws. */
  priorityPrice() {
    const { priorityMicroLamports: fixed, maxPriorityMicroLamports: max, priorityFloorMicroLamports: floor } = this.settings;
    if (fixed != null) return Math.round(fixed);
    const estimate = this.priority && Date.now() - this.priority.at <= 60_000 ? this.priority.microLamports : floor;
    return Math.round(Math.min(max, Math.max(floor, estimate)));
  }
  compile(instructions, units, microLamports = this.settings.priorityMicroLamports ?? this.settings.priorityFloorMicroLamports) {
    // A blockhash older than ~45 s may expire before the send lands; refresh failures must not sign with it.
    if (!this.blockhash || Date.now() - this.blockhash.at > 45_000) throw new Error('blockhash_unavailable');
    const tip = SystemProgram.transfer({ fromPubkey: this.user, toPubkey: TIPS[Math.floor(Math.random() * TIPS.length)], lamports: this.settings.tipLamports });
    const message = new TransactionMessage({
      payerKey: this.user, recentBlockhash: this.blockhash.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...instructions, tip],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([this.wallet]);
    return { tx, lastValidBlockHeight: this.blockhash.lastValidBlockHeight, microLamports };
  }
  /**
   * Buy with `lamports` (swap fees included) as a HARD cap on SOL spent by the swap. The token amount is quoted for
   * the budget and reduced by `slippageBps`, so an adverse move up to that tolerance still fills within the budget
   * (fewer tokens than quoted, never more SOL); beyond it the program rejects the buy.
   */
  async buyInstructions(mint, lamports, slippageBps, confirmed = null) {
    if (!this.fees) throw new Error('fees_unavailable');
    const c = await this.curve(mint, confirmed);
    const quoted = big(getBuyTokenAmountFromSolAmount({ global: this.fees.global, feeConfig: this.fees.feeConfig,
      mintSupply: bn(c.mintSupply), bondingCurve: c.bc, amount: bn(lamports), quoteMint: WSOL }));
    const tokens = quoted * BigInt(10000 - slippageBps) / 10000n;
    if (tokens <= 0n || tokens > big(c.bc.realTokenReserves)) throw new Error('curve_cannot_fill');
    const instructions = await PUMP_SDK.buyInstructions({ global: this.fees.global, bondingCurveAccountInfo: c.curveInfo,
      bondingCurve: c.bc, associatedUserAccountInfo: null, mint: c.mintKey, user: this.user, amount: bn(tokens),
      solAmount: bn(lamports), slippage: 0, tokenProgram: c.tokenProgram });
    return { instructions, tokenProgram: c.tokenProgram.toBase58(), quotedTokens: tokens,
      accounts: [c.mintKey, bondingCurvePda(c.mintKey)] };
  }
  /**
   * Sell `tokens` for at least `minLamports`; with `minLamports === null`, at least a fresh quote less `slippageBps`
   * (mandatory exits: never an unbounded zero minimum). Closes the ATA (reclaims rent) when selling the whole balance.
   */
  async sellInstructions(mint, tokens, minLamports, close, slippageBps = 2000) {
    if (!this.fees) throw new Error('fees_unavailable');
    const c = await this.curve(mint);
    // A drained curve cannot pay out more than its real SOL: selling past that fails on-chain with Overflow (6024),
    // and retrying the same amount fails forever. Cap the amount at what the fresh curve can pay (gross <= real SOL,
    // with a 1% margin for trades landing first); the rest stays in the wallet and is reported as residual.
    const payable = payableTokens(c.bc, tokens);
    if (payable <= 0n) throw new Error('curve_drained');
    if (payable < tokens) { tokens = payable; close = false; }
    const quoted = big(getSellSolAmountFromTokenAmount({ global: this.fees.global, feeConfig: this.fees.feeConfig,
      mintSupply: bn(c.mintSupply), bondingCurve: c.bc, amount: bn(tokens) }));
    if (minLamports === null) minLamports = quoted * BigInt(10000 - slippageBps) / 10000n;
    if (minLamports < 0n) minLamports = 0n;
    const instructions = await PUMP_SDK.sellInstructions({ global: this.fees.global, bondingCurveAccountInfo: c.curveInfo,
      bondingCurve: c.bc, mint: c.mintKey, user: this.user, amount: bn(tokens), solAmount: bn(minLamports), slippage: 0,
      tokenProgram: c.tokenProgram, mayhemMode: c.bc.isMayhemMode, cashback: c.bc.isCashbackCoin });
    if (close) instructions.push(createCloseAccountInstruction(getAssociatedTokenAddressSync(c.mintKey, this.user, true, c.tokenProgram), this.user, this.user, [], c.tokenProgram));
    return { instructions, tokenProgram: c.tokenProgram.toBase58(), quotedLamports: quoted,
      accounts: [c.mintKey, bondingCurvePda(c.mintKey)] };
  }
  /** Build and sign a buy without sending it: the caller persists `signature` before `submit`. */
  async prepareBuy(mint, lamports, slippageBps, confirmed = null) {
    const built = await this.buyInstructions(mint, lamports, slippageBps, confirmed);
    return this.prepare(built.instructions, mint, this.settings.buyUnits, { tokenProgram: built.tokenProgram, quotedTokens: built.quotedTokens.toString() },
      this.priorityPrice());
  }
  async prepareSell(mint, tokens, minLamports, close = true, slippageBps = 2000) {
    const built = await this.sellInstructions(mint, tokens, minLamports, close, slippageBps);
    return this.prepare(built.instructions, mint, this.settings.sellUnits, { tokenProgram: built.tokenProgram, quotedLamports: built.quotedLamports.toString() },
      this.priorityPrice());
  }
  prepare(instructions, mint, units, extra = {}, microLamports) {
    if (this.stopped) throw new Error('executor_stopped');
    const { tx, lastValidBlockHeight, microLamports: price } = this.compile(instructions, units, microLamports);
    // Worst-case SOL outside the swap: tip + base fee + priority fee (the ATA rent is refundable and tracked separately).
    const overheadLamports = BigInt(this.settings.tipLamports) + 5000n + BigInt(Math.ceil(units * price / 1e6));
    return { mint, signature: bs58.encode(tx.signatures[0]), wire: Buffer.from(tx.serialize()).toString('base64'),
      lastValidBlockHeight, microLamports: price, overheadLamports, ...extra };
  }
  /** Worst-case non-swap SOL for one transaction at the maximum allowed priority price. */
  maxOverheadLamports(side = 'buy') {
    const units = side === 'buy' ? this.settings.buyUnits : this.settings.sellUnits;
    const price = this.settings.priorityMicroLamports ?? this.settings.maxPriorityMicroLamports;
    return BigInt(this.settings.tipLamports) + 5000n + BigInt(Math.ceil(units * price / 1e6));
  }
  async buy(mint, lamports, slippageBps) { return this.submit(await this.prepareBuy(mint, lamports, slippageBps)); }
  async sell(mint, tokens, minLamports, close = true, slippageBps = 2000) { return this.submit(await this.prepareSell(mint, tokens, minLamports, close, slippageBps)); }
  /** Current block height at confirmed commitment; a signature unseen past its lastValidBlockHeight can never land. */
  async blockHeight() { return this.conn.getBlockHeight('confirmed'); }
  async rpc(method, params, timeoutMs = 10_000) {
    const res = await this.fetch(this.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    if (body.error) throw new Error(`rpc_${Number(body.error.code) || 'error'}`);
    return body.result;
  }
  async confirmedTransaction(signature) {
    return this.rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  }
  /**
   * Settle a signature from chain: { status: 'ok'|'failed'|'unknown', seen, ...deltas }. `seen` means the cluster
   * knows the signature (any commitment): it may already have landed, so it must not be expired by block height.
   */
  async resolve(signature, mint) {
    const status = (await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]))?.value?.[0];
    if (!status) return { signature, status: 'unknown', seen: false };
    if (!['confirmed', 'finalized'].includes(status.confirmationStatus)) return { signature, status: 'unknown', seen: true };
    const tx = await this.confirmedTransaction(signature);
    if (!tx) return { signature, status: 'unknown', seen: true };
    const delta = ownerDelta(tx, this.owner, mint);
    if (!delta) return { signature, status: 'unknown', seen: true };
    return { signature, status: delta.err ? 'failed' : 'ok', slot: tx.slot, ...delta };
  }
  /**
   * Send a prepared transaction through Sender, rebroadcast and poll until confirmed or the deadline. Never throws.
   * Returns { signature, status: 'ok'|'failed'|'unknown'|'rejected'|'simulated', ... }. 'rejected' means it was never
   * broadcast; 'unknown' means it may still land, and must be resolved later from chain.
   */
  async submit(prepared) {
    const { signature, wire, mint, tokenProgram } = prepared;
    const extra = { tokenProgram, lastValidBlockHeight: prepared.lastValidBlockHeight };
    if (this.stopped) return { signature, status: 'rejected', errorCode: null, ...extra };
    if (this.settings.dryRun) {
      try {
        const sim = await this.rpc('simulateTransaction', [wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
        return { signature, status: 'simulated', simulationError: sim?.value?.err ?? null, unitsConsumed: sim?.value?.unitsConsumed ?? null, ...extra };
      } catch { return { signature, status: 'simulated', simulationError: 'Unknown', unitsConsumed: null, ...extra }; }
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] });
    const post = () => this.fetch(this.senderUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).catch(error => ({ error: { transport: true, message: String(error?.name ?? 'fetch_failed') } }));
    const first = await post();
    // Only an explicit, non-transport Sender error proves the transaction was never broadcast.
    if (first?.error && !first.error.transport && !/timeout|fetch failed/i.test(String(first.error.message ?? ''))) {
      return { signature, status: 'rejected', errorCode: Number(first.error.code) || null, ...extra };
    }
    const deadline = Date.now() + this.settings.confirmTimeoutMs;
    await sleep(1500);
    while (Date.now() < deadline) {
      post();
      try {
        const settled = await this.resolve(signature, mint);
        if (settled.status !== 'unknown') return { ...settled, ...extra };
      } catch { /* transient RPC failure: keep polling until the deadline */ }
      await sleep(1000);
    }
    return { signature, status: 'unknown', ...extra };
  }
}
