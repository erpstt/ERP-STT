import assert from 'node:assert/strict';
import test from 'node:test';
import { getInventoryCatalog, listInventoryRows } from '../dist/modules/inventory-catalogs/inventory-catalogs.module.js';
import { getConfigurationCatalog, listConfigurationRows } from '../dist/modules/configuration-catalogs/configuration-catalogs.module.js';
import { customerPaymentReport } from '../dist/modules/sales-catalogs/customer-payment.service.js';
import { supplierPaymentReport } from '../dist/modules/purchasing-catalogs/supplier-payment.service.js';
import { reportSections } from '../dist/modules/reports/scheduled-report-renderer.js';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;
process.env.SUPABASE_URL = 'https://performance.test';
process.env.SUPABASE_ANON_KEY = 'test-key';

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = originalKey;
});

test('inventario pagina el catálogo completo y agrupa subsidiarias sin búsquedas cuadráticas', async () => {
  const products = Array.from({ length: 1205 }, (_, index) => ({ product_id: index + 1, display_name: `PRODUCTO ${index + 1}` }));
  const links = products.flatMap(row => [
    { product_id: row.product_id, subsidiary_id: row.product_id % 7 + 1 },
    { product_id: row.product_id, subsidiary_id: row.product_id % 11 + 20 }
  ]);
  const offsets = new Map();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 500);
    offsets.set(table, [...(offsets.get(table) ?? []), offset]);
    const source = table === 'products' ? products : table === 'product_subsidiaries' ? links : null;
    if (!source) throw new Error(`Solicitud inesperada: ${url}`);
    return Response.json(source.slice(offset, offset + limit));
  };

  const rows = await listInventoryRows(getInventoryCatalog('products'), 'Bearer test');
  assert.equal(rows.length, 1205);
  assert.deepEqual(offsets.get('products'), [0, 500, 1000]);
  assert.deepEqual(offsets.get('product_subsidiaries'), [0, 500, 1000, 1500, 2000]);
  assert.deepEqual(rows.at(-1).subsidiary_ids, [1205 % 7 + 1, 1205 % 11 + 20]);
});

test('configuración pagina agencias y conserva todas sus subsidiarias', async () => {
  const agencies = Array.from({ length: 1001 }, (_, index) => ({ tax_agency_id: index + 1, agency_name: `AGENCIA ${index + 1}` }));
  const links = agencies.map(row => ({ tax_agency_id: row.tax_agency_id, subsidiary_id: row.tax_agency_id % 13 + 1 }));
  const offsets = new Map();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 500);
    offsets.set(table, [...(offsets.get(table) ?? []), offset]);
    const source = table === 'tax_agencies' ? agencies : table === 'tax_agency_subsidiaries' ? links : null;
    if (!source) throw new Error(`Solicitud inesperada: ${url}`);
    return Response.json(source.slice(offset, offset + limit));
  };

  const rows = await listConfigurationRows(getConfigurationCatalog('tax-agencies'), 'Bearer test');
  assert.equal(rows.length, 1001);
  assert.deepEqual(offsets.get('tax_agencies'), [0, 500, 1000]);
  assert.deepEqual(offsets.get('tax_agency_subsidiaries'), [0, 500, 1000]);
  assert.deepEqual(rows.at(-1).subsidiary_ids, [1001 % 13 + 1]);
});

test('reportes de cobros y pagos unen anticipos por id sin alterar el contrato', async () => {
  globalThis.fetch = async input => {
    const rpc = new URL(String(input)).pathname.split('/').at(-1);
    if (rpc === 'customer_payment_report' || rpc === 'supplier_payment_report') return Response.json({ rows: [{ id: 2,amount:100 }, { id: 1,amount:200 }, { id: 99,amount:300 }] });
    if (rpc === 'customer_payment_advance_summary' || rpc === 'supplier_payment_advance_summary') return Response.json([{ paymentId: 1, advanceTotal: 25 }, { paymentId: 2, advanceTotal: 10 }, { paymentId: 1, advanceTotal: 999 }]);
    if (rpc === 'customer_payment_bank_fee_summary') return Response.json([{ paymentId: 2, amount: 2.5, expenseAccountNumber: '629001', expenseAccountName: 'Comisiones bancarias' }]);
    throw new Error(`RPC inesperado: ${rpc}`);
  };
  const [customer, supplier] = await Promise.all([
    customerPaymentReport('Bearer test', {}),
    supplierPaymentReport('Bearer test', {})
  ]);
  assert.deepEqual(customer.rows.map(row => row.advanceTotal), [10, 25, 0]);
  assert.deepEqual(customer.rows.map(row => row.bankFeeTotal), [2.5, 0, 0]);
  assert.deepEqual(customer.rows.map(row => row.cashNet), [87.5, 175, 300]);
  assert.deepEqual(supplier.rows.map(row => row.advanceTotal), [10, 25, 0]);
});

test('el render programado conserva cálculos financieros y oculta identificadores', () => {
  const base = { company: 'EMPRESA', currency: 'JMD', cutoff: '2026-09-30' };
  const balance = reportSections({ ...base, kind: 'balance-sheet', data: { summary: { resultExercise: 20 }, rows: [
    { account_name: 'Banco', category: 'Activo', closing: 100, account_id: 1 },
    { account_name: 'Proveedores', category: 'Pasivo', closing: -30, account_id: 2 },
    { account_name: 'Capital', category: 'Patrimonio', closing: -50, account_id: 3 }
  ] } });
  assert.deepEqual(balance[0].rows, [['Activo', 100], ['Pasivo', 30], ['Resultado del ejercicio', 20], ['Patrimonio (incluye resultado)', 70], ['Pasivo y patrimonio', 100], ['Diferencia', 0]]);
  const detail = balance.find(section => section.title === 'Detalle');
  assert.ok(detail);
  assert.equal(detail.columns.includes('account id'), false);

  const cash = reportSections({ ...base, kind: 'cash-flow', data: { summary: { periodResult: 5 }, rows: [
    { account_name: 'Caja', cash_flow_activity: 'EFECTIVO_EQUIVALENTE', category: 'Activo', opening: 50, closing: 80 },
    { account_name: 'Clientes', cash_flow_activity: 'OPERACION', category: 'Activo', opening: 30, closing: 20 },
    { account_name: 'Depreciación', cash_flow_activity: 'OPERACION', category: 'Gasto', debit: 7, credit: 0 },
    { account_name: 'Equipo', cash_flow_activity: 'INVERSION', category: 'Activo', opening: 100, closing: 130 },
    { account_name: 'Préstamo', cash_flow_activity: 'FINANCIACION', category: 'Pasivo', opening: -10, closing: -25 }
  ] } });
  assert.deepEqual(cash[0].rows.slice(0, 6), [['Actividades de operación', 22], ['Actividades de inversión', -30], ['Actividades de financiación', 15], ['Variación neta', 7], ['Efectivo inicial', 50], ['Efectivo final', 80]]);
});
