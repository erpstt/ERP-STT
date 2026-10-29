import { createHash } from 'node:crypto';
import { fetchSupabase, getSupabaseConfig } from '../../../core/database/supabase.client.js';
import { SessionAuthenticationError } from './session.service.js';
import {
  configuredRequestAccessCacheMaxEntries,
  configuredRequestAccessCacheTtlMs,
  PositiveRequestAccessCache,
} from './request-access-cache.js';

interface RequestAccessResult {
  allowed?: boolean;
  reason?: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const positiveAccessCache = new PositiveRequestAccessCache({
  ttlMs: configuredRequestAccessCacheTtlMs(),
  maxEntries: configuredRequestAccessCacheMaxEntries(),
});

function bearerToken(authorization: string) {
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim() ?? '';
  if (!token) throw new SessionAuthenticationError('Debe iniciar sesión.');
  return token;
}

function validDeviceToken(deviceToken: string | undefined) {
  const value = deviceToken?.trim() ?? '';
  if (value.length < 20 || value.length > 200) {
    throw new SessionAuthenticationError('El dispositivo no está identificado. Inicie sesión nuevamente.');
  }
  return value;
}

function authenticationMessage(reason: string | undefined) {
  if (reason === 'USER_INACTIVE') return 'El usuario autenticado no está activo en el ERP.';
  if (reason === 'DEVICE_INVALID') return 'Este dispositivo fue revocado. Inicie sesión desde un dispositivo autorizado.';
  if (reason === 'INVALID_CREDENTIAL_FORMAT') return 'Las credenciales de acceso no son válidas. Inicie sesión nuevamente.';
  return 'La sesión expiró o fue revocada. Inicie sesión nuevamente.';
}

function tokenExpiration(token: string) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: unknown };
    const seconds = Number(claims.exp);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
  } catch {
    return undefined;
  }
}

export function invalidateRequestAccess(authorization: string) {
  try { positiveAccessCache.invalidateSession(sha256(bearerToken(authorization))); }
  catch { /* El cierre de sesión no debe fallar por una credencial ya inválida. */ }
}

/**
 * Valida sesión, usuario y dispositivo mediante una sola llamada RPC.
 * Los tokens sin resumir solo viajan en sus canales originales: JWT en el
 * encabezado Authorization y dispositivo en memoria; el cuerpo contiene hashes.
 */
export async function assertRequestAccess(authorization: string, deviceToken: string | undefined) {
  const sessionToken = bearerToken(authorization);
  const deviceValue = validDeviceToken(deviceToken);
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const sessionHash = sha256(sessionToken);
  const deviceHash = sha256(deviceValue);
  await positiveAccessCache.getOrValidate({
    key: `${sessionHash}:${deviceHash}`,
    validUntil: tokenExpiration(sessionToken),
    validate: async () => {
      const response = await fetchSupabase(new URL('/rest/v1/rpc/assert_request_access', config.url), {
        method: 'POST',
        headers: {
          apikey: config.anonKey,
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_session_token_hash: sessionHash,
          p_device_token_hash: deviceHash,
        }),
      });

      const text = await response.text();
      let result: RequestAccessResult | null = null;
      try { result = text ? JSON.parse(text) as RequestAccessResult : null; }
      catch { throw new Error('Supabase devolvió una respuesta inválida al validar el acceso.'); }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new SessionAuthenticationError('La sesión expiró o fue revocada. Inicie sesión nuevamente.');
        }
        const detail = result && typeof result === 'object' && 'message' in result
          ? String((result as RequestAccessResult & { message?: unknown }).message)
          : 'No fue posible validar el acceso en Supabase.';
        throw new Error(detail);
      }
      if (result?.allowed !== true) throw new SessionAuthenticationError(authenticationMessage(result?.reason));
    },
  });
}
