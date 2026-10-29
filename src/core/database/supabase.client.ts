/**
 * Punto único para inicializar el SDK de Supabase cuando se agregue la dependencia.
 * Mantenerlo aislado evita que los módulos dependan directamente de infraestructura.
 */
import { performance } from 'node:perf_hooks';
import { auditRequestHeaders } from './audit-context.js';
import { recordSupabasePerformance } from '../performance/runtime-metrics.js';

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
  const metricStarted=performance.now();
  let attempts=0;
  const request = { ...init, headers: auditRequestHeaders(init?.headers) };
  const delays = ['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase()) ? [0, 300, 900, 1800] : [0];
  const configuredTimeout=Number(process.env.SUPABASE_REQUEST_TIMEOUT_MS??20_000);
  const timeoutMs=Number.isFinite(configuredTimeout)&&configuredTimeout>=1_000?configuredTimeout:20_000;
  let lastError: unknown;
  for (const delay of delays) {
    attempts+=1;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if(init?.signal?.aborted)throw init.signal.reason;
    const controller=new AbortController();
    let timedOut=false;
    const abortFromCaller=()=>controller.abort(init?.signal?.reason);
    init?.signal?.addEventListener('abort',abortFromCaller,{once:true});
    const timeout=setTimeout(()=>{timedOut=true;controller.abort(new Error(`Supabase no respondió en ${timeoutMs} ms.`));},timeoutMs);
    timeout.unref?.();
    try {
      const response=await fetch(input,{...request,signal:controller.signal});
      recordSupabasePerformance(input,performance.now()-metricStarted,response.status,attempts);
      return response;
    }
    catch (cause) {
      if(init?.signal?.aborted){recordSupabasePerformance(input,performance.now()-metricStarted,undefined,attempts);throw cause;}
      lastError=cause;
      if(timedOut)break;
    } finally {
      clearTimeout(timeout);
      init?.signal?.removeEventListener('abort',abortFromCaller);
    }
  }
  recordSupabasePerformance(input,performance.now()-metricStarted,undefined,attempts);
  throw new Error('No fue posible conectar con Supabase después de varios intentos.', { cause: lastError });
}
