import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const invoice = {
  invoice_id: 77,
  invoice_number: 'FAC-VEN-77',
  subsidiary_id: 1,
  customer_id: 1,
  payment_term_id: 1,
  invoice_date: '2026-09-15',
  due_date: '2026-09-30',
  fiscal_period_id: 1,
  currency_id: 1,
  exchange_rate: 1,
  memo: 'Servicio regional',
  transaction_id: 500,
  journal_id: 600,
  location_id: 1,
  total_amount: 100,
  receivable_amount: 100
};

const invoiceLine = {
  line_id: 88,
  invoice_id: 77,
  product_id: 10,
  quantity: 1,
  unit_price: 100,
  amount: 100,
  tax_rate: 0,
  tax_amount: 0,
  gross_amount: 100,
  service_country_id: 2,
  service_month: '2026-08',
  note: 'Servicio de agosto'
};

const creditNote = {
  cn_id: 51,
  cn_number: 'NC-VEN-51',
  invoice_id: 77,
  customer_id: 1,
  note_date: '2026-09-20',
  fiscal_period_id: 1,
  currency_id: 1,
  exchange_rate: 1,
  memo: 'Crédito de servicio',
  journal_id: 651,
  amount: 25
};

const debitNote = {
  dn_id: 61,
  dn_number: 'ND-VEN-61',
  invoice_id: 77,
  customer_id: 1,
  note_date: '2026-09-21',
  fiscal_period_id: 1,
  currency_id: 1,
  exchange_rate: 1,
  memo: 'Débito de servicio',
  journal_id: 661,
  amount: 30
};

const noteLines = [
  {
    line_id: 151,
    note_kind: 'CREDIT',
    note_id: 51,
    product_id: 10,
    quantity: 1,
    unit_price: 25,
    amount: 25,
    tax_rate: 0,
    tax_amount: 0,
    gross_amount: 25,
    service_country_id: 1,
    service_month: '2026-07',
    note: 'Ajuste de julio'
  },
  {
    line_id: 161,
    note_kind: 'DEBIT',
    note_id: 61,
    product_id: 10,
    quantity: 1,
    unit_price: 30,
    amount: 30,
    tax_rate: 0,
    tax_amount: 0,
    gross_amount: 30,
    service_country_id: 3,
    service_month: '2026-06',
    note: 'Ajuste de junio'
  }
];

const responses = {
  '/api/sales/invoices': [invoice],
  '/api/sales/sales-invoice-lines': [invoiceLine],
  '/api/sales/sales-invoice-withholdings': [],
  '/api/sales/credit-notes': [creditNote],
  '/api/sales/debit-notes': [debitNote],
  '/api/sales/sales-note-lines': noteLines,
  '/api/entities/customers': [{
    customer_id: 1,
    company_name: 'Cliente regional',
    tax_id: '3-101-123456',
    subsidiary_ids: [1],
    payment_term_id: 1
  }],
  '/api/inventory/products': [{
    product_id: 10,
    item_code: 'SERV-REG',
    display_name: 'Servicio regional',
    is_active: true,
    product_usage: 'Venta',
    sales_price: 100,
    sales_account_id: 4100,
    subsidiary_ids: [1]
  }],
  '/api/configuration/tax-codes': [],
  '/api/configuration/tax-types': [],
  '/api/configuration/payment-terms': [{ term_id: 1, term_name: 'Contado' }],
  '/api/configuration/uom': [],
  '/api/organization/accounting-periods': [{
    fiscal_period_id: 1,
    period_name: 'Septiembre 2026',
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    subsidiary_id: 1,
    is_closed: false,
    ar_closed: false
  }],
  '/api/core/currencies': [{
    currency_id: 1,
    currency_code: 'USD',
    symbol: 'US$',
    name: 'Dólar estadounidense'
  }],
  '/api/core/countries': [
    { country_id: 1, name: 'Costa Rica' },
    { country_id: 2, name: 'Panamá' },
    { country_id: 3, name: 'Colombia' }
  ],
  '/api/organization/subsidiaries': [{
    subsidiary_id: 1,
    name: 'Empresa de pruebas',
    country_id: 1,
    currency_id: 1
  }],
  '/api/organization/locations': [{ location_id: 1, name: 'Principal', subsidiary_id: 1 }],
  '/api/organization/departments': [],
  '/api/organization/cost-centers': [],
  '/api/organization/classes': [],
  '/api/accounting/chart-accounts': [{
    account_id: 4100,
    account_number: '4100',
    account_name: 'Ingresos por servicios',
    category: 'Ingreso',
    subsidiary_ids: [1]
  }],
  '/api/accounting/gl-impacts': [],
  '/api/accounting/journal-supports': []
};

