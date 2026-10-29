import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

try { process.loadEnvFile?.('.env'); } catch {}

const argumentsMap = new Map(process.argv.slice(2).filter(value => value.startsWith('--')).map(value => {
  const [key, ...parts] = value.slice(2).split('=');
  return [key, parts.length ? parts.join('=') : true];
}));
const numberArgument = (name, fallback, minimum, maximum) => {
  const value = Number(argumentsMap.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} debe ser un entero entre ${minimum} y ${maximum}.`);
  }
  return value;
};

const confirmed = argumentsMap.get('confirm-production-load') === true;
const baseUrl = String(argumentsMap.get('base-url') || process.env.GENTIA_LOAD_BASE_URL || process.env.GENTIA_APP_URL || '').replace(/\/$/, '');
const sessionCount = numberArgument('sessions', 120, 2, 150);
const durationSeconds = numberArgument('duration-seconds', 300, 30, 3600);
const loginRate = numberArgument('login-rate', 5, 1, 10);
const thinkTimeMs = numberArgument('think-time-ms', 4500, 500, 30000);
const timeoutMs = numberArgument('timeout-ms', 15000, 1000, 60000);
const outputFile = argumentsMap.get('output') ? resolve(String(argumentsMap.get('output'))) : null;
const explicitTechnicalEmail = String(process.env.LOAD_TEST_EMAIL || '').trim().toLowerCase() || null;

if (!confirmed) throw new Error('Ejecución bloqueada. Agregue --confirm-production-load después de revisar el entorno y la ventana de prueba.');
if (!baseUrl) throw new Error('Configure GENTIA_LOAD_BASE_URL o GENTIA_APP_URL.');
const parsedBaseUrl = new URL(baseUrl);
if (parsedBaseUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsedBaseUrl.hostname)) {
  throw new Error('El destino debe usar HTTPS, excepto durante una prueba local explícita.');
}
if (explicitTechnicalEmail && !explicitTechnicalEmail.endsWith('@example.invalid')) {
  throw new Error('LOAD_TEST_EMAIL debe ser una identidad técnica bajo @example.invalid.');
}

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const databasePassword = process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD;
if (!supabaseUrl || !anonKey || !serviceRoleKey || !databasePassword) {
  throw new Error('Faltan SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY o SUPABASE_DB_PASSWORD.');
}

const projectReference = new URL(supabaseUrl).hostname.split('.')[0];
const database = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectReference}`,
  password: databasePassword,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
  statement_timeout: 60_000,
});

const runId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const runStartedAt = new Date().toISOString();
const password = `Gentia!${randomBytes(18).toString('base64url')}9a`;
const turnstileToken = process.env.LOAD_TEST_TURNSTILE_TOKEN || undefined;
const sessions = [];
const observations = [];
let technicalUser;
let snapshot;
let authUserId;
let databaseConnected = false;
let cleanupResult = { attempted: false, authIdentityDeleted: false, databaseRestored: false, verified: false };

const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const sanitizedMessage = value => String(value || 'Error desconocido')
  .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTADO]')
  .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '[JWT REDACTADO]')
  .slice(0, 500);

async function jsonFetch(url, init = {}, requestTimeoutMs = timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { response, data };
  } finally { clearTimeout(timeout); }
}

