import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { PdfRenderGate, pdfProcessEnvironment, preparePdfHtml, renderSafePdf } from '../dist/core/security/pdf-renderer.js';
import { renderAccountingPdf, validateAccountingPdfRequest } from '../dist/modules/reports/accounting-pdf.service.js';
import { primeRoleAccessCache, invalidateRoleAccessCaches } from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import { bankCloseReportHtml, bankBalancesPdfHtml } from '../public/bank-report-pdf.js';

test('rechaza HTML del cliente antes de consultar datos o lanzar Chrome', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = () => { throw Error('No debe consultar servicios'); };
  for (const kind of ['bank', 'pending', 'forecast']) {
    await assert.rejects(renderAccountingPdf('Bearer fixture', kind, { html: '<!doctype html><iframe src="file:///secret">', fileName: 'x.pdf' }), error => error.status === 400);
    assert.throws(() => validateAccountingPdfRequest(kind, null), error => error.status === 400);
  }
  assert.throws(() => validateAccountingPdfRequest('bank', { kind: 'bank-reconciliation', bankAccountId: 1, cutoff: '2026-10-30', mode: '<script>' }), error => error.status === 400);
});

test('niega la generación a un rol sin lectura de informes antes de consultar saldos', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; invalidateRoleAccessCaches(); });
  await primeRoleAccessCache('Bearer pdf-reader-denied', { isAdmin: false, grants: [] });
  globalThis.fetch = () => { throw Error('No debe consultar saldos'); };
  await assert.rejects(renderAccountingPdf('Bearer pdf-reader-denied', 'bank', { kind: 'bank-balances', filters: { subsidiaryIds: [1] } }), error => error.status === 403);
});

test('retira ejecución, archivos, marcos y recursos remotos conservando tablas e imágenes raster embebidas', () => {
  const safe = preparePdfHtml('<!doctype html><html><head><base href="file:///"><meta http-equiv="refresh" content="0;url=http://127.0.0.1/"></head><body><script>fetch("http://internal/")</script><iframe src="file:///proc/self/environ"></iframe><object data="file:///secret"></object><img src="http://169.254.169.254/latest/meta-data" onerror="alert(1)"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="data:image/png;base64,aGVsbG8="><table><tr><td>Importe 120</td></tr></table></body></html>');
  assert.doesNotMatch(safe, /<(?:script|iframe|object|base)\b|onerror=|file:\/\/|169\.254|http-equiv="refresh"|image\/svg/i);
  assert.match(safe, /Content-Security-Policy/);
  assert.match(safe, /default-src 'none'/);
  assert.match(safe, /data:image\/png;base64,aGVsbG8=/);
  assert.match(safe, /<td>Importe 120<\/td>/);
  assert.throws(() => preparePdfHtml('<!doctype html>' + 'x'.repeat(4_000_001)), error => error.status === 400);
});

