import pg from 'pg';
import { readFile } from 'node:fs/promises';

process.loadEnvFile?.('.env');

if (!process.env.SUPABASE_URL) {
  throw new Error('Falta SUPABASE_URL en el entorno.');
}

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const password = process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD;
if (!password) {
  throw new Error('Falta SUPABASE_DB_PASSWORD o PGPASSWORD en el entorno.');
}

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
  application_name: 'gentia_apply_sales_intercompany_receivable'
});

const migration = await readFile(
  new URL(
    '../supabase/migrations/20261020100000_sales_invoice_intercompany_receivable_account.sql',
    import.meta.url
  ),
  'utf8'
);

const verificationSql = `
  with function_catalog as (
    select
      p.oid,
      p.prosecdef,
      lower(pg_get_functiondef(p.oid)) definition,
      p.proacl,
      p.proowner
    from pg_proc p
    join pg_namespace namespace on namespace.oid=p.pronamespace
    where namespace.nspname='public'
      and p.oid in (
        to_regprocedure('public.resolve_customer_receivable_account(bigint,bigint)'),
        to_regprocedure('public.apply_customer_payment_receivable_accounts(bigint,numeric)'),
        to_regprocedure('public.save_sales_invoice(jsonb,bigint)'),
        to_regprocedure('public.save_sales_note(text,jsonb,bigint)'),
        to_regprocedure('public.save_customer_payment(jsonb,bigint)'),
        to_regprocedure('public.save_customer_payment_with_advances(jsonb,bigint)')
      )
  ),
  target_accounts as (
    select account_id,account_number,accepts_entries,is_inactive,category,nature,
      financial_statement
    from public.chart_accounts
    where account_number in('113001','113002')
  ),
  historical_posting as (
    select invoice.invoice_id,
      coalesce(
        (
          select line.account_id
          from public.journal_line line
          where invoice.opening_balance_line_id is not null
            and line.opening_balance_line_id=invoice.opening_balance_line_id
            and line.customer_id=invoice.customer_id
          order by line.journal_line_id
          limit 1
        ),
        (
          select line.account_id
          from public.journal_line line
          where line.journal_id=invoice.journal_id
            and line.customer_id=invoice.customer_id
            and lower(coalesce(line.note,'')) like 'cuenta por cobrar%'
          order by line.journal_line_id
          limit 1
        )
      ) account_id
    from public.invoice invoice
  )
  select
    exists(
      select 1
      from information_schema.columns
      where table_schema='public'
        and table_name='invoice'
        and column_name='receivable_account_id'
        and data_type='bigint'
    ) invoice_snapshot_column,
    exists(
      select 1
      from pg_constraint constraint_record
      where constraint_record.conrelid='public.invoice'::regclass
        and constraint_record.confrelid='public.chart_accounts'::regclass
        and constraint_record.contype='f'
        and constraint_record.conname='invoice_receivable_account_id_fkey'
        and constraint_record.convalidated
    ) invoice_snapshot_foreign_key,
    to_regclass('public.invoice_receivable_account_idx') is not null
      invoice_snapshot_index,
    to_regprocedure('public.resolve_customer_receivable_account(bigint,bigint)')
      is not null resolver_function,
    to_regprocedure('public.apply_customer_payment_receivable_accounts(bigint,numeric)')
      is not null payment_routing_function,
    to_regprocedure('public.save_sales_invoice_before_intercompany_receivable(jsonb,bigint)')
      is not null invoice_inner_wrapper,
    to_regprocedure('public.save_sales_note_before_intercompany_receivable(text,jsonb,bigint)')
      is not null note_inner_wrapper,
    to_regprocedure('public.save_customer_payment_before_intercompany_receivable(jsonb,bigint)')
      is not null payment_inner_wrapper,
    to_regprocedure('public.save_customer_payment_with_advances_before_intercompany_receivable(jsonb,bigint)')
      is not null payment_advances_inner_wrapper,
    to_regprocedure('public.save_sales_invoice(jsonb,bigint)') is not null
      invoice_public_wrapper,
    to_regprocedure('public.save_sales_note(text,jsonb,bigint)') is not null
      note_public_wrapper,
    to_regprocedure('public.save_customer_payment(jsonb,bigint)') is not null
      payment_public_wrapper,
    to_regprocedure('public.save_customer_payment_with_advances(jsonb,bigint)') is not null
      payment_advances_public_wrapper,
    coalesce((
      select position('is_intercompany' in definition)>0
        and position('113001' in definition)>0
        and position('113002' in definition)>0
        and position('account_subsidiaries' in definition)>0
      from function_catalog
      where oid=to_regprocedure(
        'public.resolve_customer_receivable_account(bigint,bigint)'
      )
    ),false) resolver_rules,
    coalesce((
      select position('resolve_customer_receivable_account' in definition)>0
        and position('receivable_account_id' in definition)>0
        and position('sync_journal_gl_impacts' in definition)>0
      from function_catalog
      where oid=to_regprocedure('public.save_sales_invoice(jsonb,bigint)')
    ),false) invoice_routing,
    coalesce((
      select position('invoice.receivable_account_id' in definition)>0
        and position('sync_journal_gl_impacts' in definition)>0
      from function_catalog
      where oid=to_regprocedure('public.save_sales_note(text,jsonb,bigint)')
    ),false) note_uses_invoice_snapshot,
    coalesce((
      select position('group by invoice.receivable_account_id' in definition)>0
        and position('sync_journal_gl_impacts' in definition)>0
      from function_catalog
      where oid=to_regprocedure(
        'public.apply_customer_payment_receivable_accounts(bigint,numeric)'
      )
    ),false) payment_groups_by_invoice_snapshot,
    coalesce((
      select position('apply_customer_payment_receivable_accounts' in definition)>0
      from function_catalog
      where oid=to_regprocedure('public.save_customer_payment(jsonb,bigint)')
    ),false) payment_routing,
    coalesce((
      select position('apply_customer_payment_receivable_accounts' in definition)>0
      from function_catalog
      where oid=to_regprocedure(
        'public.save_customer_payment_with_advances(jsonb,bigint)'
      )
    ),false) payment_advances_routing,
    (select count(*)=2 from target_accounts) target_accounts_present,
    (
      select count(*)=2
      from target_accounts
      where accepts_entries
        and not is_inactive
        and category='Activo'
        and nature='Deudora'
        and financial_statement='Balance General'
    ) target_accounts_operational,
    not exists(
      select 1
      from public.subsidiaries subsidiary
      cross join target_accounts account
      where subsidiary.is_active
        and not exists(
          select 1
          from public.account_subsidiaries assignment
          where assignment.subsidiary_id=subsidiary.subsidiary_id
            and assignment.account_id=account.account_id
            and assignment.is_active
        )
    ) target_accounts_linked_to_all_active_subsidiaries,
    not exists(
      select 1
      from public.invoice
      where receivable_account_id is null
    ) invoice_backfill_complete,
    not exists(
      select 1
      from public.invoice invoice
      join historical_posting posting using(invoice_id)
      where posting.account_id is not null
        and invoice.receivable_account_id is distinct from posting.account_id
    ) historical_snapshot_matches_posting,
    coalesce((
      select bool_and(prosecdef)
      from function_catalog
    ),false) functions_are_security_definer,
    not has_function_privilege(
      'authenticated',
      'public.resolve_customer_receivable_account(bigint,bigint)',
      'EXECUTE'
    ) resolver_not_exposed,
    not has_function_privilege(
      'authenticated',
      'public.apply_customer_payment_receivable_accounts(bigint,numeric)',
      'EXECUTE'
    ) payment_helper_not_exposed,
    has_function_privilege(
      'authenticated','public.save_sales_invoice(jsonb,bigint)','EXECUTE'
    ) authenticated_invoice_execute,
    has_function_privilege(
      'authenticated','public.save_sales_note(text,jsonb,bigint)','EXECUTE'
    ) authenticated_note_execute,
    has_function_privilege(
      'authenticated','public.save_customer_payment(jsonb,bigint)','EXECUTE'
    ) authenticated_payment_execute,
    has_function_privilege(
      'authenticated',
      'public.save_customer_payment_with_advances(jsonb,bigint)',
      'EXECUTE'
    ) authenticated_payment_advances_execute,
    not has_function_privilege(
      'anon','public.save_sales_invoice(jsonb,bigint)','EXECUTE'
    ) anonymous_invoice_denied,
    not has_function_privilege(
      'anon','public.save_sales_note(text,jsonb,bigint)','EXECUTE'
    ) anonymous_note_denied,
    not has_function_privilege(
      'anon','public.save_customer_payment(jsonb,bigint)','EXECUTE'
    ) anonymous_payment_denied,
    not has_function_privilege(
      'anon',
      'public.save_customer_payment_with_advances(jsonb,bigint)',
      'EXECUTE'
    ) anonymous_payment_advances_denied
`;

