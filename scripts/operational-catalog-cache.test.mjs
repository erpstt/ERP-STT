import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteEntityRow,
  getEntityCatalog,
  invalidateEntityListCache,
  listEntityRows,
} from '../dist/modules/entity-catalogs/entity-catalogs.module.js';
import {
  deleteOrganizationRow,
  getOrganizationCatalog,
  invalidateOrganizationListCache,
  listOrganizationRows,
} from '../dist/modules/organization-catalogs/organization-catalogs.module.js';
import * as sales from '../dist/modules/sales-catalogs/sales-catalogs.module.js';
import * as purchasing from '../dist/modules/purchasing-catalogs/purchasing-catalogs.module.js';
import * as banking from '../dist/modules/banking-catalogs/banking-catalogs.module.js';
import * as fixedAssets from '../dist/modules/fixed-asset-catalogs/fixed-asset-catalogs.module.js';
import { saveSalesInvoice } from '../dist/modules/sales-catalogs/sales-invoice.service.js';
import { saveSupplierInvoice } from '../dist/modules/purchasing-catalogs/supplier-invoice.service.js';
import { saveFixedAsset } from '../dist/modules/fixed-asset-catalogs/fixed-assets.service.js';
import { saveAssetCategory } from '../dist/modules/fixed-asset-catalogs/asset-category.service.js';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;
process.env.SUPABASE_URL = 'https://operational-cache.example.test';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';

function bearer(user, session) {
  const claims = Buffer.from(JSON.stringify({ sub: user, session_id: session })).toString('base64url');
  return `Bearer header.${claims}.signature`;
}

const firstAuthorization = bearer('user-1', 'session-1');
const secondAuthorization = bearer('user-1', 'session-2');

function invalidateOperationalCatalogs() {
  sales.invalidateSalesCatalogCache('invoices');
  purchasing.invalidatePurchasingCatalogCache('supplier-invoices');
  banking.invalidateBankingCatalogCache('bank-accounts');
  banking.invalidateBankingCatalogCache('bank-statements');
  fixedAssets.invalidateFixedAssetCatalogCache('assets');
  fixedAssets.invalidateFixedAssetCatalogCache('asset-categories');
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateEntityListCache();
  invalidateOrganizationListCache();
  invalidateOperationalCatalogs();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalKey;
});

test('clientes se cachean por sesión y una eliminación invalida todas las vistas', async () => {
  let customerReads = 0;
  let deletes = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    if (url.pathname.endsWith('/customers')) {
      if (method === 'DELETE') { deletes += 1; return new Response(null, { status: 204 }); }
      customerReads += 1;
      return Response.json([{ customer_id: 1, company_name: 'Cliente' }]);
    }
    if (url.pathname.endsWith('/entity_subsidiaries')) return Response.json([{ customer_id: 1, subsidiary_id: 7 }]);
    if (url.pathname.endsWith('/customer_currencies')) return Response.json([{ customer_id: 1, currency_id: 2 }]);
    if (url.pathname.endsWith('/entity_withholding_rules')) return Response.json([]);
    throw new Error(`Solicitud inesperada: ${method} ${url}`);
  };

  const catalog = getEntityCatalog('customers');
  await listEntityRows(catalog, firstAuthorization);
  await listEntityRows(catalog, firstAuthorization);
  await listEntityRows(catalog, secondAuthorization);
  assert.equal(customerReads, 2, 'Cada sesión debe conservar su propio contexto activo.');

  await deleteEntityRow(catalog, firstAuthorization, 1);
  await listEntityRows(catalog, firstAuthorization);
  await listEntityRows(catalog, secondAuthorization);
  assert.equal(deletes, 1);
  assert.equal(customerReads, 4, 'Un CRUD debe invalidar el catálogo para todas las sesiones del proceso.');
});

