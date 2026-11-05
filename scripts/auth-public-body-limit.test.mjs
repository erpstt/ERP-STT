import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.deepEqual(process.argv.slice(2), [], 'This isolated fixture accepts no destinations or credentials');

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicLimit = 16 * 1024;
const defaultLimit = 8 * 1024 * 1024;
const openingLimit = 36 * 1024 * 1024;
const publicRoutes = [
  '/api/auth/login',
  '/api/auth/request-password-recovery',
  '/api/auth/continue-password-access',
  '/api/auth/complete-password-recovery',
  '/api/auth/complete-password-invitation'
];
const publicKey = 'p88-synthetic-public-key';
const serviceKey = 'p88-synthetic-service-key-not-a-real-credential';
const deviceToken = 'p88-synthetic-device-with-enough-entropy';
const authorization = 'Bearer p88-synthetic-session';
const roleAccess = {
  isAdmin: false,
  grants: [{ resourceKey: 'accounting:opening-balances', canView: true, canCreate: true, canEdit: false, canDelete: false }]
};
const bootstrapPayload = {
  bootstrapVersion: 1, user: { name: 'Synthetic', email: 'synthetic@example.invalid' },
  locale: 'es', languages: [], roles: [], activeRole: null, roleAccess,
  companies: [], activeCompany: null, requiresCompanySelection: false
};
const calls = [], unexpected = [];
let upstream, child, fixtureDir, fixtureBase, canonicalWorkspace, port, childEnvironment;
let diagnostic = '', startedEmpty = false;

function insideDirectory(parent, target) {
  const part = relative(parent, target);
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}
async function createFixture() {
  canonicalWorkspace = await realpath(workspace);
  const namedBase = join(canonicalWorkspace, '.local-tools');
  try {
    const entry = await lstat(namedBase);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'Fixture base must not be a link');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(namedBase);
  }
  fixtureBase = await realpath(namedBase);
  assert.ok(insideDirectory(canonicalWorkspace, fixtureBase), 'Fixture base must remain inside the workspace');
  assert.equal(relative(canonicalWorkspace, fixtureBase), '.local-tools');
  const created = await mkdtemp(join(fixtureBase, 'p88-auth-body-fixture-'));
  fixtureDir = await realpath(created);
  assert.equal(created, fixtureDir, 'New fixture must be canonical');
  assert.ok(insideDirectory(fixtureBase, fixtureDir) && insideDirectory(canonicalWorkspace, fixtureDir));
  assert.deepEqual(await readdir(fixtureDir), [], 'The real router must start from an empty working directory');
  startedEmpty = true;
}
async function removeFixture() {
  if (!fixtureDir) return;
  assert.equal(await realpath(workspace), canonicalWorkspace, 'Workspace must not change before cleanup');
  assert.equal(await realpath(join(canonicalWorkspace, '.local-tools')), fixtureBase, 'Fixture base must not change before cleanup');
  const entry = await lstat(fixtureDir), target = await realpath(fixtureDir);
  assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'Refusing cleanup of a replaced fixture link');
  assert.equal(target, fixtureDir);
  assert.ok(insideDirectory(fixtureBase, target) && insideDirectory(canonicalWorkspace, target));
  assert.ok(basename(target).startsWith('p88-auth-body-fixture-'));
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
}
async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise(resolveExit => {
    const timeout = setTimeout(resolveExit, 3_000);
    child.once('close', () => { clearTimeout(timeout); resolveExit(); });
    if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timeout); resolveExit(); }
  });
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'The router must stop before fixture cleanup');
}
function localRequest(path, { method = 'POST', raw = '{}', auth = false, chunked = false, declaredLength, sendBody = true } = {}) {
  assert.ok(path.startsWith('/'));
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port, path, method, agent: false,
      headers: {
        Origin: 'http://127.0.0.1:' + port,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Authorization: authorization, 'X-Device-Token': deviceToken } : {}),
        ...(hasBody ? chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': declaredLength ?? data.byteLength } : {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveResponse({ status: response.statusCode, text, json: () => JSON.parse(text) });
      });
    });
    request.setTimeout(5_000, () => request.destroy(Error('Isolated loopback request timed out')));
    request.on('error', reject);
    if (!hasBody || !sendBody) request.end();
    else if (chunked) {
      const middle = Math.floor(data.byteLength / 2);
      request.write(data.subarray(0, middle));
      request.end(data.subarray(middle));
    } else request.end(data);
  });
}
function loginInput(email = 'synthetic@example.invalid') {
  return { email, password: 'Synthetic-password-only', deviceToken };
}
function jsonAtBytes(input, bytes) {
  const empty = { ...input, padding: '' };
  const padding = bytes - Buffer.byteLength(JSON.stringify(empty));
  assert.ok(padding >= 0);
  const text = JSON.stringify({ ...empty, padding: 'a'.repeat(padding) });
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}
function assertTooLarge(response, label = '16 KB') {
  assert.equal(response.status, 413);
  const result = response.json();
  assert.equal(result.error.status, 413);
  assert.equal(result.error.message, 'La solicitud supera el límite permitido de ' + label + '.');
}
function assertAccessOnly(from) {
  assert.deepEqual(calls.slice(from).map(call => call.path), ['/rest/v1/rpc/assert_request_access']);
}

