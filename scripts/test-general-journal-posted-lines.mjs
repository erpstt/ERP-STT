import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const migration = await readFile(
  new URL('../supabase/migrations/20261002110000_fix_general_journal_posted_lines.sql', import.meta.url),
  'utf8',
);

await db.connect();
try {
  await db.query('begin');
  await db.query(migration);

  const context = (await db.query(`
    select u.email,session.session_id
    from user_company_sessions session
    join users u using(user_id)
    where session.subsidiary_id=3
    order by session.selected_at desc
    limit 1
  `)).rows[0];
  assert.ok(context, 'No existe una sesión autorizada para la empresa de pruebas.');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);

  const filters = {
    subsidiaryIds: [3],
    bookId: 3,
    dateFrom: '2026-09-01',
    dateTo: '2026-09-30',
    page: 1,
    pageSize: 100,
  };
  const report = (await db.query(
    'select run_general_journal_report($1::jsonb) report',
    [JSON.stringify(filters)],
  )).rows[0].report;

  assert.equal(Number(report.total), 60, 'Cambió la cantidad de comprobantes del período.');
  assert.ok(Math.abs(Number(report.summary.debit) - 4667335.6416) < 0.0001);
  assert.ok(Math.abs(Number(report.summary.credit) - 4667335.6416) < 0.0001);
  assert.ok(report.rows.every((row) => Math.abs(Number(row.difference)) < 0.005));

  const expectedTaxAccounts = new Map([
    ['45', '117001'],
    ['46', '215001'],
    ['158', '215001'],
    ['159', '215001'],
    ['189', '117001'],
    ['190', '117001'],
    ['191', '117001'],
    ['206', '215001'],
  ]);
  for (const [journalId, account] of expectedTaxAccounts) {
    const row = report.rows.find((item) => String(item.journal_id) === journalId);
    assert.ok(row, `No se devolvió el asiento ${journalId}.`);
    assert.ok(
      row.lines.some((line) => line.account_number === account),
      `El asiento ${journalId} no muestra la cuenta fiscal ${account}.`,
    );
  }

  const clientOnly = (await db.query(
    'select run_general_journal_report($1::jsonb) report',
    [JSON.stringify({ ...filters, departmentType: 'Cliente' })],
  )).rows[0].report;
  assert.ok(Number(clientOnly.total) > 0 && Number(clientOnly.total) < Number(report.total));
  assert.ok(clientOnly.rows.every((row) => Math.abs(Number(row.difference)) < 0.005));

  const defaultBook = (await db.query(
    'select run_general_journal_report($1::jsonb) report',
    [JSON.stringify({ ...filters, bookId: null })],
  )).rows[0].report;
  assert.ok(Math.abs(Number(defaultBook.summary.debit) - Number(report.summary.debit)) < 0.0001);
  assert.ok(Math.abs(Number(defaultBook.summary.credit) - Number(report.summary.credit)) < 0.0001);

  console.log(JSON.stringify({
    passed: true,
    rollback: true,
    journals: report.total,
    debit: report.summary.debit,
    credit: report.summary.credit,
    difference: Number(report.summary.debit) - Number(report.summary.credit),
    taxLinesVerified: expectedTaxAccounts.size,
    clientDepartmentJournals: clientOnly.total,
    defaultBookMatchesFiscalBook: true,
  }, null, 2));
  await db.query('rollback');
} catch (error) {
  await db.query('rollback');
  throw error;
} finally {
  await db.end();
}
