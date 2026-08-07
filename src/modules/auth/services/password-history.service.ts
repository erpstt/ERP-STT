import { getSupabaseConfig } from '../../../core/database/supabase.client.js';
import { hashPassword, validateNewPassword, verifyPassword } from '../../../shared/services/password.service.js';

type ChangePasswordInput = { currentPassword?: string; newPassword?: string; confirmation?: string };

function emailFromToken(authorization: string) {
  try { return String(JSON.parse(Buffer.from(authorization.replace(/^Bearer\s+/i, '').split('.')[1], 'base64url').toString('utf8')).email ?? ''); }
  catch { throw new Error('La identidad del usuario no es válida.'); }
}

async function rest<T>(path: string, authorization: string, init: RequestInit = {}): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetch(new URL(`/rest/v1/${path}`, config.url), { ...init, headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = response.status === 204 ? '' : await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(typeof payload === 'object' && payload && 'message' in payload ? String(payload.message) : 'No fue posible actualizar la contraseña.');
  return payload as T;
}

export async function changePassword(authorization: string, input: ChangePasswordInput) {
  const currentPassword = input.currentPassword ?? '';
  const newPassword = input.newPassword ?? '';
  if (!currentPassword) throw new Error('Ingrese la contraseña actual.');
  if (newPassword !== input.confirmation) throw new Error('La confirmación de la nueva contraseña no coincide.');
  validateNewPassword(newPassword);
  if (currentPassword === newPassword) throw new Error('La nueva contraseña no puede ser igual a la contraseña actual.');
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const email = emailFromToken(authorization);
  const reauth = await fetch(new URL('/auth/v1/token?grant_type=password', config.url), { method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: currentPassword }) });
  if (!reauth.ok) throw new Error('La contraseña actual no es correcta.');
  const users = await rest<Array<{ user_id: number }>>(`users?select=user_id&email=eq.${encodeURIComponent(email)}&limit=1`, authorization);
  if (!users.length) throw new Error('El usuario no está registrado en el ERP.');
  const userId = users[0].user_id;
  const history = await rest<Array<{ password_hash: string }>>(`password_history?select=password_hash&user_id=eq.${userId}&order=created_at.desc&limit=6`, authorization);
  for (const item of history) if (await verifyPassword(newPassword, item.password_hash)) throw new Error('No puede reutilizar ninguna de sus últimas 6 contraseñas.');
  const update = await fetch(new URL('/auth/v1/user', config.url), { method: 'PUT', headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: newPassword }) });
  if (!update.ok) { const payload = await update.json().catch(() => null) as { message?: string } | null; throw new Error(payload?.message ?? 'Supabase rechazó la nueva contraseña.'); }
  if (!history.length) await rest('password_history', authorization, { method: 'POST', body: JSON.stringify({ user_id: userId, password_hash: await hashPassword(currentPassword) }) });
  await rest('password_history', authorization, { method: 'POST', body: JSON.stringify({ user_id: userId, password_hash: await hashPassword(newPassword) }) });
  await rest(`sessions?user_id=eq.${userId}`, authorization, { method: 'DELETE' });
  return { success: true, message: 'Contraseña actualizada. Debe iniciar sesión nuevamente.' };
}
