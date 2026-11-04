import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_REDIRECT,
  PRODUCTION_URL,
  buildSmtpConfig,
  configureSupabaseProductionAuth,
  deriveProjectRef,
  mergeRedirectAllowList
} from './configure-supabase-production-auth.mjs';

const target = 'projectref123';
const secret = 'SYNTHETIC-P84-SMTP-PASSWORD-DO-NOT-PRINT';
const token = 'SYNTHETIC-P84-MANAGEMENT-TOKEN-DO-NOT-PRINT';
const remoteSecret = 'SYNTHETIC-P84-REMOTE-CONFIG-DO-NOT-PRINT';
const baseEnvironment = {
  SUPABASE_URL: 'https://' + target + '.supabase.co',
  SUPABASE_ACCESS_TOKEN: token
};
const smtpEnvironment = {
  ...baseEnvironment,
  EMAIL_NOTIFICATIONS_ENABLED: 'true',
  SMTP_HOST: 'smtp.example.invalid',
  SMTP_PORT: '587',
  SMTP_FROM: 'GENTIA Notificaciones <no-reply@example.invalid>',
  SMTP_USER: 'mailer@example.invalid',
  SMTP_PASSWORD: secret
};
const quiet = { info() {} };
const confirmed = { apply: true, projectRef: target, confirmProjectRef: target };
const repository = fileURLToPath(new URL('../', import.meta.url));
const entrypoint = fileURLToPath(new URL('./configure-supabase-production-auth.mjs', import.meta.url));
const preloader = new URL('./fixtures/operator-no-live-io.mjs', import.meta.url).href;

function response(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
function assertSafe(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const canary of [secret, token, remoteSecret, smtpEnvironment.SMTP_USER]) {
    assert.ok(!text.includes(canary), 'Output must not contain synthetic secret data');
  }
}
function blocked(code) {
  return error => {
    assert.equal(error.code, code);
    assertSafe(error.message);
    assertSafe(error.stack);
    assert.equal(error.cause, undefined);
    return true;
  };
}
function noEnvironmentReads() {
  const reads = [];
  return {
    reads,
    environment: new Proxy({}, { get(_target, key) { reads.push(key); throw Error(secret); } })
  };
}

test('deriva únicamente el origen HTTPS de un proyecto Supabase, sin credenciales ni rutas', () => {
  assert.equal(deriveProjectRef('https://AbC123.supabase.co/'), 'abc123');
  for (const value of [
    'http://abc123.supabase.co', 'https://example.invalid',
    'https://name:password@abc123.supabase.co', 'https://abc123.supabase.co/path',
    'https://abc123.supabase.co:444', 'https://abc123.supabase.co?x=1',
    'https://abc123.supabase.co/#fragment', secret
  ]) assert.throws(() => deriveProjectRef(value), blocked('INVALID_SUPABASE_URL'));
});

test('preserva la allowlist y añade los redirects de producción sin duplicarlos', () => {
  const value = mergeRedirectAllowList('http://localhost:3000/**, ' + PRODUCTION_URL);
  assert.deepEqual(value.split(','), ['http://localhost:3000/**', PRODUCTION_URL, PRODUCTION_REDIRECT]);
  assert.equal(mergeRedirectAllowList(value), value);
});

test('preview predeterminado incluso con SMTP no lee entorno ni exige fetch ni consulta API', async () => {
  for (const withSmtp of [false, true]) {
    const f = noEnvironmentReads(), messages = [];
    const result = await configureSupabaseProductionAuth({
      environment: f.environment, fetchImpl: null, withSmtp,
      logger: { info: message => messages.push(message) }
    });
    assert.deepEqual(result, {
      mode: 'preview', applied: false, projectRef: null,
      siteUrl: PRODUCTION_URL, productionRedirect: PRODUCTION_REDIRECT,
      preservesRedirects: true, smtpRequested: withSmtp,
      readsEnvironment: false, opensConnections: false,
      requiresExplicitTargetConfirmation: true
    });
    assert.deepEqual(f.reads, []);
    assertSafe({ result, messages });
    assert.equal('update' in result, false);
  }
});

test('preview puede describir un destino explícito sin leer su configuración', async () => {
  const f = noEnvironmentReads();
  const result = await configureSupabaseProductionAuth({
    environment: f.environment, projectRef: target, confirmProjectRef: target,
    fetchImpl() { throw Error(secret); }, logger: quiet
  });
  assert.equal(result.projectRef, target);
  assert.equal(result.applied, false);
  assert.deepEqual(f.reads, []);
});