await db.connect();
let transactionOpen = false;
try {
  await db.query('begin');
  transactionOpen = true;
  await db.query("set local lock_timeout='5s'; set local statement_timeout='180s'");
  await db.query(
    "select pg_advisory_xact_lock(hashtextextended('20261020100000_sales_invoice_intercompany_receivable_account',0))"
  );
  await db.query(migration);

  const verification = (await db.query(verificationSql)).rows[0];
  const failures = Object.entries(verification)
    .filter(([, value]) => value !== true)
    .map(([name]) => name);

  if (failures.length > 0) {
    throw new Error(
      `La asignación contable de CxC no superó las validaciones: ${failures.join(', ')}. ` +
      `Detalle: ${JSON.stringify(verification)}`
    );
  }

  const metrics = (await db.query(`
    select
      (select count(*)::integer from public.invoice) invoice_snapshots,
      (select count(*)::integer from public.subsidiaries where is_active)
        active_subsidiaries,
      (
        select count(*)::integer
        from public.account_subsidiaries assignment
        join public.chart_accounts account using(account_id)
        join public.subsidiaries subsidiary using(subsidiary_id)
        where account.account_number in('113001','113002')
          and assignment.is_active
          and subsidiary.is_active
      ) active_account_assignments
  `)).rows[0];

  await db.query('commit');
  transactionOpen = false;
  console.log(JSON.stringify({ applied: true, ...verification, ...metrics }));
} catch (error) {
  if (transactionOpen) {
    await db.query('rollback').catch(() => {});
  }
  throw error;
} finally {
  await db.end();
}
