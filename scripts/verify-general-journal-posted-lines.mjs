import assert from 'node:assert/strict';
import pg from 'pg';

process.loadEnvFile?.('.env');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${ref}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

await db.connect();
try {
  const context = (await db.query(`
    select u.email,session.session_id
    from user_company_sessions session
    join users u using(user_id)
    where session.subsidiary_id=3
    order by session.selected_at desc
    limit 1
  `)).rows[0];
  assert.ok(context);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(context)]);
  const report = (await db.query(
    'select run_general_journal_report($1::jsonb) report',
    [JSON.stringify({
      subsidiaryIds: [3], bookId: 3,
      dateFrom: '2026-09-01', dateTo: '2026-09-30',
      page: 1, pageSize: 100,
    })],
  )).rows[0].report;
  const difference = Number(report.summary.debit) - Number(report.summary.credit);
  const unbalanced = report.rows.filter((row) => Math.abs(Number(row.difference)) >= 0.005);
  assert.equal(Number(report.total), 60);
  assert.ok(Math.abs(difference) < 0.005);
  assert.equal(unbalanced.length, 0);
  assert.ok(report.rows.find((row) => String(row.journal_id) === '46')?.lines
    .some((line) => line.account_number === '215001'));
  console.log(JSON.stringify({
    live: true,
    journals: report.total,
    debit: report.summary.debit,
    credit: report.summary.credit,
    difference,
    unbalancedJournals: unbalanced.length,
    generatedTaxLinesVisible: true,
  }, null, 2));
} finally {
  await db.end();
}
