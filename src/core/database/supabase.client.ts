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
