import assert from 'node:assert/strict';
import test from 'node:test';

const turnstile = await import('../dist/core/security/turnstile.service.js');
const limiter = await import('../dist/core/security/login-rate-limit.js');
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function configure(values = {}) {
  for (const key of ['TURNSTILE_ENABLED','TURNSTILE_SITE_KEY','TURNSTILE_SECRET_KEY','TURNSTILE_ALLOWED_HOSTNAMES']) delete process.env[key];
  Object.assign(process.env, values);
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  configure(originalEnv);
});

test('Turnstile deshabilitado no expone una llave ni llama a Cloudflare', async () => {
  configure({ TURNSTILE_ENABLED: 'false' });
  globalThis.fetch = async () => { throw new Error('No debe consultar Siteverify'); };
  assert.deepEqual(turnstile.turnstilePublicConfig(), { enabled: false, siteKey: null });
  assert.deepEqual(await turnstile.verifyTurnstileToken(undefined, '127.0.0.1'), { success: true, disabled: true });
});

test('Turnstile valida el token en Siteverify y comprueba acción y hostname', async () => {
  configure({ TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret', TURNSTILE_ALLOWED_HOSTNAMES: 'erp.example.com' });
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ success:true, action:'login', hostname:'erp.example.com' }), { status:200, headers:{'Content-Type':'application/json'} });
  };
  const result = await turnstile.verifyTurnstileToken('valid-token', '192.0.2.10');
  assert.equal(result.success, true);
  assert.equal(request.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.match(String(request.init.body), /secret=secret/);
  assert.match(String(request.init.body), /response=valid-token/);
  assert.match(String(request.init.body), /remoteip=192.0.2.10/);
});

test('Turnstile rechaza tokens vencidos o reutilizados', async () => {
  configure({ TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' });
  globalThis.fetch = async () => new Response(JSON.stringify({ success:false, 'error-codes':['timeout-or-duplicate'] }), { status:200 });
  await assert.rejects(() => turnstile.verifyTurnstileToken('spent-token'), /venció/);
});

test('el limitador bloquea el sexto intento fallido de una cuenta e IP', () => {
  const ip = `test-${crypto.randomUUID()}`;
  const email = `${crypto.randomUUID()}@example.com`;
  for (let index=0; index<5; index++) limiter.recordLoginFailure(ip, email, index + 1);
  assert.throws(() => limiter.assertLoginAllowed(ip, email, 6), limiter.LoginRateLimitError);
  limiter.clearLoginFailures(ip, email);
  assert.doesNotThrow(() => limiter.assertLoginAllowed(ip, email, 7));
});
