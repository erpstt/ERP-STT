import { createHash } from 'node:crypto';
import { recordReadCacheAccess } from './runtime-metrics.js';

interface ScopedReadCacheOptions {
  defaultTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface LoadOptions<T> {
  namespace: string;
  scope: readonly (string | number | boolean | null | undefined)[];
  loader: () => Promise<T>;
  ttlMs?: number;
}

interface Entry<T> {
  namespace: string;
  expiresAt: number;
  value: T;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 2_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 300_000;
const MIN_ENTRIES = 100;
const MAX_ENTRIES = 100_000;
const registeredCaches = new Set<ScopedReadCache<unknown>>();

function boundedInteger(value: number | string | undefined, fallback: number, minimum: number, maximum: number, allowZero = false) {
  const parsed = Number(value);
  if (allowZero && parsed === 0) return 0;
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export function configuredReadCacheTtlMs(value: string | undefined = process.env.READ_CACHE_DEFAULT_TTL_MS) {
  return boundedInteger(value, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS, true);
}

export function configuredReadCacheMaxEntries(value: string | undefined = process.env.READ_CACHE_MAX_ENTRIES) {
  return boundedInteger(value, DEFAULT_MAX_ENTRIES, MIN_ENTRIES, MAX_ENTRIES);
}

function safeNamespace(value: string) {
  const normalized = value.replace(/[^a-z0-9:_-]/gi, '').slice(0, 80);
  if (!normalized) throw new Error('El espacio de caché no es válido.');
  return normalized;
}

/**
 * Caché LRU de lecturas. Las partes de alcance se resumen antes de usarse como
 * clave; correos, identificadores y credenciales nunca quedan almacenados en
 * texto claro dentro del índice de caché.
 */
export class ScopedReadCache<T> {
  private readonly values = new Map<string, Entry<T>>();
  private readonly pending = new Map<string, Promise<T>>();
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(options: ScopedReadCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = boundedInteger(options.defaultTtlMs, configuredReadCacheTtlMs(), MIN_TTL_MS, MAX_TTL_MS, true);
    this.maxEntries = boundedInteger(options.maxEntries, configuredReadCacheMaxEntries(), MIN_ENTRIES, MAX_ENTRIES);
    registeredCaches.add(this as unknown as ScopedReadCache<unknown>);
  }

  private cacheKey(namespace: string, scope: LoadOptions<T>['scope']) {
    const canonical = JSON.stringify(scope.map(value => value === undefined ? null : value));
    return `${namespace}:${createHash('sha256').update(canonical).digest('hex')}`;
  }

  private read(key: string) {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value;
  }

  private remember(key: string, namespace: string, value: T, ttlMs: number) {
    if (ttlMs <= 0) return;
    this.values.delete(key);
    while (this.values.size >= this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (!oldest) break;
      this.values.delete(oldest);
    }
    this.values.set(key, { namespace, value, expiresAt: this.now() + ttlMs });
  }

  async getOrLoad(options: LoadOptions<T>): Promise<T> {
    const namespace = safeNamespace(options.namespace);
    const ttlMs = boundedInteger(options.ttlMs, this.defaultTtlMs, MIN_TTL_MS, MAX_TTL_MS, true);
    const key = this.cacheKey(namespace, options.scope);
    const cached = this.read(key);
    if (cached !== undefined) {
      recordReadCacheAccess(namespace, true);
      return cached;
    }
    recordReadCacheAccess(namespace, false);
    if (ttlMs <= 0) return options.loader();
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    let request!: Promise<T>;
    request = (async () => {
      const value = await options.loader();
      if (this.pending.get(key) === request) this.remember(key, namespace, value, ttlMs);
      return value;
    })();
    this.pending.set(key, request);
    try { return await request; }
    finally { if (this.pending.get(key) === request) this.pending.delete(key); }
  }

  invalidate(namespace: string, scope?: LoadOptions<T>['scope']) {
    const safe = safeNamespace(namespace);
    if (scope) {
      const key = this.cacheKey(safe, scope);
      this.values.delete(key);
      this.pending.delete(key);
      return;
    }
    for (const [key, entry] of this.values) if (entry.namespace === safe) this.values.delete(key);
    for (const key of this.pending.keys()) if (key.startsWith(`${safe}:`)) this.pending.delete(key);
  }

  clear() {
    this.values.clear();
    this.pending.clear();
  }

  get size() {
    return this.values.size;
  }

  /** Solo para diagnóstico: devuelve hashes opacos, nunca el alcance original. */
  diagnosticKeys() {
    return [...this.values.keys()];
  }
}

/** Invalida el mismo catálogo en todas las cachés del proceso sin acoplar módulos. */
export function invalidateReadCacheNamespace(namespace: string) {
  for (const cache of registeredCaches) cache.invalidate(namespace);
}
