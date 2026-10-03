import assert from 'node:assert/strict';
import pg from 'pg';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

process.loadEnvFile?.('.env');
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

await db.connect();
let options;
let report;
try {
  const context = (await db.query(`
    select u.email,session.session_id
    from user_company_sessions session join users u using(user_id)
    where session.subsidiary_id=3 order by session.selected_at desc limit 1
  `)).rows[0];
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(context)]);
  options = (await db.query('select vat_declaration_report_options() value')).rows[0].value;
  report = (await db.query('select run_vat_declaration_report($1::jsonb) value', [{
    subsidiaryId: 3,
    periodMonth: '2026-09',
    includeAdjustments: true,
    documentStatuses: ['APROBADO'],
    priorPeriodCredit: 0,
  }])).rows[0].value;
} finally {
  await db.end();
}

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1680, height: 1100 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
await page.addInitScript(() => {
  localStorage.setItem('nexo_token', 'vat-report-ui-token');
  localStorage.setItem('nexo_device_token', 'vat-report-ui-device');
});
let lastFilters;
const reportFor = (filters) => {
  const prior = Number(filters?.priorPeriodCredit || 0);
  const net = Number(report.summary.grossTax) - Number(report.summary.vatWithheldSuffered) - Number(report.summary.vatWithheldPracticed) - prior;
  return { ...report, summary: { ...report.summary, priorPeriodCredit: prior, netTax: net, payableAmount: Math.max(net, 0), favorAmount: Math.max(-net, 0) } };
};
await page.route('**/api/v1/reports/tax/vat-declaration/options', (route) => route.fulfill({ json: options }));
await page.route('**/api/v1/reports/tax/vat-declaration', (route) => {
  lastFilters = route.request().postDataJSON();
  return route.fulfill({ json: reportFor(lastFilters) });
});
await page.route('**/api/v1/reports/tax/vat-declaration/pdf', (route) => route.fulfill({
  status: 200,
  headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="declaracion-gct-2026-09.pdf"' },
  body: Buffer.from('%PDF-1.4\nVAT fixture'),
}));
await page.route('**/api/v1/reports/tax/vat-declaration/excel', (route) => route.fulfill({
  status: 200,
  headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="declaracion-gct-2026-09.xlsx"' },
  body: Buffer.from('PK VAT fixture'),
}));

const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto('http://localhost:3000/');
await page.evaluate(() => {
  localStorage.setItem('nexo_token', 'vat-report-ui-token');
  localStorage.setItem('nexo_device_token', 'vat-report-ui-device');
});
await page.setContent('<iframe id="vat" src="http://localhost:3000/vat-declaration-report.html" style="width:1680px;height:1100px;border:0"></iframe>');
const app = page.frameLocator('#vat');
await app.getByRole('heading', { name: 'Declaración de GCT' }).waitFor();
await app.locator('#periodMonth').fill('2026-09');
await app.locator('#generate').click();
await app.getByText('JAM_GCT_15%', { exact: true }).first().waitFor();

assert.equal(await app.locator('#subsidiary').inputValue(), 'EMPRESA DE PRUEBAS');
assert.equal(await app.locator('#country').inputValue(), 'Jamaica');
assert.ok((await app.locator('#summary').innerText()).includes('J$'));
assert.equal(await app.locator('#salesTable .rate-row').count(), report.sales.rows.length);
assert.equal(await app.locator('#purchasesTable .rate-row').count(), report.purchases.rows.length);
assert.ok((await app.locator('#settlementContent').innerText()).includes('Retenciones de IVA/GCT practicadas'));
assert.ok((await app.locator('#warnings').innerText()).includes('sin código fiscal'));

const gctRow = app.locator('#salesTable .rate-row').filter({ hasText: 'JAM_GCT_15%' }).first();
await gctRow.click();
await app.locator('#detailDialog[open]').waitFor();
assert.ok(await app.locator('#detailRows tr').count() >= 1);
const detailText = await app.locator('#detailDialog').innerText();
assert.ok(detailText.includes('Cliente'));
await app.locator('#closeDetailFooter').click();

await app.locator('#priorPeriodCredit').fill('125');
await app.locator('#generate').click();
await app.getByText('JAM_GCT_15%', { exact: true }).first().waitFor();
assert.equal(lastFilters.subsidiaryId, 3);
assert.equal(lastFilters.periodMonth, '2026-09');
assert.equal(lastFilters.priorPeriodCredit, 125);
assert.deepEqual(lastFilters.documentStatuses, ['APROBADO']);
assert.ok(/22[.\s\u00a0]862,50/.test(await app.locator('#summary').innerText()));

const downloadPromise = page.waitForEvent('download');
await app.locator('#downloadPdf').click();
const download = await downloadPromise;
assert.equal(download.suggestedFilename(), 'declaracion-gct-2026-09.pdf');
await app.getByText('La descarga se generó correctamente.').waitFor();

const bodyText = await app.locator('body').innerText();
assert.deepEqual(['Ãƒ', 'Ã‚', 'â€', 'ï¿½'].filter((token) => bodyText.includes(token)), []);
assert.deepEqual(errors, []);
await page.screenshot({ path: '.tmp/vat-declaration-report-ui.png', fullPage: true });
console.log(JSON.stringify({
  subsidiary: 'EMPRESA DE PRUEBAS',
  country: 'Jamaica',
  salesRates: report.sales.rows.length,
  purchaseRates: report.purchases.rows.length,
  drilldown: true,
  priorCredit: true,
  directDownload: true,
  screenshot: '.tmp/vat-declaration-report-ui.png',
}, null, 2));
await browser.close();