test('el proceso PDF no recibe secretos del entorno de la aplicación', t => {
  const names = ['SUPABASE_SERVICE_ROLE_KEY', 'SMTP_PASSWORD', 'BCCR_TOKEN', 'SUPABASE_DB_PASSWORD', 'HTTP_PROXY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
  for (const name of names) process.env[name] = 'secret-test-fixture';
  const env = pdfProcessEnvironment('/isolated-pdf');
  for (const name of names) assert.equal(env[name], undefined);
  assert.notEqual(env.HOME, process.env.HOME);
});

test('la cola limita capacidad, conserva cupos al transferirlos y vence esperas', async () => {
  const gate = new PdfRenderGate(1, 1, 30);
  const first = await gate.acquire(), waiting = gate.acquire();
  await assert.rejects(gate.acquire(), error => error.status === 503);
  first(); first();
  const second = await waiting;
  await assert.rejects(gate.acquire(), error => error.status === 503);
  second();
  const final = await gate.acquire(); final();
});

test('las plantillas bancarias mantienen importes, formato y texto escapado sin depender del DOM', () => {
  const html = bankCloseReportHtml({ header: { account: 'DEMO-1234', currencyName: 'Dólar', currency: 'USD', bank: '<img src=x>', createdBy: 'Contador' }, summary: { bookBalance: 100, statementBalance: 100, difference: 0 }, movements: [{ amount: 100, beneficiary: '<script>x</script>' }] }, 'DETAIL');
  assert.match(html, /INFORME DE CONCILIACIÓN BANCARIA/);
  assert.match(html, /DEMO-1234/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(bankBalancesPdfHtml({ localCurrency: { code: 'USD' }, localAccounts: [], foreignAccounts: [], summary: {} }, { name: 'Empresa' }), /INFORME DE SALDOS BANCARIOS/);
});

test('las rutas HTTP rechazan HTML, exceso de tamaño y roles sin permiso con Supabase simulado', { timeout: 20_000 }, async t => {
  let dataQueries = 0;
  const stub = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== '/rest/v1/rpc/assert_request_access') { dataQueries++; response.writeHead(500); response.end('{}'); return; }
    response.end(JSON.stringify({ allowed: true, roleAccess: { isAdmin: false, grants: [{ resourceKey: 'reports:accounting-reports', canView: !request.headers.authorization.includes('denied'), canCreate: false, canEdit: false, canDelete: false }] } }));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { stub.closeAllConnections(); stub.close(resolve); }));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, PORT: String(port), DISABLE_BACKGROUND_JOBS: 'true', SUPABASE_URL: `http://127.0.0.1:${stub.address().port}`, SUPABASE_ANON_KEY: 'public-fixture', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture', AUTH_REQUEST_ACCESS_CACHE_TTL_MS: '0' }, stdio: 'ignore' });
  t.after(() => { child.kill(); });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(base + '/api/health'); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'El servidor HTTP de prueba debe iniciar');
  const headers = { Authorization: 'Bearer pdf-http-fixture', 'X-Device-Token': 'pdf-http-device-token-fixture', 'Content-Type': 'application/json' };
  for (const path of ['/api/reports/accounting/bank-reconciliation/pdf', '/api/reports/accounting/pending-invoice-control/pdf', '/api/reports/income-forecast/pdf']) {
    const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify({ html: '<!doctype html><iframe src="file:///secret">' }) });
    assert.equal(response.status, 400, path);
  }
  const excessive = await fetch(base + '/api/reports/accounting/bank-reconciliation/pdf', { method: 'POST', headers, body: JSON.stringify({ html: 'x'.repeat(128 * 1024) }) });
  assert.equal(excessive.status, 413);
  const denied = await fetch(base + '/api/reports/accounting/bank-reconciliation/pdf', { method: 'POST', headers: { ...headers, Authorization: 'Bearer pdf-http-denied-fixture' }, body: JSON.stringify({ kind: 'bank-balances', filters: { subsidiaryIds: [1] } }) });
  assert.equal(denied.status, 403);
  const anonymous = await fetch(base + '/api/reports/accounting/bank-reconciliation/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anonymous.status, 401);
  assert.equal(dataQueries, 0, 'Los rechazos deben ocurrir antes de consultar datos financieros');
});

test('Chrome genera un PDF con sandbox y no alcanza servicios locales desde HTML/CSS', { skip: process.env.PDF_SECURITY_BROWSER_TESTS !== 'true', timeout: 90_000 }, async t => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('must-not-read'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const pdf = await renderSafePdf(`<!doctype html><html><head><style>@import url(http://127.0.0.1:${port}/css);body{background-image:url(http://127.0.0.1:${port}/image)}</style></head><body><script>fetch('http://127.0.0.1:${port}/script')</script><iframe src="file:///proc/self/environ"></iframe><img src="http://127.0.0.1:${port}/logo"><h1>Reporte seguro</h1><table><tr><td>123.45</td></tr></table></body></html>`);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 1000);
  assert.equal(requests, 0);
});

