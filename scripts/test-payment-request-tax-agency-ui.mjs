import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(5000);

const calls = [];
const inputValues = locator => locator.evaluateAll(elements => elements.map(element => element.value));
const header = {
  id: 91,
  numero: 'SOL_PAG-00000091',
  estado: 'BORRADOR',
  id_solicitante: 7,
  tipo_solicitud: 'OTROS',
  id_moneda: 1,
  fecha_solicitud: '2026-10-27',
  fecha_pago_programada: '2026-10-30',
  concepto: 'Pago de impuestos',
  total: 1250,
  version: 1,
  id_proveedor: null,
  journal_id: null
};

const detail = () => ({
  header,
  lines: [{
    id: 501,
    id_cuenta_contable: 70,
    tipo_tercero: 'Agencia Tributaria',
    id_cliente: null,
    id_proveedor: null,
    id_empleado: null,
    id_agencia_tributaria: 301,
    id_centro_costo: null,
    concepto: 'Pago de impuesto sobre la renta',
    monto: 1250,
    accountName: '213001 / Impuestos por pagar',
    party: 'Tax Administration Jamaica / TAJ-001',
    costCenter: null
  }],
  events: []
});

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
    suppliers: [{ id: 20, name: 'Proveedor que no debe mostrarse' }],
    customers: [{ id: 21, name: 'Cliente que no debe mostrarse' }],
    employees: [{ id: 22, name: 'Empleado que no debe mostrarse' }],
    taxAgencies: [{ id: 301, name: 'Tax Administration Jamaica / TAJ-001' }],
    departments: [{ id: 41, name: 'PROYECTOS', type: 'Cliente' }],
    costCenters: [{ id: 51, name: 'CC-001 / PROYECTO FISCAL', type: 'CLIENTE', departmentId: 41 }],
    banks: [],
    rates: [],
    accounts: [{ id: 70, name: '213001 / Impuestos por pagar' }]
  };
  else if (action === 'report') body = [];
  else if (action === 'save') body = { id: header.id };
  else if (action === 'detail') body = detail();
  else if (action === 'supports') body = [];
  else if (url.pathname === '/api/audit/record-actor') body = { events: [] };

  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body)
  });
});

try {
  await page.goto('http://localhost:3000/payment-requests.css', {
    waitUntil: 'domcontentloaded'
  });
  await page.setContent('<iframe id="app"></iframe>');
  const app = page.frames().find(frame => frame !== page.mainFrame());
  await app.goto('http://localhost:3000/payment-requests.html');

  await app.click('#new');
  await app.selectOption('#type', 'OTROS');
  const partyTypes = await app.locator('#directLines .entityType option').allTextContents();
  assert.ok(partyTypes.includes('Agencia Tributaria'));

  await app.selectOption('#directLines .account', '70');
  await app.selectOption('#directLines .entityType', 'Agencia Tributaria');
  const agencyOptions = await app.locator('#directLines .entity option').allTextContents();
  assert.deepEqual(agencyOptions, ['Seleccione', 'Tax Administration Jamaica / TAJ-001']);
  assert.ok(!agencyOptions.some(option => option.includes('Proveedor que no debe mostrarse')));

  await app.selectOption('#directLines .entity', '301');
  await app.click('#addLine');
  assert.deepEqual(await inputValues(app.locator('#directLines .entityType')), [
    'Agencia Tributaria',
    'Agencia Tributaria'
  ]);
  assert.deepEqual(await inputValues(app.locator('#directLines .entity')), ['301', '301']);

  await app.click('#addLine');
  assert.deepEqual(await inputValues(app.locator('#directLines .entityType')), [
    'Agencia Tributaria',
    'Agencia Tributaria',
    'Agencia Tributaria'
  ]);
  assert.deepEqual(await inputValues(app.locator('#directLines .entity')), ['301', '301', '301']);

  await app.locator('#directLines .entityType').nth(1).selectOption('Proveedor');
  assert.deepEqual(await inputValues(app.locator('#directLines .entityType')), ['Proveedor', 'Proveedor', 'Proveedor']);
  assert.deepEqual(await inputValues(app.locator('#directLines .entity')), ['', '', '']);

  await app.locator('#directLines .entityType').nth(2).selectOption('Agencia Tributaria');
  await app.locator('#directLines .entity').nth(1).selectOption('301');
  assert.deepEqual(await inputValues(app.locator('#directLines .entityType')), [
    'Agencia Tributaria',
    'Agencia Tributaria',
    'Agencia Tributaria'
  ]);
  assert.deepEqual(await inputValues(app.locator('#directLines .entity')), ['301', '301', '301']);

  await app.locator('#directLines [data-remove="1"]').click();
  await app.locator('#directLines [data-remove="1"]').click();
  await app.selectOption('#directLines .departmentType', 'Cliente');
  await app.selectOption('#directLines .department', '41');
  await app.selectOption('#directLines .center', '51');
  await app.fill('#planned', '2026-10-30');
  await app.fill('#concept', 'Pago de impuestos');
  await app.fill('#directLines .concept', 'Pago de impuesto sobre la renta');
  await app.fill('#directLines .amount', '1250');
  await app.click('#save');
  await app.waitForFunction(() => document.querySelector('#message')?.textContent.includes('Borrador'));

  const save = calls.find(call => call.action === 'save');
  assert.ok(save, 'No se envió el borrador de la solicitud.');
  assert.equal(save.payload.type, 'OTROS');
  assert.deepEqual(save.payload.lines, [{
    accountId: '70',
    entityType: 'Agencia Tributaria',
    entityId: '301',
    departmentType: 'Cliente',
    departmentId: '41',
    costCenterId: '51',
    concept: 'Pago de impuesto sobre la renta',
    amount: '1250'
  }]);

  assert.equal(await app.locator('#directLines .entityType').inputValue(), 'Agencia Tributaria');
  assert.equal(await app.locator('#directLines .entity').inputValue(), '301');
  assert.match(await app.locator('#directLines .entity').textContent(), /Tax Administration Jamaica/);

  console.log(JSON.stringify({
    passed: true,
    partyTypeOption: true,
    agencySelectorUsesTaxAgencies: true,
    partyRepeatedAcrossActiveAndNewLines: true,
    savePayloadPreserved: true,
    draftReopenedWithTaxAgency: true
  }));
} finally {
  await browser.close();
}
