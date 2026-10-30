import { PublicKey } from '@solana/web3.js';
import { PUMP, MAYHEM } from './config.js';

const CREATE = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const TRADE = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const CURVE = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
class Reader {
  constructor(bytes) { this.bytes = bytes; this.offset = 8; }
  take(n) {
    if (n < 0 || this.offset + n > this.bytes.length) throw new Error('Truncated event');
    const value = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }
  u64() { return this.take(8).readBigUInt64LE(); }
  i64() { return Number(this.take(8).readBigInt64LE()); }
  bool() {
    const value = this.take(1)[0];
    if (value > 1) throw new Error('Invalid boolean');
    return value === 1;
  }
  key() { return new PublicKey(this.take(32)).toBase58(); }
  string() { return this.take(this.take(4).readUInt32LE()).toString('utf8'); }
}

// Decode one Pump creation event; null for legacy or non-Mayhem creations. Throws if truncated.
function createEvent(data, index) {
  const r = new Reader(data);
  const name = r.string(), symbol = r.string(); r.string();
  const mint = r.key(), curve = r.key(); r.key(); r.key();
  const timestamp = r.i64();
  r.take(32); // Four u64 reserve/supply fields.
  // Legacy creation events have no token_program / Mayhem extension.
  if (data.length === r.offset) return null;
  r.key();
  return r.bool() ? { type: 'create', index, mint, curve, timestamp, name, symbol } : null;
}

// Attribute events by invocation ancestry, not by transaction-wide program presence.
export function decodeLogs(logs) {
  const stack = [];
  const starts = [];
  const events = [];
  for (const [index, line] of logs.entries()) {
    const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]) - 1;
      stack.length = depth; starts.length = depth;
      stack.push(invoke[1]); starts.push(events.length); continue;
    }
    if (/^Program \w+ (success|failed:)/.test(line)) {
      const start = starts.pop();
      if (line.includes(' failed:') && start != null) events.length = start;
      stack.pop(); continue;
    }
    if (!line.startsWith('Program data: ') || stack.at(-1) !== PUMP) continue;
    const data = Buffer.from(line.slice(14), 'base64');
    if (data.subarray(0, 8).equals(CREATE)) {
      const created = createEvent(data, index);
      if (created) events.push(created);
    } else if (data.subarray(0, 8).equals(TRADE) && stack.includes(MAYHEM)) {
      const r = new Reader(data);
      const mint = r.key();
      const solAmount = r.u64().toString(), tokenAmount = r.u64().toString();
      const buy = r.bool(), user = r.key(), timestamp = r.i64();
      // A Pump TradeEvent under the Mayhem invocation is evidence of an actual trade.
      events.push({ type: 'trade', index, mint, solAmount, tokenAmount, buy, user, timestamp });
    }
  }
  return events;
}

const TRUNCATION_MARKER = 'Log truncated';

// Conservative decode of the log prefix before the first truncation marker. A creation is
// returned only when the Pump invocation that emitted it and EVERY ancestor invocation closed
// with success before the marker. Open or failed scopes discard their pending events;
// malformed nesting rejects the whole prefix. Trades are never recovered from partial logs.
// Returns { ok, events, reason }; reason is set when ok is false.
export function decodeCreationsBeforeTruncation(logs) {
  const reject = reason => ({ ok: false, events: [], reason });
  if (!Array.isArray(logs)) return reject('missing_logs');
  const marker = logs.findIndex(line => typeof line === 'string' && line.includes(TRUNCATION_MARKER));
  if (marker < 0) return reject('no_truncation_marker');
  const frames = [];
  const proven = [];
  for (let index = 0; index < marker; index++) {
    const line = logs[index];
    if (typeof line !== 'string') return reject('malformed_scope');
    const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      if (Number(invoke[2]) !== frames.length + 1) return reject('malformed_scope');
      frames.push({ program: invoke[1], events: [] });
      continue;
    }
    const close = /^Program (\w+) (success|failed: .*)$/.exec(line);
    if (close) {
      const frame = frames.pop();
      if (!frame || frame.program !== close[1]) return reject('malformed_scope');
      // A failed invocation discards its own and its descendants' pending events.
      if (close[2] !== 'success') continue;
      (frames.length ? frames.at(-1).events : proven).push(...frame.events);
      continue;
    }
    if (/^Program \S+ (?:invoke\b|success\b|failed:)/.test(line)) return reject('malformed_scope');
    if (!line.startsWith('Program data: ') || frames.at(-1)?.program !== PUMP) continue;
    const encoded = line.slice(14);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return reject('malformed_event');
    const data = Buffer.from(encoded, 'base64');
    if (data.length < 8 || !data.subarray(0, 8).equals(CREATE)) continue;
    try {
      const created = createEvent(data, index);
      if (created) frames.at(-1).events.push(created);
    } catch { return reject('malformed_event'); }
  }
  // Frames still open at the marker are never proven.
  return { ok: true, events: proven, reason: null };
}