test('apply exige destino y confirmación explícitos antes de leer cualquier entorno', async () => {
  for (const options of [
    { apply: true },
    { apply: true, projectRef: target },
    { apply: true, confirmProjectRef: target }
  ]) {
    const f = noEnvironmentReads();
    await assert.rejects(configureSupabaseProductionAuth({
      environment: f.environment, fetchImpl() { throw Error(secret); }, logger: quiet, ...options
    }), blocked('TARGET_CONFIRMATION_REQUIRED'));
    assert.deepEqual(f.reads, []);
  }
});

test('ref inválido, confirmación diferente y tipos ambiguos fallan antes de leer el entorno', async () => {
  for (const [options, code] of [
    [{ ...confirmed, confirmProjectRef: 'anotherproject' }, 'TARGET_CONFIRMATION_MISMATCH'],
    [{ confirmProjectRef: target }, 'TARGET_CONFIRMATION_MISMATCH'],
    [{ ...confirmed, projectRef: secret, confirmProjectRef: secret }, 'INVALID_PROJECT_REF'],
    [{ ...confirmed, projectRef: '../project', confirmProjectRef: '../project' }, 'INVALID_PROJECT_REF'],
    [{ apply: 'true' }, 'INVALID_OPTIONS'],
    [{ withSmtp: 1 }, 'INVALID_OPTIONS']
  ]) {
    const f = noEnvironmentReads();
    await assert.rejects(configureSupabaseProductionAuth({
      environment: f.environment, logger: quiet, ...options
    }), blocked(code));
    assert.deepEqual(f.reads, []);
  }
});

test('URL diferente se rechaza antes del access token, SMTP y cualquier fetch', async () => {
  const reads = [], calls = [];
  const environment = new Proxy({}, {
    get(_target, key) {
      reads.push(key);
      if (key === 'SUPABASE_URL') return 'https://anotherproject.supabase.co';
      throw Error(secret);
    }
  });
  await assert.rejects(configureSupabaseProductionAuth({
    ...confirmed, environment, withSmtp: true,
    fetchImpl: (...args) => calls.push(args), logger: quiet
  }), blocked('ENVIRONMENT_TARGET_MISMATCH'));
  assert.deepEqual(reads, ['SUPABASE_URL']);
  assert.deepEqual(calls, []);
});

test('apply sin SMTP preserva redirects mediante GET/PATCH y devuelve solo el resumen permitido', async () => {
  const calls = [], messages = [], reads = [];
  const environment = new Proxy(baseEnvironment, {
    get(object, key) {
      reads.push(key);
      if (String(key).startsWith('SMTP_')) throw Error(secret);
      return object[key];
    }
  });
  const result = await configureSupabaseProductionAuth({
    ...confirmed, environment,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? response({ uri_allow_list: 'https://staging.example.invalid/**', smtp_pass: remoteSecret })
        : { ok: true, status: 200, text() { throw Error(remoteSecret); } };
    },
    logger: { info: message => messages.push(message) }
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://api.supabase.com/v1/projects/' + target + '/config/auth');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers.Authorization, 'Bearer ' + token);
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].init.method, 'PATCH');
  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(body, {
    site_url: PRODUCTION_URL,
    uri_allow_list: 'https://staging.example.invalid/**,' + PRODUCTION_URL + ',' + PRODUCTION_REDIRECT
  });
  assert.deepEqual(result, {
    mode: 'applied', applied: true, projectRef: target, siteUrl: PRODUCTION_URL,
    redirectCount: 3, smtpConfigured: false
  });
  assert.deepEqual(reads, ['SUPABASE_URL', 'SUPABASE_ACCESS_TOKEN']);
  assertSafe({ result, messages });
});

test('SMTP explícito envía credenciales solo en PATCH y nunca las devuelve ni registra', async () => {
  const calls = [], messages = [];
  const result = await configureSupabaseProductionAuth({
    ...confirmed, environment: smtpEnvironment, withSmtp: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? response({ uri_allow_list: '', smtp_pass: remoteSecret })
        : response({ smtp_pass: remoteSecret });
    },
    logger: { info: message => messages.push(message) }
  });
  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(body, {
    site_url: PRODUCTION_URL, uri_allow_list: PRODUCTION_URL + ',' + PRODUCTION_REDIRECT,
    external_email_enabled: true, smtp_admin_email: 'no-reply@example.invalid',
    smtp_sender_name: 'GENTIA Notificaciones', smtp_host: 'smtp.example.invalid',
    smtp_port: '587', smtp_user: 'mailer@example.invalid', smtp_pass: secret
  });
  assert.equal(result.smtpConfigured, true);
  assert.equal('update' in result, false);
  assertSafe({ result, messages });
});