async function adminAuth(path, init = {}) {
  const { response, data } = await jsonFetch(new URL(path, supabaseUrl), {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const message = data && typeof data === 'object' ? data.message || data.msg || data.error : data;
    throw new Error(`Supabase Auth respondió ${response.status}: ${sanitizedMessage(message)}`);
  }
  return data;
}

async function observedRequest({ phase, label, path, method = 'GET', session, body, fatal = false }) {
  const started = performance.now();
  const record = { phase, label, status: 0, startedAtMs: started, endedAtMs: started, durationMs: 0, ok: false, timeout: false };
  try {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session) {
      headers.Authorization = `Bearer ${session.accessToken}`;
      headers['X-Device-Token'] = session.deviceToken;
    }
    const { response, data } = await jsonFetch(new URL(path, `${baseUrl}/`), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    record.status = response.status;
    record.ok = response.ok;
    if (!response.ok) {
      const message = data && typeof data === 'object' ? data.error?.message || data.message : data;
      throw new Error(`${label} respondió HTTP ${response.status}: ${sanitizedMessage(message)}`);
    }
    return data;
  } catch (cause) {
    record.timeout = cause instanceof Error && cause.name === 'AbortError';
    if (fatal) throw cause;
    return null;
  } finally {
    record.endedAtMs = performance.now();
    record.durationMs = Number((record.endedAtMs - started).toFixed(3));
    observations.push(record);
  }
}

const identifierSnapshot = async (table, idColumn, userId) => (await database.query(
  `select ${idColumn}::text id from public.${table} where user_id=$1 order by ${idColumn}`,
  [userId],
)).rows.map(row => row.id);

async function prepareTechnicalUser() {
  const userQuery = explicitTechnicalEmail
    ? await database.query(`select user_id,email,password_hash,auth_user_id::text,first_name,last_name,timezone_id,is_active from public.users where lower(email)=$1 limit 1`, [explicitTechnicalEmail])
    : await database.query(`select user_id,email,password_hash,auth_user_id::text,first_name,last_name,timezone_id,is_active
        from public.users
        where lower(email) like 'gentia-load-%@example.invalid'
          and is_active=false and auth_user_id is null
        order by user_id desc limit 1`);
  if (!userQuery.rows.length) {
    throw new Error('No existe una identidad técnica inactiva gentia-load-*@example.invalid. Defina LOAD_TEST_EMAIL con un registro técnico ya creado.');
  }
  technicalUser = userQuery.rows[0];
  const userId = Number(technicalUser.user_id);
  if (!technicalUser.email.endsWith('@example.invalid') || technicalUser.is_active || technicalUser.auth_user_id) {
    throw new Error('La identidad técnica debe estar inactiva, sin vínculo Auth y bajo @example.invalid.');
  }
  snapshot = {
    user: { ...technicalUser },
    roles: await identifierSnapshot('user_roles', 'role_id', userId),
    subsidiaries: await identifierSnapshot('user_subsidiaries', 'subsidiary_id', userId),
    sessions: await identifierSnapshot('sessions', 'session_id', userId),
    devices: await identifierSnapshot('devices', 'device_id', userId),
    loginHistory: await identifierSnapshot('login_history', 'history_id', userId),
    passwordHistory: await identifierSnapshot('password_history', 'history_id', userId),
    companySessions: await identifierSnapshot('user_company_sessions', 'session_id', userId),
    roleSessions: await identifierSnapshot('user_role_sessions', 'session_id', userId),
  };
  if (snapshot.roles.length || snapshot.subsidiaries.length || snapshot.sessions.length || snapshot.devices.length || snapshot.companySessions.length || snapshot.roleSessions.length) {
    throw new Error('La identidad técnica conserva acceso o sesiones. No se modificará hasta que un administrador la deje completamente inactiva.');
  }

  const role = (await database.query(`select role_id from public.roles where lower(role_name) in ('administrador','administrator','admin') order by is_system_role desc,role_id limit 1`)).rows[0];
  const subsidiary = (await database.query(`select subsidiary_id from public.subsidiaries where is_active=true order by subsidiary_id limit 1`)).rows[0];
  if (!role || !subsidiary) throw new Error('No existe un rol administrador o una subsidiaria activa para la prueba.');

  const identity = await adminAuth('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email: technicalUser.email,
      password,
      email_confirm: true,
      user_metadata: { technical_load_test: true, run_id: runId },
    }),
  });
  authUserId = String(identity?.id || identity?.user?.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(authUserId)) throw new Error('Supabase Auth no devolvió una identidad técnica válida.');

  await database.query('begin');
  try {
    await database.query(`update public.users set auth_user_id=$2::uuid,password_hash='auth:'||$2,is_active=true where user_id=$1`, [userId, authUserId]);
    await database.query(`insert into public.user_roles(user_id,role_id) values($1,$2) on conflict do nothing`, [userId, role.role_id]);
    await database.query(`insert into public.user_subsidiaries(user_id,subsidiary_id) values($1,$2) on conflict do nothing`, [userId, subsidiary.subsidiary_id]);
    await database.query('commit');
  } catch (cause) {
    await database.query('rollback');
    throw cause;
  }
  return { userId, roleId: Number(role.role_id), subsidiaryId: Number(subsidiary.subsidiary_id) };
}

