import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const listen = server => new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const close = server => new Promise(resolveClose => {
  server.closeAllConnections();
  server.close(resolveClose);
});

test('login HTTP inicializa historial con el dispositivo del cuerpo, sin cabecera o con una distinta', { timeout: 30000 }, async t => {
  const authId = '123e4567-e89b-42d3-a456-426614174000';
  const sessionId = '11111111-0000-4000-8000-000000000001';
  const email = 'login-http@example.invalid';
  const password = 'synthetic-existing-password';
  const serviceKey = 'sb_secret_synthetic_login_http';
  const publicKey = 'synthetic-public-key';
  const token = `header.${encode({ sub: authId, session_id: sessionId, email, exp: Math.floor(Date.now() / 1000) + 900 })}.signature`;
  const calls = [], failures = [];
  let expectedDevice, child, directory;
  const temporaryRoot = resolve(tmpdir());

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
        return json({ access_token: token, user: { id: authId, email } });
      }
      if (url.pathname === '/rest/v1/rpc/security_register_login' && request.method === 'POST') {
        assert.equal(request.headers.apikey, serviceKey);
        assert.equal(request.headers.authorization, undefined);
        assert.equal(body.p_auth_user_id, authId);
        assert.equal(body.p_auth_session_id, sessionId);
        assert.equal(body.p_device_token_hash, hash(expectedDevice.trim()));
        return json({ userId: 44 });
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
  await listen(stub);
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await close(stub);
    if (directory) {
      assert.ok(resolve(directory).startsWith(temporaryRoot + sep + 'gentia-login-device-context-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

  const temporary = createServer();
  await listen(temporary);
  const port = temporary.address().port;
  await close(temporary);
  // An empty working directory prevents server startup from reading the real .env.
  directory = await mkdtemp(join(temporaryRoot, 'gentia-login-device-context-'));
  child = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
    cwd: directory,
    env: {
      ...process.env,
      PORT: String(port),
      DISABLE_BACKGROUND_JOBS: 'true',
      TURNSTILE_ENABLED: 'false',
      SUPABASE_URL: `http://127.0.0.1:${stub.address().port}`,
      SUPABASE_ANON_KEY: publicKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '', spawnError;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', cause => { spawnError = cause; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) assert.fail(`El servidor terminó antes de iniciar: ${stderr}`);
    try {
      ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
      if (ready) break;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  assert.ok(ready, `El servidor no inició: ${stderr}`);

  for (const headerDevice of [undefined, 'different-header-device-with-enough-entropy']) {
    expectedDevice = headerDevice ? 'body-device-with-header-conflict-123' : '  body-device-without-header-123456  ';
    const before = calls.length;
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headerDevice ? { 'X-Device-Token': headerDevice } : {}) },
      body: JSON.stringify({ email, password, deviceToken: expectedDevice, deviceName: 'Synthetic HTTP browser' }),
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    assert.deepEqual(failures, []);
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.deepEqual(payload, { accessToken: token, user: { name: 'login-http', email } });
    const result = JSON.stringify(payload);
    assert.equal(result.includes(serviceKey), false);
    assert.equal(result.includes(password), false);
    assert.equal(result.includes('password_hash'), false);
    const history = calls.slice(before).filter(call => call.path === '/rest/v1/password_history');
    assert.deepEqual(history.map(call => call.method), ['GET', 'POST']);
    assert.equal(result.includes(history[1].body.password_hash), false);
  }
});
