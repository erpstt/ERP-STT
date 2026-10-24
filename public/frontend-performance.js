/**
 * Build a lookup once when a render joins two in-memory collections.
 * This keeps table rendering linear instead of repeatedly scanning a catalog.
 */
export function indexBy(rows, keySelector) {
  const index = new Map();
  for (const row of rows || []) {
    const key = keySelector(row);
    if (key !== null && key !== undefined) index.set(String(key), row);
  }
  return index;
}

/**
 * Lazy lookup for screens that join several catalogs using different primary
 * key field names. Each array/key pair is indexed only on its first use.
 */
export function createIndexedLookup() {
  const catalogs = new WeakMap();
  return (rows, key, value) => {
    if (!Array.isArray(rows)) return undefined;
    let keys = catalogs.get(rows);
    if (!keys) {
      keys = new Map();
      catalogs.set(rows, keys);
    }
    let index = keys.get(key);
    if (!index) {
      index = indexBy(rows, row => row?.[key]);
      keys.set(key, index);
    }
    return index.get(String(value));
  };
}

/**
 * Resolve async work with a fixed number of workers. The returned array keeps
 * the input order and the optional AbortSignal stops scheduling new work.
 */
export async function mapWithConcurrency(rows, concurrency, mapper, signal) {
  const items = Array.from(rows || []);
  if (!items.length) return [];

  const results = new Array(items.length);
  let cursor = 0;
  let stopped = false;
  const workerCount = Math.min(items.length, Math.max(1, Math.trunc(concurrency) || 1));

  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const failure = new Error('La operación fue cancelada.');
    failure.name = 'AbortError';
    throw failure;
  };

  async function worker() {
    while (!stopped && cursor < items.length) {
      throwIfAborted();
      const position = cursor++;
      try {
        results[position] = await mapper(items[position], position, signal);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * Compare request/filter payloads without depending on object key insertion
 * order. Array order remains significant because it can affect API semantics.
 */
export function sameRequestParameters(left, right) {
  const normalize = value => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => [key, normalize(value[key])])
    );
  };

  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/**
 * Coordinates refreshable screens: starting a new request cancels the older
 * one and exposes a cheap current-request check before a response changes UI.
 */
export function createLatestRequest() {
  let controller = null;
  let version = 0;

  return {
    begin() {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      const currentVersion = ++version;
      return {
        signal: requestController.signal,
        isCurrent: () => currentVersion === version && !requestController.signal.aborted
      };
    },
    cancel() {
      controller?.abort();
      controller = null;
      version += 1;
    }
  };
}
