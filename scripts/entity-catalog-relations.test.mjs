import assert from 'node:assert/strict';
import test from 'node:test';
import { getEntityCatalog, listEntityRows } from '../dist/modules/entity-catalogs/entity-catalogs.module.js';
import { primeRoleAccessCache } from '../dist/modules/security-catalogs/role-access-matrix.module.js';

test('maestros conservan más de mil entidades y sus relaciones mediante RPC atómico', async t => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_ANON_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [['SUPABASE_URL', originalUrl], ['SUPABASE_ANON_KEY', originalKey]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.SUPABASE_URL = 'https://catalog.test';
  process.env.SUPABASE_ANON_KEY = 'public-fixture';
  await primeRoleAccessCache('Bearer relations', { isAdmin: false, grants: ['customers', 'suppliers'].map(k => ({ resourceKey: 'entities:' + k, canView: true })) });
  for (const catalog of ['customers', 'suppliers']) {
    const source = Array.from({ length: 1205 }, (_, index) => ({
      [catalog === 'customers' ? 'customer_id' : 'supplier_id']: index + 1,
      company_name: 'Synthetic ' + index, subsidiary_ids: [1, 2], currency_ids: [1, 2],
      withholding_rules: [{ subsidiary_id: 2, tax_code_id: index + 1 }], _revision: 'synthetic-' + index
    }));
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(new URL(String(input)).pathname, '/rest/v1/rpc/entity_master_list');
      assert.deepEqual(JSON.parse(init.body), { p_catalog: catalog });
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer relations');
      assert.equal(new Headers(init.headers).get('apikey'), 'public-fixture');
      return Response.json(source);
    };
    const rows = await listEntityRows(getEntityCatalog(catalog), 'Bearer relations');
    assert.equal(calls, 1);
    assert.equal(rows.length, 1205);
    assert.deepEqual(rows.at(-1), source.at(-1));
  }
});
