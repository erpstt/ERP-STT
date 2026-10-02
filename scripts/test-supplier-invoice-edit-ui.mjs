import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const fixture = {
  '/api/accounting/chart-accounts': [
    { account_id: 10, account_number: '610100', account_name: 'Servicios profesionales', category: 'Gasto', subsidiary_id: 1, accepts_entries: false, is_inactive: true },
    { account_id: 20, account_number: '210100', account_name: 'Cuentas por pagar a proveedores', category: 'Pasivo', subsidiary_id: 1, accepts_entries: true }
  ],
  '/api/accounting/account-groups': [],
  '/api/configuration/tax-codes': [
    { tax_code_id: 11, code_name: 'IVA', rate_percentage: 15, subsidiary_id: 1, is_withholding: false }
  ],
  '/api/configuration/tax-types': [],
  '/api/organization/departments': [
    { department_id: 2, name: 'Administración', type: 'Interno', subsidiary_id: 1 }
  ],
  '/api/organization/classes': [
    { class_id: 3, name: 'Operación', subsidiary_id: 1 }
  ],
  '/api/organization/cost-centers': [
    { cost_center_id: 4, name: 'Administración general', customer_id: 9, class_id: 3, subsidiary_id: 1 }
  ],
  '/api/organization/financial-creditors': [
    { financial_creditor_id: 5, name: 'Acreedor interno', subsidiary_id: 1 }
  ],
  '/api/organization/related-companies': [
    { related_company_id: 6, name: 'Empresa relacionada', country_id: 1, subsidiary_id: 1 }
  ],
  '/api/entities/customers': [
    { customer_id: 9, company_name: 'Proyecto administrativo', department_id: 2, subsidiary_id: 1 }
  ],
  '/api/entities/suppliers': [
    { supplier_id: 7, company_name: 'Proveedor de prueba', subsidiary_id: 1, payment_term_id: 8, withholding_rules: [] }
  ],
  '/api/configuration/payment-terms': [
    { term_id: 8, term_name: 'Neto 30', days_due: 30 }
  ],
  '/api/organization/accounting-periods': [
    { fiscal_period_id: 9, subsidiary_id: 1, period_name: 'septiembre 2026', start_date: '2026-09-01', end_date: '2026-09-30', is_inactive: false, is_closed: false, ap_closed: false }
  ],
  '/api/core/currencies': [
    { currency_id: 1, currency_code: 'JMD', name: 'Dólar jamaiquino' },
    { currency_id: 2, currency_code: 'USD', name: 'Dólar estadounidense' }
  ],
  '/api/configuration/exchange-rates': [],
  '/api/core/countries': [
    { country_id: 1, name: 'Jamaica' }
  ],
  '/api/organization/subsidiaries': [
    { subsidiary_id: 1, name: 'EMPRESA DE PRUEBAS', currency_id: 1, allowed_currency_ids: [] }
  ],
  '/api/organization/locations': [
    { location_id: 1, name: 'Jamaica', subsidiary_id: 1 },
    { location_id: 2, name: 'Kingston', subsidiary_id: 1 }
  ],
  '/api/purchasing/supplier-invoice-lines': [
    { invoice_line_id: 701, invoice_id: 77, account_id: 10, quantity: 2, unit_price: 500, amount: 1000, tax_code_id: 11, tax_rate: 13, tax_amount: 130, gross_amount: 1130, note: 'Honorarios de septiembre', department_id: 2, cost_center_id: 4, class_id: 3, financial_creditor_id: 5, related_company_id: 6, es_activo_fijo: false }
  ],
  '/api/purchasing/supplier-invoices': [
    { invoice_id: 77, invoice_number: 'FAC-PRO-EDIT-77', invoice_type: null, supplier_id: 7, payment_term_id: 8, invoice_date: '2026-09-15', due_date: '2026-10-15', fiscal_period_id: 9, currency_id: 2, exchange_rate: 155.25, memo: 'Factura existente para edición', journal_id: 700, subsidiary_id: 1, location_id: 2, total_amount: 1130 }
  ],
  '/api/accounting/journals': [],
  '/api/accounting/journal-supports': [
    { support_id: 33, journal_id: 700, support_type: 'Enlace', display_name: 'Orden de servicio', support_url: 'https://example.com/orden-77' }
  ]
};

