import assert from 'node:assert/strict';
import { test } from 'node:test';

assert.deepEqual(process.argv.slice(2), [], 'This isolated test accepts no destinations or credentials');

const originalEnvironment = process.env;
const originalFetch = globalThis.fetch;
const originalLoadEnvFile = process.loadEnvFile;
const syntheticEnvironment = {};
for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP']) {
  if (originalEnvironment[key] !== undefined) syntheticEnvironment[key] = originalEnvironment[key];
}
Object.assign(syntheticEnvironment, {
  SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_ANON_KEY: 'p119-synthetic-public-key',
  SUPABASE_PUBLISHABLE_KEY: 'p119-synthetic-public-key',
  SUPABASE_SERVICE_ROLE_KEY: 'P119_PRIVATE_PROVIDER_SQL_CANARY',
  DISABLE_BACKGROUND_JOBS: 'true',
});
process.env = { ...syntheticEnvironment };
process.loadEnvFile = () => { throw Error('Environment-file access is disabled in this synthetic fixture'); };
globalThis.fetch = async () => { throw Error('Fetch is disabled during synthetic module initialization'); };
const access = await import('../dist/modules/security-catalogs/role-access-matrix.module.js');
process.env = originalEnvironment;
globalThis.fetch = originalFetch;

const canary = 'P119_PRIVATE_PROVIDER_SQL_CANARY';
const messages = {
  401: 'La sesión no es válida. Inicie sesión nuevamente.',
  403: 'No fue posible verificar los permisos del rol activo.',
};
const readGrant = { resourceKey: 'core:languages', canView: true, canCreate: false, canEdit: false, canDelete: false };
let tokenNumber = 0;
const token = () => 'Bearer p119-synthetic-' + ++tokenNumber;
let unexpectedIO = [];

test.beforeEach(() => {
  process.env = { ...syntheticEnvironment };
  access.invalidateRoleAccessCaches();
  unexpectedIO = [];
  globalThis.fetch = async () => { unexpectedIO.push('unmocked fetch'); throw Error('Unexpected synthetic fetch'); };
});
test.afterEach(() => {
  access.invalidateRoleAccessCaches();
  process.env = originalEnvironment;
  globalThis.fetch = originalFetch;
  assert.deepEqual(unexpectedIO, []);
});
test.after(() => { process.loadEnvFile = originalLoadEnvFile; });

function mock(credential, respond, expectedPath = '/rest/v1/rpc/security_my_role_access') {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, syntheticEnvironment.SUPABASE_URL);
    if (url.pathname !== expectedPath) {
      unexpectedIO.push('unexpected provider path');
      throw Error('Unexpected synthetic provider path');
    }
    assert.equal(init.method, 'POST');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), credential);
    assert.equal(headers.get('apikey'), syntheticEnvironment.SUPABASE_ANON_KEY);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.notEqual(headers.get('apikey'), canary);
    const call = { pathname: url.pathname, body: JSON.parse(init.body) };
    calls.push(call);
    return respond(call, calls.length);
  };
  return calls;
}

function publicFailure(expectedStatus) {
  return error => {
    assert.ok(error instanceof Error);
    assert.equal(error.status, expectedStatus);
    assert.equal(error.message, messages[expectedStatus]);
    for (const value of [error.message, error.stack, JSON.stringify(error)]) assert.ok(!String(value).includes(canary));
    assert.equal(error.cause, undefined);
    for (const property of ['code', 'details', 'hint', 'payload', 'data']) assert.equal(error[property], undefined);
    return true;
  };
}

for (const status of [401, 403, 500]) test('current-role HTTP ' + status + ' uses its fixed public error without reflecting provider fields or trusting error-body grants', async () => {
  const credential = token();
  const calls = mock(credential, () => Response.json({
    message: 'SELECT private_value FROM ' + canary,
    code: canary, details: canary, hint: canary,
    isAdmin: true, grants: [{ resourceKey: 'legacy:all', canView: true, canCreate: true, canEdit: true, canDelete: true }],
  }, { status }));
  const expected = status === 401 ? 401 : 403;
  await assert.rejects(() => access.myRoleAccess(credential), publicFailure(expected));
  await assert.rejects(() => access.assertRoleAccess(credential, 'core:languages', 'view'), publicFailure(expected));
  assert.equal(calls.length, 2, 'A failed access lookup must not populate a successful or negative cache');
  assert.deepEqual(calls.map(call => call.body), [{}, {}]);
});

