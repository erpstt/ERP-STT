import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const recovery = await import('../dist/modules/auth/services/password-recovery.service.js');
const passwords = await import('../dist/shared/services/password.service.js');
const originalFetch = globalThis.fetch;
const originalEnvironment = { ...process.env };

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' }
});
const hash = value => createHash('sha256').update(value).digest('hex');

function configure() {
  process.env.SUPABASE_URL = 'https://project.example.test';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test-key';
  process.env.GENTIA_APP_URL = 'https://erp.example.test';
}

function token(method = 'recovery', issuedAt = Math.floor(Date.now() / 1_000)) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({
    iat: issuedAt,
    exp: issuedAt + 3_600,
    role: 'authenticated',
    aud: 'authenticated',
    amr: [{ method, timestamp: issuedAt }]
  })}.signature`;
}

test.beforeEach(configure);
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnvironment };
});

test('solicita un correo con estado opaco sin exponer si el usuario existe', async () => {
  let storedGrant;
  let redirect;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/v1/password_recovery_grants' && init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname === '/rest/v1/password_recovery_grants' && init.method === 'POST') {
      storedGrant = JSON.parse(String(init.body));
      return new Response(null, { status: 201 });
    }
    if (url.pathname === '/auth/v1/recover') {
      redirect = url.searchParams.get('redirect_to');
      return json({});
    }
    throw new Error(`Solicitud inesperada: ${url.pathname}`);
  };

  const result = await recovery.requestPasswordRecovery(
    { email: 'PERSONA@Example.com' },
    `request-${crypto.randomUUID()}`
  );
  assert.equal(result.success, true);
  assert.equal(result.message, recovery.PASSWORD_RECOVERY_NEUTRAL_MESSAGE);
  assert.equal(JSON.stringify(result).includes('state'), false);
  assert.ok(storedGrant);
  assert.equal(storedGrant.email_hash, hash('persona@example.com'));
  assert.equal(JSON.stringify(storedGrant).includes('persona@example.com'), false);
  const callback = new URL(redirect);
  assert.equal(callback.origin, 'https://erp.example.test');
  assert.equal(callback.searchParams.get('password_recovery'), '1');
  const state = callback.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(storedGrant.state_hash, hash(state));
});

test('mantiene la misma respuesta neutra cuando Supabase rechaza un correo desconocido', async () => {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/v1/password_recovery_grants' && init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname === '/rest/v1/password_recovery_grants' && init.method === 'POST') return new Response(null, { status: 201 });
    if (url.pathname === '/auth/v1/recover') return json({ message: 'User not found' }, 422);
    throw new Error(`Solicitud inesperada: ${url.pathname}`);
  };
  const result = await recovery.requestPasswordRecovery(
    { email: `${crypto.randomUUID()}@example.com` },
    `unknown-${crypto.randomUUID()}`
  );
  assert.deepEqual(result, { success: true, message: recovery.PASSWORD_RECOVERY_NEUTRAL_MESSAGE });
});

test('completa la recuperación, registra el historial y revoca sesiones', async () => {
  const email = 'persona@example.com';
  const state = 'A'.repeat(43);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === '/auth/v1/user' && (init.method ?? 'GET') === 'GET') return json({ id: 'auth-user', email });
    if (url.pathname === '/rest/v1/password_recovery_grants' && (init.method ?? 'GET') === 'GET') {
      return json([{ recovery_id: 7, email_hash: hash(email), created_at: new Date((issuedAt - 10) * 1_000).toISOString() }]);
    }
    if (url.pathname === '/rest/v1/users') return json([{ user_id: 42, is_active: true }]);
    if (url.pathname === '/rest/v1/password_history' && (init.method ?? 'GET') === 'GET') return json([]);
    if (url.pathname === '/rest/v1/rpc/consume_password_recovery_grant') return json(true);
    if (url.pathname === '/auth/v1/user' && init.method === 'PUT') return json({ id: 'auth-user', email });
    if (url.pathname === '/rest/v1/password_history' && init.method === 'POST') return new Response(null, { status: 201 });
    if (url.pathname === '/rest/v1/sessions' && init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname === '/auth/v1/logout' && init.method === 'POST') return new Response(null, { status: 204 });
    throw new Error(`Solicitud inesperada: ${url.pathname}`);
  };

  const result = await recovery.completePasswordRecovery(
    `Bearer ${token('recovery', issuedAt)}`,
    {
      state,
      recoveryType: 'recovery',
      newPassword: 'Clave nueva segura 2026!',
      confirmation: 'Clave nueva segura 2026!'
    },
    `complete-${crypto.randomUUID()}`
  );
  assert.equal(result.success, true);
  const update = calls.find(call => call.url.pathname === '/auth/v1/user' && call.init.method === 'PUT');
  assert.deepEqual(JSON.parse(String(update.init.body)), { password: 'Clave nueva segura 2026!' });
  assert.ok(calls.some(call => call.url.pathname === '/rest/v1/password_history' && call.init.method === 'POST'));
  assert.ok(calls.some(call => call.url.pathname === '/rest/v1/sessions' && call.init.method === 'DELETE'));
  assert.ok(calls.some(call => call.url.pathname === '/auth/v1/logout' && call.url.searchParams.get('scope') === 'global'));
});

test('rechaza un token normal aunque sea un JWT autenticado vigente', async () => {
  globalThis.fetch = async () => { throw new Error('No debe consultar Supabase con un token regular.'); };
  await assert.rejects(
    () => recovery.completePasswordRecovery(
      `Bearer ${token('password')}`,
      {
        state: 'B'.repeat(43),
        recoveryType: 'recovery',
        newPassword: 'Otra clave segura 2026!',
        confirmation: 'Otra clave segura 2026!'
      },
      `regular-${crypto.randomUUID()}`
    ),
    error => error?.status === 401 && /no es válido|expiró/.test(error.message)
  );
});

test('impide reutilizar una de las últimas seis contraseñas antes de consumir el enlace', async () => {
  const email = 'history@example.com';
  const state = 'C'.repeat(43);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const previousHash = await passwords.hashPassword('Clave histórica segura 2026!');
  let consumed = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user' && (init.method ?? 'GET') === 'GET') return json({ id: 'auth-user', email });
    if (url.pathname === '/rest/v1/password_recovery_grants') {
      return json([{ recovery_id: 8, email_hash: hash(email), created_at: new Date((issuedAt - 10) * 1_000).toISOString() }]);
    }
    if (url.pathname === '/rest/v1/users') return json([{ user_id: 52, is_active: true }]);
    if (url.pathname === '/rest/v1/password_history') return json([{ password_hash: previousHash }]);
    if (url.pathname === '/rest/v1/rpc/consume_password_recovery_grant') { consumed = true; return json(true); }
    throw new Error(`Solicitud inesperada: ${url.pathname}`);
  };
  await assert.rejects(
    () => recovery.completePasswordRecovery(
      `Bearer ${token('recovery', issuedAt)}`,
      {
        state,
        recoveryType: 'recovery',
        newPassword: 'Clave histórica segura 2026!',
        confirmation: 'Clave histórica segura 2026!'
      },
      `history-${crypto.randomUUID()}`
    ),
    /No puede reutilizar/
  );
  assert.equal(consumed, false);
});

