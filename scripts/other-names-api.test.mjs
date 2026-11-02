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
import { primeRoleAccessCache, roleAccessModules } from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import { entityMasterRpc } from '../dist/modules/entity-catalogs/entity-master.service.js';
import { getEntityCatalog, createEntityRow, updateEntityRow, deleteEntityRow } from '../dist/modules/entity-catalogs/entity-catalogs.module.js';

const resourceKey = 'entities:other-names';
const grant = (key = resourceKey, write = true) => ({ resourceKey: key, canView: true, canCreate: write, canEdit: write, canDelete: write });
const listen = server => new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const close = server => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); });

test('Otros Nombres declara identificación obligatoria, filial única y número automático como un recurso independiente', () => {
  const catalog = getEntityCatalog('other-names');
  assert.equal(catalog.table, 'other_names');
  assert.equal(catalog.primaryKey, 'other_name_id');
  assert.equal(catalog.fields.find(field => field.key === 'other_name_number').readOnly, true);
  assert.equal(catalog.fields.find(field => field.key === 'identification').required, true);
  assert.equal(catalog.fields.find(field => field.key === 'name').required, true);
  const subsidiary = catalog.fields.find(field => field.key === 'subsidiary_id');
  assert.equal(subsidiary.reference, 'organization/subsidiaries');
  assert.equal(subsidiary.readOnly, true);
  assert.equal(catalog.fields.some(field => field.key === 'subsidiary_ids'), false);
  assert.equal(catalog.fields.find(field => field.key === 'payment_bank_id').reference, 'banking/banks');
  for (const key of ['payment_iban', 'payment_account_number', 'payment_beneficiary_name', 'comments']) {
    assert.ok(catalog.fields.some(field => field.key === key), key);
  }
  const resources = roleAccessModules.flatMap(module => module.resources).filter(resource => resource.key === resourceKey);
  assert.equal(resources.length, 1);
  assert.deepEqual(resources[0].actions, ['view', 'create', 'edit', 'delete']);
});

test('Otros Nombres exige concesiones propias y rechaza identificadores inválidos antes de consultar Supabase', async t => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('No debe consultar Supabase.'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const catalog = getEntityCatalog('other-names');
  for (const [role, access] of [
    ['administrator', { isAdmin: true, grants: [] }],
    ['reader', { isAdmin: false, grants: [grant(resourceKey, false)] }],
    ['supplier-manager', { isAdmin: false, grants: [grant('entities:suppliers')] }],
    ['legacy', { isAdmin: false, grants: [grant('legacy:all')] }],
  ]) {
    const authorization = `Bearer other-name-service-${role}`;
    await primeRoleAccessCache(authorization, access);
    for (const run of [
      () => createEntityRow(catalog, authorization, {}),
      () => updateEntityRow(catalog, authorization, 7, {}),
      () => deleteEntityRow(catalog, authorization, 7, { _revision: 'synthetic' }),
    ]) await assert.rejects(run, error => error.status === 403, role);
  }
  const authorization = 'Bearer other-name-service-editor';
  await primeRoleAccessCache(authorization, { isAdmin: false, grants: [grant()] });
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => entityMasterRpc(authorization, 'other-names', 'edit', {}, id), error => error.status === 400);
    await assert.rejects(() => entityMasterRpc(authorization, 'other-names', 'delete', {}, id), error => error.status === 400);
  }
  assert.equal(calls, 0);
});

