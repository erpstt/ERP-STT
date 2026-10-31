import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { assertRoleAccess } from '../security-catalogs/role-access-matrix.module.js';

const resource = 'consolidation:financial-consolidation';
type Action = 'view' | 'create' | 'edit';

function failure(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

async function rpc<T>(token: string, action: Action, name: string, payload: Record<string, unknown> = {}) {
  if (!/^Bearer\s+\S+$/i.test(token)) throw failure(401, 'Debe iniciar sesión para consolidar.');
  // Se aplica también a llamadas internas: ninguna operación llega a SQL sin RBAC.
  await assertRoleAccess(token, resource, action);
  const config = getSupabaseConfig();
  if (!config) throw Error('Supabase no está configurado.');
  const response = await fetchSupabase(new URL(`/rest/v1/rpc/${name}`, config.url), {
    method: 'POST',
    headers: { apikey: config.anonKey, Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text(), data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (response.status === 401) throw failure(401, 'La sesión no es válida.');
    if (response.status === 403 || data?.code === '42501') {
      throw failure(403, 'No tiene permiso para realizar esta operación de consolidación.');
    }
    throw Error(data?.message || 'No fue posible ejecutar la consolidación.');
  }
  return data as T;
}

function runId(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw failure(400, 'Seleccione una consolidación válida.');
  return { p_run: id };
}

export const consolidationOptions = (token: string) => rpc(token, 'view', 'consolidation_options');
export const consolidationInit = (token: string, input: Record<string, unknown>) =>
  rpc(token, 'create', 'consolidation_init', { p_period: input.period });
export const consolidationTranslate = (token: string, id: number) =>
  rpc(token, 'edit', 'consolidation_translate', runId(id));
export const consolidationProcess = (token: string, id: number) =>
  rpc(token, 'edit', 'consolidation_process', runId(id));
export const consolidationWorksheet = (token: string, id: number) =>
  rpc(token, 'view', 'consolidation_worksheet_data', runId(id));
export const consolidationPublish = (token: string, id: number) =>
  rpc(token, 'edit', 'consolidation_publish', runId(id));