async function open(path) {
  const owner = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const requests = [];
  owner.on('pageerror', error => errors.push(error.message));
  await owner.addInitScript(() => {
    localStorage.setItem('nexo_token', 'test-session');
    localStorage.setItem('nexo_device_token', 'test-device');
    localStorage.setItem('nexo_company', '1');
  });
  await owner.route('**/api/**', async route => {
    const request = route.request();
    const requestPath = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    requests.push({ path: requestPath, method, body });
    if (requestPath === '/api/reports/accounting/receivables-aging') {
      return route.fulfill({ json: { rows: [{ document_id: 77, pending: 100 }] } });
    }
    if (requestPath === '/api/sales/invoice-entry' && method === 'POST') {
      return route.fulfill({ json: { invoiceId: 91, journalId: 691, transactionNumber: 'FAC-VEN-91', total: 100 } });
    }
    if (requestPath === '/api/sales/invoice-entry/77' && method === 'PUT') {
      return route.fulfill({ json: { invoiceId: 77, journalId: 600, transactionNumber: 'FAC-VEN-77', total: 100 } });
    }
    const noteEntry = /^\/api\/sales\/note-entry\/(CREDIT|DEBIT)(?:\/(\d+))?$/.exec(requestPath);
    if (noteEntry && ['POST', 'PUT'].includes(method)) {
      const isCredit = noteEntry[1] === 'CREDIT';
      return route.fulfill({ json: {
        noteId: isCredit ? 51 : 61,
        journalId: isCredit ? 651 : 661,
        transactionNumber: isCredit ? 'NC-VEN-51' : 'ND-VEN-61',
        total: isCredit ? 25 : 30
      } });
    }
    return route.fulfill({ json: responses[requestPath] ?? [] });
  });
  await owner.goto('http://localhost:3000/');
  await owner.setContent('<iframe id="app"></iframe>');
  const frame = owner.frames().find(item => item !== owner.mainFrame());
  await frame.goto(`http://localhost:3000${path}`);
  return { owner, frame, errors, requests };
}

function savedRequest(page, path, method) {
  return page.requests.find(request => request.path === path && request.method === method);
}

async function testInvoice() {
  const created = await open('/sales-invoice-entry.html');
  await created.frame.locator('[data-k="service_month"]').first().waitFor();
  await created.frame.locator('#date').fill('2026-09-15');
  await created.frame.locator('#date').dispatchEvent('change');
  await created.frame.locator('#customer').selectOption('1');
  await created.frame.locator('[data-k="product_id"]').selectOption('10');
  await created.frame.locator('[data-k="service_month"]').fill('2026-10');
  await created.frame.locator('#save').click();
  await created.frame.locator('#successModal').waitFor({ state: 'visible' });
  assert.equal(savedRequest(created, '/api/sales/invoice-entry', 'POST')?.body.lines[0].service_month, '2026-10');
  assert.deepEqual(created.errors, []);
  await created.owner.close();

  const edited = await open('/sales-invoice-entry.html?id=77');
  const month = edited.frame.locator('[data-k="service_month"]').first();
  await month.waitFor();
  assert.equal(await month.inputValue(), '2026-08', 'La factura debe cargar el mes guardado al editar.');
  await month.fill('2026-11');
  await edited.frame.locator('#save').click();
  await edited.frame.locator('#successModal').waitFor({ state: 'visible' });
  assert.equal(savedRequest(edited, '/api/sales/invoice-entry/77', 'PUT')?.body.lines[0].service_month, '2026-11');
  assert.deepEqual(edited.errors, []);
  await edited.owner.close();
}

async function testInvoiceView() {
  const viewed = await open('/sales-invoice-view.html?id=77');
  await viewed.frame.locator('#invoice:not([hidden])').waitFor();
  assert.match(await viewed.frame.locator('.lines-section thead').textContent(), /Mes de servicio/i);
  assert.match(await viewed.frame.locator('#lines').textContent(), /2026-08|agosto\s+(?:de\s+)?2026/i);
  assert.deepEqual(viewed.errors, []);
  await viewed.owner.close();
}

async function selectSourceInvoice(page) {
  await page.frame.locator('#customer').selectOption('1');
  await page.frame.locator('#invoice:not([disabled])').waitFor();
  await page.frame.locator('#invoice').selectOption('77');
  await page.frame.locator('[data-k="service_month"]').first().waitFor();
  await page.frame.locator('#date').fill('2026-09-20');
  await page.frame.locator('#date').dispatchEvent('change');
}

async function assertCountryCatalog(select) {
  const labels = (await select.locator('option').allTextContents()).join(' | ');
  assert.match(labels, /Costa Rica/i, 'El selector debe cargar Costa Rica desde el catálogo CORE.');
  assert.match(labels, /Panamá/i, 'El selector debe cargar Panamá desde el catálogo CORE.');
  assert.match(labels, /Colombia/i, 'El selector debe cargar Colombia desde el catálogo CORE.');
}

