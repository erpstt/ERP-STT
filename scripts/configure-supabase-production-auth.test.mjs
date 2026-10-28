import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRODUCTION_REDIRECT,
  PRODUCTION_URL,
  buildSmtpConfig,
  configureSupabaseProductionAuth,
  deriveProjectRef,
  mergeRedirectAllowList
} from './configure-supabase-production-auth.mjs';

const baseEnvironment = {
  SUPABASE_URL: 'https://projectref123.supabase.co',
  SUPABASE_ACCESS_TOKEN: 'management-secret-token'
};

function response(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('deriva el project ref únicamente desde una URL alojada en Supabase', () => {
  assert.equal(deriveProjectRef('https://AbC123.supabase.co/'), 'abc123');
  assert.throws(() => deriveProjectRef('http://abc123.supabase.co'), /HTTPS/);
  assert.throws(() => deriveProjectRef('https://example.com'), /supabase\.co/);
});

test('preserva la allowlist y añade el origen y su ruta comodín sin duplicarlos', () => {
  const value = mergeRedirectAllowList(`http://localhost:3000/**, ${PRODUCTION_URL}`);
  assert.deepEqual(value.split(','), [
    'http://localhost:3000/**',
    PRODUCTION_URL,
    PRODUCTION_REDIRECT
  ]);
  assert.equal(mergeRedirectAllowList(value), value);
});

test('la vista previa consulta Auth pero no ejecuta PATCH', async () => {
  const calls = [];
  const messages = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return response({ uri_allow_list: 'http://localhost:3000/**' });
  };
  const result = await configureSupabaseProductionAuth({
    environment: baseEnvironment,
    fetchImpl,
    logger: { info: message => messages.push(message) }
  });
  assert.equal(result.applied, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, undefined);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${baseEnvironment.SUPABASE_ACCESS_TOKEN}`);
  assert.equal(result.update.site_url, PRODUCTION_URL);
  assert.match(result.update.uri_allow_list, /localhost:3000/);
  assert.match(result.update.uri_allow_list, /railway\.app\/\*\*/);
  assert.ok(!messages.join('\n').includes(baseEnvironment.SUPABASE_ACCESS_TOKEN));
});

test('aplica Site URL y allowlist preservada mediante GET seguido de PATCH', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? response({ uri_allow_list: 'https://staging.example.com/**' })
      : response({});
  };
  const result = await configureSupabaseProductionAuth({
    environment: baseEnvironment,
    fetchImpl,
    apply: true,
    logger: { info() {} }
  });
  assert.equal(result.applied, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'PATCH');
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.site_url, PRODUCTION_URL);
  assert.deepEqual(body.uri_allow_list.split(','), [
    'https://staging.example.com/**',
    PRODUCTION_URL,
    PRODUCTION_REDIRECT
  ]);
  assert.equal('smtp_pass' in body, false);
});

test('configura SMTP sin imprimir credenciales cuando se solicita expresamente', async () => {
  const secret = 'smtp-password-secret';
  const token = 'management-token-secret';
  const environment = {
    SUPABASE_URL: 'https://projectref123.supabase.co',
    SUPABASE_ACCESS_TOKEN: token,
    EMAIL_NOTIFICATIONS_ENABLED: 'true',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_FROM: 'GENTIA Notificaciones <no-reply@example.com>',
    SMTP_USER: 'mailer@example.com',
    SMTP_PASSWORD: secret
  };
  const calls = [];
  const messages = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1 ? response({ uri_allow_list: '' }) : response({});
  };
  await configureSupabaseProductionAuth({
    environment,
    fetchImpl,
    apply: true,
    withSmtp: true,
    logger: { info: message => messages.push(message) }
  });
  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(body, {
    site_url: PRODUCTION_URL,
    uri_allow_list: `${PRODUCTION_URL},${PRODUCTION_REDIRECT}`,
    external_email_enabled: true,
    smtp_admin_email: 'no-reply@example.com',
    smtp_sender_name: 'GENTIA Notificaciones',
    smtp_host: 'smtp.example.com',
    smtp_port: '587',
    smtp_user: 'mailer@example.com',
    smtp_pass: secret
  });
  const output = messages.join('\n');
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes(token));
  assert.ok(!output.includes(environment.SMTP_USER));
});

test('rechaza SMTP incompleto o desactivado y exige el access token', async () => {
  assert.throws(
    () => buildSmtpConfig({ EMAIL_NOTIFICATIONS_ENABLED: 'false' }),
    /debe estar en true/
  );
  await assert.rejects(
    configureSupabaseProductionAuth({
      environment: { SUPABASE_URL: baseEnvironment.SUPABASE_URL },
      fetchImpl: async () => response({}),
      logger: { info() {} }
    }),
    /SUPABASE_ACCESS_TOKEN/
  );
});
