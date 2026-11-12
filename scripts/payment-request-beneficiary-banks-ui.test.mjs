import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from '@playwright/test';

const hostileBank = '<img src=x onerror="window.bankXss=true">';
const supplierAccounts = [
  { slot: 'primary', bankId: 11, bankName: hostileBank, iban: 'CR05015202001026284066', accountNumber: '00001234', currencyId: 1, currencyCode: 'CRC' },
  { slot: 'secondary', bankId: 12, bankName: 'Synthetic secondary bank', iban: 'GB82WEST12345698765432', accountNumber: '00009876', currencyId: 2, currencyCode: 'USD' },
];
const supplier = { identification:'001-SUP-10', entityType: 'Proveedor', entityId: 10, name: 'Synthetic supplier', beneficiaryName: '<script>window.bankXss=true</script>', isActive: true, accounts: supplierAccounts };
const employee = { identification:'002-EMP-20', entityType: 'Empleado', entityId: 20, name: 'Synthetic employee', beneficiaryName: 'Synthetic employee beneficiary', isActive: true, accounts: [
  { slot: 'primary', bankId: 13, bankName: 'Synthetic employee bank', iban: '', accountNumber: '00002020', currencyId: null, currencyCode: null },
] };
const otherName = { identification:'003-ON-31', entityType: 'Otro Nombre', entityId: 31, name: 'ON-000031 · Synthetic other name', beneficiaryName: 'Synthetic other beneficiary', isActive: true, accounts: [
  { slot: 'primary', bankId: 14, bankName: 'Synthetic other primary bank', iban: 'GB82WEST12345698765432', accountNumber: '00003131', currencyId: 1, currencyCode: 'CRC' },
  { slot: 'secondary', bankId: 15, bankName: 'Synthetic other secondary bank', iban: '', accountNumber: '00003132', currencyId: 1, currencyCode: 'CRC' },
] };
const noAccounts = { entityType: 'Otro Nombre', entityId: 32, name: 'ON-000032 · No bank accounts', beneficiaryName: '', isActive: true, accounts: [] };
const inactiveOtherName = { ...otherName, entityId: 30, name: 'ON-000030 · Historical other name', isActive: false, accounts: [
  { slot: 'primary', bankId: 16, bankName: 'Historical current bank', iban: '', accountNumber: '00003030', currencyId: 1, currencyCode: 'CRC' },
] };
const options = {
  userId: 1, admin: false, canApprove: false, canExecute: true, company: 'Synthetic subsidiary', baseCurrencyId: 1,
  currencies: [{ id: 1, name: 'CRC' }, { id: 2, name: 'USD' }], users: [{ id: 1, name: 'Synthetic requester' }],
  suppliers: [{ id: 10, name: supplier.name }], employees: [{ id: 20, name: employee.name }],
  otherNames: [{ id: 31, name: otherName.name }, { id: 32, name: noAccounts.name }],
  customers: [{ id: 40, name: 'Synthetic customer' }], taxAgencies: [],
  departments: [{ id: 21, name: 'Synthetic department', type: 'Interno' }], costCenters: [],
  accounts: [{ id: 203, name: 'Synthetic expense' }], banks: [{ id: 1, name: 'Synthetic paying bank', currencyId: 1 }], rates: [],
  beneficiaryBankAccounts: [supplier, employee, otherName, noAccounts],
};
const header = (id, patch = {}) => ({
  id, numero: `SOL-SYN-${id}`, estado: 'APROBADO', id_solicitante: 1, tipo_solicitud: 'OTROS', id_moneda: 1,
  fecha_solicitud: '2026-10-31', fecha_pago_programada: '2026-11-02', concepto: 'Historical approved request', total: 50,
  terceros:[{entityType:'Empleado',entityId:20,name:'Synthetic employee'}], version: 7, solicitante: 'Synthetic requester', moneda: 'CRC', ...patch,
});
const directLine = (entityType, entityId, party) => ({
  id_cuenta_contable: 203, tipo_tercero: entityType,
  [entityType === 'Proveedor' ? 'id_proveedor' : entityType === 'Empleado' ? 'id_empleado' : 'id_otro_nombre']: entityId,
  id_departamento: 21, departmentType: 'Interno', concepto: 'Synthetic expense', monto: 50, accountName: 'Synthetic expense', party,
});
const detail = id => {
  const bankParty = id === 2 ? inactiveOtherName : id === 3 ? supplier : { ...supplier, accounts: supplier.accounts.map(account => account.slot === 'primary' ? { ...account, accountNumber: '00001111' } : account) };
  return {
    header: header(id, id === 3 ? { tipo_solicitud: 'CXP', id_proveedor: 10 } : {}),
    lines: id === 3 ? [{ id_factura_proveedor: 9, invoiceNumber: 'SYN-INV-9', invoiceDate: '2026-10-31', invoiceDueDate: '2026-11-02', invoiceTotal: 100, monto: 50 }]
      : [directLine(bankParty.entityType, bankParty.entityId, bankParty.name)],
    events: [], beneficiaryBankAccounts: id === 4 ? [] : [bankParty], actions: { canEdit: false, canExecute: true, canApprove: false, canCancel: false },
  };
};

