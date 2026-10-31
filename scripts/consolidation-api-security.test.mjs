import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { consolidationOptions, consolidationWorksheet } from '../dist/modules/consolidation-catalogs/financial-consolidation.service.js';
import { primeRoleAccessCache, invalidateRoleAccessCaches } from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const resource = 'consolidation:financial-consolidation';
const endpoints = [
  ['GET', '', 'view', 'consolidation_options', {}],
  ['POST', '', 'create', 'consolidation_init', { p_period: '2026-10' }],
  ['POST', '/17/run-translation', 'edit', 'consolidation_translate', { p_run: 17 }],
  ['POST', '/17/auto-eliminate', 'edit', 'consolidation_process', { p_run: 17 }],
  ['GET', '/17/worksheet', 'view', 'consolidation_worksheet_data', { p_run: 17 }],
  ['POST', '/17/publish', 'edit', 'consolidation_publish', { p_run: 17 }]
];

test('las llamadas internas rechazan permisos ausentes y los identificadores invalidos no llegan a SQL', async t => {
  t.after(() => invalidateRoleAccessCaches());
  await primeRoleAccessCache('Bearer consolidation-direct-denied', { isAdmin: false, grants: [] });
  await assert.rejects(consolidationOptions('Bearer consolidation-direct-denied'), error => error.status === 403);
  await assert.rejects(consolidationOptions(''), error => error.status === 401);
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.throws(() => consolidationWorksheet('Bearer consolidation-direct-denied', id), error => error.status === 400);
  }
});

test('las seis rutas exigen su accion y conservan el JWT; las denegadas no llegan al RPC', { timeout: 25_000 }, async t => {
  const calls = [];
  const roles = { denied: null, reader: 'view', creator: 'create', editor: 'edit', admin: 'admin' };
  const stub = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const role = request.headers.authorization?.replace('Bearer consolidation-http-', '');
    if (request.url === '/rest/v1/rpc/assert_request_access') {
      response.end(JSON.stringify({ allowed: true, roleAccess: {
        isAdmin: role === 'admin', grants: [{ resourceKey: resource,
          canView: roles[role] === 'view', canCreate: roles[role] === 'create', canEdit: roles[role] === 'edit', canDelete: false }]
      } }));
      return;
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    calls.push({ path: request.url, authorization: request.headers.authorization, key: request.headers.apikey,
      payload: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    if (request.headers.authorization === 'Bearer consolidation-http-editor' && request.url.endsWith('/consolidation_publish')) {
      response.writeHead(403); response.end(JSON.stringify({ code: '42501', message: 'private SQL detail' })); return;
    }
    response.end(JSON.stringify({ fixture: true }));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { stub.closeAllConnections(); stub.close(resolve); }));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}/api/v1/accounting/consolidation`;
  const child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env,
    PORT: String(port), DISABLE_BACKGROUND_JOBS: 'true', SUPABASE_URL: `http://127.0.0.1:${stub.address().port}`,
    SUPABASE_ANON_KEY: 'public-fixture', SUPABASE_SERVICE_ROLE_KEY: 'server-secret-fixture', AUTH_REQUEST_ACCESS_CACHE_TTL_MS: '0'
  }, stdio: 'ignore' });
  t.after(() => child.kill());
  let ready = false;
  for (let attempt = 0; attempt < 70; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'El servidor aislado debe iniciar');
  let checked = 0;
  for (const [method, path, action, rpc, payload] of endpoints) {
    for (const [role, grant] of Object.entries(roles)) {
      const before = calls.length;
      const authorization = `Bearer consolidation-http-${role}`;
      const response = await fetch(base + path, { method, headers: {
        Authorization: authorization, 'X-Device-Token': 'consolidation-http-device-fixture', 'Content-Type': 'application/json'
      }, ...(method === 'POST' ? { body: JSON.stringify({ period: '2026-10' }) } : {}) });
      const allowed = role === 'admin' || grant === action;
      const sqlDenied = role === 'editor' && rpc === 'consolidation_publish';
      assert.equal(response.status, !allowed || sqlDenied ? 403 : method === 'POST' && path === '' ? 201 : 200, `${role} ${rpc}`);
      if (!allowed) assert.equal(calls.length, before, 'Un rechazo RBAC no debe invocar el RPC');
      else {
        assert.equal(calls.length, before + 1);
        assert.deepEqual(calls.at(-1), { path: `/rest/v1/rpc/${rpc}`, authorization, key: 'public-fixture', payload });
      }
      if (sqlDenied) assert.doesNotMatch(await response.text(), /private SQL detail/);
      checked++;
    }
    const before = calls.length;
    const anonymous = await fetch(base + path, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) });
    assert.equal(anonymous.status, 401, rpc);
    assert.equal(calls.length, before);
  }
  assert.equal(checked, 30);
});
