import { createHash } from 'node:crypto';
import { getSupabaseConfig } from '../../../core/database/supabase.client.js';

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const bearerToken = (authorization: string) => authorization.replace(/^Bearer\s+/i, '').trim();
export class SessionAuthenticationError extends Error {}

function jwtExpiration(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: number };
    if (!payload.exp) throw new Error();
    return new Date(payload.exp * 1000).toISOString();
  } catch { throw new Error('El token de sesión no contiene una fecha de expiración válida.'); }
}

async function rest<T>(path: string, authorization: string, init: RequestInit = {}): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetch(new URL(`/rest/v1/${path}`, config.url), { ...init, headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = response.status === 204 ? '' : await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(typeof payload === 'object' && payload && 'message' in payload ? String(payload.message) : 'No fue posible gestionar la sesión.');
  return payload as T;
}

export async function registerSession(authorization: string, userId: number, ipAddress: string | null) {
  const token = bearerToken(authorization);
  await rest('sessions?on_conflict=session_token', authorization, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ user_id: userId, session_token: tokenHash(token), ip_address: ipAddress, expires_at: jwtExpiration(token) }) });
  await rest('login_history', authorization, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: userId, ip_address: ipAddress, status: 'EXITOSO' }) });
}

export async function assertActiveSession(authorization: string) {
  const token = bearerToken(authorization);
  if (!token) throw new SessionAuthenticationError('Debe iniciar sesión.');
  const rows = await rest<Array<{ session_id: number }>>(`sessions?select=session_id&session_token=eq.${tokenHash(token)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`, authorization);
  if (!rows.length) throw new SessionAuthenticationError('La sesión expiró o fue revocada. Inicie sesión nuevamente.');
}

export async function revokeCurrentSession(authorization: string) {
  const token = bearerToken(authorization);
  if (!token) return;
  await rest(`sessions?session_token=eq.${tokenHash(token)}`, authorization, { method: 'DELETE' });
  const config = getSupabaseConfig();
  if (config) await fetch(new URL('/auth/v1/logout', config.url), { method: 'POST', headers: { apikey: config.anonKey, Authorization: authorization } }).catch(() => undefined);
}
