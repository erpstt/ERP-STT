import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogRow, getCoreCatalog, invalidateCoreLanguageCache, listCatalogRows } from '../dist/modules/core-catalogs/core-catalogs.module.js';
import { invalidateUserCompanySummaryCache, listUserCompanies, selectUserCompany } from '../dist/modules/auth/services/company-access.service.js';
import { getOrganizationCatalog, invalidateOrganizationSubsidiarySummaryCache, listOrganizationRows } from '../dist/modules/organization-catalogs/organization-catalogs.module.js';
import { assertRoleAccess, invalidateRoleAccessCaches, myRoleAccess } from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import { createSecurityRow, getSecurityCatalog, updateSecurityRow } from '../dist/modules/security-catalogs/security-catalogs.module.js';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;
process.env.SUPABASE_URL = 'https://cache.test';
process.env.SUPABASE_ANON_KEY = 'test-key';
const claims = Buffer.from(JSON.stringify({ sub: 'auth-user-1', email: 'cache@example.test', session_id: 'session-1' })).toString('base64url');
const authorization = `Bearer header.${claims}.signature`;
const secondClaims = Buffer.from(JSON.stringify({ sub: 'auth-user-2', email: 'cache-2@example.test', session_id: 'session-2' })).toString('base64url');
const secondAuthorization = `Bearer header.${secondClaims}.signature`;

test.afterEach(() => { globalThis.fetch = originalFetch; });
test.after(() => {
  if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = originalKey;
  globalThis.fetch = originalFetch;
});

test('idiomas usa caché de cinco minutos y un CRUD la invalida', async () => {
  invalidateCoreLanguageCache();
  let reads = 0;
  globalThis.fetch = async (_input, init = {}) => {
    if ((init.method ?? 'GET') === 'POST') return Response.json([{ language_id: 2, code: 'ENG', iso_code: 'en', name: 'English', is_active: true }]);
    reads += 1;
    return Response.json([{ language_id: 1, code: 'SPA', iso_code: 'es', name: 'Español', is_active: true }]);
  };
  const catalog = getCoreCatalog('languages');
  await listCatalogRows(catalog, authorization);
  await listCatalogRows(catalog, authorization);
  assert.equal(reads, 1);
  await createCatalogRow(catalog, authorization, { code: 'ENG', iso_code: 'en', name: 'English', is_active: true });
  await listCatalogRows(catalog, authorization);
  assert.equal(reads, 2);
});

test('empresas cachea solo el resumen sin logos y conserva el contrato completo aparte', async () => {
  invalidateUserCompanySummaryCache();
  const queries = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    queries.push(url);
    if (url.pathname.endsWith('/users')) return Response.json([{ user_id: 4 }]);
    if (url.pathname.endsWith('/user_subsidiaries')) return Response.json([{ subsidiary_id: 7 }]);
    if (url.pathname.endsWith('/subsidiaries')) return Response.json([{ subsidiary_id: 7, name: 'Empresa', legal_name: 'Empresa S.A.', logo_url: 'data:image/png;base64,LOGO', currency_id: 2 }]);
    if (url.pathname.endsWith('/currencies')) return Response.json([{ currency_id: 2, currency_code: 'USD' }]);
    throw new Error(`Solicitud inesperada: ${url}`);
  };
  const first = await listUserCompanies(authorization, true);
  await listUserCompanies(authorization, true);
  assert.equal(first[0].logoUrl, null);
  assert.equal(queries.filter(url => url.pathname.endsWith('/users')).length, 1);
  const complete = await listUserCompanies(authorization, false);
  assert.equal(complete[0].logoUrl, 'data:image/png;base64,LOGO');
  assert.equal(queries.some(url => url.pathname.endsWith('/subsidiaries') && url.searchParams.get('select')?.includes('logo_url')), true);
  invalidateUserCompanySummaryCache();
  await listUserCompanies(authorization, true);
  assert.equal(queries.filter(url => url.pathname.endsWith('/users')).length, 3);
});

test('subsidiarias resume por sesión, no cachea logos y respeta invalidación', async () => {
  invalidateOrganizationSubsidiarySummaryCache();
  const queries = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    queries.push(url);
    if (url.pathname.endsWith('/subsidiaries')) return Response.json([{ subsidiary_id: 7, name: 'Empresa', legal_name: 'Empresa S.A.', logo_url: 'data:image/png;base64,NO-CACHE', currency_id: 2 }]);
    if (url.pathname.endsWith('/subsidiary_currencies')) return Response.json([{ subsidiary_id: 7, currency_id: 2, is_primary: true }]);
    throw new Error(`Solicitud inesperada: ${url}`);
  };
  const catalog = getOrganizationCatalog('subsidiaries');
  const first = await listOrganizationRows(catalog, authorization, true);
  await listOrganizationRows(catalog, authorization, true);
  assert.equal(first[0].logo_url, undefined);
  assert.equal(queries.filter(url => url.pathname.endsWith('/subsidiaries')).length, 1);
  const listQuery = queries.find(url => url.pathname.endsWith('/subsidiaries'));
  assert.equal(listQuery.searchParams.get('select').includes('logo_url'), false);
  invalidateOrganizationSubsidiarySummaryCache();
  await listOrganizationRows(catalog, authorization, true);
  assert.equal(queries.filter(url => url.pathname.endsWith('/subsidiaries')).length, 2);
});

