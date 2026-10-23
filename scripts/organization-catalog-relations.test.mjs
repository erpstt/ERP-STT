import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectRelationPages,
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
