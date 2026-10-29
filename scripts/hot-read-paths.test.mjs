import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;
process.env.SUPABASE_URL = 'https://hot-read-paths.example.test';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';

const roleService = await import('../dist/modules/auth/services/role-access.service.js');
const languageService = await import('../dist/modules/auth/services/language-preference.service.js');
const reportService = await import('../dist/modules/reports/accounting-reports.service.js');
const roleMatrix = await import('../dist/modules/security-catalogs/role-access-matrix.module.js');
const companyService = await import('../dist/modules/auth/services/company-access.service.js');
const coreCatalogs = await import('../dist/modules/core-catalogs/core-catalogs.module.js');
const securityCatalogs = await import('../dist/modules/security-catalogs/security-catalogs.module.js');

function bearer(claims) {
  return `Bearer header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

const firstAuthorization = bearer({
  sub: 'user-1',
  email: 'user-1@example.test',
  session_id: 'session-1',
});
const firstAuthorizationOtherSession = bearer({
  sub: 'user-1',
  email: 'user-1@example.test',
  session_id: 'session-2',
});

test.afterEach(() => { globalThis.fetch = originalFetch; });
test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalKey;
});

test('roles se cachean por usuario y una mutación de asignación invalida la lectura', async () => {
  roleService.invalidateUserRolesCache();
  let userReads = 0;
  let assignmentWrites = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) {
      userReads += 1;
      return Response.json([{ user_id: 11 }]);
    }
    if (url.pathname.endsWith('/user_roles') && init.method === 'POST') {
      assignmentWrites += 1;
      return Response.json([{ id: 99, user_id: 11, role_id: 7 }]);
    }
    if (url.pathname.endsWith('/user_roles')) return Response.json([{ role_id: 7 }]);
    if (url.pathname.endsWith('/roles')) {
      return Response.json([{ role_id: 7, role_name: 'Contabilidad', description: 'Rol contable' }]);
    }
    throw new Error(`Solicitud inesperada: ${init.method ?? 'GET'} ${url}`);
  };

  const first = await roleService.listUserRoles(firstAuthorization);
  await roleService.listUserRoles(firstAuthorization);
  await roleService.listUserRoles(firstAuthorizationOtherSession);
  assert.equal(first[0].name, 'Contabilidad');
  assert.equal(userReads, 1, 'Los roles son una preferencia del usuario y se comparten entre sus sesiones.');

  await securityCatalogs.createSecurityRow(
    securityCatalogs.getSecurityCatalog('user-roles'),
    firstAuthorization,
    { user_id: 11, role_id: 7 },
  );
  await roleService.listUserRoles(firstAuthorization);
  assert.equal(assignmentWrites, 1);
  assert.equal(userReads, 2, 'La asignación debe invalidar los roles cacheados.');
});

test('múltiples recursos usan una sola matriz y una denegación local conserva estado 403', async () => {
  roleMatrix.invalidateRoleAccessCaches();
  let matrixReads = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rpc/security_my_role_access')) {
      matrixReads += 1;
      return Response.json({
        isAdmin: false,
        grants: [
          { resourceKey: 'core:languages', canView: true, canCreate: false, canEdit: false, canDelete: false },
          { resourceKey: 'accounting:journals', canView: true, canCreate: true, canEdit: false, canDelete: false },
        ],
      });
    }
    throw new Error(`Solicitud inesperada: ${url}`);
  };

  await roleMatrix.assertRoleAccess(firstAuthorization, 'core:languages', 'view');
  await roleMatrix.assertRoleAccess(firstAuthorization, 'accounting:journals', 'create');
  await assert.rejects(
    () => roleMatrix.assertRoleAccess(firstAuthorization, 'accounting:journals', 'delete'),
    error => error instanceof Error && error.status === 403 && /no tiene permiso/i.test(error.message),
  );
  assert.equal(matrixReads, 1);

  const legacyAuthorization = bearer({ sub: 'legacy-user', session_id: 'legacy-session' });
  await roleMatrix.primeRoleAccessCache(legacyAuthorization, {
    isAdmin: false,
    grants: [{ resourceKey: 'legacy:all', canView: false, canCreate: false, canEdit: false, canDelete: false }],
  });
  await roleMatrix.assertRoleAccess(legacyAuthorization, 'accounting:journals', 'delete');
  assert.equal(matrixReads, 1, 'legacy:all debe autorizar localmente sin otra RPC.');
});

test('preferencia de idioma se cachea e invalida al cambiar preferencia o catálogo', async () => {
  languageService.invalidateLanguagePreferenceCache();
  let preferenceReads = 0;
  let preferenceWrites = 0;
  let languageWrites = 0;
  const preference = {
    locale: 'es',
    languages: [{ languageId: 1, code: 'SPA', isoCode: 'SPA', locale: 'es', name: 'Español' }],
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rpc/user_language_preference')) {
      preferenceReads += 1;
      return Response.json(preference);
    }
    if (url.pathname.endsWith('/rpc/set_user_language_preference')) {
      preferenceWrites += 1;
      return Response.json({ ...preference, locale: 'en' });
    }
    if (url.pathname.endsWith('/languages') && init.method === 'POST') {
      languageWrites += 1;
      return Response.json([{ language_id: 2, code: 'ENG', iso_code: 'ENG', name: 'English', is_active: true }]);
    }
    throw new Error(`Solicitud inesperada: ${init.method ?? 'GET'} ${url}`);
  };

  await languageService.getLanguagePreference(firstAuthorization);
  await languageService.getLanguagePreference(firstAuthorization);
  assert.equal(preferenceReads, 1);

  await languageService.setLanguagePreference(firstAuthorization, 'en');
  await languageService.getLanguagePreference(firstAuthorization);
  assert.equal(preferenceWrites, 1);
  assert.equal(preferenceReads, 2);

  await coreCatalogs.createCatalogRow(coreCatalogs.getCoreCatalog('languages'), firstAuthorization, {
    code: 'ENG', iso_code: 'ENG', name: 'English', is_active: true,
  });
  await languageService.getLanguagePreference(firstAuthorization);
  assert.equal(languageWrites, 1);
  assert.equal(preferenceReads, 3, 'El catálogo forma parte de la respuesta y debe invalidar la preferencia.');
});

test('opciones contables usan una RPC, caché por sesión y se invalidan al cambiar empresa', async () => {
  reportService.invalidateAccountingReportOptionsCache();
  let bundleReads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rpc/accounting_report_options_bundle')) {
      bundleReads += 1;
      return Response.json({
        subsidiaries: [{ id: 7, name: 'Empresa' }],
        reportDepartments: [],
        journalOptions: { modules: [] },
        pendingInvoiceOptions: {},
        agingOptions: {},
        bankOptions: {},
      });
    }
    if (url.pathname.endsWith('/users')) return Response.json([{ user_id: 11 }]);
    if (url.pathname.endsWith('/user_subsidiaries')) return Response.json([{ subsidiary_id: 7 }]);
    if (url.pathname.endsWith('/user_company_sessions') && init.method === 'POST') {
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/subsidiaries')) {
      return Response.json([{
        subsidiary_id: 7,
        name: 'Empresa',
        legal_name: 'Empresa S.A.',
        logo_url: null,
        currency_id: 2,
      }]);
    }
    if (url.pathname.endsWith('/currencies')) return Response.json([{ currency_code: 'USD' }]);
    if (url.pathname.endsWith('/subsidiary_currencies')) return Response.json([{ currency_id: 2 }]);
    throw new Error(`Solicitud inesperada: ${init.method ?? 'GET'} ${url}`);
  };

  const options = await reportService.accountingReportOptions(firstAuthorization);
  await reportService.accountingReportOptions(firstAuthorization);
  await reportService.accountingReportOptions(firstAuthorizationOtherSession);
  assert.deepEqual(options.journalOptions, { modules: [] });
  assert.equal(bundleReads, 2, 'Cada sesión mantiene su propio contexto activo.');

  await companyService.selectUserCompany(firstAuthorization, 7);
  await reportService.accountingReportOptions(firstAuthorization);
  await reportService.accountingReportOptions(firstAuthorizationOtherSession);
  assert.equal(bundleReads, 3, 'Cambiar empresa invalida solo el contexto de esa sesión.');
});

test('la migración consolida las seis funciones y restringe la RPC a authenticated', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20261029210000_accounting_report_options_bundle.sql', import.meta.url),
    'utf8',
  );
  for (const name of [
    'accounting_report_options',
    'income_statement_dimension_links',
    'general_journal_options',
    'pending_invoice_control_options',
    'aging_report_options',
    'bank_reconciliation_options',
  ]) assert.match(migration, new RegExp(`public\\.${name}\\(\\)`));
  assert.match(migration, /revoke all on function public\.accounting_report_options_bundle\(\) from public,anon;/i);
  assert.match(migration, /grant execute on function public\.accounting_report_options_bundle\(\) to authenticated;/i);

  const service = await readFile(
    new URL('../src/modules/reports/accounting-reports.service.ts', import.meta.url),
    'utf8',
  );
  assert.match(service, /rpc<Record<string,unknown>>\(authorization,'accounting_report_options_bundle'\)/);
  assert.doesNotMatch(service, /Promise\.all\(\[rpc<Record<string,unknown>>\(authorization,'accounting_report_options'/);
});
