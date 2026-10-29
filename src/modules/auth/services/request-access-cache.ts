interface RequestAccessCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

interface ValidationOptions {
  key: string;
  validUntil?: number;
  validate: () => Promise<void>;
}

const DEFAULT_TTL_MS = 15_000;
const MIN_TTL_MS = 10_000;
const MAX_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 5_000;
const MIN_MAX_ENTRIES = 100;
const MAX_MAX_ENTRIES = 100_000;

function integer(value: string | undefined) {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function configuredRequestAccessCacheTtlMs(value = process.env.AUTH_REQUEST_ACCESS_CACHE_TTL_MS) {
  const parsed = integer(value);
  if (parsed === 0) return 0;
  if (parsed === null) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, parsed));
}

export function configuredRequestAccessCacheMaxEntries(value = process.env.AUTH_REQUEST_ACCESS_CACHE_MAX_ENTRIES) {
  const parsed = integer(value);
  if (parsed === null) return DEFAULT_MAX_ENTRIES;
  return Math.min(MAX_MAX_ENTRIES, Math.max(MIN_MAX_ENTRIES, parsed));
}

/**
 * Conserva únicamente validaciones exitosas. Las claves deben ser hashes de
 * credenciales, nunca los tokens originales. Las validaciones concurrentes de
 * una misma sesión/dispositivo comparten la llamada en curso para evitar una
 * estampida hacia Supabase.
 */
export class PositiveRequestAccessCache {
  private readonly values = new Map<string, number>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly options: RequestAccessCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  private cached(key: string) {
    const expiresAt = this.values.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.values.delete(key);
      return false;
    }
    this.values.delete(key);
    this.values.set(key, expiresAt);
    return true;
  }

  private remember(key: string, validUntil: number | undefined) {
    if (this.options.ttlMs <= 0) return;
    const now = this.now();
    const expiresAt = Math.min(now + this.options.ttlMs, validUntil ?? Number.POSITIVE_INFINITY);
    if (expiresAt <= now) return;
    this.values.delete(key);
    while (this.values.size >= this.options.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    this.values.set(key, expiresAt);
  }

  private sessionHash(key: string) {
    const separator = key.indexOf(':');
    return separator > 0 ? key.slice(0, separator) : key;
  }

  async getOrValidate({ key, validUntil, validate }: ValidationOptions) {
    if (this.cached(key)) return;
    if (this.options.ttlMs <= 0) return validate();
    const current = this.pending.get(key);
    if (current) return current;
    let validation!: Promise<void>;
    validation = (async () => {
      await validate();
      if (this.pending.get(key) === validation) this.remember(key, validUntil);
    })();
    this.pending.set(key, validation);
    try {
      await validation;
    } finally {
      if (this.pending.get(key) === validation) this.pending.delete(key);
    }
  }

  invalidateSession(sessionHash: string) {
    const prefix = `${sessionHash}:`;
    for (const key of this.values.keys()) if (key.startsWith(prefix)) this.values.delete(key);
    for (const key of this.pending.keys()) if (key.startsWith(prefix)) this.pending.delete(key);
  }

  clear() {
    this.values.clear();
    this.pending.clear();
  }

  get size() {
    return this.values.size;
  }
}
