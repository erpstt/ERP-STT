/**
 * Punto único para inicializar el SDK de Supabase cuando se agregue la dependencia.
 * Mantenerlo aislado evita que los módulos dependan directamente de infraestructura.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { auditRequestHeaders } from './audit-context.js';
import { recordSupabasePerformance } from '../performance/runtime-metrics.js';

const requestSignalStorage = new AsyncLocalStorage<AbortSignal>();

function configuredConcurrency(): number {
  const configured = Number(process.env.SUPABASE_MAX_CONCURRENCY ?? 16);
  return Number.isFinite(configured) ? Math.min(128, Math.max(4, Math.trunc(configured))) : 16;
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const failure = new Error('La solicitud fue cancelada.');
  failure.name = 'AbortError';
  return failure;
}

type GateWaiter = {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (cause: unknown) => void;
  abort?: () => void;
};

class SupabaseConcurrencyGate {
  private active = 0;
  private readonly waiting: GateWaiter[] = [];

  constructor(private readonly maximum: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter: GateWaiter = { signal, resolve, reject };
      waiter.abort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(abortReason(signal!));
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.active < this.maximum && this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.abort!);
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseOnce());
    }
  }
}

const supabaseGate = new SupabaseConcurrencyGate(configuredConcurrency());

export class SupabaseUnavailableError extends Error {
  readonly status = 503;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SupabaseUnavailableError';
  }
}

/** Propaga el cierre de la solicitud HTTP hasta las consultas a Supabase. */
export function withSupabaseRequestSignal<T>(signal: AbortSignal, operation: () => T): T {
  return requestSignalStorage.run(signal, operation);
}

async function abortableDelay(delayMs: number, signals: Array<AbortSignal | null | undefined>): Promise<void> {
  if (!delayMs) return;
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  const aborted = activeSignals.find(signal => signal.aborted);
  if (aborted) throw abortReason(aborted);
  await new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    const listeners = new Map<AbortSignal, () => void>();
    const cleanup = () => {
      clearTimeout(timeout);
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    };
    timeout = setTimeout(() => { cleanup(); resolve(); }, delayMs);
    timeout.unref?.();
    for (const signal of activeSignals) {
      const listener = () => { cleanup(); reject(abortReason(signal)); };
      listeners.set(signal, listener);
      signal.addEventListener('abort', listener, { once: true });
    }
  });
}

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export function getSupabaseConfig(): SupabaseConfig | null {
  const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey } = process.env;
  return url && anonKey ? { url, anonKey } : null;
}

/** Solo las lecturas se reintentan: una escritura con respuesta perdida pudo confirmarse. */
export async function fetchSupabase(input: URL | string, init?: RequestInit): Promise<Response> {
  const metricStarted = performance.now();
  let attempts = 0;
  const request = { ...init, headers: auditRequestHeaders(init?.headers) };
  const delays = ['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase()) ? [0, 300, 900, 1800] : [0];
  const configuredTimeout = Number(process.env.SUPABASE_REQUEST_TIMEOUT_MS ?? 20_000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1_000 ? configuredTimeout : 20_000;
  const requestSignal = requestSignalStorage.getStore();
  const callerSignals = [init?.signal, requestSignal];
  let lastError: unknown;

  for (const delay of delays) {
    attempts += 1;
    await abortableDelay(delay, callerSignals);
    const aborted = callerSignals.find(signal => signal?.aborted);
    if (aborted) throw abortReason(aborted);

    const controller = new AbortController();
    let timedOut = false;
    let release: (() => void) | undefined;
    const abortListeners = new Map<AbortSignal, () => void>();
    for (const signal of callerSignals) {
      if (!signal) continue;
      const listener = () => controller.abort(abortReason(signal));
      abortListeners.set(signal, listener);
      signal.addEventListener('abort', listener, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Supabase no respondió en ${timeoutMs} ms.`));
    }, timeoutMs);
    timeout.unref?.();

    try {
      release = await supabaseGate.acquire(controller.signal);
      const response = await fetch(input, { ...request, signal: controller.signal });
      recordSupabasePerformance(input, performance.now() - metricStarted, response.status, attempts);
      return response;
    } catch (cause) {
      if (callerSignals.some(signal => signal?.aborted)) {
        recordSupabasePerformance(input, performance.now() - metricStarted, undefined, attempts);
        throw cause;
      }
      lastError = cause;
      if (timedOut) break;
    } finally {
      release?.();
      clearTimeout(timeout);
      for (const [signal, listener] of abortListeners) signal.removeEventListener('abort', listener);
    }
  }

  recordSupabasePerformance(input, performance.now() - metricStarted, undefined, attempts);
  throw new SupabaseUnavailableError('No fue posible conectar con Supabase después de varios intentos.', lastError);
}
