import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fetchSupabase, getSupabaseConfig } from '../../../core/database/supabase.client.js';
import { hashPassword, validateNewPassword, verifyPassword } from '../../../shared/services/password.service.js';

type RecoveryRequestInput = { email?: string };
type RecoveryCompletionInput = {
  state?: string;
  accessToken?: string;
  recoveryType?: string;
  newPassword?: string;
  confirmation?: string;
};

type RecoveryGrant = {
  recovery_id: number;
  email_hash: string;
  created_at: string;
};

type RecoveryUser = {
  user_id: number;
  email: string;
  auth_user_id: string | null;
  is_active: boolean;
};

type AttemptBucket = { timestamps: number[] };

const REQUEST_WINDOW_MS = 60 * 60 * 1_000;
const REQUEST_LIMIT = 3;
const COMPLETION_WINDOW_MS = 15 * 60 * 1_000;
const COMPLETION_LIMIT = 10;
const GRANT_LIFETIME_MS = 30 * 60 * 1_000;
const requestAttempts = new Map<string, AttemptBucket>();
const completionAttempts = new Map<string, AttemptBucket>();

export const PASSWORD_RECOVERY_NEUTRAL_MESSAGE =
  'Si el correo corresponde a un usuario registrado, recibirá un enlace para recuperar su contraseña.';

export class PasswordRecoveryError extends Error {
  constructor(message: string, readonly status = 400, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'PasswordRecoveryError';
  }
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(value: unknown) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) {
    throw new PasswordRecoveryError('Ingrese un correo electrónico válido.');
  }
  return email;
}

function authUserId(value: unknown) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new PasswordRecoveryError('El enlace de recuperación no es válido o ya expiró.', 401);
  }
  return id;
}

function safeHexEqual(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function recordAttempt(
  store: Map<string, AttemptBucket>,
  key: string,
  windowMs: number,
  limit: number,
  now = Date.now()
) {
  const recent = (store.get(key)?.timestamps ?? []).filter(timestamp => now - timestamp < windowMs);
  if (recent.length >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1_000));
    throw new PasswordRecoveryError(
      `Se realizaron demasiados intentos. Intente nuevamente en ${Math.ceil(retryAfterSeconds / 60)} minuto(s).`,
      429,
      retryAfterSeconds
    );
  }
  recent.push(now);
  store.set(key, { timestamps: recent });
  if (store.size > 5_000) {
    for (const [entryKey, bucket] of store) {
      if (!bucket.timestamps.some(timestamp => now - timestamp < windowMs)) store.delete(entryKey);
    }
  }
}

function configuredBaseUrl() {
  const raw = String(process.env.GENTIA_APP_URL ?? process.env.APP_BASE_URL ?? process.env.NEXO_APP_URL ?? '').trim();
  if (!raw) throw new PasswordRecoveryError('La URL pública para recuperar contraseñas no está configurada.', 503);
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new PasswordRecoveryError('La URL pública para recuperar contraseñas no es válida.', 503); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new PasswordRecoveryError('La URL de recuperación debe utilizar HTTPS.', 503);
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
}

function serviceConfiguration() {
  const config = getSupabaseConfig();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!config || !serviceKey) {
    throw new PasswordRecoveryError('La recuperación de contraseña no está configurada.', 503);
  }
  return { ...config, serviceKey };
}

async function payload(response: Response): Promise<unknown> {
  const text = response.status === 204 ? '' : await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; }
  catch { return null; }
}

async function serviceRest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = serviceConfiguration();
  const response = await fetchSupabase(new URL(`/rest/v1/${path}`, config.url), {
    ...init,
    headers: {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  const value = await payload(response);
  if (!response.ok) throw new PasswordRecoveryError('No fue posible procesar la recuperación de contraseña.', 503);
  return value as T;
}

function bearer(authorization: string | undefined, fallback: unknown) {
  const headerToken = authorization?.replace(/^Bearer\s+/i, '').trim() ?? '';
  const bodyToken = typeof fallback === 'string' ? fallback.trim() : '';
  const token = headerToken || bodyToken;
  if (!token || token.length > 8_192) throw new PasswordRecoveryError('El enlace de recuperación no es válido o ya expiró.', 401);
  return token;
}

function recoveryJwtIssuedAt(token: string) {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return null;
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      iat?: number;
      exp?: number;
      role?: string;
      aud?: string | string[];
      amr?: Array<{ method?: string }>;
    };
    if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || Number(claims.exp) * 1_000 <= Date.now()) return null;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.role !== 'authenticated' || !audience.includes('authenticated')) return null;
    if (!Array.isArray(claims.amr) || !claims.amr.some(item => item?.method === 'recovery')) return null;
    return Number(claims.iat) * 1_000;
  } catch { return null; }
}

