import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const apply = process.argv.includes('--apply');
const verifyOnly = process.argv.includes('--verify');
const dryRun = process.argv.includes('--dry-run');
if (!apply && !verifyOnly && !dryRun) {
  throw new Error('Use --verify para revisar, --dry-run para aplicar y revertir, o --apply para instalar la reclasificación anual de pendientes.');
}
if (!process.env.SUPABASE_URL) throw new Error('Falta SUPABASE_URL en el entorno.');
if (!process.env.SUPABASE_DB_PASSWORD && !process.env.PGPASSWORD) {
  throw new Error('Falta SUPABASE_DB_PASSWORD o PGPASSWORD en el entorno.');
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
  new URL('../supabase/migrations/20261021120000_pending_invoice_annual_reclassification.sql', import.meta.url),
  'utf8',
);

const verificationSql = `
  with definitions as (
    select
      pg_get_functiondef(to_regprocedure('public.pending_invoice_reclassification_candidates(bigint,date)')) candidates,
      pg_get_functiondef(to_regprocedure('public.pending_invoice_reclassification_preview(date)')) preview,
      pg_get_functiondef(to_regprocedure('public.pending_invoice_reclassification_execute(date)')) execute,
      coalesce(pg_get_functiondef(to_regprocedure(
        'public.reverse_pending_invoice_journal_before_historical_fx_integrity(bigint,jsonb)'
      )),pg_get_functiondef(to_regprocedure(
        'public.reverse_pending_invoice_journal(bigint,jsonb)'
      ))) regular_reversal,
      coalesce(pg_get_functiondef(to_regprocedure(
        'public.reverse_opening_pending_invoice_before_historical_fx_integrity(bigint,jsonb)'
      )),pg_get_functiondef(to_regprocedure(
        'public.reverse_opening_pending_invoice(bigint,jsonb)'
      ))) opening_reversal,
      coalesce(pg_get_functiondef(to_regprocedure(
        'public.reverse_pending_invoice_journal(bigint,jsonb)'
      )),'') regular_public,
      coalesce(pg_get_functiondef(to_regprocedure(
        'public.reverse_opening_pending_invoice(bigint,jsonb)'
      )),'') opening_public,
      coalesce(pg_get_functiondef(to_regprocedure(
        'public.reverse_pending_invoice_journal_before_support_integrity(bigint,jsonb)'
      )),'') regular_support,
      coalesce(pg_get_functiondef(to_regprocedure(
        'public.reverse_opening_pending_invoice_before_support_integrity(bigint,jsonb)'
      )),'') opening_support
  ), checks as (
    select * from (values
      ('run table',to_regclass('public.pending_invoice_reclassification_runs') is not null),
      ('item table',to_regclass('public.pending_invoice_reclassification_items') is not null),
      ('journal period type',exists(
        select 1 from information_schema.columns
        where table_schema='public' and table_name='journal' and column_name='pending_period_type'
      )),
      ('journal origin pointer',exists(
        select 1 from information_schema.columns
        where table_schema='public' and table_name='journal' and column_name='pending_origin_journal_id'
      )),
      ('opening period type',exists(
        select 1 from information_schema.columns
        where table_schema='public' and table_name='opening_pending_invoice_items' and column_name='period_type'
      )),
      ('one run per subsidiary and year',exists(
        select 1 from pg_constraint
        where conrelid='public.pending_invoice_reclassification_runs'::regclass
          and contype='u' and pg_get_constraintdef(oid) like '%subsidiary_id, fiscal_year%'
      )),
      ('source XOR',exists(
        select 1 from pg_constraint
        where conrelid='public.pending_invoice_reclassification_items'::regclass
          and contype='c'
          and pg_get_constraintdef(oid)~'source_journal_id IS NOT NULL.*<>.*source_opening_pending_id IS NOT NULL'
      )),
      ('unique journal source',to_regclass('public.pending_reclass_source_journal_unique') is not null),
      ('unique opening source',to_regclass('public.pending_reclass_source_opening_unique') is not null),
      ('RLS runs',(select relrowsecurity from pg_class where oid='public.pending_invoice_reclassification_runs'::regclass)),
      ('RLS items',(select relrowsecurity from pg_class where oid='public.pending_invoice_reclassification_items'::regclass)),
      ('authenticated no direct select runs',not has_table_privilege('authenticated','public.pending_invoice_reclassification_runs','SELECT')),
      ('authenticated no insert runs',not has_table_privilege('authenticated','public.pending_invoice_reclassification_runs','INSERT')),
      ('authenticated no update items',not has_table_privilege('authenticated','public.pending_invoice_reclassification_items','UPDATE')),
      ('authenticated no pending reversal DML',
        not has_table_privilege('authenticated','public.pending_invoice_reversal','INSERT')
        and not has_table_privilege('authenticated','public.pending_invoice_reversal','UPDATE')
        and not has_table_privilege('authenticated','public.pending_invoice_reversal','DELETE')
        and not has_table_privilege('anon','public.pending_invoice_reversal','INSERT,UPDATE,DELETE')),
      ('authenticated no GL impact DML',
        not has_table_privilege('authenticated','public.gl_impact','INSERT')
        and not has_table_privilege('authenticated','public.gl_impact','UPDATE')
        and not has_table_privilege('authenticated','public.gl_impact','DELETE')
        and not has_table_privilege('anon','public.gl_impact','INSERT,UPDATE,DELETE')),
      ('GL rebuild helper private',
        not has_function_privilege('authenticated','public.sync_journal_gl_impacts(bigint)','EXECUTE')
        and not has_function_privilege('anon','public.sync_journal_gl_impacts(bigint)','EXECUTE')),
      ('authenticated preview',has_function_privilege('authenticated','public.pending_invoice_reclassification_preview(date)','EXECUTE')),
      ('authenticated execute',has_function_privilege('authenticated','public.pending_invoice_reclassification_execute(date)','EXECUTE')),
      ('anon no preview',not has_function_privilege('anon','public.pending_invoice_reclassification_preview(date)','EXECUTE')),
      ('anon no execute',not has_function_privilege('anon','public.pending_invoice_reclassification_execute(date)','EXECUTE')),
      ('internal candidates private',not has_function_privilege('authenticated','public.pending_invoice_reclassification_candidates(bigint,date)','EXECUTE')),
      ('internal result private',not has_function_privilege('authenticated','public.pending_invoice_reclassification_execution_result(bigint)','EXECUTE')),
      ('opening stage private for authenticated',not has_function_privilege('authenticated','public.opening_pending_invoice_stage(bigint,jsonb)','EXECUTE')),
      ('opening stage private for anon',not has_function_privilege('anon','public.opening_pending_invoice_stage(bigint,jsonb)','EXECUTE')),
      ('candidate uses primary-book GL',position('gl_impact' in (select candidates from definitions))>0
        and position('debit_amount-impact.credit_amount' in (select candidates from definitions))>0
        and position('debit_fx-impact.credit_fx' in (select candidates from definitions))>0),
      ('strict Jan 1',position('extract(month from p_reclassification_date)<>1' in (select execute from definitions))>0
        and position('extract(day from p_reclassification_date)<>1' in (select execute from definitions))>0),
      ('open GL period required',position('not coalesce(period.gl_closed,false)' in (select execute from definitions))>0),
      ('serialized idempotence',position('pg_advisory_xact_lock' in (select execute from definitions))>0
        and position('alreadyExecuted' in (select execute from definitions))>0),
      ('transaction and FX line snapshots',position('candidate.balance_foreign,0,candidate.balance_foreign,0' in (select execute from definitions))>0
        and position('0,candidate.balance_foreign,0,candidate.balance_foreign' in (select execute from definitions))>0
        and position('candidate.balance_foreign*2' in (select execute from definitions))>0),
      ('four-account movement',position('current_control' in (select execute from definitions))>0
        and position('prior_control' in (select execute from definitions))>0
        and position('bridge_account' in (select execute from definitions))>0),
      ('bridge validates local and FX',position('bridge_foreign_debits-bridge_foreign_credits' in (select execute from definitions))>0
        and position('bridge_debits-bridge_credits' in (select execute from definitions))>0),
      ('support integrity wrappers remain linked',
        (to_regprocedure('public.reverse_pending_invoice_journal_before_support_integrity(bigint,jsonb)') is null
          and to_regprocedure('public.reverse_opening_pending_invoice_before_support_integrity(bigint,jsonb)') is null)
        or(position('reverse_pending_invoice_journal_before_support_integrity' in (select regular_public from definitions))>0
          and position('reverse_opening_pending_invoice_before_support_integrity' in (select opening_public from definitions))>0
          and position('reverse_pending_invoice_journal_before_historical_fx_integrity' in (select regular_support from definitions))>0
          and position('reverse_opening_pending_invoice_before_historical_fx_integrity' in (select opening_support from definitions))>0)),
      ('annual wrappers remain linked',
        (to_regprocedure('public.reverse_pending_invoice_journal_before_historical_fx_integrity(bigint,jsonb)') is null
          and to_regprocedure('public.reverse_opening_pending_invoice_before_historical_fx_integrity(bigint,jsonb)') is null)
        or(position('reverse_pending_invoice_journal_before_historical_fx_integrity' in
            coalesce(nullif((select regular_support from definitions),''),(select regular_public from definitions)))>0
          and position('reverse_opening_pending_invoice_before_historical_fx_integrity' in
            coalesce(nullif((select opening_support from definitions),''),(select opening_public from definitions)))>0)),
      ('regular prior-period reversal',position($needle$period_value='ANTERIOR'$needle$ in (select regular_reversal from definitions))>0
        and position('prior_control' in (select regular_reversal from definitions))>0
        and position('bridge_account' in (select regular_reversal from definitions))>0),
      ('opening prior-period reversal',position($needle$item_row.period_type='ANTERIOR'$needle$ in (select opening_reversal from definitions))>0
        and position('reversal_row.reversed_local' in (select opening_reversal from definitions))>0
        and position('reversal_row.reversed_foreign' in (select opening_reversal from definitions))>0),
      ('metadata protection trigger',exists(
        select 1 from pg_trigger
        where tgrelid='public.journal'::regclass
          and tgname='protect_pending_period_metadata_trigger' and not tgisinternal
      )),
      ('transaction type',exists(select 1 from transaction_types where abbreviation='ASI_RECL_PEN')),
      ('four accounts assigned to active subsidiaries',not exists(
        select 1 from subsidiaries subsidiary
        cross join(values('113003'),('113004'),('413001'),('413002')) required(account_number)
        where subsidiary.is_active and not exists(
          select 1 from chart_accounts account
          join account_subsidiaries assignment using(account_id)
          where account.account_number=required.account_number
            and assignment.subsidiary_id=subsidiary.subsidiary_id
            and assignment.is_active and account.accepts_entries and not account.is_inactive
        )
      ))
    ) result(name,ok)
  )
  select name,ok from checks order by name
`;