test('non-JSON or empty current-role error bodies cannot replace the fixed status and message', async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 503]) for (const body of ['', canary + ' is not JSON']) {
    const credential = token();
    const calls = mock(credential, () => new Response(body, { status }));
    await assert.rejects(() => access.myRoleAccess(credential), publicFailure(status === 401 ? 401 : 403));
    assert.equal(calls.length, 1);
  }
});

test('concurrent failed loads remain fail-closed and a later successful retry alone populates the normal cache', async () => {
  const credential = token();
  const calls = mock(credential, (_call, count) => count === 1
    ? Response.json({ message: canary, isAdmin: true, grants: [readGrant] }, { status: 500 })
    : Response.json({ isAdmin: false, grants: [readGrant] }));
  const results = await Promise.allSettled([access.myRoleAccess(credential), access.myRoleAccess(credential)]);
  assert.equal(calls.length, 1, 'Existing in-flight deduplication remains unchanged');
  for (const result of results) { assert.equal(result.status, 'rejected'); publicFailure(403)(result.reason); }
  const loaded = await access.myRoleAccess(credential);
  assert.equal(loaded.isAdmin, false); assert.deepEqual(loaded.grants, [readGrant]);
  assert.equal(calls.length, 2);
  await access.myRoleAccess(credential);
  assert.equal(await access.assertRoleAccess(credential, 'core:languages', 'view'), null);
  assert.equal(calls.length, 2, 'Successful role access keeps its existing cache behavior');
  await assert.rejects(() => access.assertRoleAccess(credential, 'core:languages', 'edit'), error => error.status === 403 && error.message === 'El rol activo no tiene permiso para realizar esta acción.');
  assert.equal(calls.length, 2);
});

test('successful grants retain modules, legacy exclusion, administrator behavior and explicit session invalidation', async () => {
  const credential = token();
  const calls = mock(credential, () => Response.json({ isAdmin: false, grants: [
    readGrant, { resourceKey: 'legacy:all', canView: true, canCreate: true, canEdit: true, canDelete: true },
  ] }));
  const loaded = await access.myRoleAccess(credential);
  assert.equal(loaded.modules, access.roleAccessModules);
  assert.ok(loaded.modules.length > 10);
  assert.deepEqual(loaded.grants, [readGrant]);
  assert.equal(loaded.isAdmin, false);
  assert.equal(await access.assertRoleAccess(credential, 'core:languages', 'view'), null);
  access.invalidateRoleAccessCaches(credential);
  await access.myRoleAccess(credential); assert.equal(calls.length, 2);
  const administrator = token();
  const adminCalls = mock(administrator, () => Response.json({ isAdmin: true, grants: [] }));
  assert.equal(await access.assertRoleAccess(administrator, 'core:languages', 'edit'), null);
  assert.equal(adminCalls.length, 1);
});

test('matrix provider messages are fixed while local matrix validation retains its public instruction', async () => {
  const credential = token();
  const calls = mock(credential, () => Response.json({ message: 'Seleccione un rol disponible.', code: '22023' }, { status: 400 }), '/rest/v1/rpc/security_role_access_matrix_data');
  await assert.rejects(() => access.roleAccessMatrix(credential, 999), error => error.status === 403 && error.message === 'No fue posible consultar la matriz de permisos. Verifique su acceso e inténtelo nuevamente.');
  assert.equal(calls.length, 1);
  await assert.rejects(() => access.saveRoleAccessMatrix(credential, { roleId: 0 }), error => error.message === 'Seleccione un rol válido.');
  assert.equal(calls.length, 1);
});
