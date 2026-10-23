const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

type TurnstileResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
};

export class TurnstileValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = 'TurnstileValidationError';
    this.status = status;
  }
}

function enabledFromEnvironment() {
  const configured = process.env.TURNSTILE_ENABLED?.trim().toLowerCase();
  if (configured === 'false' || configured === '0') return false;
  if (configured === 'true' || configured === '1') return true;
  return Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

function credentials() {
  const enabled = enabledFromEnvironment();
  const siteKey = process.env.TURNSTILE_SITE_KEY?.trim() ?? '';
  const secretKey = process.env.TURNSTILE_SECRET_KEY?.trim() ?? '';
  if (enabled && (!siteKey || !secretKey)) {
    throw new TurnstileValidationError('Cloudflare Turnstile está habilitado, pero faltan sus credenciales.', 503);
  }
  return { enabled, siteKey, secretKey };
}

export function turnstilePublicConfig() {
  const { enabled, siteKey } = credentials();
  return { enabled, siteKey: enabled ? siteKey : null };
}

function allowedHostnames() {
  return (process.env.TURNSTILE_ALLOWED_HOSTNAMES ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

export async function verifyTurnstileToken(token: unknown, remoteIp?: string | null) {
  const { enabled, secretKey } = credentials();
  if (!enabled) return { success: true, disabled: true };
  if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
    throw new TurnstileValidationError('Complete la verificación de seguridad antes de ingresar.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const form = new URLSearchParams({
      secret: secretKey,
      response: token.trim(),
      idempotency_key: crypto.randomUUID()
    });
    if (remoteIp) form.set('remoteip', remoteIp);
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: controller.signal
    });
    if (!response.ok) throw new TurnstileValidationError('El servicio de verificación no está disponible. Intente nuevamente.', 503);
    const result = await response.json() as TurnstileResponse;
    if (!result.success) {
      const duplicate = result['error-codes']?.includes('timeout-or-duplicate');
      throw new TurnstileValidationError(duplicate
        ? 'La verificación de seguridad venció. Complétela nuevamente.'
        : 'No fue posible validar la verificación de seguridad. Intente nuevamente.');
    }
    if (result.action && result.action !== 'login') {
      throw new TurnstileValidationError('La verificación de seguridad no corresponde al inicio de sesión.');
    }
    const hostnames = allowedHostnames();
    if (hostnames.length && (!result.hostname || !hostnames.includes(result.hostname.toLowerCase()))) {
      throw new TurnstileValidationError('La verificación de seguridad no corresponde a este sitio.');
    }
    return result;
  } catch (cause) {
    if (cause instanceof TurnstileValidationError) throw cause;
    throw new TurnstileValidationError('El servicio de verificación no respondió. Intente nuevamente.', 503);
  } finally {
    clearTimeout(timeout);
  }
}
