import { readFile } from 'node:fs/promises';
import pg from 'pg';

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
  application_name: 'gentia_apply_supplier_payable_routing'
});

const migration = await readFile(
  new URL(
    '../supabase/migrations/20261020110000_supplier_invoice_payable_account_routing.sql',
    import.meta.url
  ),
  'utf8'
);

const verificationSql = `
  with function_catalog as (
    select p.oid,p.prosecdef,lower(pg_get_functiondef(p.oid)) definition
    from pg_proc p
    join pg_namespace namespace on namespace.oid=p.pronamespace
    where namespace.nspname='public'
      and p.oid in (
        to_regprocedure('public.resolve_supplier_payable_account(bigint,bigint,text)'),
        to_regprocedure('public.ensure_supplier_invoice_payable_account(bigint)'),
        to_regprocedure('public.apply_supplier_payment_payable_accounts(bigint,numeric)'),
        to_regprocedure('public.protect_applied_supplier_advance()'),
        to_regprocedure('public.save_supplier_invoice_without_budget(jsonb,bigint)'),
        to_regprocedure('public.save_supplier_note(text,jsonb,bigint)'),
        to_regprocedure('public.save_supplier_payment(jsonb,bigint)'),
        to_regprocedure('public.save_supplier_payment_with_advances(jsonb,bigint)')
      )
  ),
  target_accounts as (
    select account_id,account_number,accepts_entries,is_inactive,category,nature,
      financial_statement
    from public.chart_accounts
    where account_number in('211001','211002','211003','211004')
  ),
  historical_posting as (
    select invoice.invoice_id,
      coalesce(
        (
          select line.account_id
          from public.journal_line line
          where invoice.opening_balance_line_id is not null
            and line.opening_balance_line_id=invoice.opening_balance_line_id
            and line.supplier_id=invoice.supplier_id
          order by line.journal_line_id limit 1
        ),
        (
          select line.account_id
          from public.journal_line line
          where line.journal_id=invoice.journal_id
            and line.supplier_id=invoice.supplier_id
            and line.entity_type='Proveedor'
            and lower(coalesce(line.note,'')) like 'cuenta por pagar%'
          order by line.journal_line_id limit 1
        )
      ) account_id
    from public.supplier_invoice invoice
  )
  select
    exists(
      select 1 from information_schema.columns
      where table_schema='public' and table_name='supplier_invoice'
        and column_name='payable_account_id' and data_type='bigint'
    ) snapshot_column,
    exists(
      select 1 from pg_constraint constraint_record
      where constraint_record.conrelid='public.supplier_invoice'::regclass
        and constraint_record.confrelid='public.chart_accounts'::regclass
        and constraint_record.contype='f'
        and constraint_record.conname='supplier_invoice_payable_account_id_fkey'
        and constraint_record.convalidated
    ) snapshot_foreign_key,
    to_regclass('public.supplier_invoice_payable_account_idx') is not null
      snapshot_index,
    exists(
      select 1 from pg_constraint constraint_record
      where constraint_record.conrelid='public.supplier_payment'::regclass
        and constraint_record.conname='supplier_payment_amount_paid_check'
        and constraint_record.contype='c'
        and position('amount_paid >= ' in pg_get_constraintdef(constraint_record.oid))>0
    ) zero_cash_advance_allowed,
    to_regprocedure('public.resolve_supplier_payable_account(bigint,bigint,text)')
      is not null resolver_function,
    to_regprocedure('public.ensure_supplier_invoice_payable_account(bigint)')
      is not null snapshot_helper,
    to_regprocedure('public.apply_supplier_payment_payable_accounts(bigint,numeric)')
      is not null payment_helper,
    to_regprocedure('public.protect_applied_supplier_advance()')
      is not null advance_protection_function,
    to_regprocedure('public.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint)')
      is not null invoice_inner_function,
    to_regprocedure('public.save_supplier_note_before_payable_routing(text,jsonb,bigint)')
      is not null note_inner_function,
    to_regprocedure('public.save_supplier_payment_before_payable_routing(jsonb,bigint)')
      is not null payment_inner_function,
    to_regprocedure('public.save_supplier_payment_with_advances_before_payable_routing(jsonb,bigint)')
      is not null payment_advances_inner_function,
    coalesce((
      select position('factura expense' in definition)>0
        and position('211003' in definition)>0
        and position('factura caja chica' in definition)>0
        and position('211004' in definition)>0
        and position('is_intercompany' in definition)>0
        and position('211001' in definition)>0
        and position('211002' in definition)>0
        and position('account_subsidiaries' in definition)>0
      from function_catalog
      where oid=to_regprocedure(
        'public.resolve_supplier_payable_account(bigint,bigint,text)'
      )
    ),false) resolver_rules,
    coalesce((
      select position('resolve_supplier_payable_account' in definition)>0
        and position('payable_account_id' in definition)>0
        and position('sync_journal_gl_impacts' in definition)>0
      from function_catalog
      where oid=to_regprocedure(
        'public.save_supplier_invoice_without_budget(jsonb,bigint)'
      )
    ),false) invoice_routing,
    coalesce((
      select position('ensure_supplier_invoice_payable_account' in definition)>0
        and position('ensure_supplier_invoice_payable_account' in definition)
          <position('save_supplier_invoice_without_budget_before_payable_routing' in definition)
      from function_catalog
      where oid=to_regprocedure(
        'public.save_supplier_invoice_without_budget(jsonb,bigint)'
      )
    ),false) snapshot_recovered_before_legacy_edit,
    coalesce((
      select position('account.account_name~*' in definition)>0
        and position('211001' in definition)>0
        and position('211004' in definition)>0
        and position('abs(coalesce(line.credit' in definition)>0
      from function_catalog
      where oid=to_regprocedure(
        'public.ensure_supplier_invoice_payable_account(bigint)'
      )
    ),false) snapshot_structural_fallback,
    coalesce((
      select position('ensure_supplier_invoice_payable_account' in definition)>0
        and position('sync_journal_gl_impacts' in definition)>0
      from function_catalog
      where oid=to_regprocedure('public.save_supplier_note(text,jsonb,bigint)')
    ),false) note_uses_invoice_snapshot,
    coalesce((
      select position('group by invoice.payable_account_id' in definition)>0
        and position('sync_journal_gl_impacts' in definition)>0
      from function_catalog
      where oid=to_regprocedure(
        'public.apply_supplier_payment_payable_accounts(bigint,numeric)'
      )
    ),false) payment_groups_by_snapshot,
    coalesce((
      select position('to_jsonb(new)' in definition)>0
        and position('-''amount_paid''' in definition)>0
        and position('supplier_payment_application' in definition)>0
        and position('supplier_advance_application' in definition)>0
        and position('supplier_payment_withholding' in definition)>0
        and position('no puede modificarse ni eliminarse' in definition)>0
      from function_catalog
      where oid=to_regprocedure('public.protect_applied_supplier_advance()')
    ),false) advance_amount_normalization_guard,
    coalesce((
      select position('advance_total+withholding_total>expected_total' in definition)>0
        and position('no puede superar el total aplicado' in definition)>0
      from function_catalog
      where oid=to_regprocedure(
        'public.save_supplier_payment_with_advances(jsonb,bigint)'
      )
    ),false) advance_withholding_overcoverage_guard,
    exists(
      select 1
      from pg_trigger trigger_record
      where trigger_record.tgrelid='public.supplier_payment'::regclass
        and trigger_record.tgname='protect_applied_supplier_advance'
        and trigger_record.tgenabled<>'D'
        and trigger_record.tgfoid=to_regprocedure(
          'public.protect_applied_supplier_advance()'
        )
    ) advance_protection_trigger_enabled,
    position(
      'save_supplier_invoice_without_budget'
      in lower(pg_get_functiondef('public.budget_run(text,jsonb,bigint)'::regprocedure))
    )>0 budget_route_uses_wrapped_entrypoint,
    (select count(*)=4 from target_accounts) target_accounts_present,
    (
      select count(*)=4 from target_accounts
      where accepts_entries and not is_inactive and category='Pasivo'
        and nature='Acreedora' and financial_statement='Balance General'
    ) target_accounts_operational,
    not exists(
      select 1
      from public.subsidiaries subsidiary
      cross join target_accounts account
      where subsidiary.is_active
        and not exists(
          select 1 from public.account_subsidiaries assignment
          where assignment.subsidiary_id=subsidiary.subsidiary_id
            and assignment.account_id=account.account_id
            and assignment.is_active
        )
    ) targets_linked_to_all_active_subsidiaries,
    not exists(
      select 1 from public.supplier_invoice where payable_account_id is null
    ) snapshot_backfill_complete,
    not exists(
      select 1
      from public.supplier_invoice invoice
      join historical_posting posting using(invoice_id)
      where posting.account_id is not null
        and invoice.payable_account_id is distinct from posting.account_id
    ) historical_snapshot_matches_posting,
    coalesce((select bool_and(prosecdef) from function_catalog),false)
      functions_are_security_definer,
    not has_function_privilege(
      'authenticated',
      'public.resolve_supplier_payable_account(bigint,bigint,text)','EXECUTE'
    ) resolver_not_exposed,
    not has_function_privilege(
      'authenticated',
      'public.ensure_supplier_invoice_payable_account(bigint)','EXECUTE'
    ) snapshot_helper_not_exposed,
    not has_function_privilege(
      'authenticated',
      'public.apply_supplier_payment_payable_accounts(bigint,numeric)','EXECUTE'
    ) payment_helper_not_exposed,
    not has_function_privilege(
      'authenticated','public.protect_applied_supplier_advance()','EXECUTE'
    ) advance_protection_not_exposed,
    not has_function_privilege(
      'authenticated',
      'public.save_supplier_invoice_without_budget(jsonb,bigint)','EXECUTE'
    ) budget_inner_not_exposed,
    not has_function_privilege(
      'authenticated',
      'public.save_supplier_invoice_without_withholding(jsonb,bigint)','EXECUTE'
    ) invoice_base_not_exposed,
    not has_function_privilege(
      'authenticated',
      'public.save_supplier_payment_without_withholding(jsonb,bigint)','EXECUTE'
    ) payment_base_not_exposed,
    not has_function_privilege(
      'authenticated',
      'public.save_supplier_payment_with_advances_base(jsonb,bigint)','EXECUTE'
    ) payment_advance_base_not_exposed,
    has_function_privilege(
      'authenticated','public.save_supplier_invoice(jsonb,bigint)','EXECUTE'
    ) authenticated_invoice_execute,
    has_function_privilege(
      'authenticated','public.save_supplier_note(text,jsonb,bigint)','EXECUTE'
    ) authenticated_note_execute,
    has_function_privilege(
      'authenticated','public.save_supplier_payment(jsonb,bigint)','EXECUTE'
    ) authenticated_payment_execute,
    has_function_privilege(
      'authenticated',
      'public.save_supplier_payment_with_advances(jsonb,bigint)','EXECUTE'
    ) authenticated_payment_advances_execute,
    not has_function_privilege(
      'anon','public.save_supplier_invoice(jsonb,bigint)','EXECUTE'
    ) anonymous_invoice_denied,
    not has_function_privilege(
      'anon','public.save_supplier_note(text,jsonb,bigint)','EXECUTE'
    ) anonymous_note_denied,
    not has_function_privilege(
      'anon','public.save_supplier_payment(jsonb,bigint)','EXECUTE'
    ) anonymous_payment_denied,
    not has_function_privilege(
      'anon',
      'public.save_supplier_payment_with_advances(jsonb,bigint)','EXECUTE'
    ) anonymous_payment_advances_denied
`;

await db.connect();
let transactionOpen = false;
try {
  await db.query('begin');
  transactionOpen = true;
  await db.query("set local lock_timeout='5s'; set local statement_timeout='180s'");
  await db.query(
    "select pg_advisory_xact_lock(hashtextextended('20261020110000_supplier_invoice_payable_account_routing',0))"
  );
  await db.query(migration);

  const verification = (await db.query(verificationSql)).rows[0];
  const failures = Object.entries(verification)
    .filter(([, value]) => value !== true)
    .map(([name]) => name);

  if (failures.length > 0) {
    throw new Error(
      `La asignación contable de CxP no superó las validaciones: ${failures.join(', ')}. ` +
      `Detalle: ${JSON.stringify(verification)}`
    );
  }

  const metrics = (await db.query(`
    select
      (select count(*)::integer from public.supplier_invoice) invoice_snapshots,
      (select count(*)::integer from public.subsidiaries where is_active)
        active_subsidiaries,
      (
        select count(*)::integer
        from public.account_subsidiaries assignment
        join public.chart_accounts account using(account_id)
        join public.subsidiaries subsidiary using(subsidiary_id)
        where account.account_number in('211001','211002','211003','211004')
          and assignment.is_active and subsidiary.is_active
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
