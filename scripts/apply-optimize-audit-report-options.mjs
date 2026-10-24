import pg from 'pg';
import { readFile } from 'node:fs/promises';

process.loadEnvFile?.('.env');
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

const migration = await readFile(new URL(
  '../supabase/migrations/20261023170000_optimize_audit_report_options.sql',
  import.meta.url
), 'utf8');

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='30s'");
  await db.query(migration);
  const check = (await db.query(`select
    to_regprocedure('public.audit_change_report_options()') is not null options_rpc,
    position('audit_change_transaction_parent' in pg_get_functiondef(
      'public.audit_change_report_options()'::regprocedure
    ))=0 avoids_per_event_parent_lookup,
    position('generate_series' in pg_get_functiondef(
      'public.audit_change_report_options()'::regprocedure
    ))>0 lightweight_month_catalog,
    obj_description('public.audit_change_report_options()'::regprocedure,'pg_proc')
      like 'Opciones livianas%' documented
  `)).rows[0];
  if (Object.values(check).some(value => value !== true)) {
    throw new Error('La optimización de opciones de auditoría no superó sus verificaciones.');
  }
  await db.query('commit');
  console.log(JSON.stringify({ applied: true, ...check }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
