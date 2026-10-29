import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { bootstrapSession } from '../dist/modules/auth/services/bootstrap.service.js';
import { assertRoleAccess, invalidateRoleAccessCaches } from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;
process.env.SUPABASE_URL = 'https://bootstrap.test';
process.env.SUPABASE_ANON_KEY = 'anon-test';

test.afterEach(() => { globalThis.fetch = originalFetch; });
test.after(() => {
  if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = originalKey;
  globalThis.fetch = originalFetch;
});

test('bootstrap usa una sola RPC, conserva el JWT y agrega el catálogo de módulos', async () => {
  invalidateRoleAccessCaches();
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: new URL(String(input)), init });
    return Response.json({
      bootstrapVersion: 1,
      user: { name: 'Usuario Prueba', email: 'usuario@example.test' },
      locale: 'es', languages: [], roles: [{ roleId: 2, name: 'Contabilidad', description: '' }],
      activeRole: { roleId: 2, name: 'Contabilidad', description: '' },
      roleAccess: { isAdmin: false, grants: [{ resourceKey: 'accounting:journals', canView: true, canCreate: false, canEdit: false, canDelete: false }] },
      companies: [{ subsidiaryId: 7, name: 'Empresa', legalName: 'Empresa S.A.', logoUrl: null, currencyCode: 'USD' }],
      activeCompany: { subsidiaryId: 7, name: 'Empresa', legalName: 'Empresa S.A.', logoUrl: null, currencyCode: 'USD', allowedCurrencyIds: [2] },
      requiresCompanySelection: false,
    });
  };
  const result = await bootstrapSession('Bearer jwt-test', { preferredRoleId: 2, preferredSubsidiaryId: 7 });
  assert.equal(calls.length, 1);
  assert.equal(result.bootstrapVersion, 1);
  assert.equal(calls[0].url.pathname, '/rest/v1/rpc/auth_bootstrap_context');
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Bearer jwt-test');
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_preferred_role_id: 2, p_preferred_subsidiary_id: 7 });
  assert.equal(result.activeRole.roleId, 2);
  assert.equal(result.activeCompany.subsidiaryId, 7);
  assert.ok(result.roleAccess.modules.length > 10);
  await assertRoleAccess('Bearer jwt-test', 'accounting:journals', 'view');
  await assert.rejects(
    () => assertRoleAccess('Bearer jwt-test', 'accounting:journals', 'delete'),
    error => error instanceof Error && error.status === 403,
  );
  assert.equal(calls.length, 1, 'El bootstrap debe precargar la matriz sin otra RPC de permisos.');
});

test('bootstrap rechaza identificadores inválidos antes de consultar Supabase', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  await assert.rejects(() => bootstrapSession('Bearer jwt-test', { preferredRoleId: 'abc' }), /rol preferido/i);
  await assert.rejects(() => bootstrapSession('Bearer jwt-test', { preferredSubsidiaryId: -2 }), /empresa preferida/i);
  assert.equal(calls, 0);
});

test('bootstrap conserva el estado HTTP de PostgREST para permitir fallback durante el despliegue', async () => {
  globalThis.fetch = async () => Response.json({ message: 'Function not found' }, { status: 404 });
  await assert.rejects(
    () => bootstrapSession('Bearer jwt-test'),
    error => error instanceof Error && error.status === 404 && /not found/i.test(error.message),
  );
});

test('la RPC deriva identidad y sesión del JWT y limita su ejecución a authenticated', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261029200000_auth_bootstrap_context.sql', import.meta.url), 'utf8');
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path=public,pg_temp/i);
  assert.match(sql, /public\.app_user_id\(\)/i);
  assert.match(sql, /public\.app_session_id\(\)/i);
  assert.match(sql, /'bootstrapVersion',1/i);
  assert.match(sql, /where user_role_sessions\.user_id=excluded\.user_id/i);
  assert.match(sql, /where user_company_sessions\.user_id=excluded\.user_id/i);
  assert.doesNotMatch(sql, /set user_id=excluded\.user_id/i);
  assert.match(sql, /revoke all on function public\.auth_bootstrap_context\(bigint,bigint\) from public,anon/i);
  assert.match(sql, /grant execute on function public\.auth_bootstrap_context\(bigint,bigint\) to authenticated/i);
  const signature = sql.slice(sql.indexOf('create or replace function'), sql.indexOf(') returns jsonb'));
  assert.doesNotMatch(signature, /p_user_id|p_session_id|p_email/i);
  assert.match(sql, /user_roles[\s\S]*p_preferred_role_id/i);
  assert.match(sql, /user_subsidiaries[\s\S]*p_preferred_subsidiary_id/i);
  assert.match(sql, /preferred_subsidiary_rejected:=true/i);
  assert.match(sql, /company_count>0 and active_company_data is null/i);
});
