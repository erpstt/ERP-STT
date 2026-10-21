import pg from 'pg';

process.loadEnvFile?.('.env');

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

const auditSql = `
with source as(
  select reversal.reversal_id,reversal.reversal_journal_id,reversal.reversal_date,
    reversal.reversed_local,reversal.reversed_foreign,reversal.reversal_type,
    reversal.source_journal_id,reversal.source_opening_pending_id,
    case when reversal.source_journal_id is not null then 'JOURNAL' else 'OPENING' end source_type,
    coalesce(source_journal.exchange_rate,opening_item.historical_exchange_rate)::numeric expected_rate,
    coalesce(source_journal.currency_id,opening_item.currency_id) expected_currency_id,
    coalesce(source_journal.subsidiary_id,opening_item.subsidiary_id)source_subsidiary_id,
    coalesce(source_journal.pending_initial_local,opening_item.initial_local)::numeric source_initial_local,
    coalesce(source_journal.pending_initial_foreign,opening_item.initial_foreign)::numeric source_initial_foreign,
    coalesce(source_journal.pending_balance_local,opening_item.balance_local)::numeric source_balance_local,
    coalesce(source_journal.pending_balance_foreign,opening_item.balance_foreign)::numeric source_balance_foreign,
    coalesce(source_journal.pending_period_type,opening_item.period_type,'ACTUAL')source_period_type,
    coalesce(source_journal.journal_number,opening_item.reference) source_reference,
    reversal_journal.transaction_id,reversal_journal.exchange_rate::numeric journal_rate,
    reversal_journal.currency_id journal_currency_id,
    reversal_journal.total_debit::numeric journal_total_debit,
    reversal_journal.total_credit::numeric journal_total_credit,
    transaction_row.exchange_rate::numeric transaction_rate,
    transaction_row.currency_id transaction_currency_id,
    transaction_row.total_amount::numeric transaction_total,
    annual_run.reclassification_date
  from public.pending_invoice_reversal reversal
  left join public.journal source_journal
    on source_journal.journal_id=reversal.source_journal_id
  left join public.opening_pending_invoice_items opening_item
    on opening_item.id=reversal.source_opening_pending_id
  join public.journal reversal_journal
    on reversal_journal.journal_id=reversal.reversal_journal_id
  join public."transaction" transaction_row
    on transaction_row.transaction_id=reversal_journal.transaction_id
  left join public.pending_invoice_reclassification_items reclassified
    on reclassified.source_journal_id=reversal.source_journal_id
      or reclassified.source_opening_pending_id=reversal.source_opening_pending_id
  left join public.pending_invoice_reclassification_runs annual_run
    on annual_run.id=reclassified.run_id
),source_stats as(
  select source.reversal_id,count(same_source.*)::integer reversal_count,
    max(same_source.reversal_id)final_reversal_id,
    coalesce(sum(same_source.reversed_local),0)::numeric total_reversed_local,
    coalesce(sum(same_source.reversed_foreign),0)::numeric total_reversed_foreign
  from source
  join public.pending_invoice_reversal same_source
    on same_source.source_journal_id is not distinct from source.source_journal_id
      and same_source.source_opening_pending_id is not distinct from
        source.source_opening_pending_id
  group by source.reversal_id
),line_totals as(
  select source.reversal_id,count(line.*)::integer line_count,
    coalesce(sum(line.debit),0)::numeric debit,
    coalesce(sum(line.credit),0)::numeric credit,
    coalesce(sum(line.debit_fx),0)::numeric debit_fx,
    coalesce(sum(line.credit_fx),0)::numeric credit_fx,
    bool_and(line.historical_exchange_rate is not distinct from source.expected_rate) line_rate_matches,
    bool_and(line.original_currency_id is not distinct from source.expected_currency_id) line_currency_matches,
    count(*)=2 and count(*)filter(where account.account_number='413001'
        and line.debit=source.reversed_foreign and line.credit=0
        and line.debit_fx=source.reversed_foreign and line.credit_fx=0)=1
      and count(*)filter(where account.account_number='113003'
        and line.debit=0 and line.credit=source.reversed_foreign
        and line.debit_fx=0 and line.credit_fx=source.reversed_foreign)=1
      current_pair,
    count(*)=2 and count(*)filter(where account.account_number='413002'
        and line.debit=source.reversed_foreign and line.credit=0
        and line.debit_fx=source.reversed_foreign and line.credit_fx=0)=1
      and count(*)filter(where account.account_number='113004'
        and line.debit=0 and line.credit=source.reversed_foreign
        and line.debit_fx=0 and line.credit_fx=source.reversed_foreign)=1
      prior_pair
  from source join public.journal_line line
    on line.journal_id=source.reversal_journal_id
  join public.chart_accounts account using(account_id)
  group by source.reversal_id
),impact_totals as(
  select source.reversal_id,count(impact.*)::integer impact_count,
    coalesce(sum(impact.debit_amount),0)::numeric debit_local,
    coalesce(sum(impact.credit_amount),0)::numeric credit_local,
    coalesce(sum(impact.debit_fx),0)::numeric debit_fx,
    coalesce(sum(impact.credit_fx),0)::numeric credit_fx,
    bool_and(impact.original_currency_id is not distinct from source.expected_currency_id) impact_currency_matches,
    count(*)=2 and count(*)filter(where book.subsidiary_id=source.source_subsidiary_id
        and book.is_primary and book.is_active and account.account_number='413001'
        and impact.debit_amount=source.reversed_local and impact.credit_amount=0
        and impact.debit_fx=source.reversed_foreign and impact.credit_fx=0)=1
      and count(*)filter(where book.subsidiary_id=source.source_subsidiary_id
        and book.is_primary and book.is_active and account.account_number='113003'
        and impact.debit_amount=0 and impact.credit_amount=source.reversed_local
        and impact.debit_fx=0 and impact.credit_fx=source.reversed_foreign)=1
      current_pair,
    count(*)=2 and count(*)filter(where book.subsidiary_id=source.source_subsidiary_id
        and book.is_primary and book.is_active and account.account_number='413002'
        and impact.debit_amount=source.reversed_local and impact.credit_amount=0
        and impact.debit_fx=source.reversed_foreign and impact.credit_fx=0)=1
      and count(*)filter(where book.subsidiary_id=source.source_subsidiary_id
        and book.is_primary and book.is_active and account.account_number='113004'
        and impact.debit_amount=0 and impact.credit_amount=source.reversed_local
        and impact.debit_fx=0 and impact.credit_fx=source.reversed_foreign)=1
      prior_pair
  from source join public.gl_impact impact on impact.transaction_id=source.transaction_id
  join public.accounting_books book on book.accounting_book_id=impact.accounting_book_id
  join public.chart_accounts account using(account_id)
  group by source.reversal_id
),audit as(
  select source.*,stats.reversal_count,stats.final_reversal_id,
    coalesce(line.line_count,0)line_count,
    coalesce(line.debit,0)line_debit,coalesce(line.credit,0)line_credit,
    coalesce(line.debit_fx,0)line_debit_fx,coalesce(line.credit_fx,0)line_credit_fx,
    coalesce(line.line_rate_matches,false)line_rate_matches,
    coalesce(line.line_currency_matches,false)line_currency_matches,
    coalesce(impact.impact_count,0)impact_count,
    coalesce(impact.debit_local,0)impact_debit_local,
    coalesce(impact.credit_local,0)impact_credit_local,
    coalesce(impact.debit_fx,0)impact_debit_fx,
    coalesce(impact.credit_fx,0)impact_credit_fx,
    coalesce(impact.impact_currency_matches,false)impact_currency_matches,
    abs(source.reversed_local-round(source.reversed_foreign*source.expected_rate,6))<=
      case when source.reversal_id=stats.final_reversal_id
          and abs(source.source_balance_local)<=.000001
          and abs(source.source_balance_foreign)<=.000001
          and abs(stats.total_reversed_local-source.source_initial_local)<=.000001
          and abs(stats.total_reversed_foreign-source.source_initial_foreign)<=.000001
        then .005+abs(source.expected_rate)*.0000005*(stats.reversal_count+1)+.000001
        else greatest(.005,abs(source.expected_rate)*.0000005+.000001)
      end amount_rate_matches,
    source.journal_rate is not distinct from source.expected_rate journal_rate_matches,
    source.transaction_rate is not distinct from source.expected_rate transaction_rate_matches,
    source.journal_currency_id is not distinct from source.expected_currency_id journal_currency_matches,
    source.transaction_currency_id is not distinct from source.expected_currency_id transaction_currency_matches,
    abs(source.journal_total_debit-source.reversed_foreign)<=.000001
      and abs(source.journal_total_credit-source.reversed_foreign)<=.000001
      and abs(source.transaction_total-source.reversed_foreign)<=.000001 header_amounts_normalized,
    abs(coalesce(line.debit,0)-source.reversed_foreign)<=.000001
      and abs(coalesce(line.credit,0)-source.reversed_foreign)<=.000001 line_amounts_normalized,
    abs(coalesce(line.debit_fx,0)-source.reversed_foreign)<=.000001
      and abs(coalesce(line.credit_fx,0)-source.reversed_foreign)<=.000001 line_fx_matches,
    abs(coalesce(impact.debit_local,0)-source.reversed_local)<=.005
      and abs(coalesce(impact.credit_local,0)-source.reversed_local)<=.005
      and abs(coalesce(impact.debit_fx,0)-source.reversed_foreign)<=.000001
      and abs(coalesce(impact.credit_fx,0)-source.reversed_foreign)<=.000001 impact_amounts_match
    ,(
      (coalesce(line.current_pair,false)and coalesce(impact.current_pair,false)
        and(case
          when source.reclassification_date is null then source.source_period_type
          when source.reversal_date<source.reclassification_date then'ACTUAL'
          when source.reversal_date>source.reclassification_date then'ANTERIOR'
          else null end)is distinct from'ANTERIOR')
      or(coalesce(line.prior_pair,false)and coalesce(impact.prior_pair,false)
        and(case
          when source.reclassification_date is null then source.source_period_type
          when source.reversal_date<source.reclassification_date then'ACTUAL'
          when source.reversal_date>source.reclassification_date then'ANTERIOR'
          else null end)is distinct from'ACTUAL')
    )account_pair_matches
  from source join source_stats stats using(reversal_id)
  left join line_totals line using(reversal_id)
  left join impact_totals impact using(reversal_id)
)
select *,
  amount_rate_matches and journal_rate_matches and transaction_rate_matches
    and journal_currency_matches and transaction_currency_matches
    and header_amounts_normalized and line_amounts_normalized
    and line_rate_matches and line_currency_matches and line_fx_matches
    and impact_currency_matches and impact_amounts_match
    and account_pair_matches passed
from audit order by reversal_date,reversal_id`;

