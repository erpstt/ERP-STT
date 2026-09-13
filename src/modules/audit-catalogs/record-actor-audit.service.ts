import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';

export async function recordActorAudit(authorization: string, table: string, id: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || !id || id.length > 100) throw new Error('Registro no válido.');
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetchSupabase(new URL('/rest/v1/rpc/record_actor_audit', config.url), {
    method: 'POST', headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_table: table, p_id: id })
  });
  if (!response.ok) throw new Error('No fue posible consultar la autoría de este registro con sus permisos actuales.');
  return response.json();
}
