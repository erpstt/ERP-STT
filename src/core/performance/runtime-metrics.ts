import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

interface RequestContext {
  upstreamCalls: number;
  upstreamMs: number;
  cacheHits: number;
  cacheMisses: number;
}

interface Series {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
  sampleCursor: number;
  upstreamCalls: number;
  upstreamMs: number;
  cacheHits: number;
  cacheMisses: number;
  attempts: number;
}

interface RequestMetricOptions {
  method?: string;
  url?: string;
  status?: () => number;
  completion?: () => Promise<void>;
}

const context = new AsyncLocalStorage<RequestContext>();
const routeSeries = new Map<string, Series>();
const upstreamSeries = new Map<string, Series>();
const cacheSeries = new Map<string, { hits: number; misses: number }>();
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

const boundedInteger = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
};

const maxRoutes = () => boundedInteger(process.env.PERFORMANCE_METRICS_MAX_ROUTES, 128, 16, 1_000);
const sampleSize = () => boundedInteger(process.env.PERFORMANCE_METRICS_SAMPLE_SIZE, 256, 32, 2_048);

function emptySeries(): Series {
  return { count: 0, errors: 0, totalMs: 0, maxMs: 0, samples: [], sampleCursor: 0, upstreamCalls: 0, upstreamMs: 0, cacheHits: 0, cacheMisses: 0, attempts: 0 };
}

function seriesFor(store: Map<string, Series>, key: string) {
  let value = store.get(key);
  if (value) {
    store.delete(key);
    store.set(key, value);
    return value;
  }
  while (store.size >= maxRoutes()) {
    const oldest = store.keys().next().value as string | undefined;
    if (!oldest) break;
    store.delete(oldest);
  }
  value = emptySeries();
  store.set(key, value);
  return value;
}

function observe(series: Series, durationMs: number, failed: boolean, details: Partial<RequestContext> & { attempts?: number } = {}) {
  const duration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  series.count += 1;
  if (failed) series.errors += 1;
  series.totalMs += duration;
  series.maxMs = Math.max(series.maxMs, duration);
  const limit = sampleSize();
  if (series.samples.length < limit) series.samples.push(duration);
  else {
    series.samples[series.sampleCursor] = duration;
    series.sampleCursor = (series.sampleCursor + 1) % limit;
  }
  series.upstreamCalls += details.upstreamCalls ?? 0;
  series.upstreamMs += details.upstreamMs ?? 0;
  series.cacheHits += details.cacheHits ?? 0;
  series.cacheMisses += details.cacheMisses ?? 0;
  series.attempts += details.attempts ?? 0;
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))];
}