test('departamentos reutiliza la lectura por sesión e invalida al modificar el catálogo', async () => {
  let reads = 0;
  let deletes = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    if (!url.pathname.endsWith('/departments')) throw new Error(`Solicitud inesperada: ${method} ${url}`);
    if (method === 'DELETE') { deletes += 1; return new Response(null, { status: 204 }); }
    reads += 1;
    return Response.json([{
      department_id: 80,
      name: 'CONTABILIDAD',
      department_subsidiaries: [{ subsidiary_id: 7 }],
    }]);
  };

  const catalog = getOrganizationCatalog('departments');
  await listOrganizationRows(catalog, firstAuthorization);
  await listOrganizationRows(catalog, firstAuthorization);
  await listOrganizationRows(catalog, secondAuthorization);
  assert.equal(reads, 2);

  await deleteOrganizationRow(catalog, firstAuthorization, 80);
  await listOrganizationRows(catalog, firstAuthorization);
  await listOrganizationRows(catalog, secondAuthorization);
  assert.equal(deletes, 1);
  assert.equal(reads, 4);
});

test('los seis catálogos de la carga reutilizan lecturas únicamente dentro de la sesión', async () => {
  invalidateOperationalCatalogs();
  const reads = new Map();
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(init.method ?? 'GET', 'GET');
    const table = new URL(String(input)).pathname.split('/').pop();
    reads.set(table, (reads.get(table) ?? 0) + 1);
    return Response.json([{ id: 1 }]);
  };

  const operations = [
    () => sales.listSalesRows(sales.getSalesCatalog('invoices'), firstAuthorization),
    () => purchasing.listPurchasingRows(purchasing.getPurchasingCatalog('supplier-invoices'), firstAuthorization),
    () => banking.listBankingRows(banking.getBankingCatalog('bank-accounts'), firstAuthorization),
    () => banking.listBankingRows(banking.getBankingCatalog('bank-statements'), firstAuthorization),
    () => fixedAssets.listFixedAssetRows(fixedAssets.getFixedAssetCatalog('assets'), firstAuthorization),
    () => fixedAssets.listFixedAssetRows(fixedAssets.getFixedAssetCatalog('asset-categories'), firstAuthorization),
  ];
  for (const operation of operations) { await operation(); await operation(); }
  assert.deepEqual(Object.fromEntries(reads), {
    invoice: 1,
    supplier_invoice: 1,
    bank_account: 1,
    bank_statement: 1,
    asset: 1,
    asset_category: 1,
  });

  await sales.listSalesRows(sales.getSalesCatalog('invoices'), secondAuthorization);
  assert.equal(reads.get('invoice'), 2, 'Otra sesión no debe reutilizar datos de la empresa activa anterior.');
});

test('guardar facturas, activos y categorías invalida sus listados especializados', async () => {
  invalidateOperationalCatalogs();
  const reads = new Map();
  const saves = new Map();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const resource = url.pathname.split('/').pop();
    if (url.pathname.includes('/rpc/')) {
      saves.set(resource, (saves.get(resource) ?? 0) + 1);
      return Response.json({ id: 1 });
    }
    reads.set(resource, (reads.get(resource) ?? 0) + 1);
    return Response.json([{ id: 1 }]);
  };

  const cases = [
    { resource: 'invoice', rpc: 'save_sales_invoice', list: () => sales.listSalesRows(sales.getSalesCatalog('invoices'), firstAuthorization), save: () => saveSalesInvoice(firstAuthorization, {}) },
    { resource: 'supplier_invoice', rpc: 'save_supplier_invoice', list: () => purchasing.listPurchasingRows(purchasing.getPurchasingCatalog('supplier-invoices'), firstAuthorization), save: () => saveSupplierInvoice(firstAuthorization, {}) },
    { resource: 'asset', rpc: 'save_fixed_asset', list: () => fixedAssets.listFixedAssetRows(fixedAssets.getFixedAssetCatalog('assets'), firstAuthorization), save: () => saveFixedAsset(firstAuthorization, {}) },
    { resource: 'asset_category', rpc: 'save_asset_category', list: () => fixedAssets.listFixedAssetRows(fixedAssets.getFixedAssetCatalog('asset-categories'), firstAuthorization), save: () => saveAssetCategory(firstAuthorization, {}) },
  ];
  for (const item of cases) {
    await item.list();
    await item.list();
    assert.equal(reads.get(item.resource), 1);
    await item.save();
    await item.list();
    assert.equal(reads.get(item.resource), 2, `${item.resource} debe releerse después de guardar.`);
    assert.equal(saves.get(item.rpc), 1);
  }
});
