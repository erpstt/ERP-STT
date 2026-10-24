import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const apply = process.argv.includes('--apply');
const verifyOnly = process.argv.includes('--verify');
const dryRun = process.argv.includes('--dry-run');
if (!apply && !verifyOnly && !dryRun) {
  throw new Error('Use --verify, --dry-run o --apply.');
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

const migration = await readFile(new URL(
  '../supabase/migrations/20261021130000_pending_reversal_historical_fx_integrity.sql',
  import.meta.url,
), 'utf8');

const verificationSql = `
with definitions as(
  select
    pg_get_functiondef(to_regprocedure(
      'public.pending_invoice_reversal_source_fx(bigint,bigint)'
    )) source_validator,
    pg_get_functiondef(to_regprocedure(
      'public.pending_invoice_normalize_reversal_fx(bigint,numeric,bigint,text)'
    )) normalizer,
    coalesce(pg_get_functiondef(to_regprocedure(
      'public.reverse_pending_invoice_journal_before_support_integrity(bigint,jsonb)'
    )),pg_get_functiondef(to_regprocedure(
      'public.reverse_pending_invoice_journal(bigint,jsonb)'
    ))) regular_wrapper,
    coalesce(pg_get_functiondef(to_regprocedure(
      'public.reverse_opening_pending_invoice_before_support_integrity(bigint,jsonb)'
    )),pg_get_functiondef(to_regprocedure(
      'public.reverse_opening_pending_invoice(bigint,jsonb)'
    ))) opening_wrapper,
    coalesce(pg_get_functiondef(to_regprocedure(
      'public.reverse_pending_invoice_journal(bigint,jsonb)'
    )),'') regular_public,
    coalesce(pg_get_functiondef(to_regprocedure(
      'public.reverse_opening_pending_invoice(bigint,jsonb)'
    )),'') opening_public,
    pg_get_functiondef(to_regprocedure(
      'public.guard_pending_control_gl_cutoff()'
    )) cutoff_guard,
    pg_get_functiondef(to_regprocedure(
      'public.pending_invoice_billing_limit_snapshot(bigint,bigint,bigint,bigint)'
    )) billing_snapshot,
    pg_get_functiondef(to_regprocedure(
      'public.pending_invoice_validate_billing_limit(bigint,bigint,bigint,date,numeric,numeric,bigint)'
    )) billing_validator,
    pg_get_functiondef(to_regprocedure(
      'public.validate_pending_reversal_invoice()'
    )) billing_trigger,
    pg_get_functiondef(to_regprocedure(
      'public.reverse_pending_invoice_journal_before_period_type(bigint,jsonb)'
    )) billing_wrapper,
    pg_get_functiondef(to_regprocedure(
      'public.pending_invoice_reversal_options(bigint,date)'
    )) options_wrapper,
    pg_get_functiondef(to_regprocedure(
      'public.guard_pending_reclassification_journal()'
    )) source_journal_guard,
    pg_get_functiondef(to_regprocedure(
      'public.guard_pending_reclassification_journal_line()'
    )) source_line_guard,
    pg_get_functiondef(to_regprocedure(
      'public.guard_pending_reclassification_gl_impact()'
    )) source_impact_guard,
    pg_get_functiondef(to_regprocedure(
      'public.guard_pending_reclassification_transaction()'
    )) source_transaction_guard,
    pg_get_functiondef(to_regprocedure(
      'public.guard_transaction_accounting_period()'
    )) transaction_period_guard,
    pg_get_functiondef(to_regprocedure(
      'public.guard_journal_accounting_period()'
    )) journal_period_guard
),data_audit as(
  select reversal.reversal_id,
    source_fx.source_historical_rate expected_rate,
    source_fx.source_currency_id expected_currency,
    reversal.reversed_local,reversal.reversed_foreign,
    reversal_journal.exchange_rate journal_rate,
    reversal_journal.currency_id journal_currency,
    reversal_journal.total_debit journal_total_debit,
    reversal_journal.total_credit journal_total_credit,
    transaction_row.exchange_rate transaction_rate,
    transaction_row.currency_id transaction_currency,
    transaction_row.total_amount transaction_total,
    line_values.line_count,line_values.debit,line_values.credit,
    line_values.debit_fx,line_values.credit_fx,
    line_values.metadata_ok line_metadata_ok,
    impact_values.impact_count,impact_values.debit impact_debit,
    impact_values.credit impact_credit,
    impact_values.debit_fx impact_debit_fx,
    impact_values.credit_fx impact_credit_fx,
    impact_values.metadata_ok impact_metadata_ok,
    line_values.current_pair line_current_pair,
    line_values.prior_pair line_prior_pair,
    impact_values.current_pair impact_current_pair,
    impact_values.prior_pair impact_prior_pair,
    case
      when reclassification.reclassification_date is null
        then source_fx.source_period_type
      when reversal.reversal_date<reclassification.reclassification_date
        then 'ACTUAL'
      when reversal.reversal_date>reclassification.reclassification_date
        then 'ANTERIOR'
      else null
    end expected_period_type,
    case when reversal.reversal_id=source_stats.final_reversal_id
        and abs(source_fx.source_balance_local)<=.000001
        and abs(source_fx.source_balance_foreign)<=.000001
        and abs(source_stats.reversed_local-source_fx.source_initial_local)<=.000001
        and abs(source_stats.reversed_foreign-source_fx.source_initial_foreign)<=.000001
      then .005+abs(source_fx.source_historical_rate)*.0000005
        *(source_stats.reversal_count+1)+.000001
      else greatest(.005,
        abs(source_fx.source_historical_rate)*.0000005+.000001)
    end allowed_fx_tolerance
  from public.pending_invoice_reversal reversal
  cross join lateral public.pending_invoice_reversal_source_fx(
    reversal.source_journal_id,reversal.source_opening_pending_id
  )source_fx
  cross join lateral(
    select count(*)::integer reversal_count,max(same_source.reversal_id)final_reversal_id,
      coalesce(sum(same_source.reversed_local),0)reversed_local,
      coalesce(sum(same_source.reversed_foreign),0)reversed_foreign
    from public.pending_invoice_reversal same_source
    where same_source.source_journal_id is not distinct from reversal.source_journal_id
      and same_source.source_opening_pending_id is not distinct from
        reversal.source_opening_pending_id
  )source_stats
  join public.journal reversal_journal
    on reversal_journal.journal_id=reversal.reversal_journal_id
  join public."transaction" transaction_row
    on transaction_row.transaction_id=reversal_journal.transaction_id
  left join lateral(
    select annual_run.reclassification_date
    from public.pending_invoice_reclassification_items item
    join public.pending_invoice_reclassification_runs annual_run
      on annual_run.id=item.run_id
    where(reversal.source_journal_id is not null
        and item.source_journal_id=reversal.source_journal_id)
      or(reversal.source_opening_pending_id is not null
        and item.source_opening_pending_id=reversal.source_opening_pending_id)
    limit 1
  )reclassification on true
  cross join lateral(
    select count(*)::integer line_count,
      coalesce(sum(line.debit),0)debit,coalesce(sum(line.credit),0)credit,
      coalesce(sum(line.debit_fx),0)debit_fx,
      coalesce(sum(line.credit_fx),0)credit_fx,
      coalesce(bool_and(line.historical_exchange_rate is not distinct from
          source_fx.source_historical_rate
        and line.original_currency_id is not distinct from
          source_fx.source_currency_id),false)metadata_ok,
      count(*)=2 and count(*)filter(where account.account_number='413001'
          and line.debit=reversal.reversed_foreign and line.credit=0
          and line.debit_fx=reversal.reversed_foreign and line.credit_fx=0)=1
        and count(*)filter(where account.account_number='113003'
          and line.debit=0 and line.credit=reversal.reversed_foreign
          and line.debit_fx=0 and line.credit_fx=reversal.reversed_foreign)=1
        as current_pair,
      count(*)=2 and count(*)filter(where account.account_number='413002'
          and line.debit=reversal.reversed_foreign and line.credit=0
          and line.debit_fx=reversal.reversed_foreign and line.credit_fx=0)=1
        and count(*)filter(where account.account_number='113004'
          and line.debit=0 and line.credit=reversal.reversed_foreign
          and line.debit_fx=0 and line.credit_fx=reversal.reversed_foreign)=1
        as prior_pair
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=reversal.reversal_journal_id
  )line_values
  cross join lateral(
    select count(*)::integer impact_count,
      coalesce(sum(impact.debit_amount),0)debit,
      coalesce(sum(impact.credit_amount),0)credit,
      coalesce(sum(impact.debit_fx),0)debit_fx,
      coalesce(sum(impact.credit_fx),0)credit_fx,
      coalesce(bool_and(impact.original_currency_id is not distinct from
        source_fx.source_currency_id),false)metadata_ok,
      count(*)=2 and count(*)filter(where book.subsidiary_id=source_fx.source_subsidiary_id
          and book.is_primary and book.is_active
          and account.account_number='413001'
          and impact.debit_amount=reversal.reversed_local and impact.credit_amount=0
          and impact.debit_fx=reversal.reversed_foreign and impact.credit_fx=0)=1
        and count(*)filter(where book.subsidiary_id=source_fx.source_subsidiary_id
          and book.is_primary and book.is_active
          and account.account_number='113003'
          and impact.debit_amount=0 and impact.credit_amount=reversal.reversed_local
          and impact.debit_fx=0 and impact.credit_fx=reversal.reversed_foreign)=1
        as current_pair,
      count(*)=2 and count(*)filter(where book.subsidiary_id=source_fx.source_subsidiary_id
          and book.is_primary and book.is_active
          and account.account_number='413002'
          and impact.debit_amount=reversal.reversed_local and impact.credit_amount=0
          and impact.debit_fx=reversal.reversed_foreign and impact.credit_fx=0)=1
        and count(*)filter(where book.subsidiary_id=source_fx.source_subsidiary_id
          and book.is_primary and book.is_active
          and account.account_number='113004'
          and impact.debit_amount=0 and impact.credit_amount=reversal.reversed_local
          and impact.debit_fx=0 and impact.credit_fx=reversal.reversed_foreign)=1
        as prior_pair
    from public.gl_impact impact
    join public.accounting_books book using(accounting_book_id)
    join public.chart_accounts account using(account_id)
    where impact.transaction_id=reversal_journal.transaction_id
  )impact_values
),billing_audit as(
  select reversal.sales_invoice_id,
    max(limit_snapshot.applied_invoice) applied_invoice,
    max(limit_snapshot.subtotal_invoice) subtotal_invoice,
    max(limit_snapshot.invoice_currency_id) invoice_currency_id,
    array_agg(distinct limit_snapshot.source_currency_id
      order by limit_snapshot.source_currency_id) source_currency_ids
  from public.pending_invoice_reversal reversal
  cross join lateral public.pending_invoice_billing_limit_snapshot(
    reversal.source_journal_id,reversal.source_opening_pending_id,
    reversal.sales_invoice_id,null
  )limit_snapshot
  where reversal.reversal_type='FACTURACION'
  group by reversal.sales_invoice_id
),data_failures as(
  select * from data_audit
  where expected_rate is null or expected_rate<=0
    or abs(reversed_local-round(reversed_foreign*expected_rate,6))
      >allowed_fx_tolerance
    or abs(journal_rate-expected_rate)>.0000000001
    or abs(transaction_rate-expected_rate)>.0000000001
    or journal_currency is distinct from expected_currency
    or transaction_currency is distinct from expected_currency
    or abs(journal_total_debit-reversed_foreign)>.000001
    or abs(journal_total_credit-reversed_foreign)>.000001
    or abs(transaction_total-reversed_foreign)>.000001
    or line_count<>2 or impact_count<>2
    or abs(debit-reversed_foreign)>.000001
    or abs(credit-reversed_foreign)>.000001
    or abs(debit_fx-reversed_foreign)>.000001
    or abs(credit_fx-reversed_foreign)>.000001
    or abs(impact_debit-reversed_local)>.005
    or abs(impact_credit-reversed_local)>.005
    or abs(impact_debit_fx-reversed_foreign)>.000001
    or abs(impact_credit_fx-reversed_foreign)>.000001
    or not(
      (line_current_pair and impact_current_pair
        and expected_period_type is distinct from 'ANTERIOR')
      or(line_prior_pair and impact_prior_pair
        and expected_period_type is distinct from 'ACTUAL')
    )
),checks as(
  select * from(values
    ('source FX validator installed',to_regprocedure(
      'public.pending_invoice_reversal_source_fx(bigint,bigint)')is not null
      and to_regprocedure(
        'public.pending_invoice_billing_limit_snapshot(bigint,bigint,bigint,bigint)')is not null
      and to_regprocedure(
        'public.pending_invoice_validate_billing_limit(bigint,bigint,bigint,date,numeric,numeric,bigint)')is not null),
    ('normalizer installed',to_regprocedure(
      'public.pending_invoice_normalize_reversal_fx(bigint,numeric,bigint,text)')is not null),
    ('regular legacy delegate private',
      not has_function_privilege('authenticated',
        'public.reverse_pending_invoice_journal_before_historical_fx_integrity(bigint,jsonb)',
        'EXECUTE')
      and not has_function_privilege('anon',
        'public.reverse_pending_invoice_journal_before_historical_fx_integrity(bigint,jsonb)',
        'EXECUTE')),
    ('opening legacy delegate private',
      not has_function_privilege('authenticated',
        'public.reverse_opening_pending_invoice_before_historical_fx_integrity(bigint,jsonb)',
        'EXECUTE')
      and not has_function_privilege('anon',
        'public.reverse_opening_pending_invoice_before_historical_fx_integrity(bigint,jsonb)',
        'EXECUTE')),
    ('helpers private',
      not has_function_privilege('authenticated',
        'public.pending_invoice_reversal_source_fx(bigint,bigint)','EXECUTE')
      and not has_function_privilege('authenticated',
        'public.pending_invoice_normalize_reversal_fx(bigint,numeric,bigint,text)','EXECUTE')
      and not has_function_privilege('authenticated',
        'public.pending_invoice_billing_limit_snapshot(bigint,bigint,bigint,bigint)','EXECUTE')
      and not has_function_privilege('authenticated',
        'public.pending_invoice_validate_billing_limit(bigint,bigint,bigint,date,numeric,numeric,bigint)','EXECUTE')),
    ('authenticated public reversal',
      has_function_privilege('authenticated',
        'public.reverse_pending_invoice_journal(bigint,jsonb)','EXECUTE')
      and has_function_privilege('authenticated',
        'public.reverse_opening_pending_invoice(bigint,jsonb)','EXECUTE')),
    ('anonymous reversal denied',
      not has_function_privilege('anon',
        'public.reverse_pending_invoice_journal(bigint,jsonb)','EXECUTE')
      and not has_function_privilege('anon',
        'public.reverse_opening_pending_invoice(bigint,jsonb)','EXECUTE')),
    ('preflight validates frozen balances',
      position('pending_initial_foreign' in
        (select source_validator from definitions))>0
      and position('source_line_rate' in
        (select source_validator from definitions))>0
      and position('source_control_debit-source_journal.pending_initial_foreign' in
        (select source_validator from definitions))>0
      and position('source_control_debit-opening_item.initial_local' in
        (select source_validator from definitions))>0
      and position('recorded_reversed_local' in
        (select source_validator from definitions))>0
      and position('reversal.reversed_foreign' in
        (select billing_snapshot from definitions))>0
      and position('reversal.reversed_local/invoice_rate' in
        (select billing_snapshot from definitions))>0
      and position('limit_snapshot.source_currency_id=limit_snapshot.invoice_currency_id' in
        (select billing_validator from definitions))>0),
    ('future reversal normalizes all FX layers',
      position('historical_exchange_rate=p_historical_rate' in
        (select normalizer from definitions))>0
      and position('original_currency_id=p_currency_id' in
        (select normalizer from definitions))>0
      and position('reversal.reversed_local' in
        (select normalizer from definitions))>0
      and position('reversal.reversed_foreign' in
        (select normalizer from definitions))>0
      and position('impact_unexpected_count' in
        (select normalizer from definitions))>0
      and position('delete from public.gl_impact' in
        lower((select normalizer from definitions)))=0
      and position('reversal.source_journal_id=target_id' in
        (select source_journal_guard from definitions))>0
      and position('reversal.source_journal_id in(old_id,new_id)' in
        (select source_line_guard from definitions))>0
      and position('reversal.source_journal_id=source.journal_id' in
        (select source_impact_guard from definitions))>0
      and position('reversal.source_journal_id=source.journal_id' in
        (select source_transaction_guard from definitions))>0),
    ('support integrity wrappers remain linked',
      (to_regprocedure('public.reverse_pending_invoice_journal_before_support_integrity(bigint,jsonb)') is null
        and to_regprocedure('public.reverse_opening_pending_invoice_before_support_integrity(bigint,jsonb)') is null)
      or(position('reverse_pending_invoice_journal_before_support_integrity' in
          (select regular_public from definitions))>0
        and position('reverse_opening_pending_invoice_before_support_integrity' in
          (select opening_public from definitions))>0)),
    ('regular wrapper validates before delegate',
      position('pending_invoice_reversal_source_fx' in
        (select regular_wrapper from definitions))>0
      and position('pending_invoice_normalize_reversal_fx' in
        (select regular_wrapper from definitions))>0
      and position('pending_invoice_validate_billing_limit' in
        (select regular_wrapper from definitions))>0
      and position('reverse_pending_invoice_journal_before_invoice_subtotal_limit' in
        (select billing_wrapper from definitions))>0
      and position('reverse_opening_pending_invoice' in
        (select billing_wrapper from definitions))>0
      and position('pending_invoice_billing_limit_snapshot' in
        (select options_wrapper from definitions))>0),
    ('opening wrapper validates before delegate',
      position('pending_invoice_reversal_source_fx' in
        (select opening_wrapper from definitions))>0
      and position('pending_invoice_normalize_reversal_fx' in
        (select opening_wrapper from definitions))>0
      and position('pending_invoice_validate_billing_limit' in
        (select opening_wrapper from definitions))>0),
    ('annual cutoff guard remains strict',
      position('app.pending_fx_metadata_backfill' in
        (select cutoff_guard from definitions))=0
      and exists(select 1 from pg_trigger
        where tgrelid='public.gl_impact'::regclass
          and tgname='guard_pending_control_gl_cutoff_trigger'
          and tgenabled='O'and not tgisinternal)
      and position('pending_reversal_finalize' in
        (select transaction_period_guard from definitions))>0
      and position('total_amount' in
        (select transaction_period_guard from definitions))>0
      and position('pending_reversal_finalize' in
        (select journal_period_guard from definitions))>0
      and position('total_debit' in
        (select journal_period_guard from definitions))>0
      and position('total_credit' in
        (select journal_period_guard from definitions))>0),
    ('historical reversal metadata complete',not exists(
      select 1 from data_audit
      where not line_metadata_ok or not impact_metadata_ok
    )),
    ('historical reversal amounts and rates reconcile',not exists(
      select 1 from data_failures)),
    ('direct reversal and GL writes remain denied',
      not has_table_privilege('authenticated','public.pending_invoice_reversal','INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon','public.pending_invoice_reversal','INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','public.gl_impact','INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon','public.gl_impact','INSERT,UPDATE,DELETE'))
  )result(name,ok)
)
select name,ok,
  case when name='historical reversal amounts and rates reconcile' then
    jsonb_build_object(
      'reversal_ids',(select coalesce(jsonb_agg(reversal_id),'[]'::jsonb)
        from data_failures),
      'billing_invoices',(select coalesce(jsonb_agg(jsonb_build_object(
          'invoice_id',sales_invoice_id,
          'subtotal',subtotal_invoice,
          'applied',applied_invoice,
          'invoice_currency_id',invoice_currency_id,
          'source_currency_ids',source_currency_ids
        )),'[]'::jsonb)
        from billing_audit where applied_invoice>subtotal_invoice+.000001)
    )
  else null end diagnostics
from checks order by name`;

async function verify() {
  const result = await db.query(verificationSql);
  const failed = result.rows.filter((row) => !row.ok);
  if (failed.length) {
    const diagnostics = failed.filter((row) => row.diagnostics)
      .map((row) => `${row.name}: ${JSON.stringify(row.diagnostics)}`)
      .join('; ');
    throw new Error(`Verificación incompleta: ${failed.map((row) => row.name).join(', ')}.${diagnostics ? ` ${diagnostics}` : ''}`);
  }
  const billingWarnings = result.rows
    .filter((row) => row.name === 'historical reversal amounts and rates reconcile')
    .flatMap((row) => row.diagnostics?.billing_invoices || []);
  if (billingWarnings.length) {
    console.warn(`Advertencia no bloqueante: ${billingWarnings.length} factura(s) tienen reversiones históricas por encima del subtotal. Los importes aplicado/subtotal están normalizados a la moneda histórica de cada factura; no se modificaron importes económicos. ${JSON.stringify(billingWarnings)}`);
  }
  return result.rows.length;
}

await db.connect();
try {
  if (apply || dryRun) {
    await db.query('begin');
    await db.query("set local lock_timeout='5s'; set local statement_timeout='180s'");
    const newerSupportLayer = (await db.query(`select
      to_regprocedure('public.reverse_pending_invoice_journal_before_support_integrity(bigint,jsonb)') is not null
      or to_regprocedure('public.reverse_opening_pending_invoice_before_support_integrity(bigint,jsonb)') is not null value`)).rows[0].value;
    if (!newerSupportLayer) await db.query(migration);
    const count = await verify();
    if (dryRun) {
      await db.query('rollback');
      console.log(`Integridad FX de reversiones validada y revertida (${count} controles).`);
    } else {
      await db.query('commit');
      const action = newerSupportLayer
        ? 'Integridad FX conservada detrás de la capa posterior y verificada'
        : 'Integridad FX de reversiones instalada';
      console.log(`${action} (${count} controles).`);
    }
  } else {
    const count = await verify();
    console.log(`Integridad FX de reversiones verificada (${count} controles).`);
  }
} catch (error) {
  if (apply || dryRun) await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
