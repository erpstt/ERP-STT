-- Commercial intercompany receivables/payables report.
--
-- 113002 is the historical control account selected on sales invoices for
-- intercompany customers. 211002 is the equivalent snapshot for supplier
-- invoices. The report keeps the General Ledger and the document subledger as
-- separate sources and reconciles them by party and original currency.

create index if not exists invoice_intercompany_commercial_report_idx
  on public.invoice(
    subsidiary_id,receivable_account_id,currency_id,customer_id,invoice_date
  );

create index if not exists supplier_invoice_intercompany_commercial_report_idx
  on public.supplier_invoice(
    subsidiary_id,payable_account_id,currency_id,supplier_id,invoice_date
  );

create index if not exists journal_line_intercompany_commercial_ar_idx
  on public.journal_line(account_id,customer_id,journal_id)
  where customer_id is not null;

create index if not exists journal_line_intercompany_commercial_ap_idx
  on public.journal_line(account_id,supplier_id,journal_id)
  where supplier_id is not null;

do $$
begin
  if to_regprocedure(
      'public.accounting_report_options_before_intercompany_commercial()'
    )is null
    and to_regprocedure('public.accounting_report_options()')is not null
  then
    execute 'alter function public.accounting_report_options() '
      ||'rename to accounting_report_options_before_intercompany_commercial';
  end if;

  if to_regprocedure(
      'public.run_accounting_report_before_intercompany_commercial(text,jsonb)'
    )is null
    and to_regprocedure('public.run_accounting_report(text,jsonb)')is not null
  then
    execute 'alter function public.run_accounting_report(text,jsonb) '
      ||'rename to run_accounting_report_before_intercompany_commercial';
  end if;
end
$$;

revoke all on function
  public.accounting_report_options_before_intercompany_commercial(),
  public.run_accounting_report_before_intercompany_commercial(text,jsonb)
  from public,anon,authenticated;

create or replace function public.accounting_report_options()
returns jsonb
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  with allowed as(
    select access.subsidiary_id
    from public.user_subsidiaries access
    where access.user_id=public.app_user_id()
  ),target_accounts as(
    select account.account_id,account.account_number
    from public.chart_accounts account
    where account.account_number in('113002','211002')
  ),party_scope as(
    select 'CUSTOMER'::text party_type,customer.customer_id party_id,
      customer.customer_number party_code,customer.company_name party_name,
      customer.tax_id identification,scope.subsidiary_id
    from public.customers customer
    join lateral(
      select link.subsidiary_id
      from public.entity_subsidiaries link
      where link.customer_id=customer.customer_id
      union
      select customer.primary_subsidiary_id
    )scope on true
    join allowed using(subsidiary_id)
    where customer.is_intercompany
      or exists(
        select 1
        from public.invoice invoice
        join target_accounts account
          on account.account_id=invoice.receivable_account_id
          and account.account_number='113002'
        where invoice.customer_id=customer.customer_id
          and invoice.subsidiary_id=scope.subsidiary_id
      )
    union all
    select 'SUPPLIER',supplier.supplier_id,supplier.supplier_number,
      supplier.company_name,supplier.tax_id,scope.subsidiary_id
    from public.suppliers supplier
    join lateral(
      select link.subsidiary_id
      from public.entity_subsidiaries link
      where link.supplier_id=supplier.supplier_id
      union
      select supplier.primary_subsidiary_id
    )scope on true
    join allowed using(subsidiary_id)
    where supplier.is_intercompany
      or exists(
        select 1
        from public.supplier_invoice invoice
        join target_accounts account
          on account.account_id=invoice.payable_account_id
          and account.account_number='211002'
        where invoice.supplier_id=supplier.supplier_id
          and invoice.subsidiary_id=scope.subsidiary_id
      )
  ),parties as(
    select party_type,party_id,party_code,party_name,identification,
      jsonb_agg(distinct subsidiary_id order by subsidiary_id)subsidiary_ids
    from party_scope
    group by party_type,party_id,party_code,party_name,identification
  )
  select public.accounting_report_options_before_intercompany_commercial()
    ||jsonb_build_object(
      'intercompanyCommercialParties',coalesce((
        select jsonb_agg(jsonb_build_object(
          'key',party.party_type||':'||party.party_id,
          'partyKey',party.party_type||':'||party.party_id,
          'id',party.party_id,
          'type',party.party_type,
          'thirdPartyType',party.party_type,
          'code',party.party_code,
          'name',party.party_name,
          'identification',party.identification,
          'subsidiaryIds',party.subsidiary_ids
        )order by party.party_name,party.party_type,party.party_id)
        from parties party
      ),'[]'::jsonb)
    )
$$;

