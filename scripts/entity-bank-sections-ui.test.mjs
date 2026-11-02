import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { chromium } from '@playwright/test';
import { vueArtifacts } from './build-vue-templates.mjs';

const bankValues = {
  payment_bank_id: 11, payment_currency_id: 1, payment_iban: 'CR05015202001026284066', payment_account_number: '00001234',
  secondary_payment_bank_id: 12, secondary_payment_currency_id: 2, secondary_payment_iban: 'GB82WEST12345698765432', secondary_payment_account_number: '00009876',
};
const catalogs = [
  { slug: 'suppliers', title: 'Proveedores', key: 'supplier_id', general: 'company_name', filename: 'supplier', operation: 'operation' },
  { slug: 'employees', title: 'Empleados', key: 'employee_id', general: 'first_name', filename: 'employee', operation: 'organization' },
  { slug: 'other-names', title: 'Otros Nombres', key: 'other_name_id', general: 'name', filename: 'other-names' },
];

test('tres entidades separan bloques, conservan dos cuentas y llevan al apartado con errores antes de guardar', { timeout: 180000 }, async t => {
  const root = resolve('public'), compiled = await vueArtifacts();
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname, file = resolve(root, '.' + pathname);
      if (!file.startsWith(root + sep)) throw Error('Invalid path');
      response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' })[extname(file)] || 'application/octet-stream');
      response.end(compiled.get('public' + pathname) ?? await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1560, height: 1200 } });
  const target = process.env.ENTITY_BANK_UI_URL || `http://127.0.0.1:${server.address().port}/index.html`, origin = new URL(target).origin;
  const calls = [], rows = Object.fromEntries(catalogs.map(catalog => [catalog.slug, {
    [catalog.key]: 7, supplier_number: 'PROV-SYN', employee_number: 'EMP-SYN', other_name_number: 'ON-000001',
    company_name: 'Synthetic supplier', name: 'Synthetic third party', first_name: 'Synthetic', last_name: 'Employee',
    supplier_type: 'Empresa', tax_id: 'SYN-TAX', identification: 'SYN-ID', email: 'person@example.invalid', phone: '8888-8888',
    subsidiary_id: 1, subsidiary_ids: [1], currency_ids: [1, 2], withholding_rules: [], applies_withholding: false,
    is_intercompany: false, is_active: true, is_sales_representative: false, department_id: 3, location_id: 4,
    payment_beneficiary_name: 'Synthetic beneficiary', comments: 'Existing notes', ...bankValues, payment_currency_id: null,
    _revision: 'INITIAL-' + catalog.slug,
  }]));
  let write = false;
  const references = {
    'organization/subsidiaries': [{ subsidiary_id: 1, name: 'Synthetic subsidiary', country_id: 1, currency_id: 1 }],
    'banking/banks': [{ bank_id: 11, bank_name: 'Synthetic bank principal', bank_code: 'SYN-A', country_id: 1 }, { bank_id: 12, bank_name: 'Synthetic bank secondary', bank_code: 'SYN-B', country_id: 1 }],
    'core/currencies': [{ currency_id: 1, currency_code: 'CRC', name: 'Colón' }, { currency_id: 2, currency_code: 'USD', name: 'US Dollar' }],
    'core/countries': [{ country_id: 1, name: 'Synthetic country' }], 'configuration/payment-terms': [], 'configuration/tax-codes': [],
    'organization/departments': [{ department_id: 3, name: 'Synthetic department', type: 'Interno', subsidiary_id: 1 }],
    'organization/locations': [{ location_id: 4, name: 'Synthetic location', subsidiary_id: 1 }], 'security/users': [],
  };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || url.pathname.endsWith('.mp4')) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const payload = request.postDataJSON(), method = request.method();
    calls.push({ path: url.pathname, method, payload });
    let json = [];
    if (url.pathname === '/api/security/turnstile/config') json = { enabled: false };
    else if (url.pathname === '/api/entities/master/options') json = { canView: true, canCreate: write, canEdit: write, canDelete: false, references };
    else {
      const catalog = catalogs.find(item => url.pathname === '/api/entities/' + item.slug || url.pathname === '/api/entities/' + item.slug + '/7');
      if (catalog) {
        if (method === 'GET') json = [{ ...rows[catalog.slug], _actions: { canEdit: write, canDelete: false } }];
        else {
          rows[catalog.slug] = { ...rows[catalog.slug], ...payload, _revision: 'NEXT-' + calls.length };
          json = { ...rows[catalog.slug], _actions: { canEdit: true, canDelete: false } };
        }
      }
    }
    await route.fulfill({ json });
  });
  await page.goto(target);
  await page.waitForFunction(() => document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
  const field = key => page.locator(`.modal [data-field-key="${key}"]`);
  const tab = id => page.locator(`.entity-form-tabs [data-entity-tab="${id}"]`);
  const save = () => page.locator('.modal .button-primary').click();
  const closed = () => page.waitForFunction(() => {
    const value = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    return !value.recordDialog.open && !value.tableLoading && value.rows.length === 1;
  });
  const open = () => page.evaluate(async () => { const value = document.getElementById('app').__vue_app__._container._vnode.component.proxy; await value.openRecordForm(value.rows[0]); });
  const mutationCount = () => calls.filter(call => ['POST', 'PATCH'].includes(call.method) && catalogs.some(catalog => call.path.startsWith('/api/entities/' + catalog.slug))).length;
  const selectCatalog = async catalog => {
    await page.evaluate(async ({ slug, title }) => {
      const value = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
      value.authenticated = true; value.selectingCompany = false; value.selectingRole = false;
      value.activeCompany = { subsidiaryId: 1, name: 'Synthetic subsidiary' }; value.activeRole = { roleId: 1, name: 'Synthetic role' };
      value.roleAccess = { loaded: true, isAdmin: false, legacy: false, grants: { ['entities:' + slug]: { canView: true, canCreate: true, canEdit: true, canDelete: false } }, modules: [] };
      value.closeWorkspace(); value.currentModule = 'Entidades'; value.currentSection = title; await value.loadCatalog();
    }, catalog);
  };
  const fillBank = async () => {
    for (const [key, value] of Object.entries(bankValues)) {
      const control = field(key).locator(key.endsWith('_id') ? 'select' : 'input');
      if (key.endsWith('_id')) await control.selectOption(String(value));
      else await control.fill(value);
    }
  };
  for (const catalog of catalogs) {
    write = false; await selectCatalog(catalog);
    assert.equal(await page.locator('.new-record:not(.catalog-export-button):visible').count(), 0);
    assert.equal(await page.locator('.icon-action.edit:visible').count(), 0);
    write = true; await selectCatalog(catalog); await open();
    assert.equal(await tab('general').getAttribute('aria-selected'), 'true');
    assert.equal(await field('payment_bank_id').isVisible(), false);
    assert.equal(await page.locator('.modal form').getAttribute('novalidate'), '');
    await field(catalog.general).locator('input').fill('Updated legacy general');
    await save(); await closed();
    const legacy = calls.filter(call => call.method === 'PATCH' && call.path === '/api/entities/' + catalog.slug + '/7').at(-1);
    assert.ok(legacy, catalog.slug + ' saves general information');
    assert.equal(legacy.payload.payment_currency_id, null);
    assert.equal(legacy.payload.payment_bank_id, 11);
    assert.equal(legacy.payload.payment_iban, bankValues.payment_iban);
    assert.equal(legacy.payload.payment_account_number, '00001234');
    assert.equal(legacy.payload.secondary_payment_account_number, '00009876');
    assert.equal(legacy.payload.secondary_payment_currency_id, 2);
    await open(); await tab('banking').click();
    assert.equal(await page.locator('.entity-bank-account:visible').count(), 2);
    assert.equal(await page.locator('.entity-bank-account[data-bank-slot="primary"]').count(), 1);
    assert.equal(await page.locator('.entity-bank-account[data-bank-slot="secondary"]').count(), 1);
    await fillBank();
    await tab('general').click();
    await field(catalog.general).locator('input').fill('');
    await tab('banking').click();
    assert.equal(await field('payment_account_number').locator('input').inputValue(), '00001234');
    assert.equal(await field('secondary_payment_currency_id').locator('select').inputValue(), '2');
    const beforeInvalid = mutationCount();
    await save();
    await page.waitForFunction(() => document.getElementById('app').__vue_app__._container._vnode.component.proxy.entityFormTab === 'general');
    try {
      await page.waitForFunction(key => document.activeElement?.closest('[data-field-key]')?.getAttribute('data-field-key') === key, catalog.general, {timeout:5000});
    } catch (cause) {
      const detail=await page.evaluate(key=>({active:document.activeElement?.outerHTML,targets:[...document.querySelectorAll('[data-field-key="'+key+'"] input')].map(element=>({html:element.outerHTML,visible:!!element.getClientRects().length,disabled:element.disabled})),error:document.getElementById('app').__vue_app__._container._vnode.component.proxy.dialogError}),catalog.general);
      throw new Error(catalog.slug+' validation focus: '+JSON.stringify(detail),{cause});
    }
    assert.equal(mutationCount(), beforeInvalid);
    assert.equal(await field(catalog.general).locator('input').evaluate(element => element === document.activeElement), true);
    await field(catalog.general).locator('input').fill('Updated general after validation');
    await tab('banking').click();
    await field('secondary_payment_bank_id').locator('select').selectOption('');
    await save();
    assert.equal(mutationCount(), beforeInvalid);
    assert.equal(await tab('banking').getAttribute('aria-selected'), 'true');
    await field('secondary_payment_bank_id').locator('select').selectOption('12');
    await save(); await closed();
    const changed = calls.filter(call => call.method === 'PATCH' && call.path === '/api/entities/' + catalog.slug + '/7').at(-1);
    for (const [key, value] of Object.entries(bankValues)) assert.equal(changed.payload[key], value, catalog.slug + ' ' + key);
    assert.ok(changed.payload._revision);
    assert.equal(changed.payload[catalog.slug === 'suppliers' ? 'supplier_number' : catalog.slug === 'employees' ? 'employee_number' : 'other_name_number'], undefined);

    await page.evaluate(async () => { await document.getElementById('app').__vue_app__._container._vnode.component.proxy.openRecordForm(); });
    if (catalog.slug === 'suppliers') {
      await field('company_name').locator('input').fill('Synthetic new supplier'); await field('tax_id').locator('input').fill('SYN-NEW-SUPPLIER');
      await tab('operation').click();
      await field('subsidiary_ids').locator('input[type="checkbox"][value="1"]').check();
      await field('currency_ids').locator('input[type="checkbox"][value="1"]').check();
    } else if (catalog.slug === 'employees') {
      await field('identification').locator('input').fill('SYN-NEW-EMPLOYEE'); await field('first_name').locator('input').fill('Synthetic new'); await field('last_name').locator('input').fill('Employee');
      await tab('organization').click(); await field('subsidiary_id').locator('select').selectOption('1');
    } else {
      await field('name').locator('input').fill('Synthetic new other name'); await field('identification').locator('input').fill('SYN-NEW-OTHER');
    }
    await tab('banking').click(); await fillBank();
    await field('payment_beneficiary_name').locator('input').fill('Synthetic account beneficiary');
    if (process.env.ENTITY_BANK_SCREENSHOTS) {
      await mkdir(process.env.ENTITY_BANK_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.ENTITY_BANK_SCREENSHOTS, 'entity-bank-' + catalog.filename + '.png'), fullPage: true });
    }
    await save(); await closed();
    const created = calls.filter(call => call.method === 'POST' && call.path === '/api/entities/' + catalog.slug).at(-1);
    assert.ok(created, catalog.slug + ' create');
    for (const [key, value] of Object.entries(bankValues)) assert.equal(created.payload[key], value, catalog.slug + ' create ' + key);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await selectCatalog(catalogs[0]); await open(); await tab('banking').click();
  const dimensions = await page.locator('.modal').evaluate(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, viewport: innerWidth }; });
  assert.ok(dimensions.left >= -1 && dimensions.right <= dimensions.viewport + 1, JSON.stringify(dimensions));
  assert.equal(await page.locator('.entity-bank-account').count(), 2);
  if (process.env.ENTITY_BANK_SCREENSHOTS) await page.screenshot({ path: join(process.env.ENTITY_BANK_SCREENSHOTS, 'entity-bank-mobile.png'), fullPage: true });
  assert.ok(!calls.some(call => ['/api/banking/banks', '/api/core/currencies', '/api/security/users'].includes(call.path)));
});
