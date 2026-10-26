import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.setDefaultTimeout(10000);
await page.addInitScript(() => {
  localStorage.setItem('nexo_token', 'income-filter-test');
  localStorage.setItem('nexo_device_token', 'income-filter-device');
});

const calls = [];
await page.route('**/api/reports/accounting/options', route => route.fulfill({ json: {
  subsidiaries: [{ id: 7, name: 'S.T.T. HOLDINGS LIMITED', currencyId: 1 }],
  currencies: [{ id: 1, code: 'JMD', name: 'Dólar jamaicano', symbol: 'J$' }],
  books: [{ id: 24, name: 'Fiscal local', subsidiaryId: 7, currencyId: 1 }],
  periods: [{ id: 10, name: 'octubre 2026', start: '2026-10-01', end: '2026-10-31', subsidiaryId: 7 }],
  departments: [{ id: 3, name: 'CONTABILIDAD', type: 'Interno', subsidiaryId: 7 }],
  reportDepartments: [{ id: 3, name: 'CONTABILIDAD', displayName: 'CONTABILIDAD', type: 'Interno', subsidiaryId: 7 }],
  locations: [], classes: [], costCenters: [], reportClasses: [], reportCostCenters: [], accounts: [], thirdParties: [],
  accountGroups: [
    { id: 41, code: '41', name: 'Ingresos', level: 2, category: 'Ingreso' },
    { id: 61, code: '61', name: 'Gastos', level: 2, category: 'Gasto' }
  ],
  journalOptions: { canReverse: false, modules: [] },
  pendingInvoiceOptions: { customers: [] },
  agingOptions: { customers: [], suppliers: [], salesRepresentatives: [], supplierCategories: [] },
  bankOptions: { accounts: [], reconciliations: [] }
}}));

await page.route('**/api/reports/accounting/general-ledger', route => route.fulfill({ json: {
  rows: [{
    id: 1,
    account_id: 99,
    account_number: '610001',
    account_name: 'Gastos administrativos',
    nature: 'Deudora',
    date: '2026-10-15',
    debit: 100,
    credit: 0,
    running_balance: 100
  }],
  summary: { debit: 100, credit: 0 },
  total: 1,
  page: 1,
  pageSize: 50
}}));

await page.route('**/api/reports/accounting/income-statement', async route => {
  const payload = route.request().postDataJSON();
  calls.push(payload);
  if (payload.columnView === 'DEPARTMENT') {
    return route.fulfill({ json: {
      columns: [{ id: '3', name: 'CONTABILIDAD' }],
      rows: [
        { account_id: 1, account_number: '410001', account_name: 'Ingresos operativos', group_id: 41, category: 'Ingreso', amount: 1000, debit: 0, credit: 1000, dimensions: { 3: 1000 } },
        { account_id: 99, account_number: '610001', account_name: 'Gastos administrativos', group_id: 61, category: 'Gasto', amount: 100, debit: 100, credit: 0, dimensions: { 3: 100 } }
      ],
      summary: { periodResult: 900, columnView: 'DEPARTMENT' },
      total: 2, page: 1, pageSize: 500
    }});
  }
  const staleAccount = payload.accountId !== null && payload.accountId !== undefined;
  return route.fulfill({ json: {
    rows: staleAccount
      ? [{ account_id: 99, account_number: '610001', account_name: 'Gastos administrativos', group_id: 61, category: 'Gasto', debit: 100, credit: 0 }]
      : [
          { account_id: 1, account_number: '410001', account_name: 'Ingresos operativos', group_id: 41, category: 'Ingreso', debit: 0, credit: 1000 },
          { account_id: 99, account_number: '610001', account_name: 'Gastos administrativos', group_id: 61, category: 'Gasto', debit: 100, credit: 0 }
        ],
    summary: { periodResult: 900 },
    total: staleAccount ? 1 : 2,
    page: 1,
    pageSize: 500
  }});
});

try {
  await page.goto('http://localhost:3000/');
  await page.setContent('<iframe id="reports" src="http://localhost:3000/accounting-reports.html?reporte=general-ledger&accountId=99" style="width:1500px;height:900px"></iframe>');
  const app = page.frameLocator('#reports');
  await app.locator('#reportTitle').filter({ hasText: 'Libro Mayor' }).waitFor();
  await app.locator('#catalog').click();
  await app.getByRole('button', { name: /Estado de Resultados Integral/ }).click();
  await app.locator('#reportTitle').filter({ hasText: 'Estado de Resultados Integral' }).waitFor();
  await app.locator('#summary .metric').first().waitFor();

  assert.equal(calls[0]?.columnView, 'TOTAL');
  assert.equal(
    calls[0]?.accountId,
    null,
    'El Estado de Resultados no debe heredar la cuenta usada para abrir el Libro Mayor.'
  );
  assert.match(await app.locator('#summary').innerText(), /Coincide al centavo/);
  assert.match(await app.locator('#summary').innerText(), /J\$\s*900,00/);

  await app.locator('#columnView').selectOption('DEPARTMENT');
  await app.locator('#summary').filter({ hasText: 'Coincide al centavo' }).waitFor();
  assert.equal(calls.at(-1)?.columnView, 'DEPARTMENT');
  assert.equal(calls.at(-1)?.accountId, null);
  assert.match(await app.locator('#summary').innerText(), /J\$\s*900,00/);

  console.log(JSON.stringify({ staleAccountCleared: true, total: 900, department: 900, reconciled: true }));
} finally {
  await browser.close();
}
