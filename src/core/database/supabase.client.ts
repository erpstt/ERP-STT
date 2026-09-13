/**
 * Punto único para inicializar el SDK de Supabase cuando se agregue la dependencia.
 * Mantenerlo aislado evita que los módulos dependan directamente de infraestructura.
 */
import { auditRequestHeaders } from './audit-context.js';

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
  const request = { ...init, headers: auditRequestHeaders(init?.headers) };
  const delays = ['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase()) ? [0, 300, 900, 1800] : [0];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try { return await fetch(input, request); }
    catch (cause) { lastError = cause; }
  }
  throw new Error('No fue posible conectar con Supabase después de varios intentos.', { cause: lastError });
}