test('SMTP desactivado o incompleto falla antes de solicitar la API', async () => {
  assert.throws(() => buildSmtpConfig({ EMAIL_NOTIFICATIONS_ENABLED: 'false' }), blocked('INVALID_CONFIGURATION'));
  for (const environment of [
    { ...smtpEnvironment, EMAIL_NOTIFICATIONS_ENABLED: 'false' },
    { ...smtpEnvironment, SMTP_PASSWORD: '' },
    { ...smtpEnvironment, SMTP_PORT: 'not-a-port' }
  ]) {
    let calls = 0;
    await assert.rejects(configureSupabaseProductionAuth({
      ...confirmed, environment, withSmtp: true, logger: quiet,
      fetchImpl() { calls++; throw Error(secret); }
    }), error => {
      assert.ok(['INVALID_CONFIGURATION', 'MISSING_CONFIGURATION'].includes(error.code));
      assertSafe(error.message);
      return true;
    });
    assert.equal(calls, 0);
  }
});

test('exige el token solo al aplicar al destino confirmado', async () => {
  let calls = 0;
  await assert.rejects(configureSupabaseProductionAuth({
    ...confirmed, environment: { SUPABASE_URL: baseEnvironment.SUPABASE_URL }, logger: quiet,
    fetchImpl() { calls++; throw Error(secret); }
  }), blocked('MISSING_CONFIGURATION'));
  assert.equal(calls, 0);
});

test('errores HTTP, cuerpos inválidos y fallos de transporte no propagan secretos ni hacen PATCH', async () => {
  for (const [makeResponse, code] of [
    [() => response({ error: remoteSecret }, 403), 'MANAGEMENT_HTTP_ERROR'],
    [() => new Response(secret), 'MANAGEMENT_INVALID_RESPONSE'],
    [() => response([]), 'MANAGEMENT_INVALID_RESPONSE'],
    [() => response(null, 204), 'MANAGEMENT_INVALID_RESPONSE'],
    [() => { throw Error(secret + token); }, 'MANAGEMENT_REQUEST_FAILED'],
    [() => ({ ok: true, status: 200, text() { throw Error(remoteSecret); } }), 'MANAGEMENT_REQUEST_FAILED']
  ]) {
    const calls = [], messages = [];
    await assert.rejects(configureSupabaseProductionAuth({
      ...confirmed, environment: baseEnvironment,
      fetchImpl: async (_url, init) => { calls.push(init); return makeResponse(); },
      logger: { info: message => messages.push(message) }
    }), blocked(code));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, 'error');
    assert.equal(calls[0].method, 'GET');
    assertSafe(messages);
  }
});

test('fallo de PATCH se sanitiza y no produce un resumen de aplicación exitosa', async () => {
  let calls = 0;
  const messages = [];
  await assert.rejects(configureSupabaseProductionAuth({
    ...confirmed, environment: smtpEnvironment, withSmtp: true,
    fetchImpl: async () => {
      if (++calls === 1) return response({ uri_allow_list: '' });
      throw Error(secret + token);
    },
    logger: { info: message => messages.push(message) }
  }), blocked('MANAGEMENT_REQUEST_FAILED'));
  assert.equal(calls, 2);
  assert.deepEqual(messages, []);
});

