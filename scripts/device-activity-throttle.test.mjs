import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

const { assertRegisteredDevice } = await import('../dist/modules/auth/services/device.service.js');
const originalFetch = globalThis.fetch;
const jwtPayload = Buffer.from(JSON.stringify({ email: 'contador@example.com' })).toString('base64url');
const authorization = `Bearer header.${jwtPayload}.signature`;
const deviceToken = 'device-token-with-enough-entropy-123456789';

function mockSupabase(lastUsed) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url, method, body: init.body });
    if (url.pathname.endsWith('/users')) {
      return Response.json([{ user_id: 42 }]);
    }
    if (url.pathname.endsWith('/devices') && method === 'GET') {
      return Response.json([{ device_id: 99, last_used: lastUsed }]);
    }
    if (url.pathname.endsWith('/devices') && method === 'PATCH') {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Solicitud inesperada: ${method} ${url}`);
  };
  return calls;
}

test.afterEach(() => { globalThis.fetch = originalFetch; });

test('mantiene la validación del dispositivo sin reescribir una actividad reciente', async () => {
  const calls = mockSupabase(new Date().toISOString());
  await assertRegisteredDevice(authorization, deviceToken);
  assert.equal(calls.filter(call => call.method === 'GET').length, 2);
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 0);
  assert.match(calls[1].url.search, /select=device_id%2Clast_used|select=device_id,last_used/);
});

test('actualiza la actividad cuando la marca tiene más de cinco minutos', async () => {
  const calls = mockSupabase(new Date(Date.now() - 10 * 60 * 1000).toISOString());
  await assertRegisteredDevice(authorization, deviceToken);
  const patches = calls.filter(call => call.method === 'PATCH');
  assert.equal(patches.length, 1);
  const payload = JSON.parse(String(patches[0].body));
  assert.ok(Math.abs(Date.now() - Date.parse(payload.last_used)) < 5_000);
});

test('registra actividad cuando el dispositivo aún no tiene una fecha', async () => {
  const calls = mockSupabase(null);
  await assertRegisteredDevice(authorization, deviceToken);
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
});
