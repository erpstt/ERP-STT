import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const requests = [];
const fixtures = {
  '/api/security/turnstile/config': { enabled: false },
  '/api/auth/roles': [{ roleId: 1, name: 'Administrador' }],
  '/api/auth/select-role': { roleId: 1, name: 'Administrador' },
  '/api/security/my-role-access': { isAdmin: true, grants: [], modules: [] },
  '/api/auth/companies': [{ subsidiaryId: 1, name: 'Empresa', legalName: 'Empresa', currencyCode: 'CRC' }],
  '/api/auth/select-company': { subsidiaryId: 1, name: 'Empresa', legalName: 'Empresa', currencyCode: 'CRC' },
  '/api/configuration/exchange-rates': [{ exchange_rate_id: 1, from_currency_id: 1, to_currency_id: 2, effective_date: '2026-10-29', spot_rate: 454.82 }],
  '/api/core/currencies': [
    { currency_id: 1, currency_code: 'USD', name: 'Dólar estadounidense' },
    { currency_id: 2, currency_code: 'CRC', name: 'Colón costarricense' }
  ],
  '/api/organization/subsidiaries': [{ subsidiary_id: 1, name: 'Empresa', currency_id: 2, secondary_currency_ids: [1] }]
};

await page.route('**/api/**', async route => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  requests.push({ path, method: request.method() });
  if (path === '/api/configuration/exchange-rates/obtener-cr') {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ guardado: true }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[path] ?? []) });
});
await page.addInitScript(() => {
  const payload = btoa(JSON.stringify({ email: 'rates@example.test', exp: Math.floor(Date.now() / 1000) + 3600 }))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  localStorage.setItem('nexo_token', `e30.${payload}.test`);
  localStorage.setItem('nexo_role', '1');
  localStorage.setItem('nexo_company', '1');
});

try {
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await page.locator('.workspace').waitFor();
  await page.locator('.nav-link').filter({ hasText: 'Configuración' }).click();
  await page.locator('.nav-children a').filter({ hasText: 'Tipos de cambio', hasNotText: 'consolidados' }).click();

  const summary = page.locator('.rate-query-menu > summary');
  await summary.waitFor();
  assert.match((await summary.innerText()).trim(), /Consultar tasa/i, 'La acción principal nunca debe mostrarse sin nombre.');
  const contrast = await summary.evaluate(element => {
    const parse = value => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = value => {
      const channels = parse(value).map(channel => {
        const normalized = channel / 255;
        return normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
      });
      return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
    };
    const style = getComputedStyle(element);
    const foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return { ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05), color: style.color, background: style.backgroundColor };
  });
  assert.ok(contrast.ratio >= 4.5, `El texto del botón debe ser legible (contraste actual ${contrast.ratio.toFixed(2)}; ${contrast.color} sobre ${contrast.background}).`);

  await summary.click();
  const costaRica = page.locator('.rate-query-menu > div button').filter({ hasText: 'Costa Rica' });
  await costaRica.waitFor();
  assert.match((await costaRica.innerText()).trim(), /Costa Rica[\s\S]*USD → CRC/);
  await costaRica.click();
  await page.waitForFunction(() => !document.querySelector('.rate-query-menu')?.hasAttribute('open'));
  assert.ok(requests.some(request => request.method === 'POST' && request.path === '/api/configuration/exchange-rates/obtener-cr'));

  console.log(JSON.stringify({ namedTrigger: true, contrast: contrast.ratio, menuAction: true }));
} finally {
  await browser.close();
}
