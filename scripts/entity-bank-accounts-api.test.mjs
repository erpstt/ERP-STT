import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { entityMasterRpc } from '../dist/modules/entity-catalogs/entity-master.service.js';
import { createEntityRow, updateEntityRow, getEntityCatalog } from '../dist/modules/entity-catalogs/entity-catalogs.module.js';
import { primeRoleAccessCache } from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import { withDeviceContext } from '../dist/core/security/device-context.js';

const catalogs = ['suppliers', 'employees', 'other-names'];
const keys = ['payment_bank_id', 'payment_currency_id', 'payment_iban', 'payment_account_number',
  'secondary_payment_bank_id', 'secondary_payment_currency_id', 'secondary_payment_iban', 'secondary_payment_account_number'];
const grants = (write = true) => catalogs.map(slug => ({ resourceKey: 'entities:' + slug, canView: true, canCreate: write, canEdit: write, canDelete: write }));
const originalFetch = globalThis.fetch, originalEnvironment = { ...process.env };
test.afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnvironment }; });

test('tres maestros exponen dos cuentas independientes con bancos, monedas y cuentas textuales', () => {
  for (const slug of catalogs) {
    const fields = getEntityCatalog(slug).fields;
    for (const key of keys) {
      const field = fields.find(item => item.key === key);
      assert.ok(field, `${slug}: ${key}`);
      assert.equal(field.required === true, false, 'La banca nueva no debe convertir registros históricos en inválidos.');
      if (key.endsWith('bank_id')) assert.equal(field.reference, 'banking/banks');
      else if (key.endsWith('currency_id')) assert.equal(field.reference, 'core/currencies');
      else assert.equal(field.type, 'text');
    }
  }
});

test('alta y edición conservan ambas cuentas, ceros y revisión usando JWT público y dispositivo del usuario', async () => {
  process.env.SUPABASE_URL = 'https://entity-bank-api.example.invalid';
  process.env.SUPABASE_ANON_KEY = 'synthetic-public';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_unused';
  const authorization = 'Bearer synthetic-bank-editor';
  const device = 'entity-bank-device-with-enough-entropy';
  const bankData = {
    payment_beneficiary_name: 'Synthetic beneficiary', payment_bank_id: 11, payment_currency_id: 1,
    payment_iban: 'CR05015202001026284066', payment_account_number: '00001234',
    secondary_payment_bank_id: 12, secondary_payment_currency_id: 2,
    secondary_payment_iban: 'GB82WEST12345698765432', secondary_payment_account_number: '00009876',
  };
  const calls = [];
  await primeRoleAccessCache(authorization, { isAdmin: false, grants: grants() });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), headers = new Headers(init.headers), body = JSON.parse(init.body);
    assert.equal(headers.get('apikey'), 'synthetic-public');
    assert.equal(headers.get('authorization'), authorization);
    assert.equal(headers.get('x-erp-device-hash'), createHash('sha256').update(device).digest('hex'));
    assert.equal(headers.get('x-device-token'), null);
    calls.push({ path: url.pathname, body });
    return Response.json({ ...body.p_payload, _revision: 'NEXT', _actions: { canEdit: true, canDelete: true } });
  };
  for (const slug of catalogs) {
    const catalog = getEntityCatalog(slug);
    await withDeviceContext(device, () => createEntityRow(catalog, authorization, bankData));
    assert.equal(calls.at(-1).path, '/rest/v1/rpc/' + (slug === 'other-names' ? 'save_other_name' : 'save_entity_master'));
    assert.deepEqual(calls.at(-1).body.p_payload, bankData);
    assert.equal(calls.at(-1).body.p_id, null);
    const edited = { ...bankData, payment_currency_id: null, _revision: 'CURRENT' };
    const row = await withDeviceContext(device, () => updateEntityRow(catalog, authorization, 7, edited));
    assert.equal(calls.at(-1).body.p_id, 7);
    assert.deepEqual(calls.at(-1).body.p_payload, edited);
    assert.equal(row.payment_account_number, '00001234');
    assert.equal(row.secondary_payment_account_number, '00009876');
    assert.equal(row.payment_currency_id, null);
  }
  assert.equal(calls.length, 6);
});

test('opciones bancarias se devuelven desde RPC autorizada y la banca no evade concesiones exactas', async () => {
  process.env.SUPABASE_URL = 'https://entity-bank-options.example.invalid';
  process.env.SUPABASE_ANON_KEY = 'synthetic-public';
  const references = {
    'banking/banks': [{ bank_id: 11, bank_name: 'Synthetic bank' }],
    'core/currencies': [{ currency_id: 1, currency_code: 'CRC' }, { currency_id: 2, currency_code: 'USD' }],
  };
  let calls = 0;
  globalThis.fetch = async (input, init = {}) => {
    calls++;
    assert.equal(new Headers(init.headers).get('apikey'), 'synthetic-public');
    assert.ok(new URL(String(input)).pathname.endsWith('_options'));
    return Response.json({ canView: true, canCreate: false, canEdit: false, canDelete: false, references });
  };
  for (const slug of catalogs) {
    const auth = 'Bearer bank-reader-' + slug;
    await primeRoleAccessCache(auth, { isAdmin: false, grants: grants(false) });
    const options = await entityMasterRpc(auth, slug, 'options');
    assert.deepEqual(options.references, references);
    const before = calls;
    await assert.rejects(() => createEntityRow(getEntityCatalog(slug), auth, { payment_bank_id: 11, payment_account_number: '0001' }), error => error.status === 403);
    await assert.rejects(() => updateEntityRow(getEntityCatalog(slug), auth, 7, { secondary_payment_bank_id: 12, secondary_payment_account_number: '0002' }), error => error.status === 403);
    assert.equal(calls, before);
  }
  assert.equal(calls, 3);
});
