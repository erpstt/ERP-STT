import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const context = await browser.newContext({
  viewport: { width: 1800, height: 1000 },
  storageState: {
    cookies: [],
    origins: [{ origin: 'http://localhost:3000', localStorage: [
      { name: 'nexo_token', value: 'purchase-report-test' },
      { name: 'nexo_device_token', value: 'purchase-device-test' },
      { name: 'nexo_company', value: '1' }
    ] }]
  }
});
const page = await context.newPage();
page.setDefaultTimeout(12000);
const errors = [];
const requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => requests.push(new URL(request.url()).pathname));
const options = {
  subsidiaries: [{ id: 1, name: 'Empresa de pruebas', currencyId: 1 }],
  currencies: [{ id: 1, code: 'JMD', name: 'Dólar jamaiquino' }],
  books: [], periods: [], departments: [], reportDepartments: [], locations: [],
  classes: [], reportClasses: [], costCenters: [{ id: 4, name: 'Proyecto Regional', subsidiaryId: 1 }],
  reportCostCenters: [], accounts: [], thirdParties: [],
  agingOptions: { suppliers: [{ id: 8, name: 'Proveedor regional', subsidiaryId: 1, category: 'Servicios' }] },
  bankOptions: { accounts: [], currencies: [], reconciliations: [] },
  salesOptions: { customers: [], representatives: [] },
  journalOptions: { modules: [] }, pendingInvoiceOptions: { customers: [] }
};

const report = {
  rows: [{
    document_type: 'FAC_PRO', document_id: 91, document_number: 'FAC-PRO-91',
    referenced_document: null, transaction_id: 300, journal_id: 700,
    issue_date: '2026-09-20', supplier_tax_id: '801250385', supplier_name: 'Proveedor regional',
    supplier_category: 'Servicios', document_status: 'APROBADO', cost_centers: 'CC-VENTAS, CC-REGIONAL',
    supports: [
      { id: 11, type: 'Archivo', name: 'factura-proveedor.pdf', fileName: 'factura-proveedor.pdf', mimeType: 'application/pdf', fileSize: 24, url: null },
      { id: 12, type: 'Enlace', name: 'Orden de compra', fileName: null, mimeType: null, fileSize: null, url: 'https://example.com/orden-91' }
    ],
    support_count: 2, currency_code: 'JMD', discount: 0, subtotal: 1000,
    taxable_base: 1000, tax: 150, total: 1150
  }],
  total: 1,
  summary: { invoices: 1150, debitNotes: 0, creditNotes: 0, netPurchases: 1150 }
};

await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/reports/accounting/options') return route.fulfill({ json: options });
  if (path === '/api/reports/accounting/purchase-transactions' && route.request().method() === 'POST') return route.fulfill({ json: report });
  if (path === '/api/reports/accounting/purchase-transactions/supports/11') return route.fulfill({ json: {
    id: 11, type: 'Archivo', name: 'factura-proveedor.pdf', fileName: 'factura-proveedor.pdf',
    mimeType: 'application/pdf', fileSize: 24, fileData: 'data:application/pdf;base64,JVBERi0xLjQKJSVFT0YK'
  } });
  return route.fulfill({ json: [] });
});
await page.route('**/__purchase_report_test_host.html', route => route.fulfill({
  contentType: 'text/html',
  body: '<!doctype html><html><body><iframe id="app" style="width:1800px;height:1000px"></iframe></body></html>'
}));

try {
  await page.goto('http://localhost:3000/__purchase_report_test_host.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const app = page.frames().find(frame => frame !== page.mainFrame());
  await app.goto('http://localhost:3000/informes/contabilidad?reporte=purchase-transactions', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await app.waitForSelector('#tbody [data-purchase-id="91"]');

  const headers = await app.locator('#thead th').allTextContents();
  assert.equal(headers[3], 'Documento referenciado');
  assert.equal(headers[4], 'Centro de costo');
  assert.equal(headers[14], 'Asiento');
  assert.equal(headers[15], 'Documentos de respaldo');
  assert.equal(await app.locator('#tbody tr').first().locator('td').nth(4).textContent(), 'CC-VENTAS, CC-REGIONAL');
  assert.equal(await app.locator('[data-purchase-support="11"]').textContent(), 'factura-proveedor.pdf');
  assert.equal(await app.locator('.purchase-support-link.external').getAttribute('href'), 'https://example.com/orden-91');

  const csvDownload = page.waitForEvent('download');
  await app.click('#csv');
  const csv = await readFile(await (await csvDownload).path(), 'utf8');
  assert.match(csv, /Centro de costo/);
  assert.match(csv, /CC-VENTAS, CC-REGIONAL/);
  assert.match(csv, /factura-proveedor\.pdf/);
  assert.match(csv, /https:\/\/example\.com\/orden-91/);

  await app.evaluate(() => { window.open = () => ({ location: { replace() {} }, close() {} }); });
  const supportResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reports/accounting/purchase-transactions/supports/11');
  await app.click('[data-purchase-support="11"]');
  await supportResponse;
  assert.equal(errors.length, 0, errors.join('\n'));

  console.log(JSON.stringify({
    passed: true,
    columnOrder: true,
    costCenters: true,
    supportLinks: true,
    lazyFileRequest: requests.includes('/api/reports/accounting/purchase-transactions/supports/11'),
    csv: true
  }));
} catch (error) {
  console.error(JSON.stringify({ errors, requests, url: page.url(), message: await page.locator('#message').textContent().catch(() => ''), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 1200) }));
  throw error;
} finally {
  await browser.close();
}
