import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const recovery = await import('../dist/modules/auth/services/password-recovery.service.js');
const passwords = await import('../dist/shared/services/password.service.js');
const originalFetch = globalThis.fetch;
const originalEnvironment = { ...process.env };
const authUserId = '123e4567-e89b-42d3-a456-426614174000';

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

function tokenWithAmr(amr, issuedAt = Math.floor(Date.now() / 1_000)) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({
    iat: issuedAt,
    exp: issuedAt + 3_600,
    role: 'authenticated',
    aud: 'authenticated',
    amr
  })}.signature`;
}
function token(method = 'recovery', issuedAt = Math.floor(Date.now() / 1_000)) {
  return tokenWithAmr([{ method, timestamp: issuedAt }], issuedAt);
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
    if (url.pathname === '/auth/v1/user' && (init.method ?? 'GET') === 'GET') return json({ id: authUserId, email });
    if (url.pathname === '/rest/v1/password_recovery_grants' && (init.method ?? 'GET') === 'GET') {
      return json([{ recovery_id: 7, email_hash: hash(email), created_at: new Date((issuedAt - 10) * 1_000).toISOString() }]);
    }
    if (url.pathname === '/rest/v1/users') return json([{ user_id: 42, email, auth_user_id: authUserId, is_active: true }]);
    if (url.pathname === '/rest/v1/password_history' && (init.method ?? 'GET') === 'GET') return json([]);
    if (url.pathname === '/rest/v1/rpc/consume_password_recovery_grant') return json(true);
    if (url.pathname === '/auth/v1/user' && init.method === 'PUT') return json({ id: authUserId, email });
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
  const erpLookup = calls.find(call => call.url.pathname === '/rest/v1/users');
  assert.equal(erpLookup.url.searchParams.get('auth_user_id'), `eq.${authUserId}`);
  assert.equal(erpLookup.url.searchParams.get('email'), `eq.${email}`);
});

test('acepta recovery string y otp objeto reciente cuando el grant está vigente', async () => {
  const email = 'amr-compatible@example.com';
  const issuedAt = Math.floor(Date.now() / 1_000);
  let consumed = 0;
  let updated = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user' && (init.method ?? 'GET') === 'GET') return json({ id: authUserId, email });
    if (url.pathname === '/rest/v1/password_recovery_grants' && (init.method ?? 'GET') === 'GET') return json([{ recovery_id: 11, email_hash: hash(email), created_at: new Date((issuedAt - 10) * 1_000).toISOString() }]);
    if (url.pathname === '/rest/v1/users') return json([{ user_id: 72, email, auth_user_id: authUserId, is_active: true }]);
    if (url.pathname === '/rest/v1/password_history' && (init.method ?? 'GET') === 'GET') return json([]);
    if (url.pathname === '/rest/v1/rpc/consume_password_recovery_grant') { consumed++; return json(true); }
    if (url.pathname === '/auth/v1/user' && init.method === 'PUT') { updated++; return json({ id: authUserId, email }); }
    if (url.pathname === '/rest/v1/password_history' && init.method === 'POST') return new Response(null, { status: 201 });
    if (url.pathname === '/rest/v1/sessions' && init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname === '/auth/v1/logout' && init.method === 'POST') return new Response(null, { status: 204 });
    throw new Error(`Solicitud inesperada: ${url.pathname}`);
  };
  const variants = [['recovery'], [{ method: 'otp', timestamp: issuedAt }]];
  for (const [index, amr] of variants.entries()) {
    const password = `Clave compatible AMR ${index + 1} 2026!`;
    const result = await recovery.completePasswordRecovery(
      `Bearer ${tokenWithAmr(amr, issuedAt)}`,
      { state: String.fromCharCode(75 + index).repeat(43), recoveryType: 'recovery', newPassword: password, confirmation: password },
      `amr-compatible-${index}-${crypto.randomUUID()}`
    );
    assert.equal(result.success, true);
  }
  assert.equal(consumed, variants.length);
  assert.equal(updated, variants.length);
});

test('rechaza otp objeto antiguo aunque el JWT tenga un iat reciente', async () => {
  const email = 'otp-antiguo@example.com';
  const issuedAt = Math.floor(Date.now() / 1_000);
  let queriedGrant = false;
  let consumed = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user' && (init.method ?? 'GET') === 'GET') return json({ id: authUserId, email });
    if (url.pathname === '/rest/v1/password_recovery_grants') { queriedGrant = true; return json([{ recovery_id: 12, email_hash: hash(email), created_at: new Date((issuedAt - 10) * 1_000).toISOString() }]); }
    if (url.pathname === '/rest/v1/rpc/consume_password_recovery_grant') { consumed = true; return json(true); }
    throw new Error(`Solicitud inesperada: ${url.pathname}`);
  };
  await assert.rejects(
    () => recovery.completePasswordRecovery(
      `Bearer ${tokenWithAmr([{ method: 'otp', timestamp: issuedAt - 3_600 }], issuedAt)}`,
      { state: 'P'.repeat(43), recoveryType: 'recovery', newPassword: 'Clave OTP antigua 2026!', confirmation: 'Clave OTP antigua 2026!' },
      `old-otp-${crypto.randomUUID()}`
    ),
    error => error?.status === 401 && /no es válido|expiró/.test(error.message)
  );
  assert.equal(queriedGrant, true);
  assert.equal(consumed, false);
});

test('rechaza otp string y AMR objeto sin timestamp antes de consultar Supabase', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('No debe consultar Supabase.'); };
  for (const [index, amr] of [['otp'], [{ method: 'otp' }]].entries()) {
    await assert.rejects(
      () => recovery.completePasswordRecovery(
        `Bearer ${tokenWithAmr(amr)}`,
        { state: String.fromCharCode(81 + index).repeat(43), recoveryType: 'recovery', newPassword: 'Clave AMR inválida 2026!', confirmation: 'Clave AMR inválida 2026!' },
        `invalid-amr-${index}-${crypto.randomUUID()}`
      ),
      error => error?.status === 401 && /no es válido|expiró/.test(error.message)
    );
  }
  assert.equal(fetchCalls, 0);
});

test('un token otp sin grant vigente no puede completar la recuperación', async () => {
  const email = 'otp-sin-grant@example.com';
  let queriedGrant = false;
  let consumed = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user' && (init.method ?? 'GET') === 'GET') return json({ id: authUserId, email });
    if (url.pathname === '/rest/v1/password_recovery_grants') { queriedGrant = true; return json([]); }
    if (url.pathname === '/rest/v1/rpc/consume_password_recovery_grant') { consumed = true; return json(true); }
    throw new Error(`Solicitud inesperada: ${url.pathname}`);
  };
  await assert.rejects(
    () => recovery.completePasswordRecovery(
      `Bearer ${tokenWithAmr([{ method: 'otp', timestamp: Math.floor(Date.now() / 1_000) }])}`,
      { state: 'N'.repeat(43), recoveryType: 'recovery', newPassword: 'Clave OTP sin grant 2026!', confirmation: 'Clave OTP sin grant 2026!' },
      `otp-without-grant-${crypto.randomUUID()}`
    ),
    error => error?.status === 401 && /no es válido|expiró/.test(error.message)
  );
  assert.equal(queriedGrant, true);
  assert.equal(consumed, false);
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

test('rechaza AMR token_refresh aunque se represente como string', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('No debe consultar Supabase con token_refresh.'); };
  await assert.rejects(
    () => recovery.completePasswordRecovery(
      `Bearer ${tokenWithAmr(['token_refresh'])}`,
      { state: 'O'.repeat(43), recoveryType: 'recovery', newPassword: 'Clave refresh rechazada 2026!', confirmation: 'Clave refresh rechazada 2026!' },
      `token-refresh-${crypto.randomUUID()}`
    ),
    error => error?.status === 401 && /no es válido|expiró/.test(error.message)
  );
  assert.equal(fetchCalls, 0);
});

test('rechaza una respuesta de Auth sin un identificador UUID válido', async () => {
  let queriedGrant = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user' && (init.method ?? 'GET') === 'GET') {
      return json({id:'identidad-no-uuid',email:'persona@example.com'});
    }
    if (url.pathname === '/rest/v1/password_recovery_grants') queriedGrant = true;
    throw new Error(`Solicitud inesperada: ${url.pathname}`);
  };

  await assert.rejects(
    () => recovery.completePasswordRecovery(
      `Bearer ${token('recovery')}`,
      {
        state: 'F'.repeat(43),
        recoveryType: 'recovery',
        newPassword: 'Clave segura UUID 2026!',
        confirmation: 'Clave segura UUID 2026!'
      },
      `invalid-uuid-${crypto.randomUUID()}`
    ),
    error => error?.status === 401 && /no es válido|expiró/.test(error.message)
  );
  assert.equal(queriedGrant, false);
});

test('impide reutilizar una de las últimas seis contraseñas antes de consumir el enlace', async () => {
  const email = 'history@example.com';
  const state = 'C'.repeat(43);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const previousHash = await passwords.hashPassword('Clave histórica segura 2026!');
  let consumed = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user' && (init.method ?? 'GET') === 'GET') return json({ id: authUserId, email });
    if (url.pathname === '/rest/v1/password_recovery_grants') {
      return json([{ recovery_id: 8, email_hash: hash(email), created_at: new Date((issuedAt - 10) * 1_000).toISOString() }]);
    }
    if (url.pathname === '/rest/v1/users') return json([{ user_id: 52, email, auth_user_id: authUserId, is_active: true }]);
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

test('rechaza una identidad de Auth que no está vinculada a un usuario ERP', async () => {
  const email = 'huerfano@example.com';
  const state = 'D'.repeat(43);
  const issuedAt = Math.floor(Date.now() / 1_000);
  let consumed = false;
  let passwordUpdated = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user' && (init.method ?? 'GET') === 'GET') return json({ id: authUserId, email });
    if (url.pathname === '/rest/v1/password_recovery_grants') {
      return json([{ recovery_id: 9, email_hash: hash(email), created_at: new Date((issuedAt - 10) * 1_000).toISOString() }]);
    }
    if (url.pathname === '/rest/v1/users') return json([]);
    if (url.pathname === '/rest/v1/rpc/consume_password_recovery_grant') { consumed = true; return json(true); }
    if (url.pathname === '/auth/v1/user' && init.method === 'PUT') { passwordUpdated = true; return json({ id: authUserId, email }); }
    throw new Error(`Solicitud inesperada: ${url.pathname}`);
  };

  await assert.rejects(
    () => recovery.completePasswordRecovery(
      `Bearer ${token('recovery', issuedAt)}`,
      {state,recoveryType:'recovery',newPassword:'Clave segura huerfana 2026!',confirmation:'Clave segura huerfana 2026!'},
      `orphan-${crypto.randomUUID()}`
    ),
    error => error?.status === 401 && /no es válido|expiró/.test(error.message)
  );
  assert.equal(consumed, false);
  assert.equal(passwordUpdated, false);
});

test('rechaza un usuario ERP cuyo auth_user_id no coincide con el token de recuperación', async () => {
  const email = 'cruzado@example.com';
  const state = 'E'.repeat(43);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const otherAuthUserId = '123e4567-e89b-42d3-a456-426614174099';
  let consumed = false;
  let passwordUpdated = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user' && (init.method ?? 'GET') === 'GET') return json({ id: authUserId, email });
    if (url.pathname === '/rest/v1/password_recovery_grants') {
      return json([{ recovery_id: 10, email_hash: hash(email), created_at: new Date((issuedAt - 10) * 1_000).toISOString() }]);
    }
    if (url.pathname === '/rest/v1/users') {
      return json([{user_id:62,email,auth_user_id:otherAuthUserId,is_active:true}]);
    }
    if (url.pathname === '/rest/v1/rpc/consume_password_recovery_grant') { consumed = true; return json(true); }
    if (url.pathname === '/auth/v1/user' && init.method === 'PUT') { passwordUpdated = true; return json({ id: authUserId, email }); }
    throw new Error(`Solicitud inesperada: ${url.pathname}`);
  };

  await assert.rejects(
    () => recovery.completePasswordRecovery(
      `Bearer ${token('recovery', issuedAt)}`,
      {state,recoveryType:'recovery',newPassword:'Clave segura cruzada 2026!',confirmation:'Clave segura cruzada 2026!'},
      `mismatch-${crypto.randomUUID()}`
    ),
    error => error?.status === 401 && /no es válido|expiró/.test(error.message)
  );
  assert.equal(consumed, false);
  assert.equal(passwordUpdated, false);
});