test('los cuatro PDF consultan datos con el JWT del actor y generan descargas sin HTML del cliente', { skip: process.env.PDF_SECURITY_BROWSER_TESTS !== 'true', timeout: 90_000 }, async t => {
  const originalFetch = globalThis.fetch, originalUrl = process.env.SUPABASE_URL, originalKey = process.env.SUPABASE_ANON_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch; invalidateRoleAccessCaches();
    for (const [name, value] of [['SUPABASE_URL', originalUrl], ['SUPABASE_ANON_KEY', originalKey]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.SUPABASE_URL = 'https://pdf-fixture.invalid'; process.env.SUPABASE_ANON_KEY = 'public-fixture';
  const auth = 'Bearer pdf-authorized-fixture';
  await primeRoleAccessCache(auth, { isAdmin: false, grants: [{ resourceKey: 'reports:accounting-reports', canView: true }] });
  const options = { subsidiaries: [{ id: 1, name: 'Empresa de prueba', currencyId: 1 }], currencies: [{ id: 1, code: 'USD', name: 'Dólar', symbol: '$' }], years: [{ id: 1, name: '2026' }], scenarios: [], pendingInvoiceOptions: { customers: [] } };
  const source = { start: '2026-01-01', end: '2026-12-31', cutoff: '2026-08-31', companies: [{ id: 1, name: 'Empresa de prueba', currencyId: 1 }], currencies: [{ id: 1, code: 'USD' }], accounts: [{ id: 10, number: '4001', name: 'Ventas', category: 'Ingreso', groupId: 1 }], groups: [{ id: 1, code: '4', name: 'Ingresos', level: 1 }], facts: [{ subsidiary_id: 1, account_id: 10, month: '2026-01-01', amount: -800 }], budgets: [], rates: [], consolidatedRates: [] };
  const fixtures = {
    accounting_report_options_bundle: options,
    bank_reconciliation_close_report: { result: { header: { code: 'CON-BAN-TEST', account: 'DEMO-1234' }, summary: { difference: 0 } } },
    run_bank_balance_period_report: { period: { end: '2026-08-31' }, localCurrency: { code: 'USD' }, localAccounts: [{ bank: 'Banco', account: 'DEMO-1234', currency: 'USD', balance: 100, localEquivalent: 100 }], summary: {} },
    run_pending_invoice_control_report: { rows: [{ status: 'PENDIENTE', initial: 100, reversed: 20, balance: 80, customer: 'Cliente de prueba', history: [] }] },
    income_forecast_options: options, income_forecast_source: source,
  };
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).pathname.split('/').at(-1);
    assert.equal(new Headers(init.headers).get('Authorization'), auth);
    assert.ok(Object.hasOwn(fixtures, name), `RPC inesperada: ${name}`);
    assert.doesNotMatch(init.body, /<!doctype|<iframe|<script/i);
    calls.push(name); return Response.json(fixtures[name]);
  };
  const filters = { subsidiaryIds: [1], dateFrom: '2026-08-01', dateTo: '2026-08-31' };
  for (const [kind, input, expected] of [
    ['bank', { kind: 'bank-reconciliation', bankAccountId: 7, cutoff: '2026-08-31', mode: 'DETAIL' }, 'CON-BAN-TEST-detallado.pdf'],
    ['bank', { kind: 'bank-balances', filters }, 'saldos-bancarios-2026-08-31.pdf'],
    ['pending', { filters, closed: false, periodType: '' }, 'control-pendientes-pendientes-parciales-2026-08-31.pdf'],
    ['forecast', { configuration: { method: 'RUN_RATE', columnView: 'ACCOUNTING_PERIOD', hierarchy: 4, fiscalYearId: 1 }, scenarioId: null }, 'resultados-proyectados-2026-08-31.pdf'],
  ]) {
    const file = await renderAccountingPdf(auth, kind, input);
    assert.equal(file.fileName, expected);
    assert.equal(Buffer.from(file.base64, 'base64').subarray(0, 4).toString(), '%PDF');
  }
  assert.ok(calls.includes('income_forecast_source'));
  assert.ok(calls.includes('run_pending_invoice_control_report'));
});
