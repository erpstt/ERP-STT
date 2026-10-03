import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

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

const migration = await readFile(
  new URL('../supabase/migrations/20261002150000_vat_declaration_report.sql', import.meta.url),
  'utf8',
);
const close = (actual, expected, label) => assert.ok(
  Math.abs(Number(actual) - Number(expected)) < 0.0001,
  `${label}: ${actual} != ${expected}`,
);

await db.connect();
try {
  await db.query('begin');
  await db.query(migration);

  const context = (await db.query(`
    select u.email,session.session_id,
      (select auth_user.id::text from auth.users auth_user where lower(auth_user.email)=lower(u.email) limit 1)sub
    from user_company_sessions session
    join users u using(user_id)
    join user_role_sessions role_session using(session_id,user_id)
    join roles role_record using(role_id)
    where session.subsidiary_id=3
      and lower(role_record.role_name) in('administrador','administrator','admin')
    order by session.selected_at desc limit 1
  `)).rows[0];
  assert.ok(context, 'No existe una sesión administrativa activa para la empresa de pruebas.');
  assert.ok(context.sub, 'El usuario administrativo no está vinculado con Auth para la auditoría de la prueba.');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);

  const options = (await db.query('select vat_declaration_report_options() value')).rows[0].value;
  assert.equal(String(options.subsidiary.id), '3');
  assert.equal(options.subsidiary.currencyCode, 'JMD');
  assert.equal(options.taxLabel, 'GCT');
  assert.ok(options.documentStatuses.some((item) => item.value === 'APROBADO'));

  const filters = {
    subsidiaryId: 3,
    periodMonth: '2026-09',
    includeAdjustments: true,
    documentStatuses: ['APROBADO'],
    priorPeriodCredit: 0,
  };
  const report = (await db.query('select run_vat_declaration_report($1::jsonb) value', [filters])).rows[0].value;
  assert.equal(report.header.countryCode, 'JMA');
  assert.equal(report.header.currencyCode, 'JMD');
  assert.ok(Array.isArray(report.sales.rows) && report.sales.rows.length >= 1);
  assert.ok(Array.isArray(report.purchases.rows) && report.purchases.rows.length >= 1);
  assert.ok(Array.isArray(report.details) && report.details.length >= 1);
  assert.ok(report.sales.rows.some((row) => row.taxCode === 'JAM_GCT_15%'));

  const detailTotals = report.details.reduce((sum, row) => {
    const target = row.side === 'SALES' ? sum.sales : sum.purchases;
    target.base += Number(row.baseAmount);
    target.tax += Number(row.taxAmount);
    target.gross += Number(row.grossAmount);
    return sum;
  }, { sales: { base: 0, tax: 0, gross: 0 }, purchases: { base: 0, tax: 0, gross: 0 } });
  close(report.summary.salesBase, detailTotals.sales.base, 'Base de ventas');
  close(report.summary.salesTax, detailTotals.sales.tax, 'GCT débito');
  close(report.summary.salesGross, detailTotals.sales.gross, 'Ventas brutas');
  close(report.summary.purchaseBase, detailTotals.purchases.base, 'Base de compras');
  close(report.summary.purchaseTax, detailTotals.purchases.tax, 'GCT crédito');
  close(report.summary.purchaseGross, detailTotals.purchases.gross, 'Compras brutas');
  close(report.summary.grossTax, Number(report.summary.salesTax) - Number(report.summary.purchaseTax), 'Impuesto bruto');
  close(
    report.summary.netTax,
    Number(report.summary.grossTax) - Number(report.summary.vatWithheldSuffered) - Number(report.summary.vatWithheldPracticed),
    'Posición neta',
  );

  const purchaseCodeId = report.purchases.rows.find((row) => Number(row.taxAmount) > 0)?.taxCodeId;
  assert.ok(purchaseCodeId, 'La prueba requiere un código de compra con crédito fiscal.');

  await db.query('savepoint vat_non_creditable');
  await db.query('update tax_codes set is_purchase_creditable=false where tax_code_id=$1', [purchaseCodeId]);
  const nonCreditable = (await db.query(
    'select run_vat_declaration_report($1::jsonb) value',
    [filters],
  )).rows[0].value;
  close(nonCreditable.summary.purchaseTax, 0, 'Crédito fiscal no acreditable excluido');
  close(nonCreditable.summary.excludedPurchaseTax, report.summary.purchaseTax, 'Impuesto no acreditable trazable');
  assert.ok(nonCreditable.summary.warnings.some((warning) => warning.includes('no acreditable')));
  await db.query('rollback to savepoint vat_non_creditable');

  await db.query('savepoint vat_import_code');
  await db.query('update tax_codes set is_import_tax=true where tax_code_id=$1', [purchaseCodeId]);
  const importReport = (await db.query(
    'select run_vat_declaration_report($1::jsonb) value',
    [filters],
  )).rows[0].value;
  assert.ok(importReport.purchases.rows.some((row) => row.isImportTax && row.description.includes('Importación')));
  await db.query('rollback to savepoint vat_import_code');

  const noCodeLine = (await db.query(`
    select line.line_id
    from sales_invoice_line line join invoice document using(invoice_id)
    where document.subsidiary_id=3 and document.invoice_date between date '2026-09-01' and date '2026-09-30'
      and line.tax_code_id is null
    order by line.line_id limit 1
  `)).rows[0];
  assert.ok(noCodeLine, 'La prueba requiere una línea de venta sin código fiscal.');
  await db.query('savepoint vat_without_code');
  await db.query('update sales_invoice_line set tax_amount=88.88,gross_amount=amount+88.88 where line_id=$1', [noCodeLine.line_id]);
  const noCodeTax = (await db.query(
    'select run_vat_declaration_report($1::jsonb) value',
    [filters],
  )).rows[0].value;
  close(noCodeTax.summary.salesTax, report.summary.salesTax, 'Impuesto sin código excluido');
  close(noCodeTax.summary.excludedSalesTax, 88.88, 'Impuesto sin código trazable');
  assert.ok(noCodeTax.summary.warnings.some((warning) => warning.includes('sin código fiscal')));
  await db.query('rollback to savepoint vat_without_code');

  const noAdjustments = (await db.query(
    'select run_vat_declaration_report($1::jsonb) value',
    [{ ...filters, includeAdjustments: false }],
  )).rows[0].value;
  assert.ok(noAdjustments.details.every((row) => row.documentType === 'INVOICE'));
  assert.ok(noAdjustments.summary.lineCount <= report.summary.lineCount);

  const priorCredit = 123.45;
  const withCredit = (await db.query(
    'select run_vat_declaration_report($1::jsonb) value',
    [{ ...filters, priorPeriodCredit: priorCredit }],
  )).rows[0].value;
  close(withCredit.summary.netTax, Number(report.summary.netTax) - priorCredit, 'Arrastre de saldo anterior');
  assert.ok(withCredit.summary.warnings.some((warning) => warning.includes('manualmente')));

  await assert.rejects(
    db.query('select run_vat_declaration_report($1::jsonb)', [{ ...filters, subsidiaryId: 1 }]),
    /empresa activa/i,
  );

  console.log(JSON.stringify({
    passed: true,
    rollback: true,
    period: report.header.periodMonth,
    salesTax: report.summary.salesTax,
    purchaseTax: report.summary.purchaseTax,
    withheldSuffered: report.summary.vatWithheldSuffered,
    withheldPracticed: report.summary.vatWithheldPracticed,
    netTax: report.summary.netTax,
    detailLines: report.summary.lineCount,
    taxRates: {
      sales: report.sales.rows.map((row) => row.taxCode),
      purchases: report.purchases.rows.map((row) => row.taxCode),
    },
  }, null, 2));
} finally {
  await db.query('rollback').catch(() => {});
  await db.end();
}