async function preparePage({ handoff = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  let updateRequest = null;
  const supportRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ useHandoff }) => {
    localStorage.setItem('nexo_token', 'test-token');
    localStorage.setItem('nexo_company', '1');
    localStorage.setItem('nexo_device_token', 'test-device');
    if (useHandoff) {
      sessionStorage.setItem('nexo_edit_supplier_invoice', JSON.stringify({ id: '77', createdAt: Date.now() }));
    } else {
      sessionStorage.removeItem('nexo_edit_supplier_invoice');
    }
  }, { useHandoff: handoff });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/purchasing/supplier-invoice-entry/77' && request.method() === 'PUT') {
      updateRequest = { method: request.method(), payload: request.postDataJSON() };
      return route.fulfill({ json: { invoiceId: 77, journalId: 700, total: 1130 } });
    }
    if (path === '/api/accounting/journal-supports' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      supportRequests.push({ method: request.method(), path, payload });
      return route.fulfill({ status: 201, json: { support_id: 900 + supportRequests.length, ...payload } });
    }
    if (path.startsWith('/api/accounting/journal-supports/') && request.method() === 'DELETE') {
      supportRequests.push({ method: request.method(), path, payload: null });
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({ json: fixture[path] ?? [] });
  });
  await page.goto('http://localhost:3000/');
  return { page, errors, supportRequests, getUpdateRequest: () => updateRequest };
}

async function openEntry(page, src) {
  await page.setContent(`<iframe id="entry" src="${src}" style="width:100%;height:980px;border:0"></iframe>`);
  const frame = page.frameLocator('#entry');
  try {
    await frame.locator('h1', { hasText: 'Editar factura FAC-PRO-EDIT-77' }).waitFor();
  } catch (error) {
    console.error(JSON.stringify({ src, frameUrls: page.frames().map(item => item.url()), heading: await frame.locator('h1').textContent().catch(() => null), message: await frame.locator('#error').textContent().catch(() => null) }));
    throw error;
  }
  await frame.locator('#lines tr').waitFor();
  return frame;
}