before(async () => {
  await createFixture();
  upstream = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : null;
      calls.push({
        path: request.url, method: request.method,
        authorization: request.headers.authorization, key: request.headers.apikey, body
      });
      if (request.url === '/rest/v1/rpc/assert_request_access' && request.method === 'POST') {
        response.end(JSON.stringify({ allowed: true, roleAccess }));
      } else if (request.url === '/rest/v1/rpc/auth_bootstrap_context' && request.method === 'POST') {
        response.end(JSON.stringify(bootstrapPayload));
      } else if (request.url === '/auth/v1/token?grant_type=password' && request.method === 'POST') {
        response.writeHead(400);
        response.end(JSON.stringify({ message: 'Synthetic credentials rejected.' }));
      } else {
        unexpected.push(request.url);
        response.writeHead(500);
        response.end(JSON.stringify({ code: 'P88_UNEXPECTED_UPSTREAM_OPERATION' }));
      }
    } catch {
      unexpected.push('INVALID_SYNTHETIC_REQUEST');
      response.writeHead(500);
      response.end('{}');
    }
  });
  await new Promise(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen));
  const reservation = createServer();
  await new Promise(resolveListen => reservation.listen(0, '127.0.0.1', resolveListen));
  port = reservation.address().port;
  await new Promise(resolveClose => reservation.close(resolveClose));
  childEnvironment = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) childEnvironment[key] = process.env[key];
  }
  Object.assign(childEnvironment, {
    SESSION_REFRESH_ALLOW_LOCAL_HTTP: 'true',
    APP_BASE_URL: 'http://127.0.0.1:' + port,
    PORT: String(port), NODE_ENV: 'test', DISABLE_BACKGROUND_JOBS: 'true',
    SUPABASE_URL: 'http://127.0.0.1:' + upstream.address().port,
    SUPABASE_ANON_KEY: publicKey, SUPABASE_PUBLISHABLE_KEY: publicKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey, AUTH_REQUEST_ACCESS_CACHE_TTL_MS: '0',
    EMAIL_NOTIFICATIONS_ENABLED: 'false', TURNSTILE_ENABLED: 'false'
  });
  child = spawn(process.execPath, [join(workspace, 'dist', 'server.js')], {
    cwd: fixtureDir, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-2_000); });
  }
  let startupError;
  child.once('error', error => { startupError = error; });
  let ready = false, readiness = 'not probed';
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) break;
    try {
      const health = await localRequest('/api/health', { method: 'GET' });
      readiness = 'HTTP ' + health.status + ': ' + health.text.slice(0, 200);
      if (health.status === 200) { ready = true; break; }
    } catch (error) {
      if (error.code === 'EACCES') throw Error('The test runner is not permitted to connect to its isolated loopback router.');
      readiness = error.code || error.message;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  assert.ok(ready, 'The isolated router did not start: ' + diagnostic + '; ' + readiness);
});

