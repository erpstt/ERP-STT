const PUBLIC_APP_URL_KEYS = ['GENTIA_APP_URL', 'APP_BASE_URL', 'NEXO_APP_URL'] as const;
const RAILWAY_PUBLIC_DOMAIN_KEY = 'RAILWAY_PUBLIC_DOMAIN';

export type PublicAppUrlIssue = 'MISSING' | 'INVALID' | 'INSECURE' | 'LOCAL_DISALLOWED';

export class PublicAppUrlConfigurationError extends Error {
  constructor(readonly issue: PublicAppUrlIssue) {
    super({
      MISSING: 'La URL pública de GENTIA no está configurada.',
      INVALID: 'La URL pública de GENTIA no es válida.',
      INSECURE: 'La URL pública de GENTIA debe utilizar HTTPS.',
      LOCAL_DISALLOWED: 'La URL pública de GENTIA no puede apuntar a localhost.'
    }[issue]);
    this.name = 'PublicAppUrlConfigurationError';
  }
}

export type PublicAppUrlOptions = {
  allowLocalHttp?: boolean;
  disallowLocalhost?: boolean;
  rootOnly?: boolean;
};

function configuredValue() {
  for (const key of PUBLIC_APP_URL_KEYS) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }

  // Railway exposes the public service domain without a protocol. Use it only
  // as a platform fallback; explicit application settings keep precedence.
  const railwayDomain = process.env[RAILWAY_PUBLIC_DOMAIN_KEY]?.trim();
  if (railwayDomain) {
    return /^[a-z][a-z\d+.-]*:\/\//i.test(railwayDomain)
      ? railwayDomain
      : `https://${railwayDomain}`;
  }
  throw new PublicAppUrlConfigurationError('MISSING');
}

function isLocalHostname(hostname: string) {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase());
}

export function publicAppUrl(options: PublicAppUrlOptions = {}) {
  let url: URL;
  try {
    url = new URL(configuredValue());
  } catch (cause) {
    if (cause instanceof PublicAppUrlConfigurationError) throw cause;
    throw new PublicAppUrlConfigurationError('INVALID');
  }

  if (url.username || url.password) throw new PublicAppUrlConfigurationError('INVALID');
  const local = isLocalHostname(url.hostname);
  const secure = url.protocol === 'https:';
  const allowedLocalHttp = options.allowLocalHttp === true && local && url.protocol === 'http:';
  if (!secure && !allowedLocalHttp) throw new PublicAppUrlConfigurationError('INSECURE');
  if (options.disallowLocalhost === true && local) {
    throw new PublicAppUrlConfigurationError('LOCAL_DISALLOWED');
  }

  url.hash = '';
  if (options.rootOnly === true) {
    url.pathname = '/';
    url.search = '';
  }
  return url;
}

export function tryPublicAppUrl(options: PublicAppUrlOptions = {}) {
  try {
    return publicAppUrl(options);
  } catch (cause) {
    if (cause instanceof PublicAppUrlConfigurationError) return null;
    throw cause;
  }
}