try {
  const direct = await preparePage();
  const directFrame = await openEntry(direct.page, '/supplier-invoice-entry.html?id=77');
  assert.equal(await directFrame.locator('h1').textContent(), 'Editar factura FAC-PRO-EDIT-77');
  assert.equal(await directFrame.locator('#invoiceNumber').inputValue(), 'FAC-PRO-EDIT-77');
  assert.equal(await directFrame.locator('#supplier').inputValue(), '7');
  assert.equal(await directFrame.locator('#paymentTerm').inputValue(), '8');
  assert.equal(await directFrame.locator('#invoiceDate').inputValue(), '2026-09-15');
  assert.equal(await directFrame.locator('#period').inputValue(), '9');
  assert.equal(await directFrame.locator('#currency').inputValue(), '2');
  assert.equal(await directFrame.locator('#rate').inputValue(), '155.25');
  assert.equal(await directFrame.locator('#location').inputValue(), '2');
  assert.equal(await directFrame.locator('#memo').inputValue(), 'Factura existente para edición');
  assert.equal(await directFrame.locator('#lines tr').count(), 1);
  assert.equal(await directFrame.locator('[data-key=account_id]').inputValue(), '10');
  assert.equal(await directFrame.locator('[data-key=quantity]').inputValue(), '2,00');
  assert.equal(await directFrame.locator('[data-key=unit_price]').inputValue(), '500,00');
  assert.equal(await directFrame.locator('[data-key=tax_rate]').inputValue(), '13');
  assert.equal(await directFrame.locator('[data-key=tax_amount]').inputValue(), '130,00');
  assert.equal(await directFrame.locator('[data-key=department_id]').inputValue(), '2');
  assert.equal(await directFrame.locator('[data-key=cost_center_id]').inputValue(), '4');
  assert.equal(await directFrame.locator('[data-key=class_id]').inputValue(), '3');
  assert.equal(await directFrame.locator('#save').textContent(), 'Actualizar factura');
  await directFrame.locator('#supportsTab').click();
  assert.equal(await directFrame.locator('#supportList .support-item strong').textContent(), 'Orden de servicio');
  await directFrame.locator('#linesTab').click();
  await directFrame.locator('#memo').fill('Factura existente para edición ajustada');
  await directFrame.locator('#save').click();
  await directFrame.locator('#successModal').waitFor({ state: 'visible' });
  const update = direct.getUpdateRequest();
  assert.equal(update?.method, 'PUT');
  assert.equal(update?.payload.invoice_number, 'FAC-PRO-EDIT-77');
  assert.equal(update?.payload.lines.length, 1);
  assert.equal(update?.payload.lines[0].quantity, 2);
  assert.equal(update?.payload.lines[0].unit_price, 500);
  assert.deepEqual(direct.errors, []);
  await direct.page.close();

  const fallback = await preparePage({ handoff: true });
  const fallbackFrame = await openEntry(fallback.page, '/supplier-invoice-entry.html');
  assert.equal(await fallbackFrame.locator('h1').textContent(), 'Editar factura FAC-PRO-EDIT-77');
  assert.equal(await fallbackFrame.locator('#invoiceNumber').inputValue(), 'FAC-PRO-EDIT-77');
  assert.equal(await fallbackFrame.locator('#lines tr').count(), 1);
  const remainingHandoff = await fallbackFrame.locator('body').evaluate(() => sessionStorage.getItem('nexo_edit_supplier_invoice'));
  assert.equal(remainingHandoff, null);
  await fallbackFrame.locator('#supportsTab').click();
  await fallbackFrame.locator('#supportLinkName').fill('Respaldo de pago');
  await fallbackFrame.locator('#supportLinkUrl').fill('https://example.com/respaldo-pago');
  await fallbackFrame.locator('#addSupportLink').click();
  assert.equal(await fallbackFrame.locator('#saveSupports').isEnabled(), true);
  await fallbackFrame.locator('#saveSupports').click();
  await fallbackFrame.locator('#supportStatus', { hasText: 'Respaldos guardados correctamente' }).waitFor();
  assert.equal(fallback.getUpdateRequest(), null);
  assert.equal(fallback.supportRequests.length, 1);
  assert.equal(fallback.supportRequests[0].method, 'POST');
  assert.equal(fallback.supportRequests[0].payload.journal_id, 700);
  assert.equal(fallback.supportRequests[0].payload.display_name, 'Respaldo de pago');
  await fallbackFrame.locator('#supportLinkName').fill('Segundo respaldo');
  await fallbackFrame.locator('#supportLinkUrl').fill('https://example.com/segundo-respaldo');
  await fallbackFrame.locator('#addSupportLink').click();
  await fallbackFrame.locator('#save').click();
  await fallbackFrame.locator('#successModal').waitFor({ state: 'visible' });
  assert.equal(await fallbackFrame.locator('#successModal h2').textContent(), 'Respaldos actualizados');
  assert.equal(fallback.getUpdateRequest(), null);
  assert.equal(fallback.supportRequests.length, 2);
  assert.deepEqual(fallback.errors, []);
  await fallback.page.close();

  console.log(JSON.stringify({
    directIdLoadsHeader: true,
    directIdLoadsLineDimensions: true,
    directIdLoadsSupports: true,
    updateUsesPut: true,
    paidInvoiceSupportSaveSkipsPut: true,
    dedicatedSupportSave: true,
    mainSaveSupportsOnly: true,
    sessionHandoffFallback: true,
    handoffIsConsumed: true
  }));
} finally {
  await browser.close();
}
