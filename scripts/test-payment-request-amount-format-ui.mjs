import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(5000);

const calls = [];
const header = {
  id: 92,
  numero: 'SOL_PAG-00000092',
  estado: 'BORRADOR',
  id_solicitante: 7,
  tipo_solicitud: 'OTROS',
  id_moneda: 1,
  fecha_solicitud: '2026-10-27',
  fecha_pago_programada: '2026-10-30',
  concepto: 'Pago de impuestos',
  total: 1695874.84,
  version: 1,
  id_proveedor: null,
  journal_id: null
};

await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  const action = url.pathname.split('/').at(-1);
  const payload = route.request().postDataJSON?.() || {};
  calls.push({ action, payload });
  let body = {};

  if (action === 'options') body = {
    company: 'S.T.T. HOLDINGS LIMITED',
    baseCurrencyId: 1,
    userId: 7,
    admin: true,
    canApprove: true,
    canExecute: true,
    currencies: [{ id: 1, name: 'JMD' }],
    users: [{ id: 7, name: 'Danny Valderrama' }],
    suppliers: [],
    customers: [],
    employees: [],
    taxAgencies: [{ id: 301, name: 'Tax Administration Jamaica / TAJ-001' }],
    departments: [{ id: 42, name: 'ADMINISTRATIVO', type: 'Interno' }],
    costCenters: [],
    banks: [],
    rates: [],
    accounts: [{ id: 70, name: '214001 / Impuesto por pagar' }]
  };
  else if (action === 'report') body = [];
  else if (action === 'save') body = { id: header.id };
  else if (action === 'detail') body = {
    header,
    lines: [{
      id: 502,
      id_cuenta_contable: 70,
      tipo_tercero: 'Agencia Tributaria',
      id_agencia_tributaria: 301,
      id_departamento: 42,
      id_centro_costo: null,
      departmentType: 'Interno',
      department: 'ADMINISTRATIVO',
      concepto: 'Impuesto principal',
      monto: 1695874.84,
      accountName: '214001 / Impuesto por pagar',
      party: 'Tax Administration Jamaica / TAJ-001',
      costCenter: null
    }],
    events: []
  };
  else if (action === 'supports') body = [];
  else if (url.pathname === '/api/audit/record-actor') body = { events: [] };

  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

const normalizedAmount = value => value.replace(/[.\s]/g, '');

try {
  await page.goto('http://localhost:3000/payment-requests.css', { waitUntil: 'domcontentloaded' });
  await page.setContent('<iframe id="app"></iframe>');
  const app = page.frames().find(frame => frame !== page.mainFrame());
  await app.goto('http://localhost:3000/payment-requests.html');

  await app.click('#new');
  await app.selectOption('#type', 'OTROS');
  const amount = app.locator('#directLines .amount');
  assert.equal(await amount.getAttribute('inputmode'), 'decimal');
  assert.equal(await amount.getAttribute('type'), 'text');

  await amount.fill('1.695.874,84');
  await app.locator('#directLines .concept').click();
  assert.equal(normalizedAmount(await amount.inputValue()), '1695874,84');
  assert.match(normalizedAmount(await app.locator('#total').textContent()), /1695874,84/);

  await amount.click();
  assert.equal(await amount.inputValue(), '1695874.84');
  await amount.fill('1695874,84');
  await app.locator('#directLines .concept').click();

  await app.selectOption('#directLines .account', '70');
  await app.selectOption('#directLines .entityType', 'Agencia Tributaria');
  await app.selectOption('#directLines .entity', '301');
  await app.selectOption('#directLines .departmentType', 'Interno');
  await app.selectOption('#directLines .department', '42');
  await app.fill('#planned', '2026-10-30');
  await app.fill('#concept', 'Pago de impuestos');
  await app.fill('#directLines .concept', 'Impuesto principal');
  await app.click('#save');
  await app.waitForFunction(() => document.querySelector('#message')?.textContent.includes('Borrador'));

  const save = calls.find(call => call.action === 'save');
  assert.ok(save, 'No se envió el borrador de la solicitud.');
  assert.equal(save.payload.lines[0].amount, '1695874.84');
  assert.equal(normalizedAmount(await app.locator('#directLines .amount').inputValue()), '1695874,84');

  console.log(JSON.stringify({
    passed: true,
    localizedAmount: true,
    numericPayloadPreserved: true,
    totalUsesFormattedAmount: true
  }));
} finally {
  await browser.close();
}
