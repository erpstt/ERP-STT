import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const password = process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD;
if (!process.env.SUPABASE_URL || !password) {
  throw Error('Configure SUPABASE_URL y SUPABASE_DB_PASSWORD antes de aplicar la migración.');
}

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

await client.connect();
try {
  await client.query('begin');
  await client.query("set local lock_timeout='15s'; set local statement_timeout='120s'");
  const sql = await readFile(new URL(
    '../supabase/migrations/20261026190000_automatic_journal_service_month.sql',
    import.meta.url
  ), 'utf8');
  await client.query(sql);

  const verification = (await client.query(`select
      to_regprocedure('public.automatic_journal_service_month(bigint)') is not null helper,
      exists(
        select 1 from pg_trigger
        where tgrelid='public.journal_line'::regclass
          and tgname='enforce_automatic_journal_service_month_trigger'
          and tgenabled<>'D'
      ) line_trigger,
      exists(
        select 1 from pg_trigger
        where tgrelid='public.journal'::regclass
          and tgname='refresh_automatic_journal_service_month_trigger'
          and tgenabled<>'D'
      ) header_trigger,
      to_regprocedure('public.import_journal_csv_before_automatic_service_month(jsonb,boolean,bigint)') is not null importer_backup,
      count(*) filter(
        where automatic_journal_service_month(entry.journal_id) is not null
          and line.service_month is distinct from automatic_journal_service_month(entry.journal_id)
      )::int mismatched_lines
    from public.journal entry
    left join public.journal_line line using(journal_id)`)).rows[0];

  assert.equal(verification.helper, true);
  assert.equal(verification.line_trigger, true);
  assert.equal(verification.header_trigger, true);
  assert.equal(verification.importer_backup, true);
  assert.equal(verification.mismatched_lines, 0);

  const importer = (await client.query(
    "select pg_get_functiondef('public.import_journal_csv_before_automatic_service_month(jsonb,boolean,bigint)'::regprocedure) definition"
  )).rows[0]?.definition || '';
  assert.ok(importer.includes('if rate<=0 then'));
  assert.ok(!importer.includes('expected_rate'));
  assert.ok(!importer.includes('exchange_rates'));

  await client.query('commit');
  console.log(JSON.stringify({
    applied: true,
    lineTrigger: verification.line_trigger,
    headerTrigger: verification.header_trigger,
    csvNormalization: verification.importer_backup,
    mismatchedLines: verification.mismatched_lines,
    templateExchangeRatePreserved: true
  }));
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}
