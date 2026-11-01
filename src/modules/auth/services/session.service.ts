import { fetchSupabase, getSupabaseConfig } from '../../../core/database/supabase.client.js';

const bearerToken = (authorization: string) => authorization.replace(/^Bearer\s+/i, '').trim();
export class SessionAuthenticationError extends Error {}

async function rest<T>(path: string, authorization: string, init: RequestInit = {}): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetchSupabase(new URL(`/rest/v1/${path}`, config.url), { ...init, headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = response.status === 204 ? '' : await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(typeof payload === 'object' && payload && 'message' in payload ? String(payload.message) : 'No fue posible gestionar la sesión.');
  return payload as T;
}

export async function assertActiveSession(authorization: string) {
  const token = bearerToken(authorization);
  if (!token) throw new SessionAuthenticationError('Debe iniciar sesión.');
  const id=await rest<number|null>('rpc/app_user_id',authorization,{method:'POST',body:'{}'});
  if(!id)throw new SessionAuthenticationError('La sesion expiro o fue revocada.');
}

export async function revokeCurrentSession(authorization: string) {
  const token = bearerToken(authorization);
  if (!token) return;
  await rest('rpc/security_logout_session',authorization,{method:'POST',body:'{}'});
  const config = getSupabaseConfig();
  if (config) await fetchSupabase(new URL('/auth/v1/logout?scope=local', config.url), { method: 'POST', headers: { apikey: config.anonKey, Authorization: authorization } }).catch(() => undefined);
}
