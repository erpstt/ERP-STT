import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.test';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

const {
  createBankingRow,
  getBankingCatalog,
  listBankStatementAccountOptions,
  updateBankingRow
} = await import('../dist/modules/banking-catalogs/banking-catalogs.module.js');

const catalog = getBankingCatalog('bank-statements');
const payload = {
  statement_date: '2026-09-30',
  bank_account_id: 41,
  opening_balance: 100,
  closing_balance: 125
};

function response(body, status = 200) {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('consulta las opciones mediante el RPC dedicado del catálogo de extractos', async t => {
  let requestedUrl = '';
  let requestedMethod = '';
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init = {}) => {
    requestedUrl = String(input);
    requestedMethod = init.method ?? 'GET';
    return response([{
      bank_account_id: 41,
      subsidiary_id: 3,
      bank_name: 'JN Bank Limited',
      account_number: '2094351444',
      currency_code: 'USD'
    }]);
  };

  const options = await listBankStatementAccountOptions('Bearer test');
  assert.equal(options.length, 1);
  assert.match(requestedUrl, /\/rest\/v1\/rpc\/bank_statement_account_options$/);
  assert.equal(requestedMethod, 'POST');
});

test('valida la cuenta contra las cuentas visibles de la subsidiaria activa antes de crear', async t => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.includes('/rest/v1/bank_account?')) return response([{ bank_account_id: 41 }]);
    if (url.endsWith('/rest/v1/bank_statement')) return response([{ statement_id: 7, ...payload }], 201);
    return response({ message: 'Ruta inesperada' }, 404);
  };

  const created = await createBankingRow(catalog, 'Bearer test', payload);
  assert.equal(created.statement_id, 7);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /bank_account_id=eq\.41/);
  assert.equal(calls[1].method, 'POST');
});

test('rechaza una cuenta de otra subsidiaria antes de escribir el extracto', async t => {
  let writes = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, init = {}) => {
    if ((init.method ?? 'GET') !== 'GET') writes += 1;
    return response([]);
  };

  await assert.rejects(
    createBankingRow(catalog, 'Bearer test', payload),
    /no pertenece a la subsidiaria activa/i
  );
  assert.equal(writes, 0);
});

test('aplica la misma validación al editar y rechaza identificadores inválidos', async t => {
  let requests = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    requests += 1;
    return response([]);
  };

  await assert.rejects(
    updateBankingRow(catalog, 'Bearer test', 7, { ...payload, bank_account_id: 'cuenta-invalida' }),
    /cuenta bancaria válida/i
  );
  assert.equal(requests, 0);
});
