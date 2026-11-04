import { createHash } from 'node:crypto';

type AttemptBucket = { timestamps: number[]; expiresAt: number };

export type BoundedRateLimitStateOptions = {
  windowMs: number;
  attemptLimit: number;
  maxEntries?: number;
  cleanupBatchSize?: number;
  clock?: () => number;
};

const MAX_ENTRIES = 5_000;
const CLEANUP_BATCH_SIZE = 32;
const MAX_CLEANUP_BATCH_SIZE = 128;
const MAX_ATTEMPTS = 100;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_KEY_CHARACTERS = 1_024;

function boundedOption(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError('Configuración del limitador inválida.');
  }
  return value;
}

/** Only fixed-length digests enter the store. Invalid or oversized identities
 * share a conservative bucket without reading or coercing arbitrary objects.
 * Callers retain responsibility for their existing identity normalization.
 */
export function boundedRateLimitKey(identity: unknown) {
  const hash = createHash('sha256').update('bounded-rate-limit-state-v1\0');
  if (typeof identity === 'string' && identity.length > 0 && identity.length <= MAX_KEY_CHARACTERS) {
    hash.update('identity\0').update(identity);
  } else {
    hash.update('invalid-identity');
  }
  return hash.digest('hex');
}

export class BoundedRateLimitStateError extends Error {
  readonly status = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('Se realizaron demasiados intentos. Inténtalo más tarde.');
    this.name = 'BoundedRateLimitStateError';
    this.retryAfterSeconds = boundedOption(retryAfterSeconds, MAX_WINDOW_MS / 1_000);
  }
}

/** Local sliding-window state only: no timers, environment access or IO.
 * Successful records renew one common TTL and move to the end of expiry order.
 * Reads and rejections neither reserve entries nor extend their lifetime.
 * A full store rejects new identities instead of evicting an active budget.
 * A distributed limiter and trusted client-IP boundary remain separate work.
 */
export class BoundedRateLimitState {
  private readonly entries = new Map<string, AttemptBucket>();
  private readonly windowMs: number;
  private readonly attemptLimit: number;
  private readonly maxEntries: number;
  private readonly cleanupBatchSize: number;
  private readonly clock: () => number;
  private lastNow = Number.NEGATIVE_INFINITY;
  private trackedAttempts = 0;

  constructor(options: BoundedRateLimitStateOptions) {
    this.windowMs = boundedOption(options.windowMs, MAX_WINDOW_MS);
    this.attemptLimit = boundedOption(options.attemptLimit, MAX_ATTEMPTS);
    this.maxEntries = boundedOption(options.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES);
    this.cleanupBatchSize = boundedOption(options.cleanupBatchSize ?? CLEANUP_BATCH_SIZE, MAX_CLEANUP_BATCH_SIZE);
    if (options.clock !== undefined && typeof options.clock !== 'function') {
      throw new RangeError('Configuración del limitador inválida.');
    }
    this.clock = options.clock ?? Date.now;
  }

  private time(override?: number) {
    const now = override === undefined ? this.clock() : override;
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - this.windowMs) {
      throw new RangeError('Reloj del limitador inválido.');
    }
    this.lastNow = Math.max(this.lastNow, now);
    return this.lastNow;
  }

  private remove(key: string, bucket: AttemptBucket) {
    this.entries.delete(key);
    this.trackedAttempts -= bucket.timestamps.length;
  }

  private cleanup(now: number) {
    // Monotonic time plus a single TTL keeps Map order sorted by expiry.
    // Each operation visits at most one batch, plus its requested identity.
    for (let checked = 0; checked < this.cleanupBatchSize; checked++) {
      const oldest = this.entries.entries().next();
      if (oldest.done || oldest.value[1].expiresAt > now) break;
      this.remove(oldest.value[0], oldest.value[1]);
    }
  }

  private active(key: string, now: number) {
    const bucket = this.entries.get(key);
    if (!bucket) return undefined;
    if (bucket.expiresAt <= now) {
      this.remove(key, bucket);
      return undefined;
    }
    let expired = 0;
    while (expired < bucket.timestamps.length && bucket.timestamps[expired] <= now - this.windowMs) expired++;
    if (expired) {
      bucket.timestamps.splice(0, expired);
      this.trackedAttempts -= expired;
    }
    return bucket;
  }

  private reject(until: number, now: number): never {
    throw new BoundedRateLimitStateError(Math.max(1, Math.ceil((until - now) / 1_000)));
  }

  private checked(identity: unknown, now: number) {
    this.cleanup(now);
    const key = boundedRateLimitKey(identity);
    const bucket = this.active(key, now);
    if (bucket && bucket.timestamps.length >= this.attemptLimit) {
      this.reject(bucket.timestamps[0] + this.windowMs, now);
    }
    if (!bucket && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.values().next().value;
      this.reject(oldest?.expiresAt ?? now + this.windowMs, now);
    }
    return { key, bucket };
  }

  assertAllowed(identity: unknown, now?: number) {
    this.checked(identity, this.time(now));
  }

  recordAttempt(identity: unknown, now?: number) {
    const timestamp = this.time(now);
    const { key, bucket } = this.checked(identity, timestamp);
    const current = bucket ?? { timestamps: [], expiresAt: 0 };
    current.timestamps.push(timestamp);
    current.expiresAt = timestamp + this.windowMs;
    this.trackedAttempts++;
    this.entries.delete(key);
    this.entries.set(key, current);
  }

  clear(identity: unknown) {
    const key = boundedRateLimitKey(identity);
    const bucket = this.entries.get(key);
    if (!bucket) return false;
    this.remove(key, bucket);
    return true;
  }

  /** Aggregate metrics only; never returns an identity, digest or timestamp. */
  getStats() {
    return {
      entries: this.entries.size,
      capacity: this.maxEntries,
      attempts: this.trackedAttempts,
      attemptLimit: this.attemptLimit,
      windowMs: this.windowMs,
    };
  }
}
