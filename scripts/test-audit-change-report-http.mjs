import assert from 'node:assert/strict';

process.loadEnvFile?.('.env');
if (!process.env.ERP_TEST_EMAIL || !process.env.ERP_TEST_PASSWORD) {
  console.log(JSON.stringify({ skipped: true, reason: 'Configure ERP_TEST_EMAIL y ERP_TEST_PASSWORD para la prueba HTTP autenticada.' }));
  process.exit(0);
}
const base = 'http://localhost:3000';
const deviceToken = `audit-change-report-${Date.now()}`;
const loginResponse = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: process.env.ERP_TEST_EMAIL,
    password: process.env.ERP_TEST_PASSWORD,
    deviceToken, deviceName: 'Validación reporte de auditoría'
  })
});
assert.equal(loginResponse.status, 200, await loginResponse.text());
const session = await loginResponse.json();
const headers = { Authorization: `Bearer ${session.accessToken}`, 'X-Device-Token': deviceToken };
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

try {
  const rolesResponse = await fetch(`${base}/api/auth/roles`, { headers });
  assert.equal(rolesResponse.status, 200, await rolesResponse.text());
  const roles = await rolesResponse.json();
  const role = roles.find(item => String(item.name || '').toLowerCase() === 'administrador') || roles[0];
  assert.ok(role, 'El usuario de prueba no tiene roles.');
  const roleResponse = await fetch(`${base}/api/auth/select-role`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ roleId: role.roleId ?? role.id }) });
  assert.equal(roleResponse.status, 200, await roleResponse.text());

  const companiesResponse = await fetch(`${base}/api/auth/companies`, { headers });
  assert.equal(companiesResponse.status, 200, await companiesResponse.text());
  const companies = await companiesResponse.json();
  assert.ok(companies[0], 'El usuario de prueba no tiene subsidiarias.');
  const companyResponse = await fetch(`${base}/api/auth/select-company`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ subsidiaryId: companies[0].subsidiaryId ?? companies[0].id }) });
  assert.equal(companyResponse.status, 200, await companyResponse.text());

  const optionsResponse = await fetch(`${base}/api/v1/reports/audit/changes/options`, { headers });
  assert.equal(optionsResponse.status, 200, await optionsResponse.text());
  const options = await optionsResponse.json();
  assert.ok(Array.isArray(options.users) && Array.isArray(options.modules) && Array.isArray(options.entityTypes));
  const month = options.months?.[0]?.id || options.defaultMonth;
  assert.match(month, /^\d{4}-\d{2}$/);
  const filters = { month, userId: null, action: null, module: null, entityType: null, search: null, page: 1, pageSize: 25 };
  const reportResponse = await fetch(`${base}/api/v1/reports/audit/changes`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(filters) });
  assert.equal(reportResponse.status, 200, await reportResponse.text());
  const report = await reportResponse.json();
  assert.equal(report.header.month, month);
  assert.ok(Array.isArray(report.rows));
  assert.equal(Number(report.summary.modifiedCount) + Number(report.summary.deletedCount), Number(report.summary.totalEvents));

  const exportFilters = { ...filters, page: undefined, pageSize: undefined };
  const [pdfResponse, excelResponse] = await Promise.all([
    fetch(`${base}/api/v1/reports/audit/changes/pdf`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(exportFilters) }),
    fetch(`${base}/api/v1/reports/audit/changes/excel`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(exportFilters) })
  ]);
  assert.equal(pdfResponse.status, 200, await pdfResponse.text());
  assert.equal(excelResponse.status, 200, await excelResponse.text());
  const pdf = Buffer.from(await pdfResponse.arrayBuffer()), excel = Buffer.from(await excelResponse.arrayBuffer());
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.equal(excel.subarray(0, 2).toString(), 'PK');
  assert.match(pdfResponse.headers.get('content-disposition') || '', /attachment/i);
  assert.match(excelResponse.headers.get('content-disposition') || '', /attachment/i);
  console.log(JSON.stringify({ passed: true, month, events: report.total, operations: report.summary.operationCount, options: 200, report: 200, pdf: { status: 200, bytes: pdf.length }, excel: { status: 200, bytes: excel.length } }));
} finally {
  await fetch(`${base}/api/auth/logout`, { method: 'POST', headers }).catch(() => {});
}
