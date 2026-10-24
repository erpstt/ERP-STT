import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

if (!process.argv.includes('--apply')) {
  throw new Error('Use --apply para instalar permanentemente la migración del auxiliar de pendientes.');
}

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

const migration = await readFile(
  new URL('../supabase/migrations/20261014110000_opening_pending_invoice_auxiliary.sql', import.meta.url),
  'utf8',
);

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='180s'");
  const installationState = (await db.query(`select
    to_regclass('public.opening_pending_invoice_items') is not null items,
    to_regclass('public.opening_pending_invoice_lines') is not null lines,
    to_regprocedure('public.opening_pending_invoice_reconciliation(bigint)') is not null reconciliation,
    to_regprocedure('public.reverse_opening_pending_invoice(bigint,jsonb)') is not null reversal,
    to_regprocedure('public.reverse_opening_pending_invoice_before_historical_fx_integrity(bigint,jsonb)') is not null
      or to_regprocedure('public.reverse_opening_pending_invoice_before_support_integrity(bigint,jsonb)') is not null newer_layer
  `)).rows[0];
  const installed = installationState.items && installationState.lines
    && installationState.reconciliation && installationState.reversal;
  if (!installed && installationState.newer_layer) {
    throw new Error('No se puede instalar el auxiliar base sobre una cadena de reversión más reciente.');
  }
  if (!installed) await db.query(migration);
  const verification = await db.query(`
    select
      to_regclass('public.opening_pending_invoice_items') is not null items,
      to_regclass('public.opening_pending_invoice_lines') is not null lines,
      to_regprocedure('public.opening_pending_invoice_reconciliation(bigint)') is not null reconciliation,
      to_regprocedure('public.reverse_opening_pending_invoice(bigint,jsonb)') is not null reversal,
      (to_regprocedure('public.reverse_opening_pending_invoice_before_support_integrity(bigint,jsonb)') is null
        or position('reverse_opening_pending_invoice_before_support_integrity' in
          pg_get_functiondef('public.reverse_opening_pending_invoice(bigint,jsonb)'::regprocedure))>0) support_wrapper_linked
  `);
  if (!Object.values(verification.rows[0]).every(Boolean)) {
    throw new Error('La migración no creó todos los objetos requeridos.');
  }
  await db.query('commit');
  console.log(installed
    ? 'Auxiliar de Pendientes de Facturar ya estaba activo y fue verificado.'
    : 'Auxiliar de Pendientes de Facturar activado correctamente.');
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
