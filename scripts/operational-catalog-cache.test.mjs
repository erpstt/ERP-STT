import assert from 'node:assert/strict';
import {catalogPageResponse} from './lib/catalog-page-fixture.mjs';
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
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

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
test.beforeEach(async()=>{for(const auth of[firstAuthorization,secondAuthorization])await primeRoleAccessCache(auth,{isAdmin:false,grants:['sales:invoices','purchasing:supplier-invoices','fixed-assets:assets','fixed-assets:asset-categories','banking:bank-statements','banking:bank-accounts'].map(resourceKey=>({resourceKey,canView:true,canCreate:true,canEdit:true,canDelete:true}))});});

function invalidateOperationalCatalogs() {
  sales.invalidateSalesCatalogCache('invoices');
  purchasing.invalidatePurchasingCatalogCache('supplier-invoices');
  banking.invalidateBankingCatalogCache('bank-accounts');
  banking.invalidateBankingCatalogCache('bank-statements');
  fixedAssets.invalidateFixedAssetCatalogCache('assets');
  fixedAssets.invalidateFixedAssetCatalogCache('asset-categories');
}

test.afterEach(() => {
  invalidateRoleAccessCaches();
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

test('clientes revalidan cada lectura y su eliminación conserva el RPC con revisión', async () => {
  for (const auth of [firstAuthorization, secondAuthorization]) await primeRoleAccessCache(auth, {
    isAdmin: false, grants: [{ resourceKey: 'entities:customers', canView: true, canCreate: false, canEdit: false, canDelete: true }],
  });
  let customerReads = 0;
  let deletes = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    if (url.pathname.endsWith('/rpc/entity_master_list')) {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { p_catalog: 'customers' });
      customerReads += 1;
      return Response.json([{ customer_id: 1, company_name: 'Cliente', subsidiary_ids: [7], currency_ids: [2], _revision: 'SYN' }]);
    }
    if (url.pathname.endsWith('/rpc/delete_entity_master')) {
      assert.deepEqual(JSON.parse(init.body), { p_catalog: 'customers', p_id: 1, p_revision: 'SYN' });
      deletes += 1;
      return Response.json(true);
    }
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
  assert.equal(customerReads, 3, 'El maestro protegido debe revalidar cada lectura con el JWT de la sesión.');

  await deleteEntityRow(catalog, firstAuthorization, 1, { _revision: 'SYN' });
  await listEntityRows(catalog, firstAuthorization);
  await listEntityRows(catalog, secondAuthorization);
  assert.equal(deletes, 1);
  assert.equal(customerReads, 5, 'Ambas sesiones vuelven a consultar después de la eliminación.');
});

test('departamentos revalida cada consulta y usa RPC para eliminar',async()=>{
 for(const auth of[firstAuthorization,secondAuthorization])await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'organization:departments',canView:true,canDelete:true}]});let reads=0,deletes=0;
 globalThis.fetch=async(input,init)=>{const path=new URL(String(input)).pathname;if(path.endsWith('/delete_organization_master')){deletes++;assert.equal(JSON.parse(init.body).p_revision,'SYN');return Response.json(true);}assert.ok(path.endsWith('/organization_master_list'));reads++;return Response.json([{department_id:80,name:'SYN',subsidiary_ids:[7],_revision:'SYN'}]);};
 const c=getOrganizationCatalog('departments');await listOrganizationRows(c,firstAuthorization);await listOrganizationRows(c,firstAuthorization);await listOrganizationRows(c,secondAuthorization);assert.equal(reads,3);await deleteOrganizationRow(c,firstAuthorization,80,{_revision:'SYN'});await listOrganizationRows(c,firstAuthorization);await listOrganizationRows(c,secondAuthorization);assert.equal(reads,5);assert.equal(deletes,1);
});

test('facturas de venta y saldos bancarios revalidan cada lectura; los demás catálogos reutilizan dentro de sesión', async () => {
  invalidateOperationalCatalogs();
  const reads = new Map();
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(init.method ?? 'GET', 'GET');
    const url=new URL(String(input)),table=url.pathname.split('/').pop(),key=url.searchParams.get('order').split('.')[0];
    reads.set(table, (reads.get(table) ?? 0) + 1);
    return catalogPageResponse([{[key]:1}]);
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
    invoice: 2,
    supplier_invoice: 1,
    bank_account: 2,
    bank_statement: 2,
    asset: 1,
    asset_category: 1,
  });

  await sales.listSalesRows(sales.getSalesCatalog('invoices'), secondAuthorization);
  assert.equal(reads.get('invoice'), 3, 'Otra sesión no debe reutilizar datos de la empresa activa anterior.');
});

test('el saldo bancario refleja movimientos de otros procesos sin invalidación local', async () => {
  let balance = 1000, reads = 0;
  globalThis.fetch = async input => {
    assert.equal(new URL(String(input)).pathname, '/rest/v1/bank_account');
    reads++;
    return catalogPageResponse([{ bank_account_id: 1, account_number: 'SYN-BANK', balance }]);
  };
  const catalog = banking.getBankingCatalog('bank-accounts');
  assert.equal((await banking.listBankingRows(catalog, firstAuthorization))[0].balance, 1000);
  balance = 1250.123456; // A customer deposit committed through another worker.
  assert.equal((await banking.listBankingRows(catalog, firstAuthorization))[0].balance, balance);
  balance = 1200.123456; // A Treasury payment committed through another module.
  for (const authorization of [firstAuthorization, secondAuthorization]) {
    assert.equal((await banking.listBankingRows(catalog, authorization))[0].balance, balance);
  }
  assert.equal(reads, 4);
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
    const key=url.searchParams.get('order').split('.')[0];return catalogPageResponse([{[key]:1}]);
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
    assert.equal(reads.get(item.resource), item.resource==='invoice'?2:1);
    await item.save();
    await item.list();
    assert.equal(reads.get(item.resource), item.resource==='invoice'?3:2, `${item.resource} debe releerse después de guardar.`);
    assert.equal(saves.get(item.rpc), 1);
  }
});
