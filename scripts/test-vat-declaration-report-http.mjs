import assert from 'node:assert/strict';

process.loadEnvFile?.('.env');
if (!process.env.ERP_TEST_EMAIL || !process.env.ERP_TEST_PASSWORD) {
  console.log(JSON.stringify({ skipped: true, reason: 'Configure ERP_TEST_EMAIL y ERP_TEST_PASSWORD para la prueba HTTP autenticada.' }));
  process.exit(0);
}
const base = 'http://localhost:3000';
const deviceToken = `vat-report-http-${Date.now()}-device`;
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: process.env.ERP_TEST_EMAIL,
    password: process.env.ERP_TEST_PASSWORD,
    deviceToken,
    deviceName: 'Prueba automática reporte IVA/GCT',
  }),
});
assert.equal(login.status, 200, await login.text());
const session = await login.json();
assert.ok(session.accessToken);
const headers = { Authorization: `Bearer ${session.accessToken}`, 'X-Device-Token': deviceToken };
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

const selected = await fetch(`${base}/api/auth/select-company`, {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({ subsidiaryId: 3 }),
});
assert.equal(selected.status, 200, await selected.text());

const optionsResponse = await fetch(`${base}/api/v1/reports/tax/vat-declaration/options`, { headers });
assert.equal(optionsResponse.status, 200, await optionsResponse.text());
const options = await optionsResponse.json();
assert.equal(Number(options.subsidiary.id), 3);
assert.equal(options.taxLabel, 'GCT');

const filters = { subsidiaryId: 3, periodMonth: '2026-09', includeAdjustments: true, documentStatuses: ['APROBADO'], priorPeriodCredit: 0 };
const reportResponse = await fetch(`${base}/api/v1/reports/tax/vat-declaration`, {
  method: 'POST', headers: jsonHeaders, body: JSON.stringify(filters),
});
assert.equal(reportResponse.status, 200, await reportResponse.text());
const report = await reportResponse.json();
assert.ok(report.details.length > 0);
assert.equal(Number(report.summary.netTax), 22987.5);

const [pdfResponse, excelResponse] = await Promise.all([
  fetch(`${base}/api/v1/reports/tax/vat-declaration/pdf`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(filters) }),
  fetch(`${base}/api/v1/reports/tax/vat-declaration/excel`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(filters) }),
]);
assert.equal(pdfResponse.status, 200, await pdfResponse.text());
assert.equal(excelResponse.status, 200, await excelResponse.text());
const pdf = Buffer.from(await pdfResponse.arrayBuffer());
const excel = Buffer.from(await excelResponse.arrayBuffer());
assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
assert.equal(excel.subarray(0, 2).toString(), 'PK');
assert.match(pdfResponse.headers.get('content-disposition') || '', /attachment/i);
assert.match(excelResponse.headers.get('content-disposition') || '', /attachment/i);

await fetch(`${base}/api/auth/logout`, { method: 'POST', headers }).catch(() => {});
console.log(JSON.stringify({
  options: 200,
  report: 200,
  pdf: { status: 200, bytes: pdf.length, directDownload: true },
  excel: { status: 200, bytes: excel.length, directDownload: true },
  netTax: report.summary.netTax,
}, null, 2));
