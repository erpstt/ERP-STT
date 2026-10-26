import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';

export class RecordActorAuditError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'RecordActorAuditError';
  }
}

function diagnosticMessage(value: unknown) {
  if (!value || typeof value !== 'object' || !('message' in value)) return undefined;
  return String((value as { message?: unknown }).message ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300) || undefined;
}

function connectionDiagnostic(cause: unknown) {
  const nested = cause && typeof cause === 'object' && 'cause' in cause
    ? (cause as { cause?: unknown }).cause
    : undefined;
  const value = nested instanceof Error ? nested.message : cause instanceof Error ? cause.message : 'Error no identificado.';
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 300);
}

async function responsePayload(response: Response) {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { return null; }
}

export async function recordActorAudit(authorization: string, table: string, id: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || !id || id.length > 100) throw new Error('Registro no válido.');
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  let response: Response;
  try {
    response = await fetchSupabase(new URL('/rest/v1/rpc/record_actor_audit', config.url), {
      method: 'POST', headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_table: table, p_id: id })
    });
  } catch (cause) {
    console.error('[RecordActorAudit] No fue posible conectar con Supabase.', {
      table,
      message: connectionDiagnostic(cause)
    });
    throw new RecordActorAuditError('No fue posible consultar la autoría en este momento. Intente nuevamente.', 503);
  }

  const payload = await responsePayload(response);
  if (!response.ok) {
    const code = payload && typeof payload === 'object' && 'code' in payload
      ? String((payload as { code?: unknown }).code ?? '').slice(0, 40)
      : undefined;
    console.error('[RecordActorAudit] Supabase rechazó la consulta de autoría.', {
      status: response.status,
      table,
      code,
      message: diagnosticMessage(payload)
    });
    if (response.status === 401 || response.status === 403) {
      throw new RecordActorAuditError('No tiene permiso para consultar la autoría de este registro.', response.status);
    }
    throw new RecordActorAuditError('No fue posible consultar la autoría por un error del servicio. Intente nuevamente.', 502);
  }
  return payload;
}