after(async () => {
  let stopped = false;
  try { await stopChild(); stopped = true; }
  finally {
    await closeServer(upstream);
    if (stopped) await removeFixture();
  }
});

test('fixture starts the real router with an empty CWD and only allowlisted synthetic loopback configuration', async () => {
  assert.equal(startedEmpty, true);
  assert.deepEqual(await readdir(fixtureDir), []);
  assert.equal(childEnvironment.DISABLE_BACKGROUND_JOBS, 'true');
  assert.equal(childEnvironment.SUPABASE_URL, 'http://127.0.0.1:' + upstream.address().port);
  assert.equal(childEnvironment.SUPABASE_ANON_KEY, publicKey);
  assert.equal(childEnvironment.SUPABASE_SERVICE_ROLE_KEY, serviceKey);
  const allowed = new Set([
    'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP',
    'PORT', 'NODE_ENV', 'DISABLE_BACKGROUND_JOBS', 'SUPABASE_URL',
    'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
    'AUTH_REQUEST_ACCESS_CACHE_TTL_MS', 'EMAIL_NOTIFICATIONS_ENABLED', 'TURNSTILE_ENABLED',
    'APP_BASE_URL', 'SESSION_REFRESH_ALLOW_LOCAL_HTTP'
  ]);
  assert.ok(Object.keys(childEnvironment).every(key => allowed.has(key)));
  for (const name of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'PGPASSWORD',
    'ERP_TEST_EMAIL', 'ERP_TEST_PASSWORD', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY',
    'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'TURNSTILE_SECRET_KEY']) {
    assert.equal(Object.hasOwn(childEnvironment, name), false);
  }
  assert.deepEqual(calls, []);
});

test('all five public authentication bodies reject an oversized Content-Length before reading bytes or contacting Auth/RPC', async () => {
  for (const path of publicRoutes) {
    const count = calls.length;
    const response = await localRequest(path, { declaredLength: publicLimit + 1, sendBody: false });
    assertTooLarge(response);
    assert.equal(calls.length, count, path);
  }
});

test('all five public authentication bodies reject actual chunked bytes over 16 KiB before any Auth/RPC', async () => {
  for (const path of publicRoutes) {
    const count = calls.length;
    const response = await localRequest(path, { raw: jsonAtBytes(loginInput(), publicLimit + 1), chunked: true });
    assertTooLarge(response);
    assert.equal(calls.length, count, path);
  }
});

test('the streamed limit counts UTF-8 bytes rather than JavaScript characters or trusted headers', async () => {
  const raw = JSON.stringify({ ...loginInput(), padding: 'é'.repeat(8_192) });
  assert.ok(raw.length < publicLimit);
  assert.ok(Buffer.byteLength(raw, 'utf8') > publicLimit);
  const count = calls.length;
  const response = await localRequest('/api/auth/login', { raw, chunked: true });
  assertTooLarge(response);
  assert.equal(calls.length, count);
});

test('a login at exactly 16 KiB reaches only the synthetic Auth rejection and retains its contract', async () => {
  const count = calls.length, input = loginInput('boundary@example.invalid');
  const response = await localRequest('/api/auth/login', { raw: jsonAtBytes(input, publicLimit), chunked: true });
  assert.equal(response.status, 400);
  assert.equal(response.json().error.message, 'No fue posible iniciar sesión. Revisa tus datos o inténtalo más tarde.');
  assert.equal(calls.length, count + 1);
  const call = calls.at(-1);
  assert.equal(call.path, '/auth/v1/token?grant_type=password');
  assert.equal(call.key, serviceKey);
  assert.equal(call.authorization, 'Bearer ' + serviceKey);
  assert.deepEqual(call.body, { email: input.email, password: input.password });
});

