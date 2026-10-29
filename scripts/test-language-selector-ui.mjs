import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
let serverLocale = 'es';
const preferenceUpdates = [];
const languages = [
  { languageId: 3, locale: 'es', code: '1', isoCode: 'SPA', name: 'Español', isActive: true },
  { languageId: 4, locale: 'en', code: '2', isoCode: 'ENG', name: 'Inglés', isActive: true },
  { languageId: 5, locale: 'pt', code: '3', isoCode: 'POR', name: 'Portugués', isActive: true }
];
const fixtures = {
  '/api/security/turnstile/config': { enabled: false },
  '/api/auth/roles': [{ roleId: 1, name: 'Administrador' }],
  '/api/auth/select-role': { roleId: 1, name: 'Administrador' },
  '/api/security/my-role-access': { isAdmin: true, grants: [], modules: [] },
  '/api/auth/companies': [{ subsidiaryId: 1, name: 'EMPRESA DE PRUEBAS', legalName: 'EMPRESA DE PRUEBAS', currencyCode: 'CRC' }],
  '/api/auth/select-company': { subsidiaryId: 1, name: 'EMPRESA DE PRUEBAS', legalName: 'EMPRESA DE PRUEBAS', currencyCode: 'CRC' },
  '/api/organization/subsidiaries': [{ subsidiary_id: 1, name: 'EMPRESA DE PRUEBAS', currency_id: 1, secondary_currency_ids: [] }]
};

await page.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (path === '/api/auth/language-preference') {
    if (request.method() === 'PATCH') {
      const payload = request.postDataJSON();
      serverLocale = payload.locale;
      preferenceUpdates.push(payload.locale);
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ locale: serverLocale, languages }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[path] ?? []) });
});
await page.addInitScript(() => {
  const payload = btoa(JSON.stringify({ email: 'i18n@example.test', session_id: 'i18n-ui', exp: Math.floor(Date.now() / 1000) + 3600 }))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  localStorage.setItem('nexo_token', `e30.${payload}.test`);
  localStorage.setItem('nexo_role', '1');
  localStorage.setItem('nexo_company', '1');
});

try {
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  const selector = page.locator('.language-selector');
  await selector.waitFor();
  assert.match(await selector.locator('summary').innerText(), /IDIOMA[\s\S]*Español/);

  await selector.locator('summary').click();
  await selector.locator('button').filter({ hasText: 'English' }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en' && localStorage.getItem('gentia_language') === 'en');
  assert.equal((await page.locator('.company-switch-single small').innerText()).trim(), 'ACTIVE COMPANY');
  assert.equal((await page.locator('.role-switch-single small').innerText()).trim(), 'ACTIVE ROLE');
  assert.deepEqual(preferenceUpdates, ['en']);

  await page.evaluate(() => {
    const table = document.createElement('table');
    table.id = 'i18n-data-safety';
    table.innerHTML = '<tbody><tr><td class="business-value">Ventas</td><td><button>Editar</button></td></tr></tbody>';
    document.body.append(table);
    const dynamicData = document.createElement('section');
    dynamicData.id = 'i18n-dynamic-data-safety';
    dynamicData.innerHTML = '<span class="business-name">Ventas</span><select><option>Cliente</option></select><span class="explicit-ui" data-i18n="navigation.sales">Ventas</span>';
    document.body.append(dynamicData);
  });
  await page.waitForFunction(() => document.querySelector('#i18n-data-safety button')?.textContent === 'Edit');
  await page.waitForFunction(() => document.querySelector('#i18n-dynamic-data-safety .explicit-ui')?.textContent === 'Sales');
  assert.equal((await page.locator('#i18n-data-safety .business-value').textContent()).trim(), 'Ventas');
  assert.equal((await page.locator('#i18n-dynamic-data-safety .business-name').textContent()).trim(), 'Ventas');
  assert.equal((await page.locator('#i18n-dynamic-data-safety option').textContent()).trim(), 'Cliente');

  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'i18n-workspace-probe';
    frame.src = '/accounting-reports.html';
    document.body.append(frame);
  });
  const workspace = page.frameLocator('#i18n-workspace-probe');
  await workspace.locator('#fromLabel').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('#i18n-workspace-probe')?.contentDocument?.documentElement.lang === 'en');
  assert.match((await workspace.locator('#fromLabel').textContent()).trim(), /^From/);

  await selector.locator('summary').click();
  await selector.locator('button').filter({ hasText: 'Português' }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'pt' && localStorage.getItem('gentia_language') === 'pt');
  assert.equal((await page.locator('.company-switch-single small').innerText()).trim(), 'EMPRESA ATIVA');
  assert.equal((await page.locator('.role-switch-single small').innerText()).trim(), 'FUNÇÃO ATIVA');
  assert.deepEqual(preferenceUpdates, ['en', 'pt']);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.language-selector').waitFor();
  await page.waitForFunction(() => document.documentElement.lang === 'pt');
  assert.match(await page.locator('.language-selector summary').innerText(), /IDIOMA[\s\S]*Português/);
  await page.evaluate(() => {
    window.GentiaI18n.setLocale = async () => 'es';
  });
  await page.locator('.language-selector summary').click();
  await page.locator('.language-selector button').filter({ hasText: 'English' }).click();
  await page.waitForFunction(() => document.querySelector('.language-menu-error')?.textContent.includes('continúa en Español'));
  assert.match(await page.locator('.language-menu-error').textContent(), /continúa en Español/);
  assert.equal(preferenceUpdates.at(-1), 'en', 'El aviso de traducción debe conservarse aunque la preferencia remota se guarde.');
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ catalogOptions: 3, english: true, portuguese: true, dataSafe: true, fallback: true, workspace: true, persisted: true }));
} finally {
  await browser.close();
}
