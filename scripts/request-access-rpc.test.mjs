import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

const { assertRequestAccess } = await import('../dist/modules/auth/services/request-access.service.js');
const { SessionAuthenticationError } = await import('../dist/modules/auth/services/session.service.js');
const originalFetch = globalThis.fetch;
const accessToken = 'header.payload.signature-with-enough-content';
const authorization = `Bearer ${accessToken}`;
const deviceToken = 'device-token-with-enough-entropy-123456789';
const digest = value => createHash('sha256').update(value).digest('hex');

test.afterEach(() => { globalThis.fetch = originalFetch; });

test('valida sesión y dispositivo con una sola RPC y envía únicamente sus hashes', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return Response.json({ allowed: true });
  };

  await assertRequestAccess(authorization, deviceToken);

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].input).pathname, '/rest/v1/rpc/assert_request_access');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), authorization);
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body, {
    p_session_token_hash: digest(accessToken),
    p_device_token_hash: digest(deviceToken),
  });
  assert.equal(String(calls[0].init.body).includes(deviceToken), false);
  assert.equal(String(calls[0].init.body).includes(accessToken), false);
});

test('convierte los rechazos de sesión y dispositivo en SessionAuthenticationError', async t => {
  for (const [reason, expected] of [
    ['SESSION_INVALID', /sesión expiró/i],
    ['DEVICE_INVALID', /dispositivo fue revocado/i],
    ['USER_INACTIVE', /usuario autenticado no está activo/i],
  ]) {
    await t.test(reason, async () => {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return Response.json({ allowed: false, reason });
      };
      await assert.rejects(assertRequestAccess(authorization, deviceToken), error => {
        assert.ok(error instanceof SessionAuthenticationError);
        assert.match(error.message, expected);
        return true;
      });
      assert.equal(calls, 1);
    });
  }
});

test('rechaza credenciales incompletas antes de consultar Supabase', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ allowed: true }); };
  await assert.rejects(assertRequestAccess('sin-bearer', deviceToken), SessionAuthenticationError);
  await assert.rejects(assertRequestAccess(authorization, 'corto'), SessionAuthenticationError);
  assert.equal(calls, 0);
});

test('la migración protege la RPC y limita last_used a cinco minutos', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261023183000_assert_request_access_rpc.sql', import.meta.url), 'utf8');
  assert.match(sql, /security definer/i);
  assert.match(sql, /account\.is_active=true/i);
  assert.match(sql, /active_session\.user_id=current_user_id/i);
  assert.match(sql, /registered_device\.user_id=current_user_id/i);
  assert.match(sql, /last_used<=checked_at-interval '5 minutes'/i);
  assert.match(sql, /revoke all on function public\.assert_request_access\(text,text\) from public/i);
  assert.match(sql, /grant execute on function public\.assert_request_access\(text,text\) to authenticated/i);
  assert.doesNotMatch(sql, /grant execute[^;]+to anon/i);
});
