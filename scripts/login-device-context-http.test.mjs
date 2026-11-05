import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.deepEqual(process.argv.slice(2), [], 'This isolated HTTP test accepts no destinations or credentials');

const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const inside = (parent, target) => {
  const part = relative(parent, target);
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
};
const listen = server => new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
});
const close = async server => {
  if (!server) return;
  server.closeAllConnections();
  if (server.listening) await new Promise((done, reject) => server.close(cause => cause ? reject(cause) : done()));
};
const waitForClose = (completion, timeoutMs) => new Promise(resolveWait => {
  const timer = setTimeout(() => resolveWait(false), timeoutMs);
  completion.then(() => { clearTimeout(timer); resolveWait(true); });
});

test('login HTTP inicializa historial con el dispositivo del cuerpo, sin cabecera o con una distinta', { timeout: 45000 }, async t => {
  const authId = '11111111-1111-4111-8111-111111111111';
  const sessionId = '11111111-0000-4000-8000-000000000001';
  const email = 'login-http@example.invalid';
  const password = 'synthetic-existing-password';
  const serviceKey = 'sb_secret_synthetic_login_http';
  const publicKey = 'synthetic-public-key';
  const token = `header.${encode({ sub: authId, session_id: sessionId, email, exp: Math.floor(Date.now() / 1000) + 900 })}.signature`;
  const calls = [], failures = [];
  let expectedDevice, child, directory, childClosed = false, childCompletion;
  const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const namedRoot = join(workspace, '.local-tools');
  try {
    const entry = await lstat(namedRoot);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
    await mkdir(namedRoot);
  }
  const temporaryRoot = await realpath(namedRoot);
  assert.equal(relative(workspace, temporaryRoot), '.local-tools');
  assert.ok(inside(workspace, temporaryRoot));

  const stub = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(request.url, 'http://localhost');
      const call = { path: url.pathname, method: request.method, body, headers: request.headers };
      calls.push(call);
      const json = (value, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };

      if (url.pathname === '/auth/v1/token' && request.method === 'POST') {
        assert.equal(url.searchParams.get('grant_type'), 'password');
        assert.deepEqual(body, { email, password });
        assert.equal(request.headers.apikey, serviceKey);
        return json({ access_token: token, refresh_token: 'synthetic-refresh-http-only', user: { id: authId, email } });
      }
      if (url.pathname === '/rest/v1/rpc/security_register_login' && request.method === 'POST') {
        assert.equal(request.headers.apikey, serviceKey);
        assert.equal(request.headers.authorization, undefined);
        assert.equal(body.p_auth_user_id, authId);
        assert.equal(body.p_auth_session_id, sessionId);
        assert.equal(body.p_device_token_hash, hash(expectedDevice.trim()));
        return json({ userId: 44, expiresAt: new Date(Date.now()+900000).toISOString() });
      }
      if (url.pathname === '/rest/v1/password_history') {
        assert.equal(request.headers.apikey, publicKey);
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        assert.equal(request.headers['x-erp-device-hash'], hash(expectedDevice.trim()));
        assert.equal(request.headers['x-device-token'], undefined);
        if (request.method === 'GET') {
          assert.equal(url.searchParams.get('user_id'), 'eq.44');
          return json([]);
        }
        assert.equal(request.method, 'POST');
        assert.equal(body.user_id, 44);
        assert.match(body.password_hash, /^scrypt\$/);
        assert.notEqual(body.password_hash, password);
        response.writeHead(204);
        return response.end();
      }
      throw new Error(`Solicitud inesperada: ${request.method} ${url.pathname}`);
    } catch (cause) {
      failures.push(cause);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'La solicitud no respeta el contexto esperado.' }));
    }
  });
  t.after(async () => {
    if (child && !childClosed) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (!await waitForClose(childCompletion, 15_000)) {
        child.kill('SIGKILL');
        await waitForClose(childCompletion, 5_000);
      }
    }
    await close(stub);
    assert.ok(!child || childClosed, 'El router no cerró sus recursos; se conserva la carpeta temporal.');
    if (directory) {
      assert.equal(await realpath(workspace), workspace);
      assert.equal(await realpath(namedRoot), temporaryRoot);
      const entry = await lstat(directory), target = await realpath(directory);
      assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
      assert.equal(target, directory);
      assert.ok(inside(temporaryRoot, target) && inside(workspace, target));
      assert.ok(basename(target).startsWith('gentia-login-device-context-'));
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  await listen(stub);

  const temporary = createServer();
  await listen(temporary);
  const port = temporary.address().port;
  await close(temporary);
  // An empty working directory prevents server startup from reading the real .env.
  directory = await mkdtemp(join(temporaryRoot, 'gentia-login-device-context-'));
  assert.equal(await realpath(directory), directory);
  assert.ok(inside(temporaryRoot, directory) && inside(workspace, directory));
  assert.deepEqual(await readdir(directory), []);
  const childEnvironment = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) childEnvironment[key] = process.env[key];
  }
  const upstreamOrigin = `http://127.0.0.1:${stub.address().port}`;
  Object.assign(childEnvironment, {
    SESSION_REFRESH_ALLOW_LOCAL_HTTP: 'true',
    APP_BASE_URL: `http://127.0.0.1:${port}`,
    PORT: String(port), NODE_ENV: 'test', DISABLE_BACKGROUND_JOBS: 'true',
    TURNSTILE_ENABLED: 'false', EMAIL_NOTIFICATIONS_ENABLED: 'false', SMTP_ENABLED: 'false',
    SUPABASE_URL: upstreamOrigin, SUPABASE_ANON_KEY: publicKey,
    SUPABASE_PUBLISHABLE_KEY: publicKey, SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  });
  for (const key of ['NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SUPABASE_DB_URL']) {
    assert.equal(Object.hasOwn(childEnvironment, key), false);
  }
  const preloader = "process.loadEnvFile=()=>{throw Error('P125_ENV_FILE_BLOCKED');};const nativeFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const target=new URL(input instanceof Request?input.url:String(input));if(target.origin!==" + JSON.stringify(upstreamOrigin) + "){process.stderr.write('P125_NON_LOOPBACK_FETCH_BLOCKED\\n');throw Error('P125_NON_LOOPBACK_FETCH_BLOCKED');}return nativeFetch(input,init);};";
  child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preloader), fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
    cwd: directory,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  childCompletion = new Promise(done => child.once('close', () => { childClosed = true; done(); }));
  let stdout = '', stderr = '', spawnError;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-64_000); });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64_000); });
  child.on('error', cause => { spawnError = cause; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false, lastProbe = 'NOT_PROBED';
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) assert.fail('El router aislado terminó antes de iniciar.');
    try {
      const probe = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      lastProbe = 'HTTP_' + probe.status;
      ready = probe.ok;
      if (ready) break;
    } catch (cause) {
      const code = cause?.cause?.code ?? cause?.code;
      lastProbe = typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : 'PROBE_FAILED';
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  assert.ok(ready, 'El router aislado no inició: ' + JSON.stringify({probe: lastProbe, listeningLog: stdout.includes('disponible en el puerto'), diagnosticBytes: stderr.length, blockedExternalFetch: stderr.includes('P125_NON_LOOPBACK_FETCH_BLOCKED')}));
  assert.deepEqual(await readdir(directory), []);

  for (const headerDevice of [undefined, 'different-header-device-with-enough-entropy']) {
    expectedDevice = headerDevice ? 'body-device-with-header-conflict-123' : '  body-device-without-header-123456  ';
    const before = calls.length;
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', ...(headerDevice ? { 'X-Device-Token': headerDevice } : {}) },
      body: JSON.stringify({ email, password, deviceToken: expectedDevice, deviceName: 'Synthetic HTTP browser' }),
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    assert.deepEqual(failures, []);
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.accessToken, token);
    assert.deepEqual(payload.user, { name: 'login-http', email });
    for (const name of ['expiresAt','erpSessionExpiresAt','refreshAt']) assert.ok(Number.isFinite(Date.parse(payload[name])));
    assert.equal(Object.hasOwn(payload, 'refreshCredential'), false);
    assert.equal(JSON.stringify(payload).includes('synthetic-refresh-http-only'), false);
    assert.match(response.headers.get('set-cookie') || '', /HttpOnly; SameSite=Strict/);
    const result = JSON.stringify(payload);
    assert.equal(result.includes(serviceKey), false);
    assert.equal(result.includes(password), false);
    assert.equal(result.includes('password_hash'), false);
    const history = calls.slice(before).filter(call => call.path === '/rest/v1/password_history');
    assert.deepEqual(history.map(call => call.method), ['GET', 'POST']);
    assert.equal(result.includes(history[1].body.password_hash), false);
  }
  assert.equal(stderr.includes('P125_NON_LOOPBACK_FETCH_BLOCKED'), false);
  assert.deepEqual(await readdir(directory), []);
});
