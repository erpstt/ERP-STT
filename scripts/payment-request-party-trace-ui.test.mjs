import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from '@playwright/test';

test('comprobantes resuelven Otros Nombres con permisos existentes y conservan referencia si no pueden consultar el catálogo', { timeout: 90000 }, async t => {
  const root = resolve('public');
  const server = createServer(async (request, response) => {
    try {
      const file = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
      if (!file.startsWith(root + sep)) throw Error('Invalid path');
      response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const hostileName = '<img src=x onerror="window.traceXss=true">';
  for (const file of ['journal-view.html', 'bank-check-view.html']) {
    for (const scenario of ['allowed', 'denied', 'missing', 'legacy']) {
      const page = await browser.newPage(), calls = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('nexo_token', 'synthetic-trace-token');
        localStorage.setItem('nexo_device_token', 'synthetic-trace-device');
      });
      const line = {
        journal_line_id: 1, journal_id: 7, check_id: 7, line_number: 1, account_id: 203,
        entity_type: scenario === 'legacy' ? 'Proveedor' : 'Otro Nombre',
        ...(scenario === 'legacy' ? { supplier_id: 10 } : { other_name_id: 801 }),
        debit: 50, credit: 0, debit_fx: 50, credit_fx: 0, amount: 50, note: 'Synthetic posting',
      };
      const fixtures = {
        '/api/accounting/journals': [{ journal_id: 7, journal_number: 'SYN-J-7', journal_type: 'Asiento de egreso', journal_date: '2026-11-02', transaction_id: 8, subsidiary_id: 1, currency_id: 1, total_debit: 50, total_credit: 50, exchange_rate: 1 }],
        '/api/accounting/journal-lines': [line],
        '/api/accounting/gl-impacts': [],
        '/api/accounting/chart-accounts': [{ account_id: 203, account_number: 'SYN-203', account_name: 'Synthetic expense' }],
        '/api/core/currencies': [{ currency_id: 1, name: 'CRC' }],
        '/api/organization/subsidiaries': [{ subsidiary_id: 1, name: 'Synthetic subsidiary' }],
        '/api/entities/suppliers': [{ supplier_id: 10, company_name: 'Synthetic prior supplier' }],
        '/api/banking/checks/7': {
          header: { check_id: 7, check_number: 'SYN-B-7', payment_type: 'TRANSFERENCIA', subsidiaryName: 'Synthetic subsidiary', bankName: 'Synthetic paying bank', accountNumber: 'SYN-ACCOUNT', currencyCode: 'CRC', payment_date: '2026-11-02', bank_reference: 'SYN-REF', beneficiary: 'Synthetic payee', amount: 50 },
          lines: [line], impact: [],
        },
      };
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        calls.push({ path: url.pathname, method: request.method(), auth: request.headers().authorization });
        if (url.pathname === '/api/entities/other-names') {
          if (scenario === 'denied') return route.fulfill({ status: 403, json: { error: { message: 'Synthetic catalog permission denied' } } });
          return route.fulfill({ json: scenario === 'missing' ? [] : [{ other_name_id: 801, name: hostileName, payment_account_number: 'PRIVATE-OTHER-BANK' }] });
        }
        return route.fulfill({ json: fixtures[url.pathname] || [] });
      });
      await page.goto(`${origin}/${file}?id=7`);
      const expected = scenario === 'legacy' ? 'Synthetic prior supplier' : scenario === 'allowed' ? hostileName : 'Otro Nombre #801';
      await page.locator('#lines').getByText(expected, { exact: true }).waitFor();
      assert.equal(await page.locator('#document').isVisible(), true, `${file} ${scenario}`);
      assert.equal(await page.locator('#error').innerText(), '');
      assert.equal(await page.locator('#lines img,#lines script').count(), 0);
      assert.equal(await page.evaluate(() => window.traceXss), undefined);
      assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE-OTHER-BANK/);
      const otherCalls = calls.filter(call => call.path === '/api/entities/other-names');
      assert.equal(otherCalls.length, scenario === 'legacy' ? 0 : 1, `${file} ${scenario}`);
      assert.ok(calls.every(call => call.method === 'GET' && call.auth === 'Bearer synthetic-trace-token'));
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
});