async function createApplicationSession(index, context) {
  const deviceToken = `gentia-load-${runId}-${index}-${randomBytes(12).toString('hex')}`;
  const login = await observedRequest({
    phase: 'session-bootstrap',
    label: 'POST /api/auth/login',
    path: '/api/auth/login',
    method: 'POST',
    body: {
      email: technicalUser.email,
      password,
      deviceToken,
      deviceName: `Carga certificación ${index + 1}`,
      ...(turnstileToken ? { turnstileToken } : {}),
    },
    fatal: true,
  });
  const accessToken = String(login?.accessToken || '');
  if (!accessToken) throw new Error('El inicio de sesión no devolvió token de acceso.');
  const session = { index, deviceToken, accessToken };
  const bootstrap = await observedRequest({
    phase: 'session-bootstrap',
    label: 'POST /api/auth/bootstrap',
    path: '/api/auth/bootstrap',
    method: 'POST',
    session,
    body: { preferredRoleId: context.roleId, preferredSubsidiaryId: context.subsidiaryId },
    fatal: true,
  });
  if (Number(bootstrap?.bootstrapVersion) !== 1) throw new Error('El servidor no devolvió bootstrapVersion 1.');
  sessions.push(session);
  return session;
}

async function createSessionBatch(from, to, context) {
  for (let cursor = from; cursor < to; cursor += loginRate) {
    await Promise.all(Array.from({ length: Math.min(loginRate, to - cursor) }, (_, offset) => createApplicationSession(cursor + offset, context)));
    if (cursor + loginRate < to) await sleep(1000);
  }
}

const workloadEndpoints = [
  { label: 'GET /api/core/languages', path: '/api/core/languages' },
  { label: 'GET /api/auth/companies?view=summary', path: '/api/auth/companies?view=summary' },
  { label: 'GET /api/organization/subsidiaries?view=summary', path: '/api/organization/subsidiaries?view=summary' },
  { label: 'GET /api/security/my-role-access', path: '/api/security/my-role-access' },
  { label: 'GET /api/auth/roles', path: '/api/auth/roles' },
  { label: 'GET /api/auth/language-preference', path: '/api/auth/language-preference' },
  { label: 'GET /api/reports/accounting/options', path: '/api/reports/accounting/options' },
];

const endpointFor = (session, iteration = 0) => workloadEndpoints[(session.index + iteration) % workloadEndpoints.length];
const readOnce = (phase, session, iteration = 0) => {
  const endpoint = endpointFor(session, iteration);
  return observedRequest({ phase, label: endpoint.label, path: endpoint.path, session });
};

async function resetServerMetrics(session) {
  await observedRequest({ phase: 'telemetry', label: 'POST /api/internal/performance', path: '/api/internal/performance', method: 'POST', session, fatal: true });
}

async function readServerMetrics(session) {
  return observedRequest({ phase: 'telemetry', label: 'GET /api/internal/performance', path: '/api/internal/performance', session, fatal: true });
}

async function runRamp() {
  for (const count of [10, 30, 60, 100, sessionCount].filter((value, index, all) => value <= sessionCount && all.indexOf(value) === index)) {
    await Promise.all(sessions.slice(0, count).map((session, index) => readOnce(`ramp-${count}`, session, index)));
    await sleep(2000);
  }
}

async function runSustained() {
  const deadline = Date.now() + durationSeconds * 1000;
  await Promise.all(sessions.map(async session => {
    let iteration = 0;
    while (Date.now() < deadline) {
      await readOnce('sustained-120', session, iteration++);
      const jitter = Math.floor(Math.random() * Math.max(250, Math.floor(thinkTimeMs / 3)));
      await sleep(thinkTimeMs + jitter);
    }
  }));
}

const percentile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
};

function summarize(records) {
  const durations = records.map(record => record.durationMs);
  const bounds = records.reduce((value, record) => ({
    startedAtMs: Math.min(value.startedAtMs, record.startedAtMs),
    endedAtMs: Math.max(value.endedAtMs, record.endedAtMs),
  }), { startedAtMs: Number.POSITIVE_INFINITY, endedAtMs: 0 });
  const elapsed = records.length ? Math.max(1, bounds.endedAtMs - bounds.startedAtMs) : 1;
  return {
    requests: records.length,
    success: records.filter(record => record.ok).length,
    errors: records.filter(record => !record.ok).length,
    timeouts: records.filter(record => record.timeout).length,
    successRate: Number((records.filter(record => record.ok).length * 100 / Math.max(1, records.length)).toFixed(3)),
    p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    p99Ms: Number(percentile(durations, 0.99).toFixed(3)),
    maxMs: Number(Math.max(0, ...durations).toFixed(3)),
    aggregateRps: Number((records.length * 1000 / elapsed).toFixed(3)),
  };
}