test('errores inesperados de getters del entorno no exponen su contenido', async () => {
  await assert.rejects(configureSupabaseProductionAuth({
    ...confirmed, environment: noEnvironmentReads().environment, logger: quiet
  }), blocked('CONFIGURATION_FAILED'));
});

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}
async function fixtureDirectory(workspace, parent, name) {
  const candidate = join(parent, name);
  assert.ok(inside(workspace, candidate));
  try {
    const entry = await lstat(candidate);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(candidate);
  }
  const canonical = await realpath(candidate);
  assert.ok(inside(workspace, canonical));
  assert.equal(relative(parent, canonical), name);
  return canonical;
}
async function fixture(t) {
  const workspace = await realpath(repository);
  const tools = await fixtureDirectory(workspace, workspace, '.local-tools');
  const base = await fixtureDirectory(workspace, tools, 'p84-auth-config-tests');
  const created = await mkdtemp(join(base, 'case-'));
  const directory = await realpath(created);
  assert.equal(created, directory);
  assert.ok(inside(base, directory) && inside(workspace, directory));
  t.after(async () => {
    assert.equal(await realpath(repository), workspace);
    assert.equal(await realpath(join(repository, '.local-tools')), tools);
    assert.equal(await realpath(join(tools, 'p84-auth-config-tests')), base);
    const entry = await lstat(directory), canonical = await realpath(directory);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    assert.equal(canonical, directory);
    assert.ok(inside(base, canonical) && inside(workspace, canonical));
    assert.ok(basename(canonical).startsWith('case-'));
    await rm(canonical, { recursive: true, force: true });
  });
  await writeFile(join(directory, '.env'), 'SUPABASE_ACCESS_TOKEN=' + token + '\nSMTP_PASSWORD=' + secret + '\n');
  return directory;
}
function childEnvironment() {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'Path', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env, SUPABASE_URL: baseEnvironment.SUPABASE_URL,
    SUPABASE_ACCESS_TOKEN: token, SMTP_PASSWORD: secret
  };
}
async function child(args, cwd) {
  return await new Promise((resolveResult, reject) => {
    const process = spawn(globalThis.process.execPath, ['--import', preloader, entrypoint, ...args], {
      cwd, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '', error = '';
    process.stdout.on('data', value => output += value);
    process.stderr.on('data', value => error += value);
    process.once('error', reject);
    const timeout = setTimeout(() => { process.kill(); reject(Error('Auth configuration test exceeded its deadline')); }, 15_000);
    process.once('close', code => { clearTimeout(timeout); resolveResult({ code, output, error }); });
  });
}
function safeChild(result) {
  assertSafe(result.output);
  assertSafe(result.error);
  assert.ok(!result.error.includes('OPERATOR_GUARD_FORBIDDEN:'));
}

test('CLI default, dry-run, SMTP preview y help no leen entorno, .env ni red bajo tripwire', async t => {
  const directory = await fixture(t);
  for (const args of [[], ['--dry-run'], ['--with-smtp'], ['--help'], ['-h'],
    ['--dry-run', '--project-ref', target, '--confirm-project-ref=' + target]]) {
    const result = await child(args, directory);
    safeChild(result);
    assert.equal(result.code, 0, result.error);
    const plan = JSON.parse(result.output);
    assert.equal(plan.mode, args.includes('--help') || args.includes('-h') ? 'help' : 'preview');
    assert.equal(plan.readsEnvironment, false);
    assert.equal(plan.opensConnections, false);
  }
});

test('CLI rechaza flags desconocidos, repetidos y valores ambiguos sin reflejar argumentos ni acceder al entorno', async t => {
  const directory = await fixture(t);
  for (const args of [
    ['--password=' + secret], ['--unknown', token], ['--apply=true'],
    ['--dry-run', '--dry-run'], ['--with-smtp=false'],
    ['--project-ref'], ['--project-ref=' + secret], ['--help', '--apply'],
    ['--apply', '--dry-run'], ['--load-env'], ['--help', '--password=' + secret],
    ['--apply', '--project-ref=' + target, '--confirm-project-ref=' + target, '--load-env', '--unknown=' + secret]
  ]) {
    const result = await child(args, directory);
    safeChild(result);
    assert.equal(result.code, 1);
    assert.equal(result.output, '');
    const failure = JSON.parse(result.error);
    assert.equal(failure.mode, 'blocked');
    assert.ok(['INVALID_ARGUMENTS', 'INVALID_PROJECT_REF', 'ENV_LOAD_REQUIRES_APPLY'].includes(failure.code));
  }
});

test('CLI apply incompleto o con confirmación distinta falla antes de cualquier carga explícita de .env', async t => {
  const directory = await fixture(t);
  for (const [args, code] of [
    [['--apply'], 'TARGET_CONFIRMATION_REQUIRED'],
    [['--apply', '--with-smtp', '--load-env'], 'TARGET_CONFIRMATION_REQUIRED'],
    [['--apply', '--project-ref=' + target, '--load-env'], 'TARGET_CONFIRMATION_REQUIRED'],
    [['--apply', '--confirm-project-ref=' + target], 'TARGET_CONFIRMATION_REQUIRED'],
    [['--apply', '--project-ref=' + target, '--confirm-project-ref=anotherproject', '--load-env'], 'TARGET_CONFIRMATION_MISMATCH']
  ]) {
    const result = await child(args, directory);
    safeChild(result);
    assert.equal(result.code, 1);
    assert.equal(result.output, '');
    assert.equal(JSON.parse(result.error).code, code);
  }
});
