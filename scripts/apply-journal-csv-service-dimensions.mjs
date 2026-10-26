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
  await client.query("set local lock_timeout='10s'; set local statement_timeout='90s'");
  const sql = await readFile(new URL(
    '../supabase/migrations/20261026193000_normalize_journal_csv_service_dimensions.sql',
    import.meta.url
  ), 'utf8');
  await client.query(sql);

  const activeImporter = (await client.query(
    "select pg_get_functiondef('public.import_journal_csv(jsonb,boolean,bigint)'::regprocedure) definition"
  )).rows[0]?.definition || '';
  const authoritativeImporter = (await client.query(
    "select pg_get_functiondef('public.import_journal_csv_before_automatic_service_month(jsonb,boolean,bigint)'::regprocedure) definition"
  )).rows[0]?.definition || '';

  assert.ok(activeImporter.includes("row_value - 'pais_servicio'") || activeImporter.includes("row_value-'pais_servicio'"));
  assert.ok(activeImporter.includes("jsonb_build_object('mes_servicio', '')") || activeImporter.includes("jsonb_build_object('mes_servicio','')"));
  assert.ok(activeImporter.includes('import_journal_csv_before_automatic_service_month'));
  assert.ok(authoritativeImporter.includes('if rate<=0 then'));
  assert.ok(!authoritativeImporter.includes('expected_rate'));
  assert.ok(!authoritativeImporter.includes('exchange_rates'));

  await client.query('commit');
  console.log(JSON.stringify({
    applied: true,
    automaticCountryIgnored: true,
    automaticMonthPreserved: true,
    pendingDimensionsPreserved: true,
    templateExchangeRatePreserved: true
  }));
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}
