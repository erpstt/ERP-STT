import { createHash } from 'node:crypto';
import { getSupabaseConfig } from '../../../core/database/supabase.client.js';
import { SessionAuthenticationError } from './session.service.js';

const deviceHash = (token: string) => createHash('sha256').update(token).digest('hex');
function authenticatedEmail(authorization: string) {
  try { return String(JSON.parse(Buffer.from(authorization.replace(/^Bearer\s+/i, '').split('.')[1], 'base64url').toString('utf8')).email ?? ''); }
  catch { throw new SessionAuthenticationError('La identidad del usuario no es válida.'); }
}

async function rest<T>(path: string, authorization: string, init: RequestInit = {}): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetch(new URL(`/rest/v1/${path}`, config.url), { ...init, headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = response.status === 204 ? '' : await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(typeof payload === 'object' && payload && 'message' in payload ? String(payload.message) : 'No fue posible gestionar el dispositivo.');
  return payload as T;
}

function validateToken(token: string | undefined) {
  const value = token?.trim() ?? '';
  if (value.length < 20 || value.length > 200) throw new SessionAuthenticationError('El dispositivo no está identificado. Inicie sesión nuevamente.');
  return value;
}

export async function registerDevice(authorization: string, userId: number, token: string | undefined, name: string | undefined) {
  const value = validateToken(token);
  const deviceName = name?.trim().slice(0, 240) || 'Navegador no identificado';
  await rest('devices?on_conflict=device_token', authorization, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, device_name: deviceName, device_token: deviceHash(value), last_used: new Date().toISOString() }),
  });
}

export async function assertRegisteredDevice(authorization: string, token: string | undefined) {
  const value = validateToken(token);
  const users = await rest<Array<{ user_id: number }>>(`users?select=user_id&email=eq.${encodeURIComponent(authenticatedEmail(authorization))}&limit=1`, authorization);
  if (!users.length) throw new SessionAuthenticationError('El usuario autenticado no está registrado en el ERP.');
  const rows = await rest<Array<{ device_id: number }>>(`devices?select=device_id&user_id=eq.${users[0].user_id}&device_token=eq.${deviceHash(value)}&limit=1`, authorization);
  if (!rows.length) throw new SessionAuthenticationError('Este dispositivo fue revocado. Inicie sesión desde un dispositivo autorizado.');
  await rest(`devices?device_id=eq.${rows[0].device_id}`, authorization, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_used: new Date().toISOString() }) });
}