create or replace function public.run_intercompany_commercial_report(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  subsidiary_ids bigint[];
  filter_book_id bigint:=nullif(p_filters->>'bookId','')::bigint;
  filter_currency_ids bigint[];
  filter_direction text:=upper(coalesce(
    nullif(p_filters->>'direction',''),'ALL'
  ));
  filter_party_key text:=upper(nullif(btrim(p_filters->>'partyKey'),''));
  filter_party_type text;
  filter_party_id bigint;
  filter_search text:=nullif(btrim(p_filters->>'search'),'');
  only_pending boolean:=coalesce(
    nullif(p_filters->>'onlyPending','')::boolean,true
  );
  include_zero boolean:=coalesce(
    nullif(p_filters->>'includeZero','')::boolean,false
  );
  date_from date:=coalesce(
    nullif(p_filters->>'dateFrom','')::date,
    date_trunc('year',current_date)::date
  );
  date_to date:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
  report jsonb;
begin
  perform public.security_assert_role_access(
    'reports:accounting-reports','view'
  );

  select coalesce(array_agg(value::bigint),array[]::bigint[])
    into subsidiary_ids
  from jsonb_array_elements_text(
    coalesce(p_filters->'subsidiaryIds','[]'::jsonb)
  );

  if cardinality(subsidiary_ids)=0 then
    subsidiary_ids:=array[public.active_subsidiary_id()];
  end if;

  if subsidiary_ids[1]is null or exists(
    select 1 from unnest(subsidiary_ids)selected(subsidiary_id)
    where not exists(
      select 1 from public.user_subsidiaries access
      where access.user_id=public.app_user_id()
        and access.subsidiary_id=selected.subsidiary_id
    )
  )then
    raise exception 'No tiene acceso a una o más subsidiarias seleccionadas.';
  end if;

  if date_from>date_to then
    raise exception 'La fecha inicial no puede ser posterior a la fecha final.';
  end if;

  if filter_direction not in('ALL','RECEIVABLE','PAYABLE')then
    raise exception 'Tipo de cuenta comercial intercompany no válido.';
  end if;

  if filter_party_key is not null then
    if filter_party_key!~'^(CUSTOMER|SUPPLIER):[0-9]+$'then
      raise exception 'El tercero seleccionado no es válido.';
    end if;
    filter_party_type:=split_part(filter_party_key,':',1);
    filter_party_id:=split_part(filter_party_key,':',2)::bigint;
  end if;

  select coalesce(array_agg(value::bigint),array[]::bigint[])
    into filter_currency_ids
  from jsonb_array_elements_text(
    coalesce(p_filters->'currencyIds','[]'::jsonb)
  );

  -- journal_line stores the customer/supplier analytical grain. As in the
  -- loan report, a secondary book cannot be mapped safely to a journal line.
  if filter_book_id is not null and(
    cardinality(subsidiary_ids)<>1
    or not exists(
      select 1 from public.accounting_books book
      where book.accounting_book_id=filter_book_id
        and book.subsidiary_id=subsidiary_ids[1]
        and book.is_primary and book.is_active
    )
  )then
    raise exception 'Este reporte solo admite el libro contable principal activo de una subsidiaria.';
  end if;

  with target_accounts as(
    select account.account_id,account.account_number,account.account_name,
      case account.account_number when'113002'then'RECEIVABLE'
        else'PAYABLE'end direction,
      case account.account_number when'113002'then'CUSTOMER'
        else'SUPPLIER'end party_type
    from public.chart_accounts account
    where account.account_number in('113002','211002')
      and not coalesce(account.is_summary,false)
  ),raw_ledger as(
    select line.journal_line_id id,journal.transaction_id,
      journal.journal_date date,
      coalesce(tran.tran_number,journal.journal_number)transaction_number,
      coalesce(transaction_type.name,journal.journal_type)transaction_type,
      journal.journal_id,journal.journal_number,journal.memo,line.note,
      journal.fx_revaluation_run_id,
      journal.fx_revaluation_run_id is not null is_fx_revaluation,
      journal.subsidiary_id,subsidiary.name subsidiary_name,
      account.account_id,account.account_number,account.account_name,
      account.direction,account.party_type,
      case when account.direction='RECEIVABLE'
        then coalesce(line.customer_id,tran.customer_id)
        else coalesce(line.supplier_id,tran.supplier_id)end party_id,
      case when account.direction='RECEIVABLE'
        then customer.customer_number else supplier.supplier_number end
        party_code,
      case when account.direction='RECEIVABLE'
        then customer.company_name else supplier.company_name end party_name,
      case when account.direction='RECEIVABLE'
        then customer.tax_id else supplier.tax_id end identification,
      case when account.direction='RECEIVABLE'
        then coalesce(customer.is_intercompany,false)
        else coalesce(supplier.is_intercompany,false)end master_intercompany,
      coalesce(
        line.original_currency_id,fx_run.currency_id,journal.currency_id,
        tran.currency_id,subsidiary.currency_id
      )currency_id,
      subsidiary.currency_id local_currency_id,
      case when journal.fx_revaluation_run_id is not null then line.debit
        when line.opening_balance_line_id is not null then line.debit
        else line.debit*coalesce(journal.exchange_rate,1)end local_debit,
      case when journal.fx_revaluation_run_id is not null then line.credit
        when line.opening_balance_line_id is not null then line.credit
        else line.credit*coalesce(journal.exchange_rate,1)end local_credit,
      case when journal.fx_revaluation_run_id is not null then 0::numeric
        when line.original_currency_id is not null
          or line.opening_balance_line_id is not null then line.debit_fx
        else line.debit end original_debit,
      case when journal.fx_revaluation_run_id is not null then 0::numeric
        when line.original_currency_id is not null
          or line.opening_balance_line_id is not null then line.credit_fx
        else line.credit end original_credit,
      case when journal.fx_revaluation_run_id is not null
        then coalesce(fx_run.closing_rate,1)
        when line.opening_balance_line_id is not null
        then coalesce(line.historical_exchange_rate,journal.exchange_rate,1)
        else coalesce(journal.exchange_rate,1)end exchange_rate,
      line.opening_balance_line_id
    from public.journal_line line
    join public.journal journal using(journal_id)
    join target_accounts account using(account_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    left join public."transaction" tran using(transaction_id)
    left join public.transaction_types transaction_type using(transaction_type_id)
    left join public.fx_revaluation_runs fx_run
      on fx_run.run_id=journal.fx_revaluation_run_id
    left join public.customers customer
      on customer.customer_id=coalesce(line.customer_id,tran.customer_id)
      and account.direction='RECEIVABLE'
    left join public.suppliers supplier
      on supplier.supplier_id=coalesce(line.supplier_id,tran.supplier_id)
      and account.direction='PAYABLE'
    where journal.subsidiary_id=any(subsidiary_ids)
      and journal.journal_date<=date_to
      and(line.debit>0 or line.credit>0)
      and exists(
        select 1
        from public.gl_impact impact
        join public.accounting_books book using(accounting_book_id)
        where impact.transaction_id=journal.transaction_id
          and impact.account_id=line.account_id
          and impact.subsidiary_id=journal.subsidiary_id
          and impact.posting_date=journal.journal_date
          and(
            filter_book_id is not null
              and impact.accounting_book_id=filter_book_id
            or filter_book_id is null and book.is_primary and book.is_active
          )
      )
  ),ledger as(
    select movement.*,
      movement.party_type||':'||coalesce(movement.party_id::text,'0')
        party_key,
      currency.currency_code,currency.name currency_name,
      currency.symbol currency_symbol,
      local_currency.currency_code local_currency_code,
      local_currency.name local_currency_name,
      local_currency.symbol local_currency_symbol,
      case when movement.direction='RECEIVABLE'
        then movement.original_debit-movement.original_credit
        else movement.original_credit-movement.original_debit
      end original_movement,
      case when movement.direction='RECEIVABLE'
        then movement.local_debit-movement.local_credit
        else movement.local_credit-movement.local_debit
      end local_movement
    from raw_ledger movement
    join public.currencies currency using(currency_id)
    join public.currencies local_currency
      on local_currency.currency_id=movement.local_currency_id
    where(filter_direction='ALL'or movement.direction=filter_direction)
      and(cardinality(filter_currency_ids)=0
        or movement.currency_id=any(filter_currency_ids))
      and(filter_party_key is null or(
        movement.party_type=filter_party_type
        and movement.party_id=filter_party_id
      ))
  ),ledger_summary as(
    select movement.subsidiary_id,movement.subsidiary_name,
      movement.direction,movement.party_type,movement.party_id,
      movement.party_key,
      coalesce(movement.party_code,'SIN-ASIGNAR')party_code,
      coalesce(movement.party_name,
        case movement.direction when'RECEIVABLE'then'Cliente sin asignar'
          else'Proveedor sin asignar'end)party_name,
      movement.identification,movement.master_intercompany,
      movement.account_id,movement.account_number,movement.account_name,
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol,
      sum(case when movement.date<date_from
        then movement.original_movement else 0 end)opening_balance,
      sum(case when movement.date between date_from and date_to
        then movement.original_debit else 0 end)debits,
      sum(case when movement.date between date_from and date_to
        then movement.original_credit else 0 end)credits,
      sum(case when movement.date between date_from and date_to
        then movement.original_movement else 0 end)period_movement,
      sum(movement.original_movement)closing_balance
    from ledger movement
    group by movement.subsidiary_id,movement.subsidiary_name,
      movement.direction,movement.party_type,movement.party_id,
      movement.party_key,movement.party_code,movement.party_name,
      movement.identification,movement.master_intercompany,
      movement.account_id,movement.account_number,movement.account_name,
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol
  ),local_summary as(
    select movement.subsidiary_id,movement.subsidiary_name,
      movement.direction,movement.party_type,movement.party_id,
      movement.party_key,
      coalesce(movement.party_code,'SIN-ASIGNAR')party_code,
      coalesce(movement.party_name,
        case movement.direction when'RECEIVABLE'then'Cliente sin asignar'
          else'Proveedor sin asignar'end)party_name,
      movement.identification,movement.master_intercompany,
      movement.currency_id original_currency_id,
      movement.currency_code original_currency_code,
      movement.currency_name original_currency_name,
      movement.currency_symbol original_currency_symbol,
      movement.local_currency_id,movement.local_currency_code,
      movement.local_currency_name,movement.local_currency_symbol,
      sum(case when movement.date<date_from
        then movement.local_movement else 0 end)opening_balance,
      sum(case when movement.date between date_from and date_to
        then movement.local_debit else 0 end)debits,
      sum(case when movement.date between date_from and date_to
        then movement.local_credit else 0 end)credits,
      sum(case when movement.date between date_from and date_to
        then movement.local_movement else 0 end)period_movement,
      sum(movement.local_movement)closing_balance
    from ledger movement
    group by movement.subsidiary_id,movement.subsidiary_name,
      movement.direction,movement.party_type,movement.party_id,
      movement.party_key,movement.party_code,movement.party_name,
      movement.identification,movement.master_intercompany,
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol,movement.local_currency_id,
      movement.local_currency_code,movement.local_currency_name,
      movement.local_currency_symbol
  ),document_source as(
    select 'RECEIVABLE'::text direction,'CUSTOMER'::text party_type,
      invoice.invoice_id document_id,'AR:'||invoice.invoice_id source_key,
      customer.customer_id party_id,'CUSTOMER:'||customer.customer_id party_key,
      customer.customer_number party_code,customer.company_name party_name,
      customer.tax_id identification,customer.is_intercompany master_intercompany,
      invoice.subsidiary_id,subsidiary.name subsidiary_name,
      account.account_id,account.account_number,account.account_name,
      invoice.invoice_number document_number,
      coalesce(invoice.invoice_date,tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date)issue_date,
      invoice.due_date,
      coalesce(tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date,invoice.invoice_date)posting_date,
      coalesce(invoice.currency_id,tran.currency_id,subsidiary.currency_id)
        currency_id,
      subsidiary.currency_id local_currency_id,
      coalesce(nullif(invoice.exchange_rate,0),
        nullif(tran.exchange_rate,0),1)exchange_rate,
      case when invoice.receivable_amount=0
          and coalesce(invoice.withholding_total,0)=0
          and invoice.total_amount<>0 then invoice.total_amount
        else invoice.receivable_amount end original_amount,
      coalesce(application.applied,0)applied_amount,
      coalesce(credit.amount,0)credit_amount,
      coalesce(debit.amount,0)debit_amount,
      (case when invoice.receivable_amount=0
          and coalesce(invoice.withholding_total,0)=0
          and invoice.total_amount<>0 then invoice.total_amount
        else invoice.receivable_amount end)
        -coalesce(application.applied,0)-coalesce(credit.amount,0)
        +coalesce(debit.amount,0)outstanding,
      coalesce(direct_journal.journal_id,fallback_journal.journal_id)journal_id,
      coalesce(invoice.transaction_id,direct_journal.transaction_id,
        fallback_journal.transaction_id)transaction_id,
      invoice.is_opening_balance
    from public.invoice invoice
    join target_accounts account
      on account.account_id=invoice.receivable_account_id
      and account.account_number='113002'
    join public.customers customer using(customer_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    left join public."transaction" tran
      on tran.transaction_id=invoice.transaction_id
    left join public.status invoice_status
      on invoice_status.status_id=tran.status_id
    left join public.journal direct_journal
      on direct_journal.journal_id=invoice.journal_id
    left join lateral(
      select fallback.journal_id,fallback.journal_date,
        fallback.transaction_id
      from public.journal fallback
      where invoice.journal_id is null
        and fallback.transaction_id=invoice.transaction_id
      order by fallback.journal_id limit 1
    )fallback_journal on true
    left join lateral(
      select sum(case when coalesce(
          payment.currency_id,payment_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then item.amount
        else item.amount*coalesce(
          nullif(payment.exchange_rate,0),
          nullif(payment_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)applied
      from public.customer_payment_application item
      join public.customer_payment payment using(payment_id)
      left join public."transaction" payment_transaction
        on payment_transaction.transaction_id=payment.transaction_id
      left join public.status payment_status
        on payment_status.status_id=payment_transaction.status_id
      where item.invoice_id=invoice.invoice_id
        and item.application_date<=date_to
        and coalesce(payment_transaction.tran_date,payment.payment_date,
          item.application_date)<=date_to
        and upper(coalesce(payment.status,'APROBADO'))
          not in('ANULADO','CANCELADO')
        and upper(coalesce(payment_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )application on true
    left join lateral(
      select sum(case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
      from public.credit_note note
      left join public."transaction" note_transaction
        on note_transaction.transaction_id=note.transaction_id
      left join public.status note_status
        on note_status.status_id=note_transaction.status_id
      where note.invoice_id=invoice.invoice_id
        and coalesce(note_transaction.tran_date,note.note_date)<=date_to
        and upper(coalesce(note_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )credit on true
    left join lateral(
      select sum(case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
      from public.debit_note note
      left join public."transaction" note_transaction
        on note_transaction.transaction_id=note.transaction_id
      left join public.status note_status
        on note_status.status_id=note_transaction.status_id
      where note.invoice_id=invoice.invoice_id
        and coalesce(note_transaction.tran_date,note.note_date)<=date_to
        and upper(coalesce(note_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )debit on true
    where invoice.subsidiary_id=any(subsidiary_ids)
      and coalesce(tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date,invoice.invoice_date)<=date_to
      and upper(coalesce(invoice_status.code,'APROBADO'))
        not in('ANULADO','CANCELADO')

    union all

    select 'PAYABLE','SUPPLIER',invoice.invoice_id,
      'AP:'||invoice.invoice_id,supplier.supplier_id,
      'SUPPLIER:'||supplier.supplier_id,supplier.supplier_number,
      supplier.company_name,supplier.tax_id,supplier.is_intercompany,
      invoice.subsidiary_id,subsidiary.name,account.account_id,
      account.account_number,account.account_name,invoice.invoice_number,
      coalesce(invoice.invoice_date,tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date),invoice.due_date,
      coalesce(tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date,invoice.invoice_date),
      coalesce(invoice.currency_id,tran.currency_id,subsidiary.currency_id),
      subsidiary.currency_id,
      coalesce(nullif(invoice.exchange_rate,0),
        nullif(tran.exchange_rate,0),1),
      case when invoice.payable_amount=0
          and coalesce(invoice.withholding_total,0)=0
          and invoice.total_amount<>0 then invoice.total_amount
        else invoice.payable_amount end,
      coalesce(application.applied,0),coalesce(credit.amount,0),
      coalesce(debit.amount,0),
      (case when invoice.payable_amount=0
          and coalesce(invoice.withholding_total,0)=0
          and invoice.total_amount<>0 then invoice.total_amount
        else invoice.payable_amount end)
        -coalesce(application.applied,0)-coalesce(credit.amount,0)
        +coalesce(debit.amount,0),
      coalesce(direct_journal.journal_id,fallback_journal.journal_id),
      coalesce(invoice.transaction_id,direct_journal.transaction_id,
        fallback_journal.transaction_id),invoice.is_opening_balance
    from public.supplier_invoice invoice
    join target_accounts account
      on account.account_id=invoice.payable_account_id
      and account.account_number='211002'
    join public.suppliers supplier using(supplier_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    left join public."transaction" tran
      on tran.transaction_id=invoice.transaction_id
    left join public.status invoice_status
      on invoice_status.status_id=tran.status_id
    left join public.journal direct_journal
      on direct_journal.journal_id=invoice.journal_id
    left join lateral(
      select fallback.journal_id,fallback.journal_date,
        fallback.transaction_id
      from public.journal fallback
      where invoice.journal_id is null
        and fallback.transaction_id=invoice.transaction_id
      order by fallback.journal_id limit 1
    )fallback_journal on true
    left join lateral(
      select sum(case when coalesce(
          payment.currency_id,payment_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then item.amount
        else item.amount*coalesce(
          nullif(payment.exchange_rate,0),
          nullif(payment_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)applied
      from public.supplier_payment_application item
      join public.supplier_payment payment using(payment_id)
      left join public."transaction" payment_transaction
        on payment_transaction.transaction_id=payment.transaction_id
      left join public.status payment_status
        on payment_status.status_id=payment_transaction.status_id
      where item.invoice_id=invoice.invoice_id
        and item.application_date<=date_to
        and coalesce(payment_transaction.tran_date,payment.payment_date,
          item.application_date)<=date_to
        and upper(coalesce(payment.status,'APROBADO'))
          not in('ANULADO','CANCELADO')
        and upper(coalesce(payment_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )application on true
    left join lateral(
      select sum(case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
      from public.supplier_credit_note note
      left join public."transaction" note_transaction
        on note_transaction.transaction_id=note.transaction_id
      left join public.status note_status
        on note_status.status_id=note_transaction.status_id
      where note.invoice_id=invoice.invoice_id
        and coalesce(note_transaction.tran_date,note.note_date)<=date_to
        and upper(coalesce(note_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )credit on true
    left join lateral(
      select sum(case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
      from public.supplier_debit_note note
      left join public."transaction" note_transaction
        on note_transaction.transaction_id=note.transaction_id
      left join public.status note_status
        on note_status.status_id=note_transaction.status_id
      where note.invoice_id=invoice.invoice_id
        and coalesce(note_transaction.tran_date,note.note_date)<=date_to
        and upper(coalesce(note_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )debit on true
    where invoice.subsidiary_id=any(subsidiary_ids)
      and coalesce(tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date,invoice.invoice_date)<=date_to
      and upper(coalesce(invoice_status.code,'APROBADO'))
        not in('ANULADO','CANCELADO')
  ),documents as(
    select document.*,currency.currency_code,currency.name currency_name,
      currency.symbol currency_symbol,
      local_currency.currency_code local_currency_code,
      local_currency.name local_currency_name,
      local_currency.symbol local_currency_symbol,
      document.outstanding*document.exchange_rate historical_local_outstanding,
      greatest(date_to-document.due_date,0)overdue_days,
      case when date_to<=document.due_date then'CURRENT'
        when date_to-document.due_date<=30 then'1_30'
        when date_to-document.due_date<=60 then'31_60'
        when date_to-document.due_date<=90 then'61_90'
        when date_to-document.due_date<=120 then'91_120'
        else'OVER_120'end aging_bucket
    from document_source document
    join public.currencies currency using(currency_id)
    join public.currencies local_currency
      on local_currency.currency_id=document.local_currency_id
    where(filter_direction='ALL'or document.direction=filter_direction)
      and(cardinality(filter_currency_ids)=0
        or document.currency_id=any(filter_currency_ids))
      and(filter_party_key is null or(
        document.party_type=filter_party_type
        and document.party_id=filter_party_id
      ))
  ),subledger_summary as(
    select document.subsidiary_id,document.subsidiary_name,
      document.direction,document.party_type,document.party_id,
      document.party_key,document.party_code,document.party_name,
      document.identification,document.master_intercompany,
      document.account_id,document.account_number,document.account_name,
      document.currency_id,document.currency_code,document.currency_name,
      document.currency_symbol,
      sum(document.outstanding)document_balance,
      count(*)filter(where abs(document.outstanding)>.005)open_document_count,
      sum(document.original_amount)document_original_total,
      sum(document.applied_amount+document.credit_amount
        -document.debit_amount)settled_total
    from documents document
    group by document.subsidiary_id,document.subsidiary_name,
      document.direction,document.party_type,document.party_id,
      document.party_key,document.party_code,document.party_name,
      document.identification,document.master_intercompany,
      document.account_id,document.account_number,document.account_name,
      document.currency_id,document.currency_code,document.currency_name,
      document.currency_symbol
  ),summary_keys as(
    select subsidiary_id,direction,party_type,party_id,currency_id
    from ledger_summary
    union
    select subsidiary_id,direction,party_type,party_id,currency_id
    from subledger_summary
  ),reconciliation as(
    select key.subsidiary_id,
      coalesce(ledger_item.subsidiary_name,subledger_item.subsidiary_name)
        subsidiary_name,key.direction,key.party_type,key.party_id,
      key.party_type||':'||coalesce(key.party_id::text,'0')party_key,
      coalesce(ledger_item.party_code,subledger_item.party_code,
        'SIN-ASIGNAR')party_code,
      coalesce(ledger_item.party_name,subledger_item.party_name,
        case key.direction when'RECEIVABLE'then'Cliente sin asignar'
          else'Proveedor sin asignar'end)party_name,
      coalesce(ledger_item.identification,subledger_item.identification)
        identification,
      coalesce(ledger_item.master_intercompany,
        subledger_item.master_intercompany,false)master_intercompany,
      coalesce(ledger_item.account_id,subledger_item.account_id)account_id,
      coalesce(ledger_item.account_number,subledger_item.account_number)
        account_number,
      coalesce(ledger_item.account_name,subledger_item.account_name)
        account_name,key.currency_id,
      coalesce(ledger_item.currency_code,subledger_item.currency_code)
        currency_code,
      coalesce(ledger_item.currency_name,subledger_item.currency_name)
        currency_name,
      coalesce(ledger_item.currency_symbol,subledger_item.currency_symbol)
        currency_symbol,
      coalesce(ledger_item.opening_balance,0)opening_balance,
      coalesce(ledger_item.debits,0)debits,
      coalesce(ledger_item.credits,0)credits,
      coalesce(ledger_item.period_movement,0)period_movement,
      coalesce(ledger_item.closing_balance,0)closing_balance,
      coalesce(subledger_item.document_balance,0)document_balance,
      coalesce(subledger_item.open_document_count,0)open_document_count,
      coalesce(subledger_item.document_original_total,0)
        document_original_total,
      coalesce(subledger_item.settled_total,0)settled_total,
      coalesce(subledger_item.document_balance,0)
        -coalesce(ledger_item.closing_balance,0)difference
    from summary_keys key
    left join ledger_summary ledger_item
      on ledger_item.subsidiary_id=key.subsidiary_id
      and ledger_item.direction=key.direction
      and ledger_item.party_type=key.party_type
      and ledger_item.party_id is not distinct from key.party_id
      and ledger_item.currency_id=key.currency_id
    left join subledger_summary subledger_item
      on subledger_item.subsidiary_id=key.subsidiary_id
      and subledger_item.direction=key.direction
      and subledger_item.party_type=key.party_type
      and subledger_item.party_id is not distinct from key.party_id
      and subledger_item.currency_id=key.currency_id
  ),visible_reconciliation as(
    select *from reconciliation item
    where include_zero
      or abs(item.closing_balance)>.0000005
      or abs(item.document_balance)>.0000005
      or abs(item.debits)+abs(item.credits)>.0000005
  ),currency_summaries as(
    select item.currency_id,item.currency_code,item.currency_name,
      item.currency_symbol,
      sum(case when item.direction='RECEIVABLE'
        then item.opening_balance else 0 end)receivable_opening,
      sum(case when item.direction='PAYABLE'
        then item.opening_balance else 0 end)payable_opening,
      sum(case when item.direction='RECEIVABLE'
        then item.debits else 0 end)receivable_debits,
      sum(case when item.direction='RECEIVABLE'
        then item.credits else 0 end)receivable_credits,
      sum(case when item.direction='PAYABLE'
        then item.debits else 0 end)payable_debits,
      sum(case when item.direction='PAYABLE'
        then item.credits else 0 end)payable_credits,
      sum(case when item.direction='RECEIVABLE'
        then item.closing_balance else 0 end)receivable_closing,
      sum(case when item.direction='PAYABLE'
        then item.closing_balance else 0 end)payable_closing,
      sum(case when item.direction='RECEIVABLE'
        then item.closing_balance else-item.closing_balance end)net_position,
      sum(case when item.direction='RECEIVABLE'
        then item.document_balance else 0 end)receivable_documents,
      sum(case when item.direction='PAYABLE'
        then item.document_balance else 0 end)payable_documents
    from visible_reconciliation item
    group by item.currency_id,item.currency_code,item.currency_name,
      item.currency_symbol
  ),local_currency_summaries as(
    select item.subsidiary_id,item.subsidiary_name,
      item.local_currency_id currency_id,
      item.local_currency_code currency_code,
      item.local_currency_name currency_name,
      item.local_currency_symbol currency_symbol,
      sum(case when item.direction='RECEIVABLE'
        then item.opening_balance else 0 end)receivable_opening,
      sum(case when item.direction='PAYABLE'
        then item.opening_balance else 0 end)payable_opening,
      sum(case when item.direction='RECEIVABLE'
        then item.debits else 0 end)receivable_debits,
      sum(case when item.direction='RECEIVABLE'
        then item.credits else 0 end)receivable_credits,
      sum(case when item.direction='PAYABLE'
        then item.debits else 0 end)payable_debits,
      sum(case when item.direction='PAYABLE'
        then item.credits else 0 end)payable_credits,
      sum(case when item.direction='RECEIVABLE'
        then item.closing_balance else 0 end)receivable_closing,
      sum(case when item.direction='PAYABLE'
        then item.closing_balance else 0 end)payable_closing,
      sum(case when item.direction='RECEIVABLE'
        then item.closing_balance else-item.closing_balance end)net_position
    from local_summary item
    group by item.subsidiary_id,item.subsidiary_name,
      item.local_currency_id,item.local_currency_code,
      item.local_currency_name,item.local_currency_symbol
  ),running_ledger as(
    select detail.*,
      sum(detail.original_movement)over(
        partition by detail.subsidiary_id,detail.account_id,
          detail.party_type,coalesce(detail.party_id,0),detail.currency_id
        order by detail.date,detail.id rows unbounded preceding
      )original_running_balance,
      sum(detail.local_movement)over(
        partition by detail.subsidiary_id,detail.account_id,
          detail.party_type,coalesce(detail.party_id,0),detail.currency_id,
          detail.local_currency_id
        order by detail.date,detail.id rows unbounded preceding
      )local_running_balance
    from ledger detail
  ),period_details as(
    select detail.*
    from running_ledger detail
    where detail.date between date_from and date_to
      and(filter_search is null or concat_ws(' ',
        detail.transaction_number,detail.transaction_type,
        detail.journal_number,detail.account_number,detail.account_name,
        detail.party_code,detail.party_name,detail.identification,
        detail.memo,detail.note,detail.subsidiary_name
      )ilike'%'||filter_search||'%')
  ),document_details as(
    select document.*
    from documents document
    where(not only_pending or abs(document.outstanding)>.005)
      and(filter_search is null or concat_ws(' ',
        document.document_number,document.party_code,document.party_name,
        document.identification,document.account_number,
        document.account_name,document.currency_code,
        document.subsidiary_name
      )ilike'%'||filter_search||'%')
  )
  select jsonb_build_object(
    'report','intercompany-commercial',
    'generatedAt',current_timestamp,
    'dateFrom',date_from,'dateTo',date_to,
    'searchScope','DETAIL_ONLY',
    'accounts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',account.account_id,'number',account.account_number,
        'name',account.account_name,'direction',account.direction
      )order by account.account_number)from target_accounts account
    ),'[]'::jsonb),
    'receivables',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'direction',item.direction,'partyType',item.party_type,
        'partyId',item.party_id,'partyKey',item.party_key,
        'partyCode',item.party_code,'partyName',item.party_name,
        'identification',item.identification,
        'masterIntercompany',item.master_intercompany,
        'accountId',item.account_id,'accountNumber',item.account_number,
        'accountName',item.account_name,'currencyId',item.currency_id,
        'currencyCode',item.currency_code,'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'openingBalance',item.opening_balance,'debits',item.debits,
        'credits',item.credits,'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance,
        'documentBalance',item.document_balance,
        'openDocumentCount',item.open_document_count,
        'documentOriginalTotal',item.document_original_total,
        'settledTotal',item.settled_total,'difference',item.difference
      )order by item.currency_code,item.party_name,item.subsidiary_name)
      from visible_reconciliation item
      where item.direction='RECEIVABLE'
    ),'[]'::jsonb),
    'payables',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'direction',item.direction,'partyType',item.party_type,
        'partyId',item.party_id,'partyKey',item.party_key,
        'partyCode',item.party_code,'partyName',item.party_name,
        'identification',item.identification,
        'masterIntercompany',item.master_intercompany,
        'accountId',item.account_id,'accountNumber',item.account_number,
        'accountName',item.account_name,'currencyId',item.currency_id,
        'currencyCode',item.currency_code,'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'openingBalance',item.opening_balance,'debits',item.debits,
        'credits',item.credits,'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance,
        'documentBalance',item.document_balance,
        'openDocumentCount',item.open_document_count,
        'documentOriginalTotal',item.document_original_total,
        'settledTotal',item.settled_total,'difference',item.difference
      )order by item.currency_code,item.party_name,item.subsidiary_name)
      from visible_reconciliation item
      where item.direction='PAYABLE'
    ),'[]'::jsonb),
    'reconciliation',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'direction',item.direction,'partyType',item.party_type,
        'partyId',item.party_id,'partyKey',item.party_key,
        'partyCode',item.party_code,'partyName',item.party_name,
        'identification',item.identification,
        'masterIntercompany',item.master_intercompany,
        'accountId',item.account_id,'accountNumber',item.account_number,
        'accountName',item.account_name,'currencyId',item.currency_id,
        'currencyCode',item.currency_code,'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'openingBalance',item.opening_balance,'debits',item.debits,
        'credits',item.credits,'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance,
        'documentBalance',item.document_balance,
        'openDocumentCount',item.open_document_count,
        'documentOriginalTotal',item.document_original_total,
        'settledTotal',item.settled_total,'difference',item.difference
      )order by item.account_number,item.currency_code,item.party_name,
        item.subsidiary_name)
      from visible_reconciliation item
    ),'[]'::jsonb),
    'currencySummaries',coalesce((
      select jsonb_agg(jsonb_build_object(
        'currencyId',item.currency_id,'currencyCode',item.currency_code,
        'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'receivableOpening',item.receivable_opening,
        'payableOpening',item.payable_opening,
        'receivableDebits',item.receivable_debits,
        'receivableCredits',item.receivable_credits,
        'payableDebits',item.payable_debits,
        'payableCredits',item.payable_credits,
        'receivableClosing',item.receivable_closing,
        'payableClosing',item.payable_closing,
        'netPosition',item.net_position,
        'receivableDocuments',item.receivable_documents,
        'payableDocuments',item.payable_documents
      )order by item.currency_code)from currency_summaries item
    ),'[]'::jsonb),
    'localCurrencySummaries',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'currencyId',item.currency_id,'currencyCode',item.currency_code,
        'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'receivableOpening',item.receivable_opening,
        'payableOpening',item.payable_opening,
        'receivableDebits',item.receivable_debits,
        'receivableCredits',item.receivable_credits,
        'payableDebits',item.payable_debits,
        'payableCredits',item.payable_credits,
        'receivableClosing',item.receivable_closing,
        'payableClosing',item.payable_closing,
        'netPosition',item.net_position
      )order by item.subsidiary_name,item.currency_code)
      from local_currency_summaries item
    ),'[]'::jsonb),
    'localPositions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'direction',item.direction,'partyType',item.party_type,
        'partyId',item.party_id,'partyKey',item.party_key,
        'partyCode',item.party_code,'partyName',item.party_name,
        'identification',item.identification,
        'masterIntercompany',item.master_intercompany,
        'originalCurrencyId',item.original_currency_id,
        'originalCurrencyCode',item.original_currency_code,
        'originalCurrencyName',item.original_currency_name,
        'originalCurrencySymbol',item.original_currency_symbol,
        'localCurrencyId',item.local_currency_id,
        'localCurrencyCode',item.local_currency_code,
        'localCurrencyName',item.local_currency_name,
        'localCurrencySymbol',item.local_currency_symbol,
        'openingBalance',item.opening_balance,
        'debits',item.debits,'credits',item.credits,
        'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance,
        'receivableClosing',case when item.direction='RECEIVABLE'
          then item.closing_balance else 0 end,
        'payableClosing',case when item.direction='PAYABLE'
          then item.closing_balance else 0 end,
        'netPosition',case when item.direction='RECEIVABLE'
          then item.closing_balance else-item.closing_balance end
      )order by item.subsidiary_name,item.original_currency_code,
        item.party_name,item.direction)
      from local_summary item
      where include_zero or abs(item.closing_balance)>.0000005
        or abs(item.debits)+abs(item.credits)>.0000005
    ),'[]'::jsonb),
    'documents',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',document.source_key,'direction',document.direction,
        'partyType',document.party_type,'partyId',document.party_id,
        'partyKey',document.party_key,'partyCode',document.party_code,
        'partyName',document.party_name,
        'identification',document.identification,
        'masterIntercompany',document.master_intercompany,
        'subsidiaryId',document.subsidiary_id,
        'subsidiaryName',document.subsidiary_name,
        'accountId',document.account_id,
        'accountNumber',document.account_number,
        'accountName',document.account_name,
        'documentId',document.document_id,
        'documentNumber',document.document_number,
        'issueDate',document.issue_date,'dueDate',document.due_date,
        'postingDate',document.posting_date,
        'overdueDays',document.overdue_days,
        'agingBucket',document.aging_bucket,
        'currencyId',document.currency_id,
        'currencyCode',document.currency_code,
        'currencyName',document.currency_name,
        'currencySymbol',document.currency_symbol,
        'exchangeRate',document.exchange_rate,
        'originalAmount',document.original_amount,
        'appliedAmount',document.applied_amount,
        'creditAmount',document.credit_amount,
        'debitAmount',document.debit_amount,
        'outstanding',document.outstanding,
        'localCurrencyId',document.local_currency_id,
        'localCurrencyCode',document.local_currency_code,
        'localCurrencyName',document.local_currency_name,
        'localCurrencySymbol',document.local_currency_symbol,
        'historicalLocalOutstanding',
          document.historical_local_outstanding,
        'journalId',document.journal_id,
        'transactionId',document.transaction_id,
        'isOpeningBalance',document.is_opening_balance
      )order by document.direction,document.currency_code,
        document.party_name,document.due_date,document.document_number)
      from document_details document
    ),'[]'::jsonb),
    'details',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',detail.id,'date',detail.date,
        'transactionId',detail.transaction_id,
        'transactionNumber',detail.transaction_number,
        'transactionType',detail.transaction_type,
        'journalId',detail.journal_id,
        'journalNumber',detail.journal_number,
        'memo',detail.memo,'note',detail.note,
        'subsidiaryId',detail.subsidiary_id,
        'subsidiaryName',detail.subsidiary_name,
        'direction',detail.direction,
        'partyType',detail.party_type,'partyId',detail.party_id,
        'partyKey',detail.party_key,'partyCode',coalesce(
          detail.party_code,'SIN-ASIGNAR'),
        'partyName',coalesce(detail.party_name,
          case detail.direction when'RECEIVABLE'then'Cliente sin asignar'
            else'Proveedor sin asignar'end),
        'identification',detail.identification,
        'partyAssigned',detail.party_id is not null,
        'masterIntercompany',detail.master_intercompany,
        'accountId',detail.account_id,
        'accountNumber',detail.account_number,
        'accountName',detail.account_name,
        'currencyId',detail.currency_id,
        'currencyCode',detail.currency_code,
        'currencyName',detail.currency_name,
        'currencySymbol',detail.currency_symbol,
        'exchangeRate',detail.exchange_rate,
        'originalDebit',detail.original_debit,
        'originalCredit',detail.original_credit,
        'originalMovement',detail.original_movement,
        'originalRunningBalance',detail.original_running_balance,
        'localCurrencyId',detail.local_currency_id,
        'localCurrencyCode',detail.local_currency_code,
        'localCurrencyName',detail.local_currency_name,
        'localCurrencySymbol',detail.local_currency_symbol,
        'localDebit',detail.local_debit,
        'localCredit',detail.local_credit,
        'localMovement',detail.local_movement,
        'localRunningBalance',detail.local_running_balance,
        'isFxRevaluation',detail.is_fx_revaluation
      )order by detail.date,detail.id)from period_details detail
    ),'[]'::jsonb),
    'quality',jsonb_build_object(
      'movementCount',(select count(*)from period_details),
      'documentCount',(select count(*)from document_details),
      'openDocumentCount',(select count(*)from documents
        where abs(outstanding)>.005),
      'partyCount',(select count(distinct party_type||':'||party_id)
        from reconciliation where party_id is not null),
      'thirdPartyCount',(select count(distinct party_type||':'||party_id)
        from reconciliation where party_id is not null),
      'currencyCount',(select count(distinct currency_id)from reconciliation),
      'unassignedPartyMovementCount',(select count(*)from ledger
        where party_id is null),
      'missingThirdPartyCount',(select count(*)from ledger
        where party_id is null),
      'unassignedOpeningPartyMovementCount',(select count(*)from ledger
        where party_id is null and date<date_from),
      'missingOpeningThirdPartyCount',(select count(*)from ledger
        where party_id is null and date<date_from),
      'unassignedPeriodPartyMovementCount',(select count(*)from ledger
        where party_id is null and date>=date_from),
      'missingPeriodThirdPartyCount',(select count(*)from ledger
        where party_id is null and date>=date_from),
      'classificationMismatchCount',(select count(*)from documents
        where not master_intercompany),
      'reconciliationDifferenceCount',(select count(*)
        from reconciliation where abs(difference)>.005),
      'fxAdjustmentMovementCount',(select count(*)from ledger
        where is_fx_revaluation and date between date_from and date_to),
      'hasReconciliationDifferences',exists(select 1
        from reconciliation where abs(difference)>.005),
      'valid',not exists(select 1 from ledger where party_id is null)
        and not exists(select 1 from reconciliation
          where abs(difference)>.005)
        and not exists(select 1 from documents
          where not master_intercompany),
      'issues',coalesce((
        select jsonb_agg(issue)from(values
          (case when exists(select 1 from ledger where party_id is null)
            then jsonb_build_object('code','MISSING_PARTY',
              'message','Hay movimientos de 113002/211002 sin cliente o proveedor asignado.')end),
          (case when exists(select 1 from reconciliation
              where abs(difference)>.005)
            then jsonb_build_object('code','RECONCILIATION_DIFFERENCE',
              'message','El auxiliar comercial no coincide con el Mayor para uno o más terceros y monedas.')end),
          (case when exists(select 1 from documents
              where not master_intercompany)
            then jsonb_build_object('code','MASTER_CLASSIFICATION',
              'message','Hay documentos históricos de 113002/211002 cuyo tercero ya no está marcado como intercompany.')end)
        )warning(issue)where issue is not null
      ),'[]'::jsonb)
    )
  )into report;

  return report||jsonb_build_object(
    'rows',report->'details',
    'total',jsonb_array_length(report->'details')
  );
end
$$;

create or replace function public.run_accounting_report(
  p_report text,
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
begin
  if p_report='intercompany-commercial'then
    return public.run_intercompany_commercial_report(p_filters);
  end if;
  return public.run_accounting_report_before_intercompany_commercial(
    p_report,p_filters
  );
end
$$;

revoke all on function public.accounting_report_options(),
  public.run_intercompany_commercial_report(jsonb),
  public.run_accounting_report(text,jsonb)
  from public,anon;

grant execute on function public.accounting_report_options(),
  public.run_intercompany_commercial_report(jsonb),
  public.run_accounting_report(text,jsonb)
  to authenticated;

comment on function public.run_intercompany_commercial_report(jsonb) is
  'Cuentas comerciales intercompany 113002/211002 por cliente/proveedor y moneda, con documentos abiertos y conciliación Mayor versus auxiliar.';

notify pgrst,'reload schema';
