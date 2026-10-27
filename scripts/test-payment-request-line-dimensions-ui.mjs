import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(5000);

const calls = [];
const header = {
  id: 93,
  numero: 'SOL_PAG-00000093',
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
    suppliers: [], customers: [], employees: [],
    taxAgencies: [{ id: 301, name: 'TAJ' }],
    departments: [
      { id: 41, name: 'PROYECTOS', type: 'Cliente' },
      { id: 42, name: 'ADMINISTRATIVO', type: 'Interno' },
      { id: 43, name: 'OTRO CLIENTE', type: 'Cliente' }
    ],
    costCenters: [
      { id: 51, name: 'CC-001 / PROYECTO A', type: 'CLIENTE', departmentId: 41 },
      { id: 52, name: 'CC-002 / PROYECTO B', type: 'CLIENTE', departmentId: 43 },
      { id: 53, name: 'INT-001 / ADMINISTRACION', type: 'INTERNO', departmentId: 42 }
    ],
    banks: [], rates: [],
    accounts: [{ id: 70, name: '214001 / Impuesto por pagar' }]
  };
  else if (action === 'report') body = [];
  else if (action === 'save') body = { id: header.id };
  else if (action === 'detail') body = {
    header,
    lines: [{
      id: 503,
      id_cuenta_contable: 70,
      tipo_tercero: 'Agencia Tributaria',
      id_agencia_tributaria: 301,
      id_departamento: 41,
      id_centro_costo: 51,
      departmentType: 'Cliente',
      department: 'PROYECTOS',
      costCenter: 'CC-001 / PROYECTO A',
      concepto: 'Impuesto principal',
      monto: 1250,
      accountName: '214001 / Impuesto por pagar',
      party: 'TAJ'
    }],
    events: []
  };
  else if (action === 'supports') body = [];
  else if (url.pathname === '/api/audit/record-actor') body = { events: [] };

  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

const optionValues = locator => locator.locator('option').evaluateAll(options => options.map(option => option.value));

try {
  await page.goto('http://localhost:3000/payment-requests.css', { waitUntil: 'domcontentloaded' });
  await page.setContent('<iframe id="app"></iframe>');
  const app = page.frames().find(frame => frame !== page.mainFrame());
  await app.goto('http://localhost:3000/payment-requests.html');

  await app.click('#new');
  await app.selectOption('#type', 'OTROS');
  await app.selectOption('#directLines .account', '70');
  await app.selectOption('#directLines .entityType', 'Agencia Tributaria');
  await app.selectOption('#directLines .entity', '301');

  await app.selectOption('#directLines .departmentType', 'Cliente');
  assert.deepEqual(await optionValues(app.locator('#directLines .department')), ['', '41', '43']);
  await app.selectOption('#directLines .department', '41');
  assert.deepEqual(await optionValues(app.locator('#directLines .center')), ['', '51']);
  await app.selectOption('#directLines .center', '51');

  await app.selectOption('#directLines .department', '43');
  assert.equal(await app.locator('#directLines .center').inputValue(), '');
  assert.deepEqual(await optionValues(app.locator('#directLines .center')), ['', '52']);

  await app.selectOption('#directLines .departmentType', 'Interno');
  assert.deepEqual(await optionValues(app.locator('#directLines .department')), ['', '42']);
  await app.selectOption('#directLines .department', '42');
  assert.deepEqual(await optionValues(app.locator('#directLines .center')), ['', '53']);

  for (const selector of [
    '.account','.entityType','.entity','.departmentType','.department',
    '.concept','.amount'
  ]) {
    assert.equal(await app.locator(`#directLines ${selector}`).getAttribute('required'), '');
  }
  assert.equal(await app.locator('#directLines .center').getAttribute('required'), null);

  await app.selectOption('#directLines .departmentType', 'Cliente');
  await app.selectOption('#directLines .department', '41');
  await app.selectOption('#directLines .center', '51');
  await app.fill('#planned', '2026-10-30');
  await app.fill('#concept', 'Pago de impuestos');
  await app.fill('#directLines .concept', 'Impuesto principal');
  await app.fill('#directLines .amount', '1250');
  await app.click('#save');
  await app.waitForFunction(() => document.querySelector('#message')?.textContent.includes('Borrador'));

  const save = calls.find(call => call.action === 'save');
  assert.equal(save.payload.lines[0].departmentType, 'Cliente');
  assert.equal(save.payload.lines[0].departmentId, '41');
  assert.equal(save.payload.lines[0].costCenterId, '51');
  assert.equal(await app.locator('#directLines .departmentType').inputValue(), 'Cliente');
  assert.equal(await app.locator('#directLines .department').inputValue(), '41');
  assert.equal(await app.locator('#directLines .center').inputValue(), '51');

  console.log(JSON.stringify({
    passed: true,
    departmentsFilteredByType: true,
    costCentersFilteredByDepartment: true,
    internalCentersUseExplicitDepartmentLink: true,
    requiredLineFieldsMarkedInBrowser: true,
    dimensionsSavedAndReopened: true
  }));
} finally {
  await browser.close();
}