async function verify() {
  const result = await db.query(verificationSql);
  const failed = result.rows.filter((row) => !row.ok);
  if (failed.length) {
    throw new Error(`Verificación incompleta: ${failed.map((row) => row.name).join(', ')}.`);
  }
  return result.rows.length;
}

await db.connect();
try {
  if (apply || dryRun) {
    await db.query('begin');
    await db.query("set local lock_timeout='5s'; set local statement_timeout='180s'");
    const newerLayer = (await db.query(`select
      to_regprocedure('public.reverse_pending_invoice_journal_before_support_integrity(bigint,jsonb)') is not null
      or to_regprocedure('public.reverse_opening_pending_invoice_before_support_integrity(bigint,jsonb)') is not null
      or to_regprocedure('public.reverse_pending_invoice_journal_before_historical_fx_integrity(bigint,jsonb)') is not null
      or to_regprocedure('public.reverse_opening_pending_invoice_before_historical_fx_integrity(bigint,jsonb)') is not null value`)).rows[0].value;
    if (!newerLayer) await db.query(migration);
    const count = await verify();
    if (dryRun) {
      await db.query('rollback');
      console.log(`Reclasificación anual validada dentro de una transacción revertida (${count} controles).`);
    } else {
      await db.query('commit');
      const action = newerLayer
        ? 'Reclasificación anual conservada detrás de la capa posterior y verificada'
        : 'Reclasificación anual de pendientes instalada y verificada';
      console.log(`${action} (${count} controles).`);
    }
  } else {
    const count = await verify();
    console.log(`Reclasificación anual de pendientes verificada (${count} controles).`);
  }
} catch (error) {
  if (apply || dryRun) await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
