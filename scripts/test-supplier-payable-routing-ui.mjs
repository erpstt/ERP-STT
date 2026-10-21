import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { supplierPayableRoute } from '../public/supplier-payable-routing.js';

const cases = [
  ['Factura estándar', false, '211001'],
  ['Factura estándar', true, '211002'],
  ['Factura Tarjeta', false, '211001'],
  ['Factura Tarjeta', true, '211002'],
  ['Factura Activos Fijos', false, '211001'],
  ['Factura Activos Fijos', true, '211002'],
  ['Factura Expense', false, '211003'],
  ['Factura Expense', true, '211003'],
  ['Factura Caja Chica', false, '211004'],
  ['Factura Caja Chica', true, '211004']
];

for (const [invoiceType, intercompany, expected] of cases) {
  assert.equal(
    supplierPayableRoute(invoiceType, intercompany).accountNumber,
    expected,
    `${invoiceType} (${intercompany ? 'intercompany' : 'externo'}) debe usar ${expected}.`
  );
}

const files = await Promise.all([
  readFile(new URL('../public/supplier-invoice-entry.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/supplier-invoice-entry.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/supplier-note-entry.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/supplier-note-entry.html', import.meta.url), 'utf8')
]);
const [invoiceJs, invoiceHtml, noteJs, noteHtml] = files;

assert.match(invoiceJs, /invoiceRecord\.payable_account_id/);
assert.match(invoiceJs, /invoiceRecord\.invoice_type/);
assert.match(invoiceJs, /supplierPayableRoute\(invoiceType,supplier\.is_intercompany\)/);
assert.match(invoiceHtml, /id="supplierPayableAccountInfo"/);
assert.match(invoiceHtml, /CUENTA POR PAGAR AUTOMÁTICA/);
assert.match(noteJs, /invoice\.payable_account_id/);
assert.match(noteJs, /supplierPayableRoute\(invoice\.invoice_type,supplier\?\.is_intercompany\)/);
assert.match(noteHtml, /id="supplierNotePayableAccountInfo"/);
assert.match(noteHtml, /CUENTA POR PAGAR DE LA FACTURA/);

console.log(JSON.stringify({
  routes: Object.fromEntries(cases.map(([type, intercompany, account]) => [
    `${type}:${intercompany ? 'intercompany' : 'normal'}`,
    account
  ])),
  invoicePreview: true,
  editSnapshot: true,
  noteSnapshot: true
}));