test('small public requests preserve their business-validation status and never contact Auth/RPC', async () => {
  for (const [path, status] of [
    ['/api/auth/login', 400],
    ['/api/auth/request-password-recovery', 400],
    ['/api/auth/continue-password-access', 400],
    ['/api/auth/complete-password-recovery', 401],
    ['/api/auth/complete-password-invitation', 401]
  ]) {
    const count = calls.length;
    const response = await localRequest(path);
    assert.equal(response.status, status, path);
    assert.equal(response.json().error.status, status);
    assert.ok(response.json().error.message.length > 0);
    assert.doesNotMatch(response.json().error.message, /supera el límite/);
    assert.equal(calls.length, count);
  }
});

test('small valid-shaped login still delegates to synthetic Auth without opening a session', async () => {
  const count = calls.length, input = loginInput('small@example.invalid');
  const response = await localRequest('/api/auth/login', { raw: JSON.stringify(input) });
  assert.equal(response.status, 400);
  assert.equal(response.json().error.message, 'No fue posible iniciar sesión. Revisa tus datos o inténtalo más tarde.');
  assert.deepEqual(calls.slice(count).map(call => call.path), ['/auth/v1/token?grant_type=password']);
});

test('authenticated bootstrap retains the larger operational body allowance and authorization before its mock RPC', async () => {
  const count = calls.length;
  const response = await localRequest('/api/auth/bootstrap', {
    auth: true, raw: jsonAtBytes({ preferredRoleId: 2, preferredSubsidiaryId: 7 }, publicLimit + 1)
  });
  assert.equal(response.status, 200);
  assert.equal(response.json().bootstrapVersion, 1);
  assert.deepEqual(calls.slice(count).map(call => call.path), [
    '/rest/v1/rpc/assert_request_access', '/rest/v1/rpc/auth_bootstrap_context'
  ]);
  const call = calls.at(-1);
  assert.equal(call.authorization, authorization);
  assert.equal(call.key, publicKey);
  assert.deepEqual(call.body, { p_preferred_role_id: 2, p_preferred_subsidiary_id: 7 });
});

test('the authenticated default body still rejects above 8 MiB before its business RPC', async () => {
  const count = calls.length;
  const response = await localRequest('/api/auth/bootstrap', {
    auth: true, declaredLength: defaultLimit + 1, sendBody: false
  });
  assertTooLarge(response, '8 MB');
  assertAccessOnly(count);
});

test('opening validation retains its 36 MiB exception and performs no financial write for a 9 MiB empty fixture', async () => {
  const count = calls.length;
  const response = await localRequest('/api/opening-balances/validate', {
    auth: true, raw: jsonAtBytes({}, 9 * 1024 * 1024)
  });
  assert.equal(response.status, 400);
  assert.equal(response.json().error.message, 'No fue posible validar el archivo. Revisa el formato o consulta la referencia.');
  assertAccessOnly(count);
});

test('opening validation still rejects above 36 MiB before any financial operation', async () => {
  const count = calls.length;
  const response = await localRequest('/api/opening-balances/validate', {
    auth: true, declaredLength: openingLimit + 1, sendBody: false
  });
  assertTooLarge(response, '36 MB');
  assertAccessOnly(count);
});

test('operational routes keep requiring authentication even with a body larger than the public limit', async () => {
  const count = calls.length;
  const response = await localRequest('/api/auth/bootstrap', { raw: jsonAtBytes({}, publicLimit + 1) });
  assert.equal(response.status, 401);
  assert.equal(response.json().error.message, 'Debe iniciar sesión.');
  assert.equal(calls.length, count);
});

test('all upstream calls remained in the explicit synthetic allowlist and the router remains healthy', async () => {
  assert.deepEqual(unexpected, []);
  const allowed = new Set([
    '/auth/v1/token?grant_type=password',
    '/rest/v1/rpc/assert_request_access',
    '/rest/v1/rpc/auth_bootstrap_context'
  ]);
  assert.ok(calls.every(call => allowed.has(call.path)));
  assert.equal(calls.filter(call => call.path.startsWith('/auth/v1/')).length, 2);
  assert.equal((await localRequest('/api/health', { method: 'GET' })).status, 200);
});