test('HTTP de Otros Nombres conserva JWT y dispositivo, usa RPC protegidas y devuelve errores seguros', { timeout: 45000 }, async t => {
  const publicKey = 'other-names-public-synthetic';
  const deviceToken = 'other-names-http-device-with-enough-entropy';
  const expectedDeviceHash = createHash('sha256').update(deviceToken).digest('hex');
  const failures = [], calls = [];
  const privateDetail = 'PRIVATE SQL DETAIL public.other_names identification_normalized';
  const row = { other_name_id: 7, other_name_number: 'ON-000001', subsidiary_id: 1, name: 'Tercero sintético', identification: '123456789', _revision: 'revision-2', _actions: { canEdit: true, canDelete: true } };
  let child, directory;
  const temporaryRoot = resolve(tmpdir());
  const stub = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const chunk of request) text += chunk;
      const payload = text ? JSON.parse(text) : {};
      const path = new URL(request.url, 'http://localhost').pathname;
      const authorization = request.headers.authorization;
      const role = authorization?.replace('Bearer other-name-http-', '');
      assert.equal(request.headers.apikey, publicKey);
      assert.equal(request.headers['x-erp-device-hash'], expectedDeviceHash);
      assert.equal(request.headers['x-device-token'], undefined);
      const send = (value, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      const access = { isAdmin: role === 'administrator', grants: role === 'manager' ? [grant()] : role === 'reader' ? [grant(resourceKey, false)] : role === 'supplier-manager' ? [grant('entities:suppliers')] : [] };
      if (path === '/rest/v1/rpc/assert_request_access') {
        assert.equal(payload.p_device_token_hash, expectedDeviceHash);
        return send({ allowed: true, roleAccess: access });
      }
      if (path === '/rest/v1/rpc/security_my_role_access') return send(access);
      calls.push({ path, payload, authorization, key: request.headers.apikey });
      assert.ok(['/rest/v1/rpc/other_name_list', '/rest/v1/rpc/other_name_options', '/rest/v1/rpc/save_other_name', '/rest/v1/rpc/delete_other_name'].includes(path), path);
      assert.equal(role === 'manager' || role === 'reader', true);
      if (payload.p_payload?.name === 'DUPLICATE') return send({ code: '23505', message: privateDetail, details: 'identification=private-value' }, 400);
      if (payload.p_payload?.name === 'INVALID-BANK') return send({ code: '22023', message: privateDetail }, 400);
      if (payload.p_payload?.name === 'STALE') return send({ code: '55000', message: privateDetail }, 400);
      if (payload.p_payload?.name === 'DB-DENIED') return send({ code: '42501', message: privateDetail }, 403);
      if (path.endsWith('/other_name_list')) return send([row]);
      if (path.endsWith('/other_name_options')) return send({ canView: true, canCreate: role === 'manager', canEdit: role === 'manager', canDelete: role === 'manager', references: { 'organization/subsidiaries': [{ subsidiary_id: 1, name: 'Subsidiaria sintética' }], 'banking/banks': [{ bank_id: 2, bank_name: 'Banco sintético' }] } });
      return send(path.endsWith('/delete_other_name') ? true : row);
    } catch (cause) {
      failures.push(cause);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'La prueba recibió una solicitud inesperada.' }));
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
      assert.ok(resolve(directory).startsWith(temporaryRoot + sep + 'gentia-other-names-api-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
  const probe = createServer();
  await listen(probe);
  const port = probe.address().port;
  await close(probe);
  directory = await mkdtemp(join(temporaryRoot, 'gentia-other-names-api-'));
  child = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
    cwd: directory,
    env: { ...process.env, PORT: String(port), DISABLE_BACKGROUND_JOBS: 'true', SUPABASE_URL: `http://127.0.0.1:${stub.address().port}`, SUPABASE_ANON_KEY: publicKey, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_other_names_unused', AUTH_REQUEST_ACCESS_CACHE_TTL_MS: '0', SMTP_ENABLED: 'false' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '', spawnError;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', cause => { spawnError = cause; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) assert.fail(`El servidor terminó antes de iniciar: ${stderr}`);
    try { ready = (await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) })).ok; if (ready) break; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  assert.ok(ready, `El servidor no inició: ${stderr}`);
  const request = (role, path, method = 'GET', payload) => fetch(base + '/api/entities/' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer other-name-http-' + role, 'X-Device-Token': deviceToken },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal((await fetch(base + '/api/entities/other-names')).status, 401);
  const input = { name: 'Tercero sintético', identification: '123456789', payment_bank_id: 2, payment_beneficiary_name: 'Beneficiario sintético', payment_account_number: '0000123456', comments: 'Pago sin factura', is_active: true };
  for (const role of ['administrator', 'reader', 'supplier-manager']) {
    for (const [method, path, payload] of [['POST', 'other-names', input], ['PATCH', 'other-names/7', { ...input, _revision: 'revision-1' }], ['DELETE', 'other-names/7', { _revision: 'revision-1' }]]) {
      const before = calls.length;
      assert.equal((await request(role, path, method, payload)).status, 403, role + ' ' + method);
      assert.equal(calls.length, before, 'Una mutación sin concesión no debe alcanzar la RPC.');
    }
  }
  for (const [method, path, payload, rpc, expected] of [
    ['GET', 'other-names', undefined, 'other_name_list', {}],
    ['GET', 'master/options?catalog=other-names', undefined, 'other_name_options', {}],
    ['POST', 'other-names', input, 'save_other_name', { p_payload: input, p_id: null }],
    ['PATCH', 'other-names/7', { ...input, _revision: 'revision-1' }, 'save_other_name', { p_payload: { ...input, _revision: 'revision-1' }, p_id: 7 }],
    ['DELETE', 'other-names/7', { _revision: 'revision-1' }, 'delete_other_name', { p_id: 7, p_revision: 'revision-1' }],
  ]) {
    const before = calls.length;
    const response = await request('manager', path, method, payload);
    assert.equal(response.status, method === 'POST' ? 201 : 200, await response.clone().text());
    assert.equal(calls.length, before + 1);
    assert.deepEqual(calls.at(-1), { path: '/rest/v1/rpc/' + rpc, payload: expected, authorization: 'Bearer other-name-http-manager', key: publicKey });
    const result = await response.json();
    assert.equal(JSON.stringify(result).includes('sb_secret'), false);
    if (rpc === 'other_name_list') assert.equal(result[0].other_name_number, 'ON-000001');
  }
  assert.equal((await request('reader', 'other-names')).status, 200);
  assert.equal((await request('reader', 'master/options?catalog=other-names')).status, 200);
  for (const [name, status, expression] of [['DUPLICATE', 409, /identificación.*subsidiaria/i], ['INVALID-BANK', 400, /IBAN|cuenta/i], ['STALE', 409, /cambió/i], ['DB-DENIED', 403, /autorizad/i]]) {
    const response = await request('manager', 'other-names', 'POST', { ...input, name });
    assert.equal(response.status, status);
    const message = await response.text();
    assert.match(message, expression);
    assert.equal(message.includes(privateDetail), false);
    assert.equal(message.includes('private-value'), false);
  }
  for (const id of ['0', String(Number.MAX_SAFE_INTEGER + 1)]) {
    const before = calls.length;
    assert.equal((await request('manager', 'other-names/' + id, 'PATCH', input)).status, 400);
    assert.equal(calls.length, before);
  }
  assert.deepEqual(failures, []);
});