test('solicitudes muestran cuentas actuales del beneficiario y auditoría plegada sin alterar pagos históricos', { timeout: 120000 }, async t => {
  const root = resolve('public');
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname, file = resolve(root, '.' + pathname);
      if (!file.startsWith(root + sep)) throw Error('Invalid path');
      response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'application/octet-stream');
      let body = await readFile(file);
      // Production injects this common component when serving business pages.
      if (pathname === '/payment-requests.html') body = body.toString('utf8').replace('</head>', '<script src="/record-audit.js"></script></head>');
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1560, height: 1200 } });
  const origin = `http://127.0.0.1:${server.address().port}`, calls = [], unknown = [], errors = [];
  let refreshedAccount = null, refreshedVersion = 7;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('nexo_token', 'synthetic-bank-ui-token');
    localStorage.setItem('nexo_device_token', 'synthetic-bank-ui-device');
    localStorage.setItem('nexo_company', '1');
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const payload = request.method() === 'POST' ? request.postDataJSON() : {};
    calls.push({ path: url.pathname, payload, method: request.method(), auth: request.headers().authorization });
    let json;
    if (url.pathname === '/api/audit/record-actor') {
      assert.equal(request.headers().authorization, 'Bearer synthetic-bank-ui-token');
      assert.equal(request.headers()['x-device-token'], 'synthetic-bank-ui-device');
      json = { created_by_name: 'Synthetic original author', created_by_email: 'author@example.invalid', actor_type: 'HUMAN', actor_source: 'Synthetic fixture', updated_by_name: null, updated_by_email: null };
    } else {
      if (!url.pathname.startsWith('/api/treasury/payment-requests/')) {
        unknown.push(url.pathname);
        return route.fulfill({ status: 400, json: { error: { message: 'Unexpected catalog or service request' } } });
      }
      const action = url.pathname.split('/').at(-1);
      if (action === 'access') json = { canView: true, canCreate: true, canEdit: true, canDelete: false };
      else if (action === 'options') json = options;
      else if (action === 'report') json = [header(1), header(2), header(3, { tipo_solicitud: 'CXP', id_proveedor: 10, terceros:[{entityType:'Proveedor',entityId:10,name:'Synthetic supplier'}] }), header(4, { moneda:'USD', id_moneda:2, terceros:[{entityType:'Otro Nombre',entityId:31,name:'Synthetic employee'}] }),header(5,{moneda:'USD',estado:'APLICADO'}),header(6,{moneda:'CRC',estado:'ANULADO'})];
      else if (action === 'detail') {
        json = detail(Number(payload.id));
        if (Number(payload.id) === 1) {
          json.header.version = refreshedVersion;
          if (refreshedAccount) json.beneficiaryBankAccounts = json.beneficiaryBankAccounts.map(party => ({ ...party, accounts: party.accounts.map(account => account.slot === 'primary' ? { ...account, accountNumber: refreshedAccount } : account) }));
        }
      }
      else if (action === 'supports') json = [];
      else if (action === 'invoices') json = [{ id: 9, number: 'SYN-INV-9', date: '2026-10-31', dueDate: '2026-11-02', total: 100, balance: 100, reserved: 0, available: 100 }];
      else { unknown.push(url.pathname); return route.fulfill({ status: 400, json: { error: { message: 'Unexpected fixture mutation' } } }); }
    }
    return route.fulfill({ json });
  });
  await page.goto(origin + '/payment-requests.html');
  await page.locator('[data-open="1"]').waitFor();
  assert.deepEqual(await page.locator('#filterCurrency option').allTextContents(),['Todas','CRC','USD']);
  await page.selectOption('#filterCurrency','USD');
  await page.waitForFunction(()=>document.querySelector('#pendingCount').textContent==='1');
  assert.deepEqual(await page.locator('#rows [data-open]').evaluateAll(nodes=>nodes.map(n=>n.dataset.open)),['4']);
  assert.equal(await page.locator('#appliedCount').textContent(),'1');
  assert.equal(await page.locator('#cancelledCount').textContent(),'0');
  await page.click('#appliedTab');
  await page.locator('[data-open="5"]').waitFor();
  assert.equal(await page.locator('#filterCurrency').inputValue(),'USD');
  await page.click('#pendingTab');
  await page.locator('[data-open="4"]').waitFor();
  await page.selectOption('#filterCurrency','');
  await page.locator('[data-open="1"]').waitFor();
  assert.equal(await page.locator('#rows [data-open]').count(),4);
  await page.screenshot({path:'.local-tools/payment-request-currency-filter.png',fullPage:true});
  assert.deepEqual(await page.locator('#rows tr').first().locator('td').allTextContents().then(c=>c.slice(1,3)),['Synthetic employeeEmpleado','Synthetic requester']);
  await page.selectOption('#filterSupplier','Otro Nombre:31');
  await page.waitForFunction(()=>document.querySelector('#pendingCount').textContent==='1');
  assert.deepEqual(await page.locator('#rows [data-open]').evaluateAll(nodes=>nodes.map(n=>n.dataset.open)),['4']);
  await page.selectOption('#filterCurrency','CRC');
  await page.waitForFunction(()=>document.querySelector('#pendingCount').textContent==='0');
  assert.equal(await page.locator('#rows td').getAttribute('colspan'),'10');
  await page.selectOption('#filterCurrency','');
  await page.locator('[data-open="4"]').waitFor();
  await page.selectOption('#filterSupplier','Proveedor:10');
  await page.locator('[data-open="3"]').waitFor();
  assert.equal(await page.locator('#rows [data-open]').count(),1);
  await page.selectOption('#filterSupplier','');
  await page.locator('[data-open="1"]').waitFor();
  assert.ok(calls.filter(c=>c.path.endsWith('/report')).every(c=>!c.payload.supplierId));
  await page.screenshot({path:'.local-tools/payment-request-parties.png',fullPage:true});
  const panel = page.locator('#beneficiaryBanking'), payPanel = page.locator('#payBeneficiaryBanking');
  const account = (slot, scope = panel) => scope.locator(`.beneficiary-bank-account[data-slot="${slot}"]`);
  const audit = page.locator('#requestRecordAudit'), auditSummary = audit.locator(':scope > summary');
  const screenshots = '.local-tools';
  await mkdir(screenshots, { recursive: true });
  const open = async id => {
    await page.locator(`[data-open="${id}"]`).click();
    await page.locator('#title').filter({ hasText: `SOL-SYN-${id}` }).waitFor();
    assert.equal(await audit.evaluate(element => element.open), false);
  };
  const back = async () => { await page.locator('#back').click(); await page.locator('#list').waitFor({ state: 'visible' }); };
  const noMutations = () => assert.ok(!calls.some(call => /\/(save|execute|transition|support-save|support-delete)$/.test(call.path)), JSON.stringify(calls));

  await open(1);
  assert.equal(await page.locator('#requestForm').isHidden(), true);
  assert.equal(await page.locator('#save').isHidden(), true);
  assert.equal(await panel.locator('.beneficiary-bank-party').count(), 1);
  assert.equal((await panel.locator('.beneficiary-bank-identification strong').innerText()).trim(),'001-SUP-10');
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 2);
  assert.match(await account('primary').innerText(), /00001111/);
  assert.doesNotMatch(await panel.innerText(), /00001234/); // The authorized detail, rather than stale options, is authoritative.
  assert.match(await account('secondary').innerText(), /00009876/);
  assert.match(await panel.innerText(), /CR05015202001026284066/);
  assert.match(await panel.innerText(), /GB82WEST12345698765432/);
  assert.match(await panel.innerText(), /CRC/);
  assert.match(await panel.innerText(), /USD/);
  assert.match(await panel.innerText(), /<img src=x onerror=/);
  assert.match(await panel.innerText(), /<script>window.bankXss=true<\/script>/);
  assert.equal(await panel.locator('img,script').count(), 0);
  assert.equal(await page.evaluate(() => window.bankXss), undefined);
  assert.match(await panel.locator('.beneficiary-bank-notice').allTextContents().then(values => values.join(' ')), /moneda/i);
  await page.screenshot({ path: screenshots + '/payment-request-audit-collapsed.png', fullPage: true });
  await auditSummary.focus();
  await page.keyboard.press('Enter');
  assert.equal(await audit.evaluate(element => element.open), true);
  await audit.getByText('Synthetic original author', { exact: true }).waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await audit.evaluate(element => element.open), false);
  await page.screenshot({ path: screenshots + '/payment-request-banks-approved.png', fullPage: true });

  refreshedAccount = '00006666';
  const beforeRefresh = calls.filter(call => call.path.endsWith('/detail')).length;
  await page.locator('[data-transition="EXECUTE"]').click();
  await page.locator('#payDialog').waitFor({ state: 'visible' });
  assert.equal(calls.filter(call => call.path.endsWith('/detail')).length, beforeRefresh + 1);
  assert.equal(await payPanel.locator('.beneficiary-bank-account').count(), 2);
  assert.match(await payPanel.innerText(), /00006666/);
  assert.doesNotMatch(await payPanel.innerText(), /00001111/);
  assert.equal(await payPanel.locator('input,select,textarea').count(), 0);
  assert.equal(await page.locator('#bank option[value="1"]').textContent(), 'Synthetic paying bank');
  noMutations();
  await page.locator('[data-close="payDialog"]').click();
  refreshedAccount = null;
  await back();
  await open(2);
  assert.match(await panel.innerText(), /00003030/);
  assert.doesNotMatch(await panel.innerText(), /00001111|00009876/);
  assert.match(await panel.locator('.beneficiary-bank-notice').allTextContents().then(values => values.join(' ')), /inactiv/i);
  await auditSummary.click();
  assert.equal(await audit.evaluate(element => element.open), true);
  await back();
  await open(3);
  assert.match(await panel.innerText(), /00001234/);
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 2);
  noMutations();
  await back();
  await open(4);
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 0);
  assert.ok(await panel.locator('.beneficiary-bank-empty').count());
  assert.doesNotMatch(await panel.innerText(), /00001234|00009876/);

  // A new request resets expanded auditing and resolves banks while selecting beneficiaries.
  await page.locator('#new').click();
  assert.equal(await audit.evaluate(element => element.open), false);
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 0);
  await page.locator('#type').selectOption('OTROS');
  await page.locator('.entityType').selectOption('Proveedor');
  await page.locator('.entity').selectOption('10');
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 2);
  assert.match(await account('primary').innerText(), /00001234/);
  await page.locator('#addLine').click();
  assert.equal(await panel.locator('.beneficiary-bank-party').count(), 1);
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 2);
  await page.locator('.entityType').first().selectOption('Empleado');
  assert.doesNotMatch(await panel.innerText(), /00001234|00009876/);
  await page.locator('.entity').first().selectOption('20');
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 1);
  assert.match(await panel.innerText(), /00002020/);
  assert.match(await account('primary').innerText(), /Moneda[\s\S]*No registrada/i);
  await page.locator('.entityType').first().selectOption('Otro Nombre');
  await page.locator('.entity').first().selectOption('31');
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 2);
  assert.match(await panel.innerText(), /00003131/);
  assert.match(await panel.innerText(), /00003132/);
  assert.doesNotMatch(await panel.innerText(), /00002020|00001234/);
  await page.locator('#currency').selectOption('2');
  await panel.locator('.beneficiary-bank-notice').filter({ hasText: /moneda/i }).first().waitFor();
  await page.locator('.entity').first().selectOption('32');
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 0);
  assert.ok(await panel.locator('.beneficiary-bank-empty').count());
  assert.doesNotMatch(await panel.innerText(), /00003131|00003132/);
  await page.locator('.entityType').first().selectOption('Cliente');
  await page.locator('.entity').first().selectOption('40');
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 0);
  assert.doesNotMatch(await panel.innerText(), /00003131|00003132|00002020/);

  await page.locator('#type').selectOption('CXP');
  await page.locator('#currency').selectOption('1');
  await page.locator('#supplierSearch').fill(supplier.name);
  await page.locator('#supplierSearch').dispatchEvent('change');
  await page.locator('#invoices [data-id="9"]').waitFor();
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 2);
  assert.match(await panel.innerText(), /00001234/);
  await page.locator('#supplierSearch').fill('');
  await page.locator('#supplierSearch').dispatchEvent('change');
  assert.equal(await panel.locator('.beneficiary-bank-account').count(), 0);
  assert.doesNotMatch(await panel.innerText(), /00001234/);

  await back();
  await open(1);
  refreshedVersion = 8;
  await page.locator('[data-transition="EXECUTE"]').click();
  await page.locator('#message').filter({ hasText: /cambi|actualiz|verifi|revise/i }).waitFor();
  assert.equal(await page.locator('#payDialog').isVisible(), false);
  noMutations();
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await panel.evaluate(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth, scroll: element.scrollWidth, client: element.clientWidth }; });
  assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1 && bounds.scroll <= bounds.client + 1, JSON.stringify(bounds));
  await page.screenshot({ path: screenshots + '/payment-request-banks-mobile.png', fullPage: true });

  // Shared record-audit remains expanded when embedded without this page's wrapper.
  await page.evaluate(() => { const host = document.createElement('div'); host.id = 'unaffected-audit'; document.body.append(host); window.NexoRecordAudit.show('suppliers', 10, host); });
  await page.locator('#unaffected-audit record-audit').getByText('Synthetic original author', { exact: true }).waitFor();
  assert.equal(await page.locator('#unaffected-audit details').count(), 1); // Existing operation-origin details only.
  assert.equal(await page.locator('#unaffected-audit record-audit').getByText('Synthetic original author', { exact: true }).isVisible(), true);
  noMutations();
  assert.deepEqual(unknown, []);
  assert.deepEqual(errors, []);
  assert.ok(calls.every(call => call.auth === 'Bearer synthetic-bank-ui-token'));
});