async function testNote(kind, id, storedMonth, postedMonth, editedMonth, storedCountry, postedCountry, editedCountry) {
  const created = await open(`/sales-note-entry.html?kind=${kind}`);
  await selectSourceInvoice(created);
  const createMonth = created.frame.locator('[data-k="service_month"]').first();
  const createCountry = created.frame.locator('[data-k="service_country_id"]').first();
  assert.equal(await createMonth.inputValue(), '2026-08', 'La nota nueva debe heredar el mes de la factura.');
  await createCountry.waitFor();
  await assertCountryCatalog(createCountry);
  assert.equal(await createCountry.inputValue(), '2', 'La nota nueva debe heredar el país de servicio de la factura.');
  await createMonth.fill(postedMonth);
  await createCountry.selectOption(String(postedCountry));
  await created.frame.locator('#save').click();
  await created.frame.locator('#successModal').waitFor({ state: 'visible' });
  const postLine = savedRequest(created, `/api/sales/note-entry/${kind}`, 'POST')?.body.lines[0];
  assert.equal(postLine?.service_month, postedMonth);
  assert.equal(String(postLine?.service_country_id), String(postedCountry), `${kind} debe enviar el país en el POST.`);
  assert.deepEqual(created.errors, []);
  await created.owner.close();

  const edited = await open(`/sales-note-entry.html?kind=${kind}&id=${id}`);
  const month = edited.frame.locator('[data-k="service_month"]').first();
  const country = edited.frame.locator('[data-k="service_country_id"]').first();
  await month.waitFor();
  await country.waitFor();
  await assertCountryCatalog(country);
  assert.equal(await month.inputValue(), storedMonth, `${kind} debe cargar el mes guardado al editar.`);
  assert.equal(await country.inputValue(), String(storedCountry), `${kind} debe cargar el país guardado al editar.`);
  await month.fill(editedMonth);
  await country.selectOption(String(editedCountry));
  await edited.frame.locator('#save').click();
  await edited.frame.locator('#successModal').waitFor({ state: 'visible' });
  const putLine = savedRequest(edited, `/api/sales/note-entry/${kind}/${id}`, 'PUT')?.body.lines[0];
  assert.equal(putLine?.service_month, editedMonth);
  assert.equal(String(putLine?.service_country_id), String(editedCountry), `${kind} debe enviar el país en el PUT.`);
  assert.deepEqual(edited.errors, []);
  await edited.owner.close();
}

async function testNoteView(kind, id, storedMonth, countryName) {
  const viewed = await open(`/sales-note-view.html?kind=${kind}&id=${id}`);
  await viewed.frame.locator('#invoice:not([hidden])').waitFor();
  const headings = await viewed.frame.locator('.lines-section thead').textContent();
  assert.match(headings, /País de servicio/i);
  assert.match(headings, /Mes de servicio/i);
  const monthName = storedMonth === '2026-07' ? 'julio' : 'junio';
  const lineText = await viewed.frame.locator('#lines').textContent();
  assert.match(lineText, new RegExp(countryName, 'i'), `${kind} debe mostrar el país de servicio guardado.`);
  assert.match(lineText, new RegExp(`${storedMonth}|${monthName}\\s+(?:de\\s+)?2026`, 'i'));
  assert.deepEqual(viewed.errors, []);
  await viewed.owner.close();
}

try {
  await testInvoice();
  await testNote('CREDIT', 51, '2026-07', '2026-09', '2026-12', 1, 3, 2);
  await testNote('DEBIT', 61, '2026-06', '2026-09', '2027-01', 3, 1, 2);
  const viewResults = await Promise.allSettled([
    testInvoiceView(),
    testNoteView('CREDIT', 51, '2026-07', 'Costa Rica'),
    testNoteView('DEBIT', 61, '2026-06', 'Colombia')
  ]);
  const viewFailures = viewResults
    .map((result, index) => result.status === 'rejected'
      ? `${['Factura', 'Nota de crédito', 'Nota de débito'][index]}: ${result.reason.message}`
      : '')
    .filter(Boolean);
  assert.deepEqual(viewFailures, [], `Falló la visualización del mes de servicio:\n${viewFailures.join('\n')}`);
  console.log(JSON.stringify({
    passed: true,
    invoice: { post: true, editLoad: true, put: true, view: true },
    creditNote: { countryCatalog: true, inheritedCountry: true, post: true, editLoad: true, put: true, view: true },
    debitNote: { countryCatalog: true, inheritedCountry: true, post: true, editLoad: true, put: true, view: true }
  }));
} finally {
  await browser.close();
}