const billingWarningSql = `
with invoice_snapshot as(
  select invoice.invoice_id,
    coalesce(invoice.currency_id,transaction_row.currency_id)invoice_currency_id,
    coalesce(nullif(invoice.exchange_rate,0),
      nullif(transaction_row.exchange_rate,0))invoice_historical_rate,
    round(coalesce(sum(line.amount),greatest(invoice.total_amount-
      coalesce(sum(line.tax_amount),0),0)),6)subtotal_invoice
  from public.invoice invoice
  left join public."transaction" transaction_row
    on transaction_row.transaction_id=invoice.transaction_id
  left join public.sales_invoice_line line
    on line.invoice_id=invoice.invoice_id
  group by invoice.invoice_id,transaction_row.currency_id,
    transaction_row.exchange_rate
),normalized as(
  select reversal.reversal_id,reversal.sales_invoice_id,
    invoice.invoice_currency_id,invoice.invoice_historical_rate,
    invoice.subtotal_invoice,
    coalesce(source_journal.currency_id,opening_item.currency_id)
      source_currency_id,
    case
      when coalesce(source_journal.currency_id,opening_item.currency_id)
        =invoice.invoice_currency_id then reversal.reversed_foreign
      when invoice.invoice_historical_rate>0
        then round(reversal.reversed_local/invoice.invoice_historical_rate,6)
      else null
    end applied_invoice
  from public.pending_invoice_reversal reversal
  join invoice_snapshot invoice
    on invoice.invoice_id=reversal.sales_invoice_id
  left join public.journal source_journal
    on source_journal.journal_id=reversal.source_journal_id
  left join public.opening_pending_invoice_items opening_item
    on opening_item.id=reversal.source_opening_pending_id
  where reversal.reversal_type='FACTURACION'
),billing as(
  select sales_invoice_id,invoice_currency_id,
    max(subtotal_invoice)subtotal_invoice,
    round(sum(applied_invoice),6)applied_invoice,
    array_agg(distinct source_currency_id order by source_currency_id)
      source_currency_ids,
    bool_or(applied_invoice is null)has_invalid_snapshot
  from normalized
  group by sales_invoice_id,invoice_currency_id
)
select sales_invoice_id invoice_id,invoice_currency_id,source_currency_ids,
  subtotal_invoice,applied_invoice,has_invalid_snapshot
from billing
where has_invalid_snapshot
  or applied_invoice>subtotal_invoice+.000001
order by sales_invoice_id`;