async function removeGrant(stateHash: string) {
  await serviceRest(`password_recovery_grants?state_hash=eq.${stateHash}`, { method: 'DELETE' }).catch(() => undefined);
}

export async function requestPasswordRecovery(input: RecoveryRequestInput, ipAddress?: string | null) {
  const startedAt = Date.now();
  const email = normalizeEmail(input.email);
  recordAttempt(requestAttempts, `${ipAddress || 'unknown'}|${sha256(email)}`, REQUEST_WINDOW_MS, REQUEST_LIMIT);
  const config = serviceConfiguration();
  const state = randomBytes(32).toString('base64url');
  const stateHash = sha256(state);
  const emailHash = sha256(email);
  const expiresAt = new Date(Date.now() + GRANT_LIFETIME_MS).toISOString();

  await serviceRest(
    `password_recovery_grants?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,
    { method: 'DELETE' }
  ).catch(() => undefined);
  await serviceRest('password_recovery_grants', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ state_hash: stateHash, email_hash: emailHash, expires_at: expiresAt })
  });

  const redirect = configuredBaseUrl();
  redirect.pathname = '/';
  redirect.search = '';
  redirect.searchParams.set('password_recovery', '1');
  redirect.searchParams.set('state', state);
  const recoverUrl = new URL('/auth/v1/recover', config.url);
  recoverUrl.searchParams.set('redirect_to', redirect.toString());

  try {
    const response = await fetchSupabase(recoverUrl, {
      method: 'POST',
      headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    if (!response.ok) {
      await removeGrant(stateHash);
      // Supabase puede responder 4xx cuando el correo no existe o limita el
      // envío. La
      // respuesta al navegador se mantiene neutra para no enumerar usuarios.
      if (response.status < 400 || response.status >= 500) {
        throw new PasswordRecoveryError('El servicio de recuperación no está disponible. Intente nuevamente.', 503);
      }
    }
  } catch (cause) {
    await removeGrant(stateHash);
    if (cause instanceof PasswordRecoveryError) throw cause;
    throw new PasswordRecoveryError('El servicio de recuperación no está disponible. Intente nuevamente.', 503);
  }

  // Reduce diferencias de tiempo observables entre correos existentes y no existentes.
  const remaining = 300 - (Date.now() - startedAt);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  return { success: true, message: PASSWORD_RECOVERY_NEUTRAL_MESSAGE };
}

export async function completePasswordRecovery(
  authorization: string | undefined,
  input: RecoveryCompletionInput,
  ipAddress?: string | null
) {
  recordAttempt(completionAttempts, ipAddress || 'unknown', COMPLETION_WINDOW_MS, COMPLETION_LIMIT);
  const state = typeof input.state === 'string' ? input.state.trim() : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) {
    throw new PasswordRecoveryError('El enlace de recuperación no es válido o ya expiró.', 401);
  }
  if (input.recoveryType && input.recoveryType !== 'recovery') {
    throw new PasswordRecoveryError('El enlace no corresponde a una recuperación de contraseña.', 401);
  }
  const newPassword = input.newPassword ?? '';
  if (newPassword !== input.confirmation) throw new PasswordRecoveryError('La confirmación de la nueva contraseña no coincide.');
  validateNewPassword(newPassword);
  const token = bearer(authorization, input.accessToken);
  const issuedAt = recoveryJwtIssuedAt(token);
  if (!issuedAt) throw new PasswordRecoveryError('El enlace de recuperación no es válido o ya expiró.', 401);
  const config = serviceConfiguration();

  const userResponse = await fetchSupabase(new URL('/auth/v1/user', config.url), {
    headers: { apikey: config.anonKey, Authorization: `Bearer ${token}` }
  });
  const userPayload = await payload(userResponse) as { id?: unknown; email?: unknown } | null;
  const email = userResponse.ok && typeof userPayload?.email === 'string' ? userPayload.email.trim().toLowerCase() : '';
  if (!email) throw new PasswordRecoveryError('El enlace de recuperación no es válido o ya expiró.', 401);
  const identityId = authUserId(userPayload?.id);

  const stateHash = sha256(state);
  const grants = await serviceRest<RecoveryGrant[]>(
    `password_recovery_grants?select=recovery_id,email_hash,created_at&state_hash=eq.${stateHash}&consumed_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`
  );
  const grant = grants[0];
  const emailHash = sha256(email);
  const grantCreatedAt = grant ? Date.parse(grant.created_at) : Number.NaN;
  if (!grant || !safeHexEqual(grant.email_hash, emailHash) || !Number.isFinite(grantCreatedAt) || issuedAt < grantCreatedAt - 120_000) {
    throw new PasswordRecoveryError('El enlace de recuperación no es válido o ya expiró.', 401);
  }

  const users = await serviceRest<RecoveryUser[]>(
    `users?select=user_id,email,auth_user_id,is_active&email=eq.${encodeURIComponent(email)}&auth_user_id=eq.${encodeURIComponent(identityId)}&limit=1`
  );
  const recoveryUser = users[0];
  const erpEmail = typeof recoveryUser?.email === 'string' ? recoveryUser.email.trim().toLowerCase() : '';
  const erpAuthUserId = typeof recoveryUser?.auth_user_id === 'string' ? recoveryUser.auth_user_id.trim().toLowerCase() : '';
  const userId = Number(recoveryUser?.user_id);
  if (
    !recoveryUser?.is_active ||
    erpEmail !== email ||
    erpAuthUserId !== identityId ||
    !Number.isSafeInteger(userId) ||
    userId <= 0
  ) {
    throw new PasswordRecoveryError('El enlace de recuperación no es válido o ya expiró.', 401);
  }

  const history = await serviceRest<Array<{ password_hash: string }>>(
    `password_history?select=password_hash&user_id=eq.${userId}&order=created_at.desc&limit=6`
  );
  for (const item of history) {
    if (await verifyPassword(newPassword, item.password_hash)) {
      throw new PasswordRecoveryError('No puede reutilizar ninguna de sus últimas 6 contraseñas.');
    }
  }

  const claimed = await serviceRest<boolean>('rpc/consume_password_recovery_grant', {
    method: 'POST',
    body: JSON.stringify({ p_state_hash: stateHash, p_email_hash: emailHash })
  });
  if (!claimed) throw new PasswordRecoveryError('El enlace de recuperación ya fue utilizado o expiró.', 401);

  const update = await fetchSupabase(new URL('/auth/v1/user', config.url), {
    method: 'PUT',
    headers: { apikey: config.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: newPassword })
  });
  if (!update.ok) {
    throw new PasswordRecoveryError('No fue posible actualizar la contraseña. Solicite un nuevo enlace e intente nuevamente.', 400);
  }

  let maintenanceFailure = false;
  try {
    await serviceRest('password_history', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, password_hash: await hashPassword(newPassword) })
    });
  } catch { maintenanceFailure = true; }
  try { await serviceRest(`sessions?user_id=eq.${userId}`, { method: 'DELETE' }); }
  catch { maintenanceFailure = true; }
  if (maintenanceFailure) console.error('[PasswordRecovery] La contraseña cambió, pero falló el mantenimiento del historial o las sesiones.');
  await fetchSupabase(new URL('/auth/v1/logout?scope=global', config.url), {
    method: 'POST',
    headers: { apikey: config.anonKey, Authorization: `Bearer ${token}` }
  }).catch(() => undefined);
  return { success: true, message: 'Contraseña actualizada. Inicie sesión con su nueva contraseña.' };
}

