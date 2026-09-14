import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(5000);
page.on('pageerror', error => console.error(error));
const savedSupports = [];
const calls = [];
const header = {
  id: 7, numero: 'SOL_PAG-00000007', estado: 'BORRADOR', id_solicitante: 1,
  tipo_solicitud: 'OTROS', id_moneda: 1, fecha_solicitud: '2026-09-13',
  fecha_pago_programada: '2026-09-14', concepto: 'Prueba de respaldos', total: 10,
  version: 1, id_proveedor: null, journal_id: null
};
const detail = () => ({
  header,
  lines: [{ id_cuenta_contable: 10, tipo_tercero: null, id_centro_costo: null, concepto: 'Servicio', monto: 10, accountName: '1-10 / Cuenta de prueba' }],
  events: []
});

await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  const action = url.pathname.split('/').at(-1);
  const payload = route.request().postDataJSON?.() || {};
  calls.push({ action, payload });
  let body = {};
  if (action === 'options') body = {
    company: 'Nexo', baseCurrencyId: 1, userId: 1, admin: false, canApprove: false, canExecute: false,
    currencies: [{ id: 1, name: 'CRC' }], users: [{ id: 1, name: 'Ana' }], suppliers: [],
    customers: [], employees: [], costCenters: [], banks: [], rates: [], accounts: [{ id: 10, name: '1-10 / Cuenta de prueba' }]
  };
  else if (action === 'report') body = [];
  else if (action === 'save') body = { id: 7 };
  else if (action === 'detail') body = detail();
  else if (action === 'supports') body = savedSupports;
  else if (action === 'support-save') {
    savedSupports.push({ ...payload, id: savedSupports.length + 1 });
    body = { id: savedSupports.length };
  } else if (action === 'support-delete') {
    const index = savedSupports.findIndex(item => item.id === payload.supportId);
    if (index >= 0) savedSupports.splice(index, 1);
    body = { deleted: true };
  } else if (url.pathname === '/api/audit/record-actor') body = { events: [] };
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

try {
  await page.goto('http://localhost:3000/');
  await page.setContent('<iframe id="app"></iframe>');
  const app = page.frames().find(frame => frame !== page.mainFrame());
  await app.goto('http://localhost:3000/payment-requests.html');
  const visibleText = await app.locator('body').innerText();
  assert.doesNotMatch(visibleText, /Ã|Â|�/);
  assert.match(visibleText, /CONTABILIDAD · TESORERÍA/);
  assert.match(visibleText, /Solicitudes que aún no generaron pago/);
  await app.click('#new');
  await app.selectOption('#type', 'OTROS');
  await app.fill('#planned', '2026-09-14');
  await app.fill('#concept', 'Prueba de respaldos');
  await app.selectOption('#directLines .account', '10');
  await app.fill('#directLines .concept', 'Servicio');
  await app.fill('#directLines .amount', '10');
  await app.setInputFiles('#supportFiles', { name: 'orden.pdf', mimeType: 'application/pdf', buffer: Buffer.from('PDF de prueba') });
  await app.fill('#supportLinkName', 'Carpeta del proveedor');
  await app.fill('#supportLinkUrl', 'https://example.com/respaldo');
  await app.click('#addSupportLink');
  assert.equal(await app.locator('.support-item').count(), 2);
  await app.click('#save');
  await app.waitForFunction(() => document.querySelector('#message')?.textContent.includes('archivos de respaldo guardados'));
  assert.equal(calls.filter(call => call.action === 'support-save').length, 2);
  assert.equal(await app.locator('.support-item').count(), 2);
  assert.equal(await app.locator('.support-item-actions button').count(), 2);

  header.estado = 'APROBADO';
  await app.evaluate(() => document.querySelector('#back').click());
  await app.waitForFunction(() => !document.querySelector('#list').hidden);
  await app.evaluate(() => document.querySelector('#rows').innerHTML = '<tr><td><button data-open="7">Abrir</button></td></tr>');
  await app.click('[data-open="7"]');
  await app.waitForFunction(() => document.querySelector('#title')?.textContent.includes('APROBADO'));
  assert.equal(await app.locator('#supportActions').isHidden(), true);
  assert.equal(await app.locator('.support-item-actions button').count(), 0);
  assert.equal(await app.locator('.support-item-actions a').count(), 2);
  console.log(JSON.stringify({ passed: true, savedSupports: savedSupports.length, approvedReadOnly: true }));
} finally {
  await browser.close();
}
