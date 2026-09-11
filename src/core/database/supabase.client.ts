/**
 * Punto único para inicializar el SDK de Supabase cuando se agregue la dependencia.
 * Mantenerlo aislado evita que los módulos dependan directamente de infraestructura.
 */
export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export function getSupabaseConfig(): SupabaseConfig | null {
  const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey } = process.env;
  return url && anonKey ? { url, anonKey } : null;
}

/** Reintenta solamente fallos de red; las respuestas HTTP se entregan sin alterar. */
export async function fetchSupabase(input: URL | string, init?: RequestInit): Promise<Response> {
  const delays = [0, 300, 900, 1800];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try { return await fetch(input, init); }
    catch (cause) { lastError = cause; }
  }
  throw new Error('No fue posible conectar con Supabase después de varios intentos.', { cause: lastError });
}
