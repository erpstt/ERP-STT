-- Include opening AR/AP documents in the aging reports.
--
-- Opening documents intentionally keep their own document date and historical
-- exchange rate.  They point directly to the shared opening journal and do not
-- need an individual transaction row.  The original aging query used an inner
-- join to `transaction`, so those documents disappeared from the subledger
-- while their journal lines remained in the General Ledger.

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
  currency_mode:=coalesce(nullif(p_filters->>'agingCurrencyMode',''),'LOCAL');
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
          then invoice.total_amount
          else invoice.total_amount*coalesce(nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1)
        end original_amount,
        case when currency_mode='ORIGINAL'
          then coalesce(application.applied,0)+coalesce(credit.amount,0)
          else(coalesce(application.applied,0)+coalesce(credit.amount,0))
            *coalesce(nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1)
        end applied_amount,
        case when currency_mode='ORIGINAL'
          then greatest(invoice.total_amount-coalesce(application.applied,0)-coalesce(credit.amount,0)+coalesce(debit.amount,0),0)
          else greatest(invoice.total_amount-coalesce(application.applied,0)-coalesce(credit.amount,0)+coalesce(debit.amount,0),0)
            *coalesce(nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1)
        end pending,
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
            *case when currency_mode='ORIGINAL'then 1 else payment_transaction.exchange_rate end
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
            'amount',applied.amount
          )order by applied.application_date)
          from public.customer_payment_application applied
          join public.customer_payment payment using(payment_id)
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
        select sum(applied.amount)applied
        from public.customer_payment_application applied
        where applied.invoice_id=invoice.invoice_id
          and applied.application_date<=cutoff
      )application on true
      left join lateral(
        select sum(note.amount)amount
        from public.credit_note note
        join public."transaction" note_transaction using(transaction_id)
        where note.invoice_id=invoice.invoice_id
          and note_transaction.tran_date<=cutoff
      )credit on true
      left join lateral(
        select sum(note.amount)amount
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
      order by entity_name,due_date,document_number
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
      *case when currency_mode='ORIGINAL'then 1 else tran.exchange_rate end
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
          then invoice.total_amount
          else invoice.total_amount*coalesce(nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1)
        end original_amount,
        case when currency_mode='ORIGINAL'
          then coalesce(application.applied,0)+coalesce(credit.amount,0)
          else(coalesce(application.applied,0)+coalesce(credit.amount,0))
            *coalesce(nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1)
        end applied_amount,
        case when currency_mode='ORIGINAL'
          then greatest(invoice.total_amount-coalesce(application.applied,0)-coalesce(credit.amount,0)+coalesce(debit.amount,0),0)
          else greatest(invoice.total_amount-coalesce(application.applied,0)-coalesce(credit.amount,0)+coalesce(debit.amount,0),0)
            *coalesce(nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1)
        end pending,
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
            *case when currency_mode='ORIGINAL'then 1 else payment_transaction.exchange_rate end
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
              'Pago aplicado'::text history_type,applied.amount
            from public.supplier_payment_application applied
            join public.supplier_payment payment using(payment_id)
            where applied.invoice_id=invoice.invoice_id
              and applied.application_date<=cutoff
            union all
            select note_transaction.tran_date,note.cn_number,'Nota de crédito',note.amount
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
        select sum(applied.amount)applied
        from public.supplier_payment_application applied
        where applied.invoice_id=invoice.invoice_id
          and applied.application_date<=cutoff
      )application on true
      left join lateral(
        select sum(note.amount)amount
        from public.supplier_credit_note note
        join public."transaction" note_transaction using(transaction_id)
        where note.invoice_id=invoice.invoice_id
          and note_transaction.tran_date<=cutoff
      )credit on true
      left join lateral(
        select sum(note.amount)amount
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
      order by entity_name,due_date,document_number
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
      *case when currency_mode='ORIGINAL'then 1 else tran.exchange_rate end
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

revoke all on function public.run_aging_report_before_consolidation(text,jsonb)
  from public,anon,authenticated;

comment on function public.run_aging_report_before_consolidation(text,jsonb) is
 'Antigüedad CxC/CxP por documento, incluyendo auxiliares de apertura con su fecha documental, fecha contable y tasa histórica.';

notify pgrst,'reload schema';
