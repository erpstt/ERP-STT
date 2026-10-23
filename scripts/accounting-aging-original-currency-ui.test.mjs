import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await browser.newPage({ viewport: { width: 1560, height: 1100 }, acceptDownloads: true });
  page.setDefaultTimeout(15_000);
  await page.addInitScript(() => {
    localStorage.setItem('nexo_token', 'aging-original-ui-test');
    localStorage.setItem('nexo_company', '24');
    window.__agingPrintCalled = false;
    window.print = () => { window.__agingPrintCalled = true; };
  });

  const payloads = [];
  let reconciliationAvailable = true;
  let reconciliationReason = null;
  await page.route('**/api/reports/accounting/options', route => route.fulfill({ json: {
    subsidiaries: [{ id: 24, name: 'S.T.T. HOLDINGS LIMITED', currencyId: 1 }],
    currencies: [
      { id: 1, code: 'JMD', name: 'Dólar jamaicano', symbol: 'J$' },
      { id: 2, code: 'USD', name: 'Dólar estadounidense', symbol: 'US$' },
    ],
    books: [], periods: [], departments: [], locations: [], classes: [], costCenters: [], accounts: [], thirdParties: [], accountGroups: [],
    journalOptions: { canReverse: true, modules: [] }, pendingInvoiceOptions: { customers: [] },
    agingOptions: { customers: [{ id: 5, name: 'Cliente Multimoneda', subsidiaryId: 24 }], suppliers: [], salesRepresentatives: [], supplierCategories: [] },
  } }));
  await page.route('**/api/reports/accounting/receivables-aging', route => {
    const payload = route.request().postDataJSON();
    payloads.push(payload);
    const original = payload.agingCurrencyMode === 'ORIGINAL';
    const common = { entity_id: 5, entity_code: 'CLI-000005', identification: 'ID-5', entity_name: 'Cliente Multimoneda', manager: 'Gestor Uno', issue_date: '2026-08-01', due_date: '2026-08-31', overdue_days: 30, bucket: '1_30', applications: [] };
    if (!original) return route.fulfill({ json: { rows: [{ ...common, document_id: 10, document_number: 'FAC-JMD', original_amount: 15_000, applied_amount: 0, pending: 15_000, entity_advances: 1_000, journal_id: 4 }], total: 1, summary: { subledger: 15_000, advances: 1_000, netBalance: 14_000, controlBalance: 14_000, difference: 0 } } });
    const rows = [
        { ...common, document_id: 10, document_number: 'FAC-JMD', original_amount: 15_000, applied_amount: 0, pending: 15_000, entity_advances: 1_000, journal_id: 4, currency_id: 1, currency_code: 'JMD', currency_name: 'Dólar jamaicano', currency_symbol: 'J$' },
        { ...common, document_id: 11, document_number: 'FAC-USD', original_amount: 100, applied_amount: 0, pending: 100, entity_advances: 5, journal_id: 5, currency_id: 2, currency_code: 'USD', currency_name: 'Dólar estadounidense', currency_symbol: 'US$' },
      ];
    if (Number(payload.pageSize) === 250) rows.push({ ...common, entity_id: 6, entity_code: 'CLI-000006', entity_name: 'Cliente exportado', document_id: 12, document_number: 'FAC-EXPORT', original_amount: 25, applied_amount: 0, pending: 25, entity_advances: 0, journal_id: 6, currency_id: 2, currency_code: 'USD', currency_name: 'Dólar estadounidense', currency_symbol: 'US$' });
    return route.fulfill({ json: {
      rows,
      total: 3,
      summary: {
        reconciliationAvailable,
        reconciliationReason,
        currencyBreakdown: [
          { currencyId: 1, currencyCode: 'JMD', currencyName: 'Dólar jamaicano', currencySymbol: 'J$', subledger: 15_000, advances: 1_000, netBalance: 14_000, controlBalance: reconciliationAvailable ? 13_999.5 : null, difference: reconciliationAvailable ? .5 : null },
          { currencyId: 2, currencyCode: 'USD', currencyName: 'Dólar estadounidense', currencySymbol: 'US$', subledger: 100, advances: 5, netBalance: 95, controlBalance: reconciliationAvailable ? 95 : null, difference: reconciliationAvailable ? 0 : null },
        ],
      },
    } });
  });

  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.evaluate(() => { localStorage.setItem('nexo_token', 'aging-original-ui-test'); localStorage.setItem('nexo_company', '24'); });
  await page.setContent('<iframe id="reports" src="http://localhost:3000/accounting-reports.html?reporte=receivables-aging" style="width:1520px;height:1060px"></iframe>');
  const app = page.frameLocator('#reports');
  await app.locator('#agingCurrencyMode').selectOption('ORIGINAL');
  await app.locator('.aging-currency-card').first().waitFor();

  assert.equal(payloads.at(-1).agingCurrencyMode, 'ORIGINAL');
  assert.equal(await app.locator('#tbody tr.aging-summary').count(), 3, 'La vista resumida debe agrupar todas las páginas y separar cada entidad y moneda.');
  assert.match(await app.locator('#tbody').innerText(), /Cliente exportado/, 'La vista resumida debe incluir entidades disponibles en páginas posteriores.');
  const summary = await app.locator('#summary').innerText();
  assert.match(summary, /JMD/);
  assert.match(summary, /USD/);
  assert.match(summary, /Diferencia J\$\s*0[,.]50/);
  assert.match(summary, /Coincide al centavo/);
  assert.doesNotMatch(summary, /15[ .]?100[,.]00/, 'No se deben sumar JMD y USD.');
  const table = await app.locator('#tbody').innerText();
  assert.match(table, /J\$\s*15\s*000[,.]00/);
  assert.match(table, /US\$\s*100[,.]00/);

  await app.locator('#agingView').selectOption('DETAIL');
  await app.locator('#tbody tr.aging-detail').first().waitFor();
  assert.match(await app.locator('#thead').innerText(), /Moneda/);
  assert.equal(await app.locator('#tbody .aging-currency-badge').count(), 2);

  const csvDownloadPromise = page.waitForEvent('download');
  await app.locator('#csv').click();
  const csvDownload = await csvDownloadPromise;
  const csvPath = await csvDownload.path();
  const csv = await fs.readFile(csvPath, 'utf8');
  assert.match(csv, /"Moneda"/);
  assert.match(csv, /"JMD"/);
  assert.match(csv, /"USD"/);
  assert.match(csv, /FAC-EXPORT/, 'CSV debe incluir todas las páginas del reporte.');

  const excelDownloadPromise = page.waitForEvent('download');
  await app.locator('#excel').click();
  const excelDownload = await excelDownloadPromise;
  const excelPath = await excelDownload.path();
  const excel = await fs.readFile(excelPath, 'utf8');
  assert.match(excel, /Resumen por moneda/);
  assert.match(excel, /Dólar jamaicano/);
  assert.match(excel, /Dólar estadounidense/);
  assert.match(excel, /FAC-EXPORT/, 'Excel debe incluir todas las páginas del reporte.');

  const reportFrame = page.frames().find(frame => frame !== page.mainFrame());
  await reportFrame.evaluate(() => { window.__agingPrintCalled = false; window.print = () => { window.__agingPrintCalled = true; window.__agingPrintedText = document.body.innerText; }; });
  await app.locator('#pdf').click();
  await reportFrame.waitForFunction(() => window.__agingPrintCalled === true);
  assert.equal(await reportFrame.evaluate(() => window.__agingPrintCalled), true);
  assert.match(await reportFrame.evaluate(() => window.__agingPrintedText), /FAC-EXPORT/, 'PDF debe incluir todas las páginas del reporte.');
  assert.match(await app.locator('#printCurrency').innerText(), /monedas originales por documento/i);
  assert.match(await app.locator('#printPeriod').innerText(), /Fecha de corte:/);

  reconciliationAvailable = false;
  await app.locator('#agingCurrencyMode').selectOption('LOCAL');
  await app.locator('#agingCurrencyMode').selectOption('ORIGINAL');
  await app.getByText('Conciliación no disponible con filtros analíticos').first().waitFor();
  assert.equal(await app.locator('.aging-currency-card.unavailable').count(), 2);

  reconciliationReason = 'CROSS_CURRENCY';
  await app.locator('#agingCurrencyMode').selectOption('LOCAL');
  await app.locator('#agingCurrencyMode').selectOption('ORIGINAL');
  await app.getByText(/aplicaciones entre monedas/i).first().waitFor();

  console.log(JSON.stringify({ originalCurrenciesSeparated: true, rowSymbols: true, summaryByCurrency: true, reconciliationByCurrency: true, unavailableReconciliationExplained: true, crossCurrencyExplained: true, completeCsv: true, completeExcel: true, completePdf: true, pdfOriginalLabel: true }));
} finally {
  await browser.close();
}