// Proven pre-truncation creations of a truncated, successful transaction (empty otherwise).
export function recoverableCreations(tx) {
  const meta = tx?.meta;
  if (!meta || meta.err !== null || !Number.isSafeInteger(tx.slot)) return [];
  return decodeCreationsBeforeTruncation(meta.logMessages).events.map(event => ({ ...event, slot: tx.slot }));
}

export function transactionEvents(tx) {
  if (!tx || !tx.meta || !Object.hasOwn(tx.meta, 'err') || tx.meta.err === undefined ||
      !Number.isSafeInteger(tx.slot)) throw new Error('Malformed transaction metadata');
  if (tx.meta.err !== null) return [];
  if (tx.meta.logMessages?.some(line => line.includes('Log truncated'))) {
    throw Object.assign(new Error('Transaction logs truncated; history remains incomplete'), { code: 'TRUNCATED_LOGS' });
  }
  if (!Array.isArray(tx.meta.logMessages) || !Number.isSafeInteger(tx.blockTime)) {
    throw new Error('Missing logs or on-chain block time');
  }
  return decodeLogs(tx.meta.logMessages).map(event => ({ ...event, slot: tx.slot }));
}

// Fixed, payload-free labels for why a curve account failed validation (diagnostics only).
export const CURVE_VALIDATION_CODES = Object.freeze(['missing_or_wrong_owner', 'length_or_discriminator',
  'unsupported_quote', 'invalid_flags', 'zero_reserves']);
const invalidCurve = (code, message) => Object.assign(new Error(message), { validation: code });

// Pinned public IDL prefix, not a claim that an arbitrary account length identifies a version.
// See test/fixtures/pump-curve-prefix.json for source revision and native-SOL sentinel semantics.
export function curveLayoutEvidence(account) {
  const evidence = { curveDiscriminatorMatches: null, quoteLayout: null, quoteMintObserved: null };
  const data = account?.data;
  if (account?.owner !== PUMP || !Array.isArray(data) || data[1] !== 'base64' || typeof data[0] !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data[0])) return evidence;
  const bytes = Buffer.from(data[0], 'base64');
  if (bytes.length < 8) return evidence;
  evidence.curveDiscriminatorMatches = bytes.subarray(0, 8).equals(CURVE);
  if (evidence.curveDiscriminatorMatches && bytes.length >= 115) {
    evidence.quoteLayout = 'documented_quote_prefix_83';
    evidence.quoteMintObserved = new PublicKey(bytes.subarray(83, 115)).toBase58();
  }
  return evidence;
}

export function decodeCurve(account) {
  if (!account || account.owner !== PUMP) throw invalidCurve('missing_or_wrong_owner', 'Missing or wrong-owner curve account');
  const bytes = Buffer.from(account.data[0], 'base64');
  if (bytes.length < 82 || !bytes.subarray(0, 8).equals(CURVE)) throw invalidCurve('length_or_discriminator', 'Unknown curve layout');
  // Current IDL appends quote_mint after is_cashback_coin. All-zero means native SOL.
  if (bytes.length >= 115 && bytes.subarray(83, 115).some(byte => byte !== 0)) {
    throw invalidCurve('unsupported_quote', 'Unsupported non-native-SOL quote');
  }
  if (bytes[48] > 1 || bytes[81] > 1) throw invalidCurve('invalid_flags', 'Invalid curve flags');
  if (bytes[48] === 1) return { complete: true, mayhem: bytes[81] === 1, marketCap: null,
    liquidity: Number(bytes.readBigUInt64LE(32)) / 1e9 };
  const virtualTokens = bytes.readBigUInt64LE(8);
  const virtualQuote = bytes.readBigUInt64LE(16);
  const supply = bytes.readBigUInt64LE(40);
  if (virtualTokens === 0n) throw invalidCurve('zero_reserves', 'Zero virtual token reserves');
  return {
    complete: bytes[48] === 1,
    mayhem: bytes[81] === 1,
    marketCap: Number(virtualQuote * supply / virtualTokens) / 1e9,
    liquidity: Number(bytes.readBigUInt64LE(32)) / 1e9,
  };
}

export function filterReasons(curve, cfg) {
  const reasons = [];
  if (curve.marketCap < cfg.minCap) reasons.push('market_cap_below_min');
  if (curve.marketCap > cfg.maxCap) reasons.push('market_cap_above_max');
  if (curve.liquidity <= cfg.minLiquidity) reasons.push('liquidity_at_or_below_min');
  return reasons;
}

export function classify(curve, cfg) {
  if (curve.complete) return { category: 'graduated', age: null, passes: false, reasons: [] };
  const reasons = filterReasons(curve, cfg);
  const passes = reasons.length === 0;
  return { age: null, passes, reasons, category: passes ? 'candidate' : 'unqualified' };
}
