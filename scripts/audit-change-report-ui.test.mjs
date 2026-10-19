import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
const reportRequests = [];

await context.addInitScript(() => {
  localStorage.setItem('nexo_token', 'audit-report-test');
  localStorage.setItem('nexo_device_token', 'audit-report-device');
});

await context.route('**/api/v1/reports/audit/changes/options', route => route.fulfill({ json: {
  defaultMonth: '2026-10', timeZone: 'America/Costa_Rica',
  subsidiaries: [{ id: 'sub-1', name: 'Empresa de Pruebas' }],
  users: [{ id: 7, name: 'Ana Pérez', email: 'ana@example.test' }],
  modules: [{ id: 'sales', label: 'Ventas y cuentas por cobrar' }],
  transactionTypes: [{ id: 'sales_invoice', label: 'Facturas de venta' }, { id: 'vendor_bill', label: 'Facturas de proveedor' }],
  months: [{ id: '2026-10', label: 'octubre de 2026' }]
} }));

await context.route('**/api/v1/reports/audit/changes', async route => {
  reportRequests.push(JSON.parse(route.request().postData() || '{}'));
  await route.fulfill({ json: {
    header: { month: '2026-10', periodLabel: 'octubre de 2026', scopeLabel: 'Auditoría autorizada' },
    summary: { totalEvents: 2, operationCount: 2, modifiedCount: 1, deletedCount: 1, fieldChanges: 2, userCount: 1, mostActiveUser: 'Ana Pérez', byTransactionType: [{ transactionType: 'sales_invoice', transactionTypeLabel: 'Facturas de venta', total: 1, modified: 1, deleted: 0 }, { transactionType: 'vendor_bill', transactionTypeLabel: 'Facturas de proveedor', total: 1, modified: 0, deleted: 1 }] },
    total: 2,
    rows: [
      { auditId: 101, timestamp: '2026-10-18T16:20:00Z', action: 'MODIFICACION', transactionType: 'sales_invoice', transactionTypeLabel: 'Facturas de venta', documentNumber: 'FAC-000044', subsidiaryName: 'Empresa de Pruebas', documentCreator: { name: 'Carlos Gómez', email: 'carlos@example.test' }, module: 'sales', moduleLabel: 'Ventas y cuentas por cobrar', entityType: 'invoice', entityLabel: 'Factura de venta', entityKey: 'invoice_id=44', recordLabel: 'FAC-000044', actor: { name: 'Ana Pérez', email: 'ana@example.test', type: 'HUMAN', source: 'NEXO ERP' }, ipAddress: '127.0.0.1', fieldsChangedCount: 2, changes: [{ field: 'status', fieldLabel: 'Estado', oldValue: 'BORRADOR', newValue: 'APROBADO' }, { field: 'note', fieldLabel: 'Nota', oldValue: '', newValue: '<img src=x onerror=alert(1)>' }] },
      { auditId: 102, timestamp: '2026-10-18T16:20:01Z', action: 'ELIMINACION', transactionType: 'vendor_bill', transactionTypeLabel: 'Facturas de proveedor', documentNumber: 'FAC-PRO-000008', subsidiaryNames: ['Empresa de Pruebas', 'Empresa Dos'], module: 'purchases', moduleLabel: 'Compras y cuentas por pagar', entityType: 'vendor_bill', entityLabel: 'Factura de proveedor', entityKey: 'bill_id=8', recordLabel: 'FAC-PRO-000008', actor: { name: 'Ana Pérez', email: 'ana@example.test', type: 'HUMAN', source: 'NEXO ERP' }, ipAddress: '127.0.0.1', fieldsChangedCount: 0, changes: [], deletedSnapshot: { description: 'Servicio eliminado', amount: '125.00' } }
    ]
  } });
});

for (const format of ['pdf', 'excel']) await context.route(`**/api/v1/reports/audit/changes/${format}`, route => route.fulfill({
  status: 200,
  headers: { 'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="auditoria-cambios-2026-10.${format === 'pdf' ? 'pdf' : 'xlsx'}"` },
  body: format === 'pdf' ? '%PDF-1.4 test' : 'xlsx-test'
}));

const page = await context.newPage();
try {
  await page.goto('http://localhost:3000/');
  await page.setContent('<iframe id="report" src="http://localhost:3000/audit-change-report.html" style="width:1500px;height:960px"></iframe>');
  const frame = page.frameLocator('#report');
  await frame.getByRole('heading', { name: 'Transacciones modificadas y eliminadas' }).waitFor();
  await frame.locator('.record-title', { hasText: 'FAC-000044' }).waitFor();
  assert.equal(await frame.locator('#month').inputValue(), '2026-10');
  assert.equal(await frame.locator('#subsidiary').inputValue(), 'sub-1');
  assert.equal(await frame.locator('#subsidiary').isDisabled(), true, 'Una única subsidiaria autorizada debe quedar seleccionada.');
  assert.ok(await frame.getByText('2 cambios registrados', { exact: true }).count());
  assert.ok(await frame.getByText('Modificado', { exact: true }).count());
  assert.ok(await frame.getByText('Eliminado', { exact: true }).count());
  assert.equal(await frame.locator('.transaction-group').count(), 2, 'Los documentos deben agruparse por tipo de transacción.');
  assert.ok(await frame.locator('.transaction-group-heading').filter({ hasText: 'Facturas de venta' }).count());
  assert.ok(await frame.locator('.transaction-group-heading').filter({ hasText: 'Facturas de proveedor' }).count());
  assert.equal(await frame.locator('.company-label', { hasText: 'Empresa de Pruebas' }).count(), 2);
  assert.ok(await frame.getByText('Empresa de Pruebas · Empresa Dos', { exact: true }).count());
  assert.ok(await frame.getByText('Registrado por: Carlos Gómez', { exact: true }).count());
  assert.ok(await frame.getByText('Modificado por', { exact: true }).count());
  assert.equal(await frame.getByText('Origen / IP', { exact: true }).count(), 0, 'La vista no debe mostrar lenguaje técnico al usuario.');

  await frame.locator('[data-expand="101"]').click();
  await frame.getByText('BORRADOR', { exact: true }).waitFor();
  await frame.getByText('APROBADO', { exact: true }).waitFor();
  assert.equal(await frame.locator('img').count(), 0, 'Los valores auditados deben escaparse como texto.');
  assert.ok(await frame.getByText('<img src=x onerror=alert(1)>', { exact: true }).count());
  await frame.locator('[data-expand="102"]').click();
  await frame.getByText('Servicio eliminado', { exact: true }).waitFor();

  await frame.locator('#action').selectOption('DELETE');
  await frame.locator('#generate').click();
  await frame.locator('.record-title', { hasText: 'FAC-000044' }).waitFor();
  assert.equal(reportRequests.at(-1).action, 'DELETE');
  assert.equal(reportRequests.at(-1).subsidiaryId, 'sub-1');
  await frame.locator('body').screenshot({ path: '.tmp/audit-change-report-ui.png', animations: 'disabled' });

  for (const [button, extension] of [['downloadPdf', '.pdf'], ['downloadExcel', '.xlsx']]) {
    const downloadPromise = page.waitForEvent('download');
    await frame.locator(`#${button}`).click();
    const download = await downloadPromise;
    assert.ok(download.suggestedFilename().endsWith(extension));
  }
  console.log(JSON.stringify({ passed: true, filters: true, indicators: true, beforeAfter: true, deletionSnapshot: true, xssEscaped: true, exports: true, requests: reportRequests.length }));
} finally {
  await browser.close();
}
