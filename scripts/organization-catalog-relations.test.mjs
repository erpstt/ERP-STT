import { primeRoleAccessCache } from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectRelationPages,
  getOrganizationRow,
  getOrganizationCatalog,
  invalidateOrganizationListCache,
  listOrganizationRows,
  updateOrganizationRow,
} from '../dist/modules/organization-catalogs/organization-catalogs.module.js';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;

process.env.SUPABASE_URL = 'https://catalog.test';
process.env.SUPABASE_ANON_KEY = 'test-key';

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateOrganizationListCache();
});

test.after(() => {
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalKey;
  globalThis.fetch = originalFetch;
});

test('collectRelationPages recupera relaciones posteriores al límite de 1.000 filas', async () => {
  const source = Array.from({ length: 1569 }, (_, index) => index + 1);
  const offsets = [];
  const rows = await collectRelationPages(async (offset, limit) => {
    offsets.push(offset);
    return source.slice(offset, offset + limit);
  });
  assert.equal(rows.length, 1569);
  assert.equal(rows.at(-1), 1569);
  assert.deepEqual(offsets, [0, 500, 1000, 1500]);
});

test('el listado de subsidiarias excluye logos pesados y el detalle conserva el registro completo', async () => {
  const queries = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    queries.push(url);
    if (url.pathname.endsWith('/subsidiaries')) {
      const detail = url.searchParams.get('subsidiary_id') === 'eq.7';
      const complete = url.searchParams.get('select') === '*';
      return Response.json([{
        subsidiary_id: 7,
        name: 'Empresa de pruebas',
        legal_name: 'Empresa de pruebas S.A.',
        currency_id: 2,
        ...(detail || complete ? { logo_url: 'data:image/png;base64,LOGO' } : {}),
      }]);
    }
    if (url.pathname.endsWith('/subsidiary_currencies')) {
      return Response.json([{ subsidiary_id: 7, currency_id: 2, is_primary: true }]);
    }
    throw new Error(`Solicitud inesperada: ${url}`);
  };

  const catalog = getOrganizationCatalog('subsidiaries');
  const complete = await listOrganizationRows(catalog, 'Bearer test');
  const list = await listOrganizationRows(catalog, 'Bearer test', true);
  const detail = await getOrganizationRow(catalog, 'Bearer test', 7);
  const completeQuery = queries.find(url => url.pathname.endsWith('/subsidiaries') && url.searchParams.get('select') === '*');
  const listQuery = queries.find(url => url.pathname.endsWith('/subsidiaries') && !url.searchParams.has('subsidiary_id') && url.searchParams.get('select') !== '*');
  const detailQuery = queries.find(url => url.pathname.endsWith('/subsidiaries') && url.searchParams.has('subsidiary_id'));

  assert.ok(completeQuery);
  assert.equal(complete[0].logo_url, 'data:image/png;base64,LOGO');
  assert.ok(listQuery);
  assert.equal(listQuery.searchParams.get('select').includes('logo_url'), false);
  assert.equal(list[0].logo_url, undefined);
  assert.deepEqual(list[0].allowed_currency_ids, [2]);
  assert.equal(detailQuery.searchParams.get('select'), '*');
  assert.equal(detail.logo_url, 'data:image/png;base64,LOGO');
  assert.deepEqual(detail.allowed_currency_ids, [2]);
});


test('departamentos conserva más de mil asignaciones por RPC y JWT público', async () => {
 await primeRoleAccessCache('Bearer dimensions', {isAdmin:false,grants:[{resourceKey:'organization:departments',canView:true,canEdit:true}]});
 const rows=Array.from({length:1205},(_,i)=>({department_id:i+1,name:'SYN '+i,subsidiary_ids:[1,2,3],_revision:'SYN-'+i}));let calls=0;
 globalThis.fetch=async(input,init)=>{calls++;assert.equal(new URL(String(input)).pathname,'/rest/v1/rpc/organization_master_list');assert.equal(new Headers(init.headers).get('Authorization'),'Bearer dimensions');assert.equal(new Headers(init.headers).get('apikey'),'test-key');return Response.json(rows);};
 const actual=await listOrganizationRows(getOrganizationCatalog('departments'),'Bearer dimensions');assert.equal(calls,1);assert.equal(actual.length,1205);assert.deepEqual(actual.at(-1),rows.at(-1));
});
test('actualización envía maestro, revisión y asignaciones en una única RPC',async()=>{
 await primeRoleAccessCache('Bearer dimension-edit',{isAdmin:false,grants:[{resourceKey:'organization:departments',canEdit:true}]});let calls=0;
 const payload={name:'SYN',type:'Interno',subsidiary_ids:[1,2],is_inactive:false,_revision:'SYN'};
 globalThis.fetch=async(input,init)=>{calls++;assert.equal(new URL(String(input)).pathname,'/rest/v1/rpc/save_organization_master');assert.deepEqual(JSON.parse(init.body),{p_catalog:'departments',p_payload:payload,p_id:80});return Response.json({department_id:80});};
 await updateOrganizationRow(getOrganizationCatalog('departments'),'Bearer dimension-edit',80,payload);assert.equal(calls,1);
});
