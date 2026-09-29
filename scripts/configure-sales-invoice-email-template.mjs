import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

await db.connect();
try {
  await db.query("begin; set local lock_timeout='10s'; set local statement_timeout='90s'");
  const migration = await readFile(
    new URL('../supabase/migrations/20260928130000_sales_invoice_email_template.sql', import.meta.url),
    'utf8'
  );
  await db.query(migration);

  const installed = (await db.query(`
    select
      to_regprocedure('public.sales_invoice_email_settings(text,jsonb)') is not null as function_ready,
      to_regprocedure('public.sales_invoice_delivery_snapshot(bigint)') is not null as delivery_ready,
      count(*) filter (where tipo_notificacion='FACTURA_VENTA')::int as configured_subsidiaries
    from public.configuraciones_correos
  `)).rows[0];
  assert.equal(installed.function_ready, true);
  assert.equal(installed.delivery_ready, true);
  assert.ok(installed.configured_subsidiaries > 0);

  await db.query('commit');
  console.log(JSON.stringify({
    applied: true,
    functionReady: true,
    deliverySnapshotReady: true,
    configuredSubsidiaries: installed.configured_subsidiaries
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