function round(value: number, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function seriesSnapshot(label: string, series: Series) {
  return {
    label,
    count: series.count,
    errors: series.errors,
    averageMs: round(series.count ? series.totalMs / series.count : 0),
    p50Ms: round(percentile(series.samples, 0.5)),
    p95Ms: round(percentile(series.samples, 0.95)),
    p99Ms: round(percentile(series.samples, 0.99)),
    maxMs: round(series.maxMs),
    averageUpstreamCalls: round(series.count ? series.upstreamCalls / series.count : 0),
    averageUpstreamMs: round(series.count ? series.upstreamMs / series.count : 0),
    cacheHits: series.cacheHits,
    cacheMisses: series.cacheMisses,
    averageAttempts: round(series.count ? series.attempts / series.count : 0),
  };
}

export function normalizeRequestRoute(method = 'GET', rawUrl = '/') {
  let pathname = '/';
  try { pathname = new URL(rawUrl, 'http://gentia.local').pathname; }
  catch { pathname = '/invalid-route'; }
  const normalized = pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .slice(0, 180);
  return `${method.toUpperCase().slice(0, 12)} ${normalized}`;
}

function upstreamLabel(input: URL | string) {
  try {
    const pathname = new URL(String(input), 'http://supabase.local').pathname;
    const rpc = pathname.match(/\/rest\/v1\/rpc\/([^/]+)/);
    if (rpc) return `rpc/${rpc[1].slice(0, 80)}`;
    const table = pathname.match(/\/rest\/v1\/([^/]+)/);
    if (table) return `table/${table[1].slice(0, 80)}`;
    const auth = pathname.match(/\/auth\/v1\/([^/]+)/);
    if (auth) return `auth/${auth[1].slice(0, 80)}`;
  } catch { /* La telemetría nunca debe interrumpir la solicitud. */ }
  return 'supabase/other';
}

export async function withRequestPerformance<T>(options: RequestMetricOptions, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const requestContext: RequestContext = { upstreamCalls: 0, upstreamMs: 0, cacheHits: 0, cacheMisses: 0 };
  let failed = false;
  try {
    const result = await context.run(requestContext, operation);
    if (options.completion) await options.completion();
    return result;
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    const status = options.status?.() ?? (failed ? 500 : 200);
    observe(
      seriesFor(routeSeries, normalizeRequestRoute(options.method, options.url)),
      performance.now() - started,
      failed || status >= 500,
      requestContext,
    );
  }
}

export function recordSupabasePerformance(input: URL | string, durationMs: number, status?: number, attempts = 1) {
  const failed = status === undefined || status >= 400;
  observe(seriesFor(upstreamSeries, upstreamLabel(input)), durationMs, failed, { attempts });
  const active = context.getStore();
  if (active) {
    active.upstreamCalls += 1;
    active.upstreamMs += Math.max(0, durationMs);
  }
}

export function recordReadCacheAccess(namespace: string, hit: boolean) {
  const safeNamespace = namespace.replace(/[^a-z0-9:_-]/gi, '').slice(0, 80) || 'unknown';
  const current = cacheSeries.get(safeNamespace) ?? { hits: 0, misses: 0 };
  if (hit) current.hits += 1;
  else current.misses += 1;
  cacheSeries.set(safeNamespace, current);
  const active = context.getStore();
  if (active) {
    if (hit) active.cacheHits += 1;
    else active.cacheMisses += 1;
  }
}

let previousCpu = process.cpuUsage();
let previousCpuAt = performance.now();

export function runtimePerformanceSnapshot() {
  const now = performance.now();
  const cpu = process.cpuUsage(previousCpu);
  const elapsedMicros = Math.max(1, (now - previousCpuAt) * 1_000);
  previousCpu = process.cpuUsage();
  previousCpuAt = now;
  const memory = process.memoryUsage();
  const nanosecondsToMs = (value: number) => round(value / 1_000_000);
  return {
    generatedAt: new Date().toISOString(),
    process: {
      uptimeSeconds: round(process.uptime()),
      cpuPercentSinceLastSample: round((cpu.user + cpu.system) * 100 / elapsedMicros),
      cpuUserMs: round(cpu.user / 1_000),
      cpuSystemMs: round(cpu.system / 1_000),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
    },
    eventLoop: {
      meanMs: nanosecondsToMs(eventLoop.mean),
      p95Ms: nanosecondsToMs(eventLoop.percentile(95)),
      p99Ms: nanosecondsToMs(eventLoop.percentile(99)),
      maxMs: nanosecondsToMs(eventLoop.max),
    },
    routes: [...routeSeries.entries()].map(([label, series]) => seriesSnapshot(label, series)).sort((a, b) => b.count - a.count),
    upstream: [...upstreamSeries.entries()].map(([label, series]) => seriesSnapshot(label, series)).sort((a, b) => b.count - a.count),
    caches: [...cacheSeries.entries()].map(([namespace, values]) => ({
      namespace,
      ...values,
      hitRatePercent: round((values.hits + values.misses) ? values.hits * 100 / (values.hits + values.misses) : 0),
    })),
  };
}

export function resetRuntimePerformanceMetrics() {
  routeSeries.clear();
  upstreamSeries.clear();
  cacheSeries.clear();
  eventLoop.reset();
  previousCpu = process.cpuUsage();
  previousCpuAt = performance.now();
}
