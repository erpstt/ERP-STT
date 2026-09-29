import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const countries = [
  { country_id: 1, country_code_iso2: 'CR', name: 'Costa Rica' },
  { country_id: 2, country_code_iso2: 'JM', name: 'Jamaica' },
  { country_id: 3, country_code_iso2: 'PA', name: 'Panamá' }
];

function responses(edit = false) {
  return {
    '/api/sales/invoices': edit ? [{
      invoice_id: 77,
      invoice_number: 'FAC-VEN-77',
      subsidiary_id: 1,
      customer_id: 1,
      payment_term_id: 1,
      invoice_date: '2026-09-15',
      fiscal_period_id: 1,
      currency_id: 1,
      exchange_rate: 1,
      memo: 'Servicio regional',
      transaction_id: 500,
      journal_id: 600
    }] : [],
    '/api/sales/sales-invoice-lines': edit ? [{
      line_id: 88,
      invoice_id: 77,
      product_id: 10,
      quantity: 1,
      unit_price: 100,
      amount: 100,
      tax_rate: 0,
      tax_amount: 0,
      gross_amount: 100,
      service_month: '2026-09',
      service_country_id: 1,
      note: 'Servicio en Costa Rica'
    }] : [],
    '/api/sales/sales-invoice-withholdings': [],
    '/api/entities/customers': [{
      customer_id: 1,
      company_name: 'Cliente regional',
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
    '/api/core/currencies': [{ currency_id: 1, currency_code: 'USD', name: 'Dólar estadounidense' }],
    '/api/core/countries': countries,
    '/api/organization/subsidiaries': [{
      subsidiary_id: 1,
      name: 'Empresa de pruebas',
      country_id: 2,
      currency_id: 1
    }],
    '/api/organization/locations': [{ location_id: 1, name: 'Principal', subsidiary_id: 1 }],
    '/api/organization/departments': [],
    '/api/organization/cost-centers': [],
    '/api/organization/classes': [],
    '/api/accounting/chart-accounts': [],
    '/api/accounting/gl-impacts': [],
    '/api/accounting/journal-supports': []
  };
}

async function preparePage(edit = false) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const requestedPaths = [];
  let savedPayload;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('nexo_token', 'test');
    localStorage.setItem('nexo_company', '1');
  });
  const mocked = responses(edit);
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requestedPaths.push(path);
    if (path === '/api/sales/invoice-entry' && request.method() === 'POST') {
      savedPayload = request.postDataJSON();
      return route.fulfill({ json: { invoiceId: 91, transactionNumber: 'FAC-VEN-91', total: 100 } });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mocked[path] ?? [])
    });
  });
  await page.goto('http://localhost:3000/');
  await page.setContent('<iframe id="app"></iframe>');
  const frame = page.frames().find(item => item !== page.mainFrame());
  await frame.goto(`http://localhost:3000/sales-invoice-entry.html${edit ? '?id=77' : ''}`);
  try {
    await frame.locator('[data-k="service_country_id"]').waitFor({ timeout: 5000 });
  } catch (error) {
    console.error(JSON.stringify({ edit, errors, requestedPaths }));
    throw error;
  }
  return { page: frame, ownerPage: page, errors, requestedPaths, getSavedPayload: () => savedPayload };
}

async function prepareView() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('nexo_token', 'test');
    localStorage.setItem('nexo_company', '1');
  });
  const mocked = responses(true);
  await page.route('**/api/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(mocked[new URL(route.request().url()).pathname] ?? [])
  }));
  await page.goto('http://localhost:3000/');
  await page.setContent('<iframe id="view"></iframe>');
  const frame = page.frames().find(item => item !== page.mainFrame());
  await frame.goto('http://localhost:3000/sales-invoice-view.html?id=77');
  await frame.locator('#invoice:not([hidden])').waitFor({ timeout: 5000 });
  return { page: frame, ownerPage: page, errors };
}

try {
  const create = await preparePage(false);
  const country = create.page.locator('[data-k="service_country_id"]').first();
  assert.ok(create.requestedPaths.includes('/api/core/countries'), 'La pantalla debe consultar el catálogo CORE de países.');
  assert.match(await create.page.locator('#salesLinesPanel thead').textContent(), /País de servicio/);
  assert.deepEqual(await country.locator('option').allTextContents(), [
    'Seleccione un país',
    'Costa Rica',
    'Jamaica',
    'Panamá'
  ]);
  assert.equal(await country.inputValue(), '2', 'Una línea nueva debe proponer el país de la subsidiaria activa.');

  await create.page.locator('#customer').selectOption('1');
  await create.page.locator('[data-k="product_id"]').selectOption('10');
  await country.selectOption('3');
  await create.page.locator('#save').click();
  await create.page.locator('#successModal').waitFor({ state: 'visible' });
  assert.equal(String(create.getSavedPayload()?.lines?.[0]?.service_country_id), '3');
  assert.deepEqual(create.errors, []);
  await create.ownerPage.close();

  const edit = await preparePage(true);
  assert.equal(
    await edit.page.locator('[data-k="service_country_id"]').first().inputValue(),
    '1',
    'Al editar debe recuperarse el país guardado en la línea.'
  );
  assert.deepEqual(edit.errors, []);
  await edit.ownerPage.close();

  const view = await prepareView();
  assert.match(await view.page.locator('.lines-section thead').textContent(), /País de servicio/);
  assert.match(await view.page.locator('#lines').textContent(), /Costa Rica/);
  assert.deepEqual(view.errors, []);
  await view.ownerPage.close();

  console.log(JSON.stringify({
    passed: true,
    coreCountryCatalog: true,
    allCountriesListed: true,
    subsidiaryCountryDefault: true,
    createPayload: true,
    editPersistence: true,
    invoiceView: true
  }));
} finally {
  await browser.close();
}
