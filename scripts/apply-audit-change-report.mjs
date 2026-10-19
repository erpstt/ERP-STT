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

const migration = (await Promise.all([
  '20261019110000_audit_change_report.sql',
  '20261019120000_optimize_audit_change_report.sql',
  '20261019130000_audit_transaction_change_report.sql'
].map(file => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')))).join('\n');

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='120s'");
  await db.query(migration);
  const check = (await db.query(`select
    to_regprocedure('public.audit_change_report_options()') is not null options_rpc,
    to_regprocedure('public.run_audit_change_report(jsonb)') is not null report_rpc,
    position('audit:change-report' in pg_get_functiondef('public.run_audit_change_report(jsonb)'::regprocedure))>0 role_guard,
    position('America/Costa_Rica' in pg_get_functiondef('public.run_audit_change_report(jsonb)'::regprocedure))>0 local_month_range,
    position('execution_context_id' in pg_get_functiondef('public.run_audit_change_report(jsonb)'::regprocedure))>0 operation_metric,
    position('audit_change_transaction_identity' in pg_get_functiondef('public.run_audit_change_report(jsonb)'::regprocedure))>0 transaction_identity,
    to_regprocedure('public.audit_change_historical_row(text,bigint,text,bigint,jsonb)') is not null historical_snapshot,
    to_regprocedure('public.audit_change_transaction_parent(text,bigint,text,jsonb,text,bigint)') is not null child_parent_mapping,
    to_regprocedure('public.audit_change_transaction_identities_related(jsonb,jsonb)') is not null related_identity_guard,
    position('user_subsidiaries' in pg_get_functiondef('public.run_audit_change_report(jsonb)'::regprocedure))>0 subsidiary_scope,
    to_regprocedure('public.audit_change_transaction_meta(text)') is not null transaction_taxonomy,
    to_regclass('public.audit_log_change_options_idx') is not null options_index,
    to_regclass('public.audit_log_transaction_change_idx') is not null transaction_index,
    to_regclass('public.audit_log_transaction_child_change_idx') is not null child_transaction_index,
    to_regclass('public.change_log_meaningful_event_idx') is not null meaningful_change_index,
    to_regprocedure('public.audit_has_direct_read(text)') is not null direct_read_guard,
    (select count(*)=5 from pg_policies where schemaname='public'
      and tablename=any(array['audit_log','change_log','event_log','activity_log','deleted_records'])
      and policyname='audit_select' and coalesce(qual,'')like'%audit_has_direct_read%') protected_audit_tables
  `)).rows[0];
  if (Object.values(check).some(value => value !== true)) {
    throw new Error('El reporte de auditoría no quedó instalado con todas sus validaciones.');
  }
  await db.query('commit');
  console.log(JSON.stringify({ applied: true, ...check }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
