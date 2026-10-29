import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectRelationPages,
  getOrganizationRow,
  getOrganizationCatalog,
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

test('listOrganizationRows carga todas las subsidiarias de departamentos con más de 1.000 vínculos', async () => {
  const departments = Array.from({ length: 61 }, (_, index) => ({ department_id: index + 1, name: `DEP ${index + 1}` }));
  const links = departments.flatMap((department, departmentIndex) =>
    Array.from({ length: departmentIndex < 60 ? 26 : 9 }, (_, subsidiaryIndex) => ({
      department_id: department.department_id,
      subsidiary_id: subsidiaryIndex + 1,
    })),
  );
  const offsets = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/departments')) return Response.json(departments);
    if (url.pathname.endsWith('/department_subsidiaries')) {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 500);
      offsets.push(offset);
      return Response.json(links.slice(offset, offset + limit));
    }
    throw new Error(`Solicitud inesperada: ${url}`);
  };
  const rows = await listOrganizationRows(getOrganizationCatalog('departments'), 'Bearer test');
  assert.equal(links.length, 1569);
  assert.deepEqual(offsets, [0, 500, 1000, 1500]);
  assert.deepEqual(rows.at(-1).subsidiary_ids, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('departamentos incorpora sus subsidiarias en una sola consulta PostgREST', async () => {
  let calls = 0;
  globalThis.fetch = async input => {
    calls += 1;
    const url = new URL(String(input));
    assert.ok(url.pathname.endsWith('/departments'));
    assert.match(url.searchParams.get('select') || '', /department_subsidiaries\(subsidiary_id\)/);
    return Response.json([{
      department_id: 80,
      name: 'CONTABILIDAD R.',
      department_subsidiaries: [{ subsidiary_id: 3 }, { subsidiary_id: 7 }],
    }]);
  };

  const rows = await listOrganizationRows(getOrganizationCatalog('departments'), 'Bearer test');
  assert.equal(calls, 1);
  assert.deepEqual(rows, [{ department_id: 80, name: 'CONTABILIDAD R.', subsidiary_ids: [3, 7] }]);
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

test('una inserción fallida conserva las relaciones que ya existían', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    calls.push({ method, table: url.pathname.split('/').at(-1), query: url.search });
    if (url.pathname.endsWith('/departments') && method === 'PATCH') return Response.json([{ department_id: 80 }]);
    if (url.pathname.endsWith('/department_subsidiaries') && method === 'GET') {
      return Response.json([{ department_id: 80, subsidiary_id: 1 }, { department_id: 80, subsidiary_id: 2 }]);
    }
    if (url.pathname.endsWith('/department_subsidiaries') && method === 'POST') {
      return Response.json({ message: 'Fallo simulado al insertar' }, { status: 500 });
    }
    if (method === 'DELETE') throw new Error('No debe borrar vínculos después de una inserción fallida.');
    throw new Error(`Solicitud inesperada: ${method} ${url}`);
  };
  await assert.rejects(
    updateOrganizationRow(getOrganizationCatalog('departments'), 'Bearer test', 80, {
      name: 'COMUNICACIONES', type: 'Interno', parent_id: 72, subsidiary_ids: [2, 3], is_inactive: false,
    }),
    /Fallo simulado al insertar/,
  );
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
});

test('el PATCH guarda el encabezado y sincroniza exactamente las subsidiarias seleccionadas', async () => {
  const relationMethods = [];
  let departmentPatch;
  let insertedLinks;
  let deletedQuery;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    if (url.pathname.endsWith('/departments') && method === 'PATCH') {
      departmentPatch = { query: url.search, body: JSON.parse(String(init.body)) };
      return Response.json([{ department_id: 80 }]);
    }
    if (url.pathname.endsWith('/department_subsidiaries')) {
      relationMethods.push(method);
      if (method === 'GET') return Response.json([{ department_id: 80, subsidiary_id: 1 }, { department_id: 80, subsidiary_id: 2 }]);
      if (method === 'POST') {
        insertedLinks = JSON.parse(String(init.body));
        return new Response(null, { status: 201 });
      }
      if (method === 'DELETE') {
        deletedQuery = url.search;
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`Solicitud inesperada: ${method} ${url}`);
  };
  await updateOrganizationRow(getOrganizationCatalog('departments'), 'Bearer test', 80, {
    name: 'COMUNICACIONES', type: 'Interno', parent_id: 72, subsidiary_ids: [2, 3], is_inactive: false,
  });
  assert.deepEqual(departmentPatch, {
    query: '?department_id=eq.80',
    body: {
      name: 'COMUNICACIONES', type: 'Interno', parent_id: 72, is_inactive: false, subsidiary_id: 2,
    },
  });
  assert.deepEqual(relationMethods, ['GET', 'POST', 'DELETE']);
  assert.deepEqual(insertedLinks, [{ department_id: 80, subsidiary_id: 3 }]);
  assert.match(deletedQuery, /department_id=eq\.80/);
  assert.match(deletedQuery, /subsidiary_id=in\.\(1\)/);
});
