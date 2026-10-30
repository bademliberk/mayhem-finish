// Operational diagnostics are bounded metadata, never billed usage or raw provider errors.
const PREFIX = 'feed_health_';
export const HEALTH_STALE_MS = 5000;
export const SLOT_PROGRESS_MS = 30000;
const components = new Set(['process', 'discovery', 'standard', 'preprocessed', 'recovery']);
const phases = new Set(['starting', 'connecting', 'subscribing', 'subscribed', 'backoff', 'idle', 'running', 'stopped', 'waiting', 'recovering', 'complete']);
const categories = new Set(['connect_failed', 'transport_error', 'http_rejected', 'disconnected', 'ack_timeout',
  'subscribe_failed', 'send_failed', 'heartbeat_timeout', 'heartbeat_failed', 'malformed_message', 'oversized_frame',
  'slot_progress_timeout', 'backfill_failed', 'callback_failed']);
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
const numericFields = ['updatedAt', 'startedAt', 'attempts', 'failureStreak', 'lastAckAt', 'lastPayloadAt',
  'lastProgressAt', 'lastSlot', 'nextRetryAt', 'pending', 'cutoff', 'stoppedAt', 'pendingAcks', 'pendingProgress'];
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

export function safeFailure(category, error = {}, at = Date.now()) {
  // Never stringify/coerce an error, a code or a provider-controlled field.
  const result = { category: categories.has(category) ? category : 'transport_error', at };
  if (networkCodes.has(error?.code)) result.networkCode = error.code;
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) result.httpStatus = error.httpStatus;
  if (Number.isInteger(error?.wsCode) && error.wsCode >= 1000 && error.wsCode <= 4999) result.wsCode = error.wsCode;
  if (Number.isSafeInteger(error?.subscriptionCode) && Math.abs(error.subscriptionCode) <= 2147483648) result.subscriptionCode = error.subscriptionCode;
  return result;
}

function sanitized(value = {}) {
  const result = {};
  if (phases.has(value.phase)) result.phase = value.phase;
  for (const key of numericFields) if (nonnegative(value[key]) || value[key] === null) result[key] = value[key];
  if (value.lastFailure) {
    const f = value.lastFailure;
    result.lastFailure = safeFailure(f.category, { code: f.networkCode, httpStatus: f.httpStatus,
      wsCode: f.wsCode, subscriptionCode: f.subscriptionCode }, nonnegative(f.at) ? f.at : null);
  }
  return result;
}

export class FeedHealth {
  constructor(store, component, now = Date.now) {
    if (!components.has(component)) throw new Error('Unknown feed health component');
    this.store = store; this.component = component; this.now = now;
    this.value = { phase: 'starting', startedAt: now(), attempts: 0, failureStreak: 0 };
  }
  update(patch = {}, persist = true) {
    Object.assign(this.value, sanitized(patch));
    if (persist) this.flush();
  }
  failure(category, error) {
    this.update({ failureStreak: this.value.failureStreak + 1, lastFailure: safeFailure(category, error, this.now()) });
  }
  flush() {
    this.value.updatedAt = this.now();
    // Tiny test transports may provide usage only; production Store always provides run.
    this.store.run?.('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      PREFIX + this.component, JSON.stringify(sanitized(this.value)));
  }
  stop() { this.update({ phase: 'stopped', stoppedAt: this.now(), nextRetryAt: null }); }
}

export function readFeedHealth(store, now = Date.now()) {
  const read = component => {
    try {
      const raw = store.get('SELECT value FROM metadata WHERE key=?', PREFIX + component)?.value;
      return raw ? sanitized(JSON.parse(raw)) : {};
    } catch { return {}; }
  };
  const expired = value => !nonnegative(value.updatedAt) || now < value.updatedAt || now - value.updatedAt > HEALTH_STALE_MS;
  const process = read('process');
  process.state = process.phase === 'stopped' ? 'stopped' : !process.phase ? 'unavailable' : expired(process) ? 'stale' : 'running';
  const result = { process };
  for (const component of ['discovery', 'standard', 'preprocessed']) {
    const value = read(component);
    value.state = value.phase === 'stopped' || process.state === 'stopped' ? 'stopped'
      : !value.phase ? 'unavailable' : process.state !== 'running' || expired(value) ? 'stale'
        : value.phase === 'idle' ? 'idle' : value.phase !== 'subscribed' ? 'degraded'
          : component === 'standard' ? (nonnegative(value.lastProgressAt) && value.lastProgressAt <= now && now - value.lastProgressAt < SLOT_PROGRESS_MS
            && !value.pendingAcks && !value.pendingProgress ? 'healthy' : 'degraded') : component === 'preprocessed' && value.pending ? 'degraded' : 'subscribed';
    result[component] = value;
  }
  const recovery = read('recovery');
  const pending = store.get("SELECT COUNT(*) n FROM coverage WHERE kind IN ('backfill','process_gap','websocket_gap') AND ended_at IS NULL")?.n ?? 0;
  const cutoff = Number(store.get("SELECT value FROM metadata WHERE key='backfill_cutoff'")?.value);
  recovery.pending = pending;
  recovery.cutoff = nonnegative(cutoff) ? cutoff : null; // seconds, matching persisted recovery cutoff
  recovery.state = process.state === 'stopped' ? 'stopped' : process.state === 'stale' ? 'stale'
    : pending || recovery.cutoff != null ? (process.state === 'running' && !expired(recovery) && recovery.phase === 'recovering' ? 'recovering' : 'incomplete')
      : process.state === 'unavailable' ? 'unavailable' : 'complete';
  result.recovery = recovery;
  return result;
}