await db.connect();
try {
  await db.query("begin read only; set local statement_timeout='60s'");
  const rows = (await db.query(auditSql)).rows;
  const billingWarnings = (await db.query(billingWarningSql)).rows;
  const failed = rows.filter((row) => !row.passed);
  const summary = {
    reversals: rows.length,
    passed: rows.length - failed.length,
    failed: failed.length,
    bySource: Object.fromEntries(['JOURNAL', 'OPENING'].map((sourceType) => {
      const sourceRows = rows.filter((row) => row.source_type === sourceType);
      return [sourceType, { total: sourceRows.length, failed: sourceRows.filter((row) => !row.passed).length }];
    })),
    byReversalType: Object.fromEntries([...new Set(rows.map((row) => row.reversal_type))].sort().map((type) => {
      const typeRows = rows.filter((row) => row.reversal_type === type);
      return [type, { total: typeRows.length, failed: typeRows.filter((row) => !row.passed).length }];
    })),
  };
  console.log(JSON.stringify({
    summary,
    failures: failed,
    warnings: {
      historicalBillingOverapplications: billingWarnings,
      note: billingWarnings.length
        ? 'Advertencia no bloqueante: aplicado y subtotal están expresados en la moneda histórica de cada factura; no se modificaron importes económicos.'
        : null,
    },
  }, null, 2));
  if (failed.length) process.exitCode = 2;
  await db.query('rollback');
} finally {
  await db.end();
}