test('permisos y autorizaciones positivas se cachean y una asignación de rol los invalida', async () => {
  invalidateRoleAccessCaches();
  let myAccessCalls = 0;
  let assertionCalls = 0;
  let assignments = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rpc/security_my_role_access')) { myAccessCalls += 1; return Response.json({ isAdmin: false, grants: [] }); }
    if (url.pathname.endsWith('/rpc/security_assert_role_access')) { assertionCalls += 1; return Response.json(null); }
    if (url.pathname.endsWith('/user_roles') && init.method === 'POST') { assignments += 1; return Response.json([{ id: 1 }]); }
    throw new Error(`Solicitud inesperada: ${init.method ?? 'GET'} ${url}`);
  };
  await myRoleAccess(authorization);
  await myRoleAccess(authorization);
  await assertRoleAccess(authorization, 'core:languages', 'view');
  await assertRoleAccess(authorization, 'core:languages', 'view');
  assert.equal(myAccessCalls, 1);
  assert.equal(assertionCalls, 1);
  await createSecurityRow(getSecurityCatalog('user-roles'), authorization, { user_id: 4, role_id: 1 });
  assert.equal(assignments, 1);
  await myRoleAccess(authorization);
  await assertRoleAccess(authorization, 'core:languages', 'view');
  assert.equal(myAccessCalls, 2);
  assert.equal(assertionCalls, 2);
});

test('un cambio de contexto invalida solo las autorizaciones de esa sesión', async () => {
  invalidateRoleAccessCaches();
  let assertionCalls = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rpc/security_assert_role_access')) { assertionCalls += 1; return Response.json(null); }
    throw new Error(`Solicitud inesperada: ${url}`);
  };
  await assertRoleAccess(authorization, 'core:languages', 'view');
  await assertRoleAccess(secondAuthorization, 'core:languages', 'view');
  await assertRoleAccess(authorization, 'core:languages', 'view');
  await assertRoleAccess(secondAuthorization, 'core:languages', 'view');
  assert.equal(assertionCalls, 2);
  invalidateRoleAccessCaches(authorization);
  await assertRoleAccess(authorization, 'core:languages', 'view');
  await assertRoleAccess(secondAuthorization, 'core:languages', 'view');
  assert.equal(assertionCalls, 3);
});

test('cambiar empresas de un usuario invalida empresas y subsidiarias resumidas', async () => {
  invalidateUserCompanySummaryCache();
  invalidateOrganizationSubsidiarySummaryCache();
  let companyUserReads = 0;
  let subsidiaryReads = 0;
  let syncCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rpc/security_sync_user_subsidiaries')) { syncCalls += 1; return Response.json({ userId: 4, subsidiaryIds: [7] }); }
    if (url.pathname.endsWith('/users')) { companyUserReads += 1; return Response.json([{ user_id: 4 }]); }
    if (url.pathname.endsWith('/user_subsidiaries')) return Response.json([{ subsidiary_id: 7 }]);
    if (url.pathname.endsWith('/subsidiaries')) { subsidiaryReads += 1; return Response.json([{ subsidiary_id: 7, name: 'Empresa', legal_name: 'Empresa S.A.', currency_id: 2 }]); }
    if (url.pathname.endsWith('/currencies')) return Response.json([{ currency_id: 2, currency_code: 'USD' }]);
    if (url.pathname.endsWith('/subsidiary_currencies')) return Response.json([{ subsidiary_id: 7, currency_id: 2, is_primary: true }]);
    throw new Error(`Solicitud inesperada: ${init.method ?? 'GET'} ${url}`);
  };
  await listUserCompanies(authorization, true);
  await listOrganizationRows(getOrganizationCatalog('subsidiaries'), authorization, true);
  await updateSecurityRow(getSecurityCatalog('user-subsidiaries'), authorization, 4, { user_id: 4, subsidiary_ids: [7] });
  await listUserCompanies(authorization, true);
  await listOrganizationRows(getOrganizationCatalog('subsidiaries'), authorization, true);
  assert.equal(syncCalls, 1);
  assert.equal(companyUserReads, 2);
  assert.equal(subsidiaryReads, 4);
});

test('seleccionar empresa invalida el resumen sujeto al alcance de la sesión', async () => {
  invalidateOrganizationSubsidiarySummaryCache();
  let summaryReads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json([{ user_id: 4 }]);
    if (url.pathname.endsWith('/user_subsidiaries')) return Response.json([{ subsidiary_id: 7 }]);
    if (url.pathname.endsWith('/user_company_sessions') && init.method === 'POST') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/subsidiaries')) {
      if (url.searchParams.get('subsidiary_id') === 'eq.7') return Response.json([{ subsidiary_id: 7, name: 'Empresa', legal_name: 'Empresa S.A.', logo_url: null, currency_id: 2 }]);
      summaryReads += 1;
      return Response.json([{ subsidiary_id: 7, name: 'Empresa', legal_name: 'Empresa S.A.', currency_id: 2 }]);
    }
    if (url.pathname.endsWith('/currencies')) return Response.json([{ currency_code: 'USD' }]);
    if (url.pathname.endsWith('/subsidiary_currencies')) return Response.json([{ subsidiary_id: 7, currency_id: 2, is_primary: true }]);
    throw new Error(`Solicitud inesperada: ${init.method ?? 'GET'} ${url}`);
  };
  const catalog = getOrganizationCatalog('subsidiaries');
  await listOrganizationRows(catalog, authorization, true);
  await listOrganizationRows(catalog, authorization, true);
  assert.equal(summaryReads, 1);
  await selectUserCompany(authorization, 7);
  await listOrganizationRows(catalog, authorization, true);
  assert.equal(summaryReads, 2);
});