function groupedSummary(records, field) {
  return Object.fromEntries([...new Set(records.map(record => record[field]))].sort().map(key => [key, summarize(records.filter(record => record[field] === key))]));
}

async function restoreTechnicalUser() {
  cleanupResult.attempted = true;
  const failures = [];
  if (authUserId) {
    try {
      await adminAuth(`/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, { method: 'DELETE' });
      cleanupResult.authIdentityDeleted = true;
    } catch (cause) { failures.push(`Auth: ${sanitizedMessage(cause instanceof Error ? cause.message : cause)}`); }
  }
  if (databaseConnected && snapshot && technicalUser) {
    const userId = Number(technicalUser.user_id);
    try {
      await database.query('begin');
      for (const table of ['user_company_sessions', 'user_role_sessions', 'sessions', 'devices']) {
        await database.query(`delete from public.${table} where user_id=$1`, [userId]);
      }
      await database.query(`delete from public.login_history where user_id=$1 and not (history_id::text=any($2::text[]))`, [userId, snapshot.loginHistory]);
      await database.query(`delete from public.password_history where user_id=$1 and not (history_id::text=any($2::text[]))`, [userId, snapshot.passwordHistory]);
      await database.query('delete from public.user_roles where user_id=$1', [userId]);
      await database.query('delete from public.user_subsidiaries where user_id=$1', [userId]);
      for (const roleId of snapshot.roles) await database.query('insert into public.user_roles(user_id,role_id) values($1,$2)', [userId, roleId]);
      for (const subsidiaryId of snapshot.subsidiaries) await database.query('insert into public.user_subsidiaries(user_id,subsidiary_id) values($1,$2)', [userId, subsidiaryId]);
      await database.query(`update public.users set email=$2,password_hash=$3,auth_user_id=$4::uuid,first_name=$5,last_name=$6,timezone_id=$7,is_active=$8 where user_id=$1`, [
        userId,
        snapshot.user.email,
        snapshot.user.password_hash,
        snapshot.user.auth_user_id,
        snapshot.user.first_name,
        snapshot.user.last_name,
        snapshot.user.timezone_id,
        snapshot.user.is_active,
      ]);
      // Los historiales anteriores se preservan como evidencia; solo se retiran
      // los eventos y hashes generados durante esta ejecución controlada.
      await database.query('commit');
      cleanupResult.databaseRestored = true;
      const verification = (await database.query(`select
        (select count(*)::int from public.sessions where user_id=$1) sessions,
        (select count(*)::int from public.devices where user_id=$1) devices,
        (select count(*)::int from public.user_company_sessions where user_id=$1) company_sessions,
        (select count(*)::int from public.user_role_sessions where user_id=$1) role_sessions,
        (select count(*)::int from public.user_roles where user_id=$1) roles,
        (select count(*)::int from public.user_subsidiaries where user_id=$1) subsidiaries,
        (select count(*)::int from public.login_history where user_id=$1) login_history,
        (select count(*)::int from public.password_history where user_id=$1) password_history,
        (select email from public.users where user_id=$1) email,
        (select password_hash from public.users where user_id=$1) password_hash,
        (select first_name from public.users where user_id=$1) first_name,
        (select last_name from public.users where user_id=$1) last_name,
        (select timezone_id::text from public.users where user_id=$1) timezone_id,
        (select is_active from public.users where user_id=$1) is_active,
        (select auth_user_id is null from public.users where user_id=$1) auth_detached`, [userId])).rows[0];
      cleanupResult.verified = verification.sessions === 0
        && verification.devices === 0
        && verification.company_sessions === 0
        && verification.role_sessions === 0
        && verification.roles === snapshot.roles.length
        && verification.subsidiaries === snapshot.subsidiaries.length
        && verification.login_history === snapshot.loginHistory.length
        && verification.password_history === snapshot.passwordHistory.length
        && verification.email === snapshot.user.email
        && verification.password_hash === snapshot.user.password_hash
        && verification.first_name === snapshot.user.first_name
        && verification.last_name === snapshot.user.last_name
        && verification.timezone_id === (snapshot.user.timezone_id === null ? null : String(snapshot.user.timezone_id))
        && verification.is_active === snapshot.user.is_active
        && verification.auth_detached === (snapshot.user.auth_user_id === null);
      if (!cleanupResult.verified) failures.push('La verificación posterior no coincide con el estado operativo inicial.');
    } catch (cause) {
      await database.query('rollback').catch(() => undefined);
      failures.push(`Base de datos: ${sanitizedMessage(cause instanceof Error ? cause.message : cause)}`);
    }
  }
  if (failures.length) throw new Error(`Limpieza incompleta. ${failures.join(' ')}`);
}

let primaryFailure;
let cleanupFailure;
let report;
try {
  await database.connect();
  databaseConnected = true;
  const health = await jsonFetch(new URL('/api/health', `${baseUrl}/`));
  if (!health.response.ok || health.data?.status !== 'ok') throw new Error('La verificación /api/health no fue satisfactoria.');
  const context = await prepareTechnicalUser();

  const firstSession = await createApplicationSession(0, context);
  await resetServerMetrics(firstSession);
  await createSessionBatch(1, sessionCount, context);
  const bootstrapServerMetrics = await readServerMetrics(firstSession);
  await resetServerMetrics(firstSession);

  const clientWorkloadStarted = performance.now();
  await runRamp();
  await runSustained();
  await sleep(10_000);
  for (let index = 0; index < 6; index += 1) await readOnce('recovery', firstSession, index);
  const workloadElapsedSeconds = (performance.now() - clientWorkloadStarted) / 1000;
  const workloadServerMetrics = await readServerMetrics(firstSession);

  const bootstrapRecords = observations.filter(record => record.phase === 'session-bootstrap');
  const workloadRecords = observations.filter(record => record.phase.startsWith('ramp-') || record.phase === 'sustained-120' || record.phase === 'recovery');
  const sustained = summarize(observations.filter(record => record.phase === 'sustained-120'));
  sustained.rps = Number((sustained.requests / durationSeconds).toFixed(3));
  const criteria = {
    successRateAtLeast99: sustained.successRate >= 99,
    errorRateBelow1: sustained.requests > 0 && sustained.errors / sustained.requests < 0.01,
    zeroTimeouts: sustained.timeouts === 0,
    p95Below1500Ms: sustained.p95Ms < 1500,
    p99Below3000Ms: sustained.p99Ms < 3000,
  };
  report = {
    runId,
    startedAt: runStartedAt,
    completedAt: new Date().toISOString(),
    target: parsedBaseUrl.origin,
    configuration: { sessionCount, durationSeconds, loginRate, thinkTimeMs, timeoutMs },
    methodology: 'Una identidad técnica, 120 sesiones Auth y dispositivos independientes; operaciones funcionales de solo lectura.',
    bootstrap: { overall: summarize(bootstrapRecords), byEndpoint: groupedSummary(bootstrapRecords, 'label'), server: bootstrapServerMetrics },
    workload: {
      elapsedSeconds: Number(workloadElapsedSeconds.toFixed(3)),
      overall: { ...summarize(workloadRecords), rps: Number((workloadRecords.length / workloadElapsedSeconds).toFixed(3)) },
      sustained,
      byPhase: groupedSummary(workloadRecords, 'phase'),
      byEndpoint: groupedSummary(workloadRecords, 'label'),
      server: workloadServerMetrics,
    },
    criteria,
    passed: Object.values(criteria).every(Boolean),
  };
} catch (cause) {
  primaryFailure = cause;
} finally {
  try { await restoreTechnicalUser(); }
  catch (cause) { if (primaryFailure) cleanupFailure = cause; else primaryFailure = cause; }
  if (databaseConnected) await database.end().catch(() => undefined);
}

if (report) {
  report.cleanup = cleanupResult;
  if (outputFile) {
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    runId: report.runId,
    target: report.target,
    configuration: report.configuration,
    bootstrap: report.bootstrap.overall,
    sustained: report.workload.sustained,
    criteria: report.criteria,
    passed: report.passed,
    cleanup: report.cleanup,
    outputFile,
  }, null, 2));
}
if (primaryFailure) {
  throw new Error(`${sanitizedMessage(primaryFailure instanceof Error ? primaryFailure.message : primaryFailure)}${cleanupFailure ? ` Limpieza: ${sanitizedMessage(cleanupFailure.message)}` : ''}`);
}
