import assert from 'node:assert/strict';
import test from 'node:test';
import { getEntityCatalog, listEntityRows } from '../dist/modules/entity-catalogs/entity-catalogs.module.js';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;
process.env.SUPABASE_URL = 'https://catalog.test';
process.env.SUPABASE_ANON_KEY = 'test-key';

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = originalKey;
});

test('clientes conserva todas las relaciones aunque superen el límite de PostgREST', async () => {
  const customers = Array.from({ length: 1205 }, (_, index) => ({ customer_id: index + 1, company_name: `CLIENTE ${index + 1}` }));
  const subsidiaries = customers.map(row => ({ customer_id: row.customer_id, subsidiary_id: row.customer_id % 17 + 1 }));
  const currencies = customers.map(row => ({ customer_id: row.customer_id, currency_id: row.customer_id % 3 + 1 }));
  const rules = customers.map(row => ({ customer_id: row.customer_id, subsidiary_id: row.customer_id % 17 + 1, tax_code_id: row.customer_id % 5 + 1 }));
  const offsets = new Map();

  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 1000);
    offsets.set(table, [...(offsets.get(table) ?? []), offset]);
    const source = table === 'customers' ? customers
      : table === 'entity_subsidiaries' ? subsidiaries
      : table === 'customer_currencies' ? currencies
      : table === 'entity_withholding_rules' ? rules
      : null;
    if (!source) throw new Error(`Solicitud inesperada: ${url}`);
    return Response.json(source.slice(offset, offset + limit));
  };

  const rows = await listEntityRows(getEntityCatalog('customers'), 'Bearer test');
  assert.equal(rows.length, 1205);
  assert.deepEqual(offsets.get('customers'), [0, 1000]);
  assert.deepEqual(offsets.get('entity_subsidiaries'), [0, 500, 1000]);
  assert.deepEqual(rows.at(-1).subsidiary_ids, [1205 % 17 + 1]);
  assert.deepEqual(rows.at(-1).currency_ids, [1205 % 3 + 1]);
  assert.deepEqual(rows.at(-1).withholding_rules, [{ subsidiary_id: 1205 % 17 + 1, tax_code_id: 1205 % 5 + 1 }]);
});
