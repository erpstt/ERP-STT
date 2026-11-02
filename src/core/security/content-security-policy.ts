/** Root application no longer compiles templates or executes inline scripts. */
export function contentSecurityPolicy(requestTarget: string): string {
  // Headers are applied before the request target is validated. Never parse untrusted URL syntax here.
  const pathname = requestTarget.split('?')[0];
  const root = pathname === '/' || pathname === '/index.html';
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    `script-src 'self'${root ? '' : " 'unsafe-inline'"} https://challenges.cloudflare.com`,
    ...(root ? ["script-src-attr 'none'"] : []),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src 'self' https://challenges.cloudflare.com"
  ].join('; ');
}
