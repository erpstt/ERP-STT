-- Reconcile AR/AP aging in original currency without mixing monetary units.
--
-- The legacy ORIGINAL mode returned document balances in their transaction
-- currency, but compared that total with the local-currency GL columns.  It
-- also added USD, JMD and any other document currencies into one scalar.  The
-- opening balances made that defect visible: USD 393,988.76 was compared with
-- JMD 59,492,302.76 even though both amounts represent the same balance.

do $$
begin
  if to_regprocedure(
      'public.run_aging_report_before_original_currency_reconciliation(text,jsonb)'
    )is null
    and to_regprocedure(
      'public.run_aging_report_before_consolidation(text,jsonb)'
    )is not null
  then
    execute 'alter function public.run_aging_report_before_consolidation(text,jsonb) '
      ||'rename to run_aging_report_before_original_currency_reconciliation';
  end if;
end
$$;

revoke all on function
  public.run_aging_report_before_original_currency_reconciliation(text,jsonb)
  from public,anon,authenticated;

create or replace function public.run_aging_report_before_original_currency_reconciliation(
  p_kind text,
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint;
  cutoff date;
  filter_entity_id bigint;
  sales_id bigint;
  filter_cost_id bigint;
  filter_book_id bigint;
  filter_supplier_category text;
  only_pending boolean;
  currency_mode text;
  page_no integer;
  page_size integer;
  result jsonb;
  control_balance numeric;
  subledger numeric;
  advances numeric:=0;
begin
  sid:=nullif(p_filters->'subsidiaryIds'->>0,'')::bigint;
  cutoff:=nullif(p_filters->>'dateTo','')::date;
  filter_entity_id:=nullif(p_filters->>'agingEntityId','')::bigint;
  sales_id:=nullif(p_filters->>'salesRepresentativeId','')::bigint;
  filter_cost_id:=nullif(p_filters->>'costCenterId','')::bigint;
  filter_book_id:=nullif(p_filters->>'bookId','')::bigint;
  filter_supplier_category:=nullif(p_filters->>'supplierCategory','');
  only_pending:=coalesce((p_filters->>'onlyPending')::boolean,true);
  currency_mode:=upper(coalesce(nullif(p_filters->>'agingCurrencyMode',''),'LOCAL'));
  page_no:=greatest(coalesce((p_filters->>'page')::integer,1),1);
  page_size:=least(greatest(coalesce((p_filters->>'pageSize')::integer,50),10),250);

  if sid is null or(
    coalesce(auth.role(),'')<>'service_role'
    and not exists(
      select 1 from public.user_subsidiaries access
      where access.user_id=public.app_user_id()and access.subsidiary_id=sid
    )
  )then
    raise exception 'No tiene acceso a la subsidiaria seleccionada.';
  end if;
  if cutoff is null then raise exception 'La fecha de corte es obligatoria.';end if;

  if p_kind='AR'then
    with docs as(
      select
        invoice.invoice_id document_id,
        customer.customer_id entity_id,
        customer.customer_number entity_code,
        customer.tax_id identification,
        customer.company_name entity_name,
        concat_ws(' ',representative.first_name,representative.last_name)manager,
        invoice.invoice_number document_number,
        coalesce(invoice.invoice_date,tran.tran_date,direct_journal.journal_date,fallback_journal.journal_date)issue_date,
        invoice.due_date,
        case when currency_mode='ORIGINAL'
          then coalesce(nullif(invoice.receivable_amount,0),invoice.total_amount)
          else coalesce(nullif(invoice.receivable_amount,0),invoice.total_amount)*coalesce(nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1)
        end original_amount,
        coalesce(application.applied,0)+coalesce(credit.amount,0)applied_amount,
        greatest(
          coalesce(nullif(invoice.receivable_amount,0),invoice.total_amount)
            *case when currency_mode='ORIGINAL'then 1 else coalesce(
              nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
            )end
          -coalesce(application.applied,0)-coalesce(credit.amount,0)
          +coalesce(debit.amount,0),0
        )pending,
        greatest(cutoff-invoice.due_date,0)overdue_days,
        case when cutoff<=invoice.due_date then'CURRENT'
          when cutoff-invoice.due_date<=30 then'1_30'
          when cutoff-invoice.due_date<=60 then'31_60'
          when cutoff-invoice.due_date<=90 then'61_90'
          when cutoff-invoice.due_date<=120 then'91_120'
          else'OVER_120'
        end bucket,
        coalesce(direct_journal.journal_id,fallback_journal.journal_id)journal_id,
        coalesce((
          select sum(
            greatest(payment.amount_received-coalesce((
              select sum(payment_application.amount)
              from public.customer_payment_application payment_application
              where payment_application.payment_id=payment.payment_id
                and payment_application.application_date<=cutoff
            ),0),0)
            *case when currency_mode='ORIGINAL'then 1 else coalesce(
              nullif(payment.exchange_rate,0),
              nullif(payment_transaction.exchange_rate,0),1
            )end
          )
          from public.customer_payment payment
          join public."transaction" payment_transaction using(transaction_id)
          where payment.customer_id=customer.customer_id
            and payment_transaction.subsidiary_id=sid
            and payment_transaction.tran_date<=cutoff
        ),0)entity_advances,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'date',applied.application_date,
            'reference',payment.payment_number,
            'amount',case when currency_mode='ORIGINAL'then
              case when coalesce(
                payment.currency_id,payment_transaction.currency_id,
                invoice.currency_id,tran.currency_id
              )=coalesce(invoice.currency_id,tran.currency_id)
              then applied.amount
              else applied.amount*coalesce(
                nullif(payment.exchange_rate,0),
                nullif(payment_transaction.exchange_rate,0),1
              )/coalesce(
                nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
              )end
            else applied.amount*coalesce(
              nullif(payment.exchange_rate,0),
              nullif(payment_transaction.exchange_rate,0),1
            )end
          )order by applied.application_date)
          from public.customer_payment_application applied
          join public.customer_payment payment using(payment_id)
          left join public."transaction" payment_transaction
            on payment_transaction.transaction_id=payment.transaction_id
          where applied.invoice_id=invoice.invoice_id
            and applied.application_date<=cutoff
        ),'[]'::jsonb)applications
      from public.invoice invoice
      left join public."transaction" tran
        on tran.transaction_id=invoice.transaction_id
      join public.customers customer on customer.customer_id=invoice.customer_id
      left join public.employees representative
        on representative.employee_id=customer.sales_representative_id
      left join public.journal direct_journal
        on direct_journal.journal_id=invoice.journal_id
      left join lateral(
        select fallback.journal_id,fallback.journal_date,fallback.transaction_id
        from public.journal fallback
        where invoice.journal_id is null
          and fallback.transaction_id=invoice.transaction_id
        order by fallback.journal_id
        limit 1
      )fallback_journal on true
      left join lateral(
        select sum(case when currency_mode='ORIGINAL'then
          case when coalesce(
            payment.currency_id,payment_transaction.currency_id,
            invoice.currency_id,tran.currency_id
          )=coalesce(invoice.currency_id,tran.currency_id)
          then applied.amount
          else applied.amount*coalesce(
            nullif(payment.exchange_rate,0),
            nullif(payment_transaction.exchange_rate,0),1
          )/coalesce(
            nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
          )end
        else applied.amount*coalesce(
          nullif(payment.exchange_rate,0),
          nullif(payment_transaction.exchange_rate,0),1
        )end)applied
        from public.customer_payment_application applied
        join public.customer_payment payment using(payment_id)
        left join public."transaction" payment_transaction
          on payment_transaction.transaction_id=payment.transaction_id
        where applied.invoice_id=invoice.invoice_id
          and applied.application_date<=cutoff
      )application on true
      left join lateral(
        select sum(case when currency_mode='ORIGINAL'then
          case when coalesce(
            note.currency_id,note_transaction.currency_id,
            invoice.currency_id,tran.currency_id
          )=coalesce(invoice.currency_id,tran.currency_id)
          then note.amount
          else note.amount*coalesce(
            nullif(note.exchange_rate,0),
            nullif(note_transaction.exchange_rate,0),1
          )/coalesce(
            nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
          )end
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
        from public.credit_note note
        join public."transaction" note_transaction using(transaction_id)
        where note.invoice_id=invoice.invoice_id
          and note_transaction.tran_date<=cutoff
      )credit on true
      left join lateral(
        select sum(case when currency_mode='ORIGINAL'then
          case when coalesce(
            note.currency_id,note_transaction.currency_id,
            invoice.currency_id,tran.currency_id
          )=coalesce(invoice.currency_id,tran.currency_id)
          then note.amount
          else note.amount*coalesce(
            nullif(note.exchange_rate,0),
            nullif(note_transaction.exchange_rate,0),1
          )/coalesce(
            nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
          )end
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
        from public.debit_note note
        join public."transaction" note_transaction using(transaction_id)
        where note.invoice_id=invoice.invoice_id
          and note_transaction.tran_date<=cutoff
      )debit on true
      where invoice.subsidiary_id=sid
        -- The original document date is displayed and drives aging.  The
        -- accounting date controls when it first exists in this report.
        and coalesce(
          tran.tran_date,
          direct_journal.journal_date,
          fallback_journal.journal_date,
          invoice.invoice_date
        )<=cutoff
        and(filter_entity_id is null or customer.customer_id=filter_entity_id)
        and(sales_id is null or customer.sales_representative_id=sales_id)
        and(filter_book_id is null or exists(
          select 1 from public.gl_impact impact
          where impact.transaction_id=coalesce(
              invoice.transaction_id,
              direct_journal.transaction_id,
              fallback_journal.transaction_id
            )
            and impact.accounting_book_id=filter_book_id
            and(
              invoice.opening_balance_line_id is null
              or impact.opening_balance_line_id=invoice.opening_balance_line_id
            )
        ))
    ),filtered as(
      select *,count(*)over()total_count,sum(pending)over()subledger_total
      from docs where not only_pending or pending>.005
    ),paged as(
      select *from filtered
      order by entity_name,due_date,document_number,document_id
      limit page_size offset(page_no-1)*page_size
    )
    select jsonb_build_object(
      'rows',coalesce(jsonb_agg(to_jsonb(paged)-'total_count'-'subledger_total'),'[]'::jsonb),
      'total',coalesce(max(total_count),0),
      'subledgerTotal',coalesce(max(subledger_total),0),
      'page',page_no,
      'pageSize',page_size
    )into result from paged;

    select coalesce(sum(
      case when coalesce(account.nature,account_group.nature)='Acreedora'
        then impact.credit_amount-impact.debit_amount
        else impact.debit_amount-impact.credit_amount
      end
    ),0)into control_balance
    from public.gl_impact impact
    join public.chart_accounts account using(account_id)
    join public.account_group account_group on account_group.group_id=account.account_group_id
    where impact.subsidiary_id=sid
      and impact.posting_date<=cutoff
      and(filter_book_id is null or impact.accounting_book_id=filter_book_id)
      and(
        lower(account.account_name)like'%cuenta%por cobrar%'
        or lower(account.account_name)like'%clientes por cobrar%'
      );

    subledger:=coalesce((result->>'subledgerTotal')::numeric,0);
    select coalesce(sum(
      greatest(payment.amount_received-coalesce(application.applied,0),0)
      *case when currency_mode='ORIGINAL'then 1 else coalesce(
        nullif(payment.exchange_rate,0),nullif(tran.exchange_rate,0),1
      )end
    ),0)into advances
    from public.customer_payment payment
    join public."transaction" tran using(transaction_id)
    left join lateral(
      select sum(item.amount)applied
      from public.customer_payment_application item
      where item.payment_id=payment.payment_id and item.application_date<=cutoff
    )application on true
    where tran.subsidiary_id=sid
      and tran.tran_date<=cutoff
      and(filter_entity_id is null or payment.customer_id=filter_entity_id);

  elsif p_kind='AP'then
    with docs as(
      select
        invoice.invoice_id document_id,
        supplier.supplier_id entity_id,
        supplier.supplier_number entity_code,
        supplier.tax_id identification,
        supplier.company_name entity_name,
        supplier.supplier_category entity_category,
        null::text manager,
        invoice.invoice_number external_document_number,
        coalesce(tran.tran_number,direct_journal.journal_number,fallback_journal.journal_number,invoice.invoice_number)document_number,
        coalesce(invoice.invoice_date,tran.tran_date,direct_journal.journal_date,fallback_journal.journal_date)issue_date,
        invoice.due_date,
        case when currency_mode='ORIGINAL'
          then (case when invoice.payable_amount=0
            and coalesce(invoice.withholding_total,0)=0
            and invoice.total_amount<>0
          then invoice.total_amount else invoice.payable_amount end)
          else (case when invoice.payable_amount=0
            and coalesce(invoice.withholding_total,0)=0
            and invoice.total_amount<>0
          then invoice.total_amount else invoice.payable_amount end)*coalesce(nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1)
        end original_amount,
        coalesce(application.applied,0)+coalesce(credit.amount,0)applied_amount,
        greatest(
          (case when invoice.payable_amount=0
            and coalesce(invoice.withholding_total,0)=0
            and invoice.total_amount<>0
          then invoice.total_amount else invoice.payable_amount end)
            *case when currency_mode='ORIGINAL'then 1 else coalesce(
              nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
            )end
          -coalesce(application.applied,0)-coalesce(credit.amount,0)
          +coalesce(debit.amount,0),0
        )pending,
        greatest(cutoff-invoice.due_date,0)overdue_days,
        case when cutoff<=invoice.due_date then'CURRENT'
          when cutoff-invoice.due_date<=30 then'1_30'
          when cutoff-invoice.due_date<=60 then'31_60'
          when cutoff-invoice.due_date<=90 then'61_90'
          when cutoff-invoice.due_date<=120 then'91_120'
          else'OVER_120'
        end bucket,
        coalesce(direct_journal.journal_id,fallback_journal.journal_id)journal_id,
        coalesce((
          select sum(
            greatest(payment.amount_paid-coalesce((
              select sum(payment_application.amount)
              from public.supplier_payment_application payment_application
              where payment_application.payment_id=payment.payment_id
                and payment_application.application_date<=cutoff
            ),0),0)
            *case when currency_mode='ORIGINAL'then 1 else coalesce(
              nullif(payment.exchange_rate,0),
              nullif(payment_transaction.exchange_rate,0),1
            )end
          )
          from public.supplier_payment payment
          join public."transaction" payment_transaction using(transaction_id)
          where payment.supplier_id=supplier.supplier_id
            and payment_transaction.subsidiary_id=sid
            and payment_transaction.tran_date<=cutoff
        ),0)entity_advances,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'date',history.history_date,
            'reference',history.reference,
            'type',history.history_type,
            'amount',history.amount
          )order by history.history_date)
          from(
            select applied.application_date history_date,payment.payment_number reference,
              'Pago aplicado'::text history_type,
              case when currency_mode='ORIGINAL'then
                case when coalesce(
                  payment.currency_id,payment_transaction.currency_id,
                  invoice.currency_id,tran.currency_id
                )=coalesce(invoice.currency_id,tran.currency_id)
                then applied.amount
                else applied.amount*coalesce(
                  nullif(payment.exchange_rate,0),
                  nullif(payment_transaction.exchange_rate,0),1
                )/coalesce(
                  nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
                )end
              else applied.amount*coalesce(
                nullif(payment.exchange_rate,0),
                nullif(payment_transaction.exchange_rate,0),1
              )end amount
            from public.supplier_payment_application applied
            join public.supplier_payment payment using(payment_id)
            left join public."transaction" payment_transaction
              on payment_transaction.transaction_id=payment.transaction_id
            where applied.invoice_id=invoice.invoice_id
              and applied.application_date<=cutoff
            union all
            select note_transaction.tran_date,note.cn_number,'Nota de crédito',
              case when currency_mode='ORIGINAL'then
                case when coalesce(
                  note.currency_id,note_transaction.currency_id,
                  invoice.currency_id,tran.currency_id
                )=coalesce(invoice.currency_id,tran.currency_id)
                then note.amount
                else note.amount*coalesce(
                  nullif(note.exchange_rate,0),
                  nullif(note_transaction.exchange_rate,0),1
                )/coalesce(
                  nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
                )end
              else note.amount*coalesce(
                nullif(note.exchange_rate,0),
                nullif(note_transaction.exchange_rate,0),
                nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
              )end
            from public.supplier_credit_note note
            join public."transaction" note_transaction using(transaction_id)
            where note.invoice_id=invoice.invoice_id
              and note_transaction.tran_date<=cutoff
          )history
        ),'[]'::jsonb)applications
      from public.supplier_invoice invoice
      left join public."transaction" tran
        on tran.transaction_id=invoice.transaction_id
      join public.suppliers supplier on supplier.supplier_id=invoice.supplier_id
      left join public.journal direct_journal
        on direct_journal.journal_id=invoice.journal_id
      left join lateral(
        select fallback.journal_id,fallback.journal_number,fallback.journal_date,fallback.transaction_id
        from public.journal fallback
        where invoice.journal_id is null
          and fallback.transaction_id=invoice.transaction_id
        order by fallback.journal_id
        limit 1
      )fallback_journal on true
      left join lateral(
        select sum(case when currency_mode='ORIGINAL'then
          case when coalesce(
            payment.currency_id,payment_transaction.currency_id,
            invoice.currency_id,tran.currency_id
          )=coalesce(invoice.currency_id,tran.currency_id)
          then applied.amount
          else applied.amount*coalesce(
            nullif(payment.exchange_rate,0),
            nullif(payment_transaction.exchange_rate,0),1
          )/coalesce(
            nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
          )end
        else applied.amount*coalesce(
          nullif(payment.exchange_rate,0),
          nullif(payment_transaction.exchange_rate,0),1
        )end)applied
        from public.supplier_payment_application applied
        join public.supplier_payment payment using(payment_id)
        left join public."transaction" payment_transaction
          on payment_transaction.transaction_id=payment.transaction_id
        where applied.invoice_id=invoice.invoice_id
          and applied.application_date<=cutoff
      )application on true
      left join lateral(
        select sum(case when currency_mode='ORIGINAL'then
          case when coalesce(
            note.currency_id,note_transaction.currency_id,
            invoice.currency_id,tran.currency_id
          )=coalesce(invoice.currency_id,tran.currency_id)
          then note.amount
          else note.amount*coalesce(
            nullif(note.exchange_rate,0),
            nullif(note_transaction.exchange_rate,0),1
          )/coalesce(
            nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
          )end
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
        from public.supplier_credit_note note
        join public."transaction" note_transaction using(transaction_id)
        where note.invoice_id=invoice.invoice_id
          and note_transaction.tran_date<=cutoff
      )credit on true
      left join lateral(
        select sum(case when currency_mode='ORIGINAL'then
          case when coalesce(
            note.currency_id,note_transaction.currency_id,
            invoice.currency_id,tran.currency_id
          )=coalesce(invoice.currency_id,tran.currency_id)
          then note.amount
          else note.amount*coalesce(
            nullif(note.exchange_rate,0),
            nullif(note_transaction.exchange_rate,0),1
          )/coalesce(
            nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
          )end
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
        from public.supplier_debit_note note
        join public."transaction" note_transaction using(transaction_id)
        where note.invoice_id=invoice.invoice_id
          and note_transaction.tran_date<=cutoff
      )debit on true
      where invoice.subsidiary_id=sid
        and coalesce(
          tran.tran_date,
          direct_journal.journal_date,
          fallback_journal.journal_date,
          invoice.invoice_date
        )<=cutoff
        and(filter_entity_id is null or supplier.supplier_id=filter_entity_id)
        and(filter_supplier_category is null or supplier.supplier_category=filter_supplier_category)
        and(filter_cost_id is null or exists(
          select 1 from public.journal_line line
          where line.journal_id=coalesce(direct_journal.journal_id,fallback_journal.journal_id)
            and line.cost_center_id=filter_cost_id
            and(
              invoice.opening_balance_line_id is null
              or line.opening_balance_line_id=invoice.opening_balance_line_id
            )
        ))
        and(filter_book_id is null or exists(
          select 1 from public.gl_impact impact
          where impact.transaction_id=coalesce(
              invoice.transaction_id,
              direct_journal.transaction_id,
              fallback_journal.transaction_id
            )
            and impact.accounting_book_id=filter_book_id
            and(
              invoice.opening_balance_line_id is null
              or impact.opening_balance_line_id=invoice.opening_balance_line_id
            )
        ))
    ),filtered as(
      select *,count(*)over()total_count,sum(pending)over()subledger_total
      from docs where not only_pending or pending>.005
    ),paged as(
      select *from filtered
      order by entity_name,due_date,document_number,document_id
      limit page_size offset(page_no-1)*page_size
    )
    select jsonb_build_object(
      'rows',coalesce(jsonb_agg(to_jsonb(paged)-'total_count'-'subledger_total'),'[]'::jsonb),
      'total',coalesce(max(total_count),0),
      'subledgerTotal',coalesce(max(subledger_total),0),
      'page',page_no,
      'pageSize',page_size
    )into result from paged;

    select coalesce(sum(
      case when coalesce(account.nature,account_group.nature)='Acreedora'
        then impact.credit_amount-impact.debit_amount
        else impact.debit_amount-impact.credit_amount
      end
    ),0)into control_balance
    from public.gl_impact impact
    join public.chart_accounts account using(account_id)
    join public.account_group account_group on account_group.group_id=account.account_group_id
    where impact.subsidiary_id=sid
      and impact.posting_date<=cutoff
      and(filter_book_id is null or impact.accounting_book_id=filter_book_id)
      and(
        lower(account.account_name)like'%cuenta%por pagar%'
        or lower(account.account_name)like'%proveedores por pagar%'
      );

    subledger:=coalesce((result->>'subledgerTotal')::numeric,0);
    select coalesce(sum(
      greatest(payment.amount_paid-coalesce(application.applied,0),0)
      *case when currency_mode='ORIGINAL'then 1 else coalesce(
        nullif(payment.exchange_rate,0),nullif(tran.exchange_rate,0),1
      )end
    ),0)into advances
    from public.supplier_payment payment
    join public."transaction" tran using(transaction_id)
    left join lateral(
      select sum(item.amount)applied
      from public.supplier_payment_application item
      where item.payment_id=payment.payment_id and item.application_date<=cutoff
    )application on true
    where tran.subsidiary_id=sid
      and tran.tran_date<=cutoff
      and(filter_entity_id is null or payment.supplier_id=filter_entity_id);
  else
    raise exception 'Tipo de auxiliar no válido.';
  end if;

  result:=coalesce(result,jsonb_build_object(
    'rows','[]'::jsonb,'total',0,'page',page_no,'pageSize',page_size
  ));
  return(result-'subledgerTotal')||jsonb_build_object('summary',jsonb_build_object(
    'subledger',subledger,
    'advances',advances,
    'netBalance',subledger-advances,
    'controlBalance',control_balance,
    'difference',(subledger-advances)-control_balance
  ));
end
$$;

create or replace function public.aging_original_currency_breakdown(
  p_kind text,
  p_filters jsonb default '{}'::jsonb,
  p_local boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=nullif(p_filters->'subsidiaryIds'->>0,'')::bigint;
  cutoff date:=nullif(p_filters->>'dateTo','')::date;
  filter_entity_id bigint:=nullif(p_filters->>'agingEntityId','')::bigint;
  sales_id bigint:=nullif(p_filters->>'salesRepresentativeId','')::bigint;
  filter_cost_id bigint:=nullif(p_filters->>'costCenterId','')::bigint;
  filter_book_id bigint:=nullif(p_filters->>'bookId','')::bigint;
  filter_supplier_category text:=nullif(p_filters->>'supplierCategory','');
  only_pending boolean:=coalesce((p_filters->>'onlyPending')::boolean,true);
  result jsonb;
begin
  if p_kind not in('AR','AP')then
    raise exception 'Tipo de auxiliar no válido.';
  end if;
  if sid is null or cutoff is null then
    raise exception 'La subsidiaria y la fecha de corte son obligatorias.';
  end if;

  with source as materialized(
    -- Pending documents are already expressed in their original currency.
    select
      case when p_local then subsidiary.currency_id
        else coalesce(invoice.currency_id,tran.currency_id,subsidiary.currency_id)
      end currency_id,
      sum(greatest(
        coalesce(nullif(invoice.receivable_amount,0),invoice.total_amount)
          *case when p_local then coalesce(
            nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
          )else 1 end
        -coalesce(application.applied,0)
        -coalesce(credit.amount,0)+coalesce(debit.amount,0),0
      ))::numeric subledger,
      0::numeric advances,
      0::numeric control_balance
    from public.invoice invoice
    join public.subsidiaries subsidiary
      on subsidiary.subsidiary_id=invoice.subsidiary_id
    left join public."transaction" tran
      on tran.transaction_id=invoice.transaction_id
    join public.customers customer on customer.customer_id=invoice.customer_id
    left join public.journal direct_journal
      on direct_journal.journal_id=invoice.journal_id
    left join lateral(
      select fallback.journal_id,fallback.journal_date,fallback.transaction_id
      from public.journal fallback
      where invoice.journal_id is null
        and fallback.transaction_id=invoice.transaction_id
      order by fallback.journal_id
      limit 1
    )fallback_journal on true
    left join lateral(
      select sum(case when p_local then
        applied.amount*coalesce(
          nullif(payment.exchange_rate,0),
          nullif(payment_transaction.exchange_rate,0),1
        )
      else case when coalesce(
          payment.currency_id,payment_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then applied.amount
        else applied.amount*coalesce(
          nullif(payment.exchange_rate,0),
          nullif(payment_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end
      end)applied
      from public.customer_payment_application applied
      join public.customer_payment payment using(payment_id)
      left join public."transaction" payment_transaction
        on payment_transaction.transaction_id=payment.transaction_id
      where applied.invoice_id=invoice.invoice_id
        and applied.application_date<=cutoff
    )application on true
    left join lateral(
      select sum(case when p_local then
        note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )
      else case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end
      end)amount
      from public.credit_note note
      join public."transaction" note_transaction using(transaction_id)
      where note.invoice_id=invoice.invoice_id
        and note_transaction.tran_date<=cutoff
    )credit on true
    left join lateral(
      select sum(case when p_local then
        note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )
      else case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end
      end)amount
      from public.debit_note note
      join public."transaction" note_transaction using(transaction_id)
      where note.invoice_id=invoice.invoice_id
        and note_transaction.tran_date<=cutoff
    )debit on true
    where p_kind='AR'
      and invoice.subsidiary_id=sid
      and coalesce(
        tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date,invoice.invoice_date
      )<=cutoff
      and(filter_entity_id is null or customer.customer_id=filter_entity_id)
      and(sales_id is null or customer.sales_representative_id=sales_id)
      and(filter_book_id is null or exists(
        select 1
        from public.gl_impact impact
        where impact.transaction_id=coalesce(
            invoice.transaction_id,direct_journal.transaction_id,
            fallback_journal.transaction_id
          )
          and impact.accounting_book_id=filter_book_id
          and(
            invoice.opening_balance_line_id is null
            or impact.opening_balance_line_id=invoice.opening_balance_line_id
          )
      ))
    group by case when p_local then subsidiary.currency_id
      else coalesce(invoice.currency_id,tran.currency_id,subsidiary.currency_id)
    end

    union all

    select
      case when p_local then subsidiary.currency_id
        else coalesce(invoice.currency_id,tran.currency_id,subsidiary.currency_id)
      end,
      sum(greatest(
        (case
          when invoice.payable_amount=0
            and coalesce(invoice.withholding_total,0)=0
            and invoice.total_amount<>0
          then invoice.total_amount
          else invoice.payable_amount
        end)*case when p_local then coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )else 1 end-coalesce(application.applied,0)
        -coalesce(credit.amount,0)+coalesce(debit.amount,0),0
      ))::numeric,
      0::numeric,
      0::numeric
    from public.supplier_invoice invoice
    join public.subsidiaries subsidiary
      on subsidiary.subsidiary_id=invoice.subsidiary_id
    left join public."transaction" tran
      on tran.transaction_id=invoice.transaction_id
    join public.suppliers supplier on supplier.supplier_id=invoice.supplier_id
    left join public.journal direct_journal
      on direct_journal.journal_id=invoice.journal_id
    left join lateral(
      select fallback.journal_id,fallback.journal_date,fallback.transaction_id
      from public.journal fallback
      where invoice.journal_id is null
        and fallback.transaction_id=invoice.transaction_id
      order by fallback.journal_id
      limit 1
    )fallback_journal on true
    left join lateral(
      select sum(case when p_local then
        applied.amount*coalesce(
          nullif(payment.exchange_rate,0),
          nullif(payment_transaction.exchange_rate,0),1
        )
      else case when coalesce(
          payment.currency_id,payment_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then applied.amount
        else applied.amount*coalesce(
          nullif(payment.exchange_rate,0),
          nullif(payment_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end
      end)applied
      from public.supplier_payment_application applied
      join public.supplier_payment payment using(payment_id)
      left join public."transaction" payment_transaction
        on payment_transaction.transaction_id=payment.transaction_id
      where applied.invoice_id=invoice.invoice_id
        and applied.application_date<=cutoff
    )application on true
    left join lateral(
      select sum(case when p_local then
        note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )
      else case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end
      end)amount
      from public.supplier_credit_note note
      join public."transaction" note_transaction using(transaction_id)
      where note.invoice_id=invoice.invoice_id
        and note_transaction.tran_date<=cutoff
    )credit on true
    left join lateral(
      select sum(case when p_local then
        note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )
      else case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end
      end)amount
      from public.supplier_debit_note note
      join public."transaction" note_transaction using(transaction_id)
      where note.invoice_id=invoice.invoice_id
        and note_transaction.tran_date<=cutoff
    )debit on true
    where p_kind='AP'
      and invoice.subsidiary_id=sid
      and coalesce(
        tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date,invoice.invoice_date
      )<=cutoff
      and(filter_entity_id is null or supplier.supplier_id=filter_entity_id)
      and(filter_supplier_category is null
        or supplier.supplier_category=filter_supplier_category)
      and(filter_cost_id is null or exists(
        select 1
        from public.journal_line line
        where line.journal_id=coalesce(
            direct_journal.journal_id,fallback_journal.journal_id
          )
          and line.cost_center_id=filter_cost_id
          and(
            invoice.opening_balance_line_id is null
            or line.opening_balance_line_id=invoice.opening_balance_line_id
          )
      ))
      and(filter_book_id is null or exists(
        select 1
        from public.gl_impact impact
        where impact.transaction_id=coalesce(
            invoice.transaction_id,direct_journal.transaction_id,
            fallback_journal.transaction_id
          )
          and impact.accounting_book_id=filter_book_id
          and(
            invoice.opening_balance_line_id is null
            or impact.opening_balance_line_id=invoice.opening_balance_line_id
          )
      ))
    group by case when p_local then subsidiary.currency_id
      else coalesce(invoice.currency_id,tran.currency_id,subsidiary.currency_id)
    end

    union all

    -- Unapplied receipts/payments stay separated by their own currency.
    select
      case when p_local then subsidiary.currency_id
        else coalesce(payment.currency_id,tran.currency_id,subsidiary.currency_id)
      end,
      0::numeric,
      sum(greatest(payment.amount_received-coalesce(application.applied,0),0)
        *case when p_local then coalesce(nullif(tran.exchange_rate,0),1)
          else 1 end),
      0::numeric
    from public.customer_payment payment
    join public."transaction" tran using(transaction_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    join public.customers customer on customer.customer_id=payment.customer_id
    left join lateral(
      select sum(item.amount)applied
      from public.customer_payment_application item
      where item.payment_id=payment.payment_id
        and item.application_date<=cutoff
    )application on true
    where p_kind='AR'
      and tran.subsidiary_id=sid
      and tran.tran_date<=cutoff
      and(filter_entity_id is null or payment.customer_id=filter_entity_id)
      and(sales_id is null or customer.sales_representative_id=sales_id)
      and(filter_book_id is null or exists(
        select 1 from public.gl_impact impact
        where impact.transaction_id=tran.transaction_id
          and impact.accounting_book_id=filter_book_id
      ))
    group by case when p_local then subsidiary.currency_id
      else coalesce(payment.currency_id,tran.currency_id,subsidiary.currency_id)
    end

    union all

    select
      case when p_local then subsidiary.currency_id
        else coalesce(payment.currency_id,tran.currency_id,subsidiary.currency_id)
      end,
      0::numeric,
      sum(greatest(payment.amount_paid-coalesce(application.applied,0),0)
        *case when p_local then coalesce(nullif(tran.exchange_rate,0),1)
          else 1 end),
      0::numeric
    from public.supplier_payment payment
    join public."transaction" tran using(transaction_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    join public.suppliers supplier on supplier.supplier_id=payment.supplier_id
    left join lateral(
      select sum(item.amount)applied
      from public.supplier_payment_application item
      where item.payment_id=payment.payment_id
        and item.application_date<=cutoff
    )application on true
    where p_kind='AP'
      and filter_cost_id is null
      and tran.subsidiary_id=sid
      and tran.tran_date<=cutoff
      and(filter_entity_id is null or payment.supplier_id=filter_entity_id)
      and(filter_supplier_category is null
        or supplier.supplier_category=filter_supplier_category)
      and(filter_book_id is null or exists(
        select 1 from public.gl_impact impact
        where impact.transaction_id=tran.transaction_id
          and impact.accounting_book_id=filter_book_id
      ))
    group by case when p_local then subsidiary.currency_id
      else coalesce(payment.currency_id,tran.currency_id,subsidiary.currency_id)
    end

    union all

    -- The GL comparison uses the FX columns, never local debit/credit, and
    -- resolves opening-balance parties from the matching journal line.
    select
      case when p_local then subsidiary.currency_id
        else coalesce(impact.original_currency_id,tran.currency_id,subsidiary.currency_id)
      end,
      0::numeric,
      0::numeric,
      sum(case
        when coalesce(account.nature,account_group.nature)='Acreedora'
          then case when p_local
            then impact.credit_amount-impact.debit_amount
            else impact.credit_fx-impact.debit_fx end
        else case when p_local
          then impact.debit_amount-impact.credit_amount
          else impact.debit_fx-impact.credit_fx end
      end)::numeric
    from public.gl_impact impact
    join public.chart_accounts account using(account_id)
    join public.account_group account_group
      on account_group.group_id=account.account_group_id
    join public.subsidiaries subsidiary using(subsidiary_id)
    left join public."transaction" tran using(transaction_id)
    left join lateral(
      select line.customer_id,line.supplier_id
      from public.journal journal
      join public.journal_line line using(journal_id)
      where journal.transaction_id=impact.transaction_id
        and line.account_id=impact.account_id
        and(
          impact.opening_balance_line_id is null
          or line.opening_balance_line_id=impact.opening_balance_line_id
        )
        and(line.customer_id is not null or line.supplier_id is not null)
      order by line.journal_line_id
      limit 1
    )party_line on true
    left join public.customers customer
      on customer.customer_id=coalesce(tran.customer_id,party_line.customer_id)
    left join public.suppliers supplier
      on supplier.supplier_id=coalesce(tran.supplier_id,party_line.supplier_id)
    where impact.subsidiary_id=sid
      and impact.posting_date<=cutoff
      and(filter_book_id is null or impact.accounting_book_id=filter_book_id)
      and(
        (p_kind='AR'and(
          lower(account.account_name)like'%cuenta%por cobrar%'
          or lower(account.account_name)like'%clientes por cobrar%'
        ))
        or(p_kind='AP'and(
          lower(account.account_name)like'%cuenta%por pagar%'
          or lower(account.account_name)like'%proveedores por pagar%'
        ))
      )
      and(filter_entity_id is null or case when p_kind='AR'
        then coalesce(tran.customer_id,party_line.customer_id)=filter_entity_id
        else coalesce(tran.supplier_id,party_line.supplier_id)=filter_entity_id
      end)
      and(p_kind<>'AR'or sales_id is null
        or customer.sales_representative_id=sales_id)
      and(p_kind<>'AP'or filter_supplier_category is null
        or supplier.supplier_category=filter_supplier_category)
      and(p_kind<>'AP'or filter_cost_id is null or exists(
        select 1
        from public.journal scoped_journal
        join public.journal_line scoped_line using(journal_id)
        where scoped_journal.transaction_id=impact.transaction_id
          and scoped_line.cost_center_id=filter_cost_id
          and(
            impact.opening_balance_line_id is null
            or scoped_line.opening_balance_line_id=impact.opening_balance_line_id
          )
      ))
    group by case when p_local then subsidiary.currency_id
      else coalesce(
        impact.original_currency_id,tran.currency_id,subsidiary.currency_id
      )
    end
  ),totals as(
    select currency_id,
      sum(subledger)::numeric subledger,
      sum(advances)::numeric advances,
      sum(control_balance)::numeric control_balance
    from source
    group by currency_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'currencyId',currency.currency_id,
    'currencyCode',currency.currency_code,
    'currencyName',currency.name,
    'currencySymbol',currency.symbol,
    'subledger',totals.subledger,
    'advances',totals.advances,
    'netBalance',totals.subledger-totals.advances,
    'controlBalance',totals.control_balance,
    'difference',(totals.subledger-totals.advances)-totals.control_balance
  )order by currency.currency_code),'[]'::jsonb)
  into result
  from totals
  join public.currencies currency using(currency_id)
  where not only_pending
     or abs(totals.subledger)>.0000005
     or abs(totals.advances)>.0000005
     or abs(totals.control_balance)>.0000005;

  return result;
end
$$;

create or replace function public.run_aging_report_before_consolidation(
  p_kind text,
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  report jsonb;
  rows_with_currency jsonb;
  breakdown jsonb;
  breakdown_count integer;
  only_currency jsonb;
  cutoff date:=nullif(p_filters->>'dateTo','')::date;
  sid bigint:=nullif(p_filters->'subsidiaryIds'->>0,'')::bigint;
  filter_entity_id bigint:=nullif(p_filters->>'agingEntityId','')::bigint;
  currency_mode text:=upper(coalesce(
    nullif(p_filters->>'agingCurrencyMode',''),'LOCAL'
  ));
  cross_currency_activity boolean:=false;
  reconciliation_available boolean;
  reconciliation_reason text;
begin
  report:=public.run_aging_report_before_original_currency_reconciliation(
    p_kind,p_filters
  );

  if currency_mode='ORIGINAL'and p_kind='AR'then
    select
      exists(
        select 1
        from public.customer_payment_application application
        join public.customer_payment payment using(payment_id)
        join public."transaction" payment_transaction
          on payment_transaction.transaction_id=payment.transaction_id
        join public.invoice invoice using(invoice_id)
        left join public."transaction" invoice_transaction
          on invoice_transaction.transaction_id=invoice.transaction_id
        where invoice.subsidiary_id=sid
          and application.application_date<=cutoff
          and(filter_entity_id is null or invoice.customer_id=filter_entity_id)
          and coalesce(payment.currency_id,payment_transaction.currency_id)
            is distinct from coalesce(invoice.currency_id,invoice_transaction.currency_id)
      )or exists(
        select 1 from public.credit_note note
        join public."transaction" note_transaction using(transaction_id)
        join public.invoice invoice using(invoice_id)
        left join public."transaction" invoice_transaction
          on invoice_transaction.transaction_id=invoice.transaction_id
        where invoice.subsidiary_id=sid and note_transaction.tran_date<=cutoff
          and(filter_entity_id is null or invoice.customer_id=filter_entity_id)
          and coalesce(note.currency_id,note_transaction.currency_id)
            is distinct from coalesce(invoice.currency_id,invoice_transaction.currency_id)
      )or exists(
        select 1 from public.debit_note note
        join public."transaction" note_transaction using(transaction_id)
        join public.invoice invoice using(invoice_id)
        left join public."transaction" invoice_transaction
          on invoice_transaction.transaction_id=invoice.transaction_id
        where invoice.subsidiary_id=sid and note_transaction.tran_date<=cutoff
          and(filter_entity_id is null or invoice.customer_id=filter_entity_id)
          and coalesce(note.currency_id,note_transaction.currency_id)
            is distinct from coalesce(invoice.currency_id,invoice_transaction.currency_id)
      )into cross_currency_activity;
  elsif currency_mode='ORIGINAL'and p_kind='AP'then
    select
      exists(
        select 1
        from public.supplier_payment_application application
        join public.supplier_payment payment using(payment_id)
        join public."transaction" payment_transaction
          on payment_transaction.transaction_id=payment.transaction_id
        join public.supplier_invoice invoice using(invoice_id)
        left join public."transaction" invoice_transaction
          on invoice_transaction.transaction_id=invoice.transaction_id
        where invoice.subsidiary_id=sid
          and application.application_date<=cutoff
          and(filter_entity_id is null or invoice.supplier_id=filter_entity_id)
          and coalesce(payment.currency_id,payment_transaction.currency_id)
            is distinct from coalesce(invoice.currency_id,invoice_transaction.currency_id)
      )or exists(
        select 1 from public.supplier_credit_note note
        join public."transaction" note_transaction using(transaction_id)
        join public.supplier_invoice invoice using(invoice_id)
        left join public."transaction" invoice_transaction
          on invoice_transaction.transaction_id=invoice.transaction_id
        where invoice.subsidiary_id=sid and note_transaction.tran_date<=cutoff
          and(filter_entity_id is null or invoice.supplier_id=filter_entity_id)
          and coalesce(note.currency_id,note_transaction.currency_id)
            is distinct from coalesce(invoice.currency_id,invoice_transaction.currency_id)
      )or exists(
        select 1 from public.supplier_debit_note note
        join public."transaction" note_transaction using(transaction_id)
        join public.supplier_invoice invoice using(invoice_id)
        left join public."transaction" invoice_transaction
          on invoice_transaction.transaction_id=invoice.transaction_id
        where invoice.subsidiary_id=sid and note_transaction.tran_date<=cutoff
          and(filter_entity_id is null or invoice.supplier_id=filter_entity_id)
          and coalesce(note.currency_id,note_transaction.currency_id)
            is distinct from coalesce(invoice.currency_id,invoice_transaction.currency_id)
      )into cross_currency_activity;
  end if;

  reconciliation_reason:=case
    when nullif(p_filters->>'costCenterId','')is not null
      then'ANALYTICAL_FILTERS'
    when cross_currency_activity then'CROSS_CURRENCY'
    else null
  end;
  reconciliation_available:=reconciliation_reason is null;

  if currency_mode<>'ORIGINAL'then
    breakdown:=public.aging_original_currency_breakdown(p_kind,p_filters,true);
    rows_with_currency:=coalesce(report->'rows','[]'::jsonb);
  else
    -- Add the document currency explicitly so every displayed/exported value
    -- carries its unit. Correct the entity advance per document currency too.
    with items as(
      select item.value item,
        nullif(item.value->>'document_id','')::bigint document_id,
        nullif(item.value->>'entity_id','')::bigint entity_id,
        item.ordinality
      from jsonb_array_elements(coalesce(report->'rows','[]'::jsonb))
        with ordinality item(value,ordinality)
    ),typed as(
      select items.*,
        coalesce(ar_invoice.currency_id,ar_tran.currency_id,
          ap_invoice.currency_id,ap_tran.currency_id)currency_id
      from items
      left join public.invoice ar_invoice
        on p_kind='AR'and ar_invoice.invoice_id=items.document_id
      left join public."transaction" ar_tran
        on ar_tran.transaction_id=ar_invoice.transaction_id
      left join public.supplier_invoice ap_invoice
        on p_kind='AP'and ap_invoice.invoice_id=items.document_id
      left join public."transaction" ap_tran
        on ap_tran.transaction_id=ap_invoice.transaction_id
    )
    select coalesce(jsonb_agg(
      typed.item||jsonb_build_object(
        'currency_id',currency.currency_id,
        'currency_code',currency.currency_code,
        'currency_name',currency.name,
        'currency_symbol',currency.symbol,
        'presentation_currency',currency.currency_code,
        'entity_advances',case when p_kind='AR'then coalesce((
          select sum(greatest(payment.amount_received-coalesce(application.applied,0),0))
          from public.customer_payment payment
          join public."transaction" tran using(transaction_id)
          left join lateral(
            select sum(applied.amount)applied
            from public.customer_payment_application applied
            where applied.payment_id=payment.payment_id
              and applied.application_date<=cutoff
          )application on true
          where payment.customer_id=typed.entity_id
            and tran.subsidiary_id=nullif(p_filters->'subsidiaryIds'->>0,'')::bigint
            and tran.tran_date<=cutoff
            and coalesce(payment.currency_id,tran.currency_id)=typed.currency_id
        ),0)else coalesce((
          select sum(greatest(payment.amount_paid-coalesce(application.applied,0),0))
          from public.supplier_payment payment
          join public."transaction" tran using(transaction_id)
          left join lateral(
            select sum(applied.amount)applied
            from public.supplier_payment_application applied
            where applied.payment_id=payment.payment_id
              and applied.application_date<=cutoff
          )application on true
          where payment.supplier_id=typed.entity_id
            and tran.subsidiary_id=nullif(p_filters->'subsidiaryIds'->>0,'')::bigint
            and tran.tran_date<=cutoff
            and coalesce(payment.currency_id,tran.currency_id)=typed.currency_id
        ),0)end
      )order by typed.ordinality
    ),'[]'::jsonb)
    into rows_with_currency
    from typed
    join public.currencies currency using(currency_id);

    breakdown:=public.aging_original_currency_breakdown(p_kind,p_filters,false);
  end if;

  select coalesce(jsonb_agg(
    item.value||case when reconciliation_available
      then jsonb_build_object('reconciliationAvailable',true)
      else jsonb_build_object(
        'reconciliationAvailable',false,
        'reconciliationReason',reconciliation_reason,
        'controlBalance',null,
        'difference',null
      )
    end order by item.ordinality
  ),'[]'::jsonb)
  into breakdown
  from jsonb_array_elements(breakdown)with ordinality item(value,ordinality);

  breakdown_count:=jsonb_array_length(breakdown);
  only_currency:=case when breakdown_count=1 then breakdown->0 else null end;

  return jsonb_set(report,'{rows}',rows_with_currency,true)
    ||jsonb_build_object('currencyMode',currency_mode)
    ||jsonb_build_object('summary',jsonb_build_object(
      'currencyMode',currency_mode,
      'currencyBreakdown',breakdown,
      'mixedCurrencies',breakdown_count>1,
      'reconciliationAvailable',reconciliation_available,
      'reconciliationReason',reconciliation_reason,
      'currencyId',case when breakdown_count=1
        then(only_currency->>'currencyId')::bigint else null end,
      'currencyCode',case when breakdown_count=1
        then only_currency->>'currencyCode'else null end,
      'currencyName',case when breakdown_count=1
        then only_currency->>'currencyName'else null end,
      'currencySymbol',case when breakdown_count=1
        then only_currency->>'currencySymbol'else null end,
      'subledger',case when breakdown_count=0 then 0
        when breakdown_count=1 then(only_currency->>'subledger')::numeric
        else null end,
      'advances',case when breakdown_count=0 then 0
        when breakdown_count=1 then(only_currency->>'advances')::numeric
        else null end,
      'netBalance',case when breakdown_count=0 then 0
        when breakdown_count=1 then(only_currency->>'netBalance')::numeric
        else null end,
      'controlBalance',case when not reconciliation_available then null
        when breakdown_count=0 then 0
        when breakdown_count=1 then(only_currency->>'controlBalance')::numeric
        else null end,
      'difference',case when not reconciliation_available then null
        when breakdown_count=0 then 0
        when breakdown_count=1 then(only_currency->>'difference')::numeric
        else null end
    ));
end
$$;

revoke all on function public.aging_original_currency_breakdown(text,jsonb,boolean),
  public.run_aging_report_before_consolidation(text,jsonb)
  from public,anon,authenticated;

comment on function public.aging_original_currency_breakdown(text,jsonb,boolean) is
  'Conciliación CxC/CxP por moneda original usando debit_fx/credit_fx y original_currency_id con fallback a la moneda de transacción.';

comment on function public.run_aging_report_before_consolidation(text,jsonb) is
  'Antigüedad CxC/CxP con filas identificadas por moneda y conciliación separada por moneda original.';

notify pgrst,'reload schema';
