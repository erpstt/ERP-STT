import assert from 'node:assert/strict';
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

await db.connect();
try {
  const context = (await db.query(`
    select u.email,session.session_id
    from user_company_sessions session join users u using(user_id)
    where session.subsidiary_id=3 order by session.selected_at desc limit 1
  `)).rows[0];
  assert.ok(context);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(context)]);
  const functions = (await db.query(`
    select proname from pg_proc join pg_namespace on pg_namespace.oid=pronamespace
    where nspname='public' and proname in('vat_declaration_report_options','run_vat_declaration_report')
  `)).rows.map((row) => row.proname);
  assert.deepEqual(new Set(functions), new Set(['vat_declaration_report_options', 'run_vat_declaration_report']));
  const report = (await db.query('select run_vat_declaration_report($1::jsonb) value', [{
    subsidiaryId: 3,
    periodMonth: '2026-09',
    includeAdjustments: true,
    documentStatuses: ['APROBADO'],
    priorPeriodCredit: 0,
  }])).rows[0].value;
  assert.ok(report.details.length > 0);
  assert.equal(Number(report.summary.netTax), Number(report.summary.grossTax) - Number(report.summary.vatWithheldSuffered) - Number(report.summary.vatWithheldPracticed));
  console.log(JSON.stringify({
    active: true,
    subsidiary: report.header.subsidiaryName,
    period: report.header.periodMonth,
    salesTax: report.summary.salesTax,
    purchaseTax: report.summary.purchaseTax,
    withheldPracticed: report.summary.vatWithheldPracticed,
    netTax: report.summary.netTax,
    detailLines: report.details.length,
  }, null, 2));
} finally {
  await db.end();
}
