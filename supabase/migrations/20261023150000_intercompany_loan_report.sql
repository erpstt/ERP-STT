-- Professional intercompany-loan report.
--
-- Scope is defined by the two requested account groups, including future
-- descendants.  113002/211002 are intentionally excluded because they belong
-- to the commercial AR/AP groups rather than groups 119 and 219.

create index if not exists journal_line_related_company_reporting_idx
  on public.journal_line(related_company_id,journal_id,account_id)
  where related_company_id is not null;

create index if not exists journal_line_intercompany_account_idx
  on public.journal_line(account_id,journal_id,journal_line_id);

do $$
begin
  if to_regprocedure(
      'public.accounting_report_options_before_intercompany_loans()'
    )is null
    and to_regprocedure('public.accounting_report_options()')is not null
  then
    execute 'alter function public.accounting_report_options() '
      ||'rename to accounting_report_options_before_intercompany_loans';
  end if;

  if to_regprocedure(
      'public.run_accounting_report_before_intercompany_loans(text,jsonb)'
    )is null
    and to_regprocedure(
      'public.run_accounting_report(text,jsonb)'
    )is not null
  then
    execute 'alter function public.run_accounting_report(text,jsonb) '
      ||'rename to run_accounting_report_before_intercompany_loans';
  end if;
end
$$;

revoke all on function
  public.accounting_report_options_before_intercompany_loans(),
  public.run_accounting_report_before_intercompany_loans(text,jsonb)
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
  ),companies as(
    select company.related_company_id,company.code,company.name,
      company.identification,
      coalesce((
        select jsonb_agg(distinct scope.subsidiary_id order by scope.subsidiary_id)
        from(
          select link.subsidiary_id
          from public.related_company_subsidiaries link
          where link.related_company_id=company.related_company_id
          union
          select company.subsidiary_id where company.subsidiary_id is not null
        )scope
        join allowed on allowed.subsidiary_id=scope.subsidiary_id
      ),'[]'::jsonb)subsidiary_ids
    from public.related_companies company
    where not coalesce(company.is_inactive,false)
      and(
        exists(
          select 1
          from public.related_company_subsidiaries link
          join allowed using(subsidiary_id)
          where link.related_company_id=company.related_company_id
        )
        or company.subsidiary_id in(select subsidiary_id from allowed)
      )
  ),books as(
    select book.accounting_book_id,book.book_name,book.subsidiary_id,
      book.base_currency_id
    from public.accounting_books book
    join allowed on allowed.subsidiary_id=book.subsidiary_id
    where book.is_primary and book.is_active
  )
  select public.accounting_report_options_before_intercompany_loans()
    ||jsonb_build_object(
      'relatedCompanies',coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',company.related_company_id,
          'code',company.code,
          'name',company.name,
          'identification',company.identification,
          'subsidiaryIds',company.subsidiary_ids
        )order by company.name,company.code)
        from companies company
      ),'[]'::jsonb),
      'intercompanyBooks',coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',book.accounting_book_id,
          'name',book.book_name,
          'subsidiaryId',book.subsidiary_id,
          'currencyId',book.base_currency_id
        )order by book.book_name,book.accounting_book_id)
        from books book
      ),'[]'::jsonb)
    )
$$;

-- FX revaluation used to collapse every non-document exposure into GL:<account>.
-- That loses the related-company dimension for accounts 119/219. Keep the
-- established AR/AP document logic, while splitting only these GL exposures by
-- original currency and related company. Accounts with legacy account-level FX
-- adjustments retain the legacy grain because those historical adjustments
-- cannot be allocated safely after the fact.
create or replace function public.fx_exposures(
  p_date date,
  p_currency bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=public.fx_assert_access();
  book bigint;
  result jsonb;
begin
  select accounting_book_id into book
  from public.accounting_books
  where subsidiary_id=sid and is_primary and is_active
  order by accounting_book_id limit 1;
  if book is null then
    raise exception 'Configure un libro contable principal activo.';
  end if;
  if(select count(*)from public.accounting_books
      where subsidiary_id=sid and is_primary and is_active)<>1 then
    raise exception 'Debe existir un único libro principal activo.';
  end if;
  if p_currency=(select currency_id from public.subsidiaries
      where subsidiary_id=sid)then
    raise exception 'Seleccione una moneda extranjera.';
  end if;

  with recursive intercompany_groups as(
    select account_group.group_id
    from public.account_group
    where not coalesce(account_group.is_inactive,false)
      and(
        account_group.group_code in('119','219')
        or lower(account_group.group_name)in(
          lower('Cuentas por Cobrar Compañías Relacionadas'),
          lower('Cuentas por Pagar Compañías Relacionadas')
        )
      )
    union all
    select child.group_id
    from public.account_group child
    join intercompany_groups parent on parent.group_id=child.parent_id
    where not coalesce(child.is_inactive,false)
  ),eligible as(
    select account.*,
      account.account_group_id in(select group_id from intercompany_groups)
        is_intercompany_group
    from public.chart_accounts account
    join public.account_subsidiaries scope using(account_id)
    where scope.subsidiary_id=sid and scope.is_active
      and account.pending_fx_revaluation
      and account.category in('Activo','Pasivo')
      and not account.is_inactive and account.accepts_entries
  ),ledger as(
    select impact.*,
      coalesce(impact.original_currency_id,tran.currency_id)
        effective_currency_id
    from public.gl_impact impact
    join public."transaction" tran using(transaction_id)
    join eligible account using(account_id)
    where impact.subsidiary_id=sid and tran.subsidiary_id=sid
      and impact.accounting_book_id=book and impact.posting_date<=p_date
      and coalesce(impact.original_currency_id,tran.currency_id)=p_currency
      and not exists(
        select 1 from public.journal journal
        where journal.transaction_id=tran.transaction_id
          and journal.fx_revaluation_run_id is not null
      )
      and not exists(
        select 1
        from public.opening_balance_runs run
        join public.journal source on source.journal_id=run.journal_id
        left join public.journal reversal
          on reversal.reversed_from_journal_id=source.journal_id
        where run.status='REVERSED'and reversal.journal_date<=p_date
          and(source.transaction_id=tran.transaction_id
            or reversal.transaction_id=tran.transaction_id)
      )
  ),documents as(
    select 'AR:'||invoice.invoice_id source_key,'CxC'::text source_type,
      invoice.invoice_id,invoice.invoice_number document,
      invoice.customer_id entity_id,customer.company_name party,
      coalesce(invoice.transaction_id,journal.transaction_id)transaction_id,
      invoice.currency_id,'Activo'::text category,
      invoice.opening_balance_line_id
    from public.invoice invoice
    join public.customers customer using(customer_id)
    left join public.opening_balance_runs run on run.id=invoice.opening_run_id
    left join public.journal journal on journal.journal_id=run.journal_id
    where invoice.subsidiary_id=sid and invoice.currency_id=p_currency
      and invoice.invoice_date<=p_date
    union all
    select 'AP:'||invoice.invoice_id,'CxP',invoice.invoice_id,
      invoice.invoice_number,invoice.supplier_id,supplier.company_name,
      coalesce(invoice.transaction_id,journal.transaction_id),
      invoice.currency_id,'Pasivo',invoice.opening_balance_line_id
    from public.supplier_invoice invoice
    join public.suppliers supplier using(supplier_id)
    left join public.opening_balance_runs run on run.id=invoice.opening_run_id
    left join public.journal journal on journal.journal_id=run.journal_id
    where invoice.subsidiary_id=sid and invoice.currency_id=p_currency
      and invoice.invoice_date<=p_date
  ),mapping as(
    select document.source_key,document.transaction_id,
      document.opening_balance_line_id,1::numeric weight
    from documents document
    union all
    select document.source_key,note.transaction_id,null::bigint,1
    from documents document join public.credit_note note
      on note.invoice_id=document.invoice_id and document.source_type='CxC'
    where note.note_date<=p_date
    union all
    select document.source_key,note.transaction_id,null::bigint,1
    from documents document join public.debit_note note
      on note.invoice_id=document.invoice_id and document.source_type='CxC'
    where note.note_date<=p_date
    union all
    select document.source_key,note.transaction_id,null::bigint,1
    from documents document join public.supplier_credit_note note
      on note.invoice_id=document.invoice_id and document.source_type='CxP'
    where note.note_date<=p_date
    union all
    select document.source_key,note.transaction_id,null::bigint,1
    from documents document join public.supplier_debit_note note
      on note.invoice_id=document.invoice_id and document.source_type='CxP'
    where note.note_date<=p_date
    union all
    select document.source_key,payment.transaction_id,null::bigint,
      application.amount/nullif((select sum(item.amount)
        from public.customer_payment_application item
        where item.payment_id=payment.payment_id),0)
    from documents document
    join public.customer_payment_application application
      on application.invoice_id=document.invoice_id
      and document.source_type='CxC'
    join public.customer_payment payment using(payment_id)
    where application.application_date<=p_date and payment.payment_date<=p_date
    union all
    select document.source_key,payment.transaction_id,null::bigint,
      application.amount/nullif((select sum(item.amount)
        from public.supplier_payment_application item
        where item.payment_id=payment.payment_id),0)
    from documents document
    join public.supplier_payment_application application
      on application.invoice_id=document.invoice_id
      and document.source_type='CxP'
    join public.supplier_payment payment using(payment_id)
    where application.application_date<=p_date and payment.payment_date<=p_date
  ),doc_balances as(
    select document.source_key,document.source_type,document.document,
      document.party,document.entity_id,impact.account_id,
      null::bigint related_company_id,p_currency currency_id,
      sum((impact.debit_fx-impact.credit_fx)*mapping.weight)fc,
      sum((impact.debit_amount-impact.credit_amount)*mapping.weight)local
    from documents document
    join mapping using(source_key)
    join ledger impact on impact.transaction_id=mapping.transaction_id
      and(mapping.opening_balance_line_id is null
        and impact.opening_balance_line_id is null
        or impact.opening_balance_line_id=mapping.opening_balance_line_id)
    join eligible account on account.account_id=impact.account_id
      and account.category=document.category
    where exists(
      select 1 from ledger original
      where original.transaction_id=document.transaction_id
        and original.account_id=impact.account_id
        and(document.opening_balance_line_id is null
          and original.opening_balance_line_id is null
          or original.opening_balance_line_id=document.opening_balance_line_id)
    )
    group by document.source_key,document.source_type,document.document,
      document.party,document.entity_id,impact.account_id
  ),prior_adjustments as(
    select line.fx_source_key source_key,line.account_id,
      sum(line.debit-line.credit)local
    from public.journal_line line
    join public.journal journal using(journal_id)
    join public.fx_revaluation_runs run
      on run.run_id=journal.fx_revaluation_run_id
    where run.subsidiary_id=sid and run.currency_id=p_currency
      and journal.journal_date<=p_date and line.fx_source_key is not null
    group by line.fx_source_key,line.account_id
  ),legacy_intercompany_accounts as(
    select distinct adjustment.account_id
    from prior_adjustments adjustment
    join eligible account using(account_id)
    where account.is_intercompany_group
      and adjustment.source_key='GL:'||adjustment.account_id
    union
    -- If a 119/219 account was also configured as an AR/AP document control,
    -- retain the established document allocation plus one account-level GL
    -- residual. Without a journal-line/document key, splitting that residual
    -- by company would duplicate the document exposure.
    select distinct document.account_id
    from doc_balances document
    join eligible account using(account_id)
    where account.is_intercompany_group
  ),other_balances as(
    select 'GL:'||impact.account_id source_key,'Mayor'::text source_type,
      ''::text document,''::text party,null::bigint entity_id,
      impact.account_id,null::bigint related_company_id,p_currency currency_id,
      sum(impact.debit_fx-impact.credit_fx)
        -coalesce((select sum(document.fc)from doc_balances document
          where document.account_id=impact.account_id),0)fc,
      sum(impact.debit_amount-impact.credit_amount)
        -coalesce((select sum(document.local)from doc_balances document
          where document.account_id=impact.account_id),0)local
    from ledger impact
    join eligible account using(account_id)
    where not account.is_intercompany_group
      or impact.account_id in(select account_id from legacy_intercompany_accounts)
    group by impact.account_id
  ),intercompany_ledger as(
    select line.account_id,line.related_company_id,
      case when line.original_currency_id is not null
          or line.opening_balance_line_id is not null
        then line.debit_fx-line.credit_fx
        else line.debit-line.credit end foreign_amount,
      case when line.opening_balance_line_id is not null
        then line.debit-line.credit
        else(line.debit-line.credit)*journal.exchange_rate end local_amount
    from public.journal_line line
    join public.journal journal using(journal_id)
    join public."transaction" tran using(transaction_id)
    join eligible account using(account_id)
    where account.is_intercompany_group
      and line.account_id not in(select account_id from legacy_intercompany_accounts)
      and journal.subsidiary_id=sid and journal.journal_date<=p_date
      and coalesce(line.original_currency_id,journal.currency_id,
        tran.currency_id)=p_currency
      and journal.fx_revaluation_run_id is null
      and exists(
        select 1 from public.gl_impact impact
        where impact.transaction_id=journal.transaction_id
          and impact.account_id=line.account_id
          and impact.subsidiary_id=journal.subsidiary_id
          and impact.accounting_book_id=book
          and impact.posting_date=journal.journal_date
      )
      and not exists(
        select 1
        from public.opening_balance_runs run
        join public.journal source on source.journal_id=run.journal_id
        left join public.journal reversal
          on reversal.reversed_from_journal_id=source.journal_id
        where run.status='REVERSED'and reversal.journal_date<=p_date
          and(source.transaction_id=journal.transaction_id
            or reversal.transaction_id=journal.transaction_id)
      )
  ),intercompany_balances as(
    select concat_ws(':','ICGL',ledger.account_id,
        coalesce(ledger.related_company_id,0),p_currency)source_key,
      'Mayor'::text source_type,''::text document,''::text party,
      null::bigint entity_id,ledger.account_id,ledger.related_company_id,
      p_currency currency_id,sum(ledger.foreign_amount)fc,
      sum(ledger.local_amount)local
    from intercompany_ledger ledger
    group by ledger.account_id,ledger.related_company_id
  ),balances as(
    select * from doc_balances
    union all select * from other_balances
    union all select * from intercompany_balances
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceKey',balance.source_key,'sourceType',balance.source_type,
    'document',balance.document,'party',balance.party,
    'entityId',balance.entity_id,'relatedCompanyId',balance.related_company_id,
    'currencyId',balance.currency_id,'accountId',account.account_id,
    'accountNumber',account.account_number,'accountName',account.account_name,
    'category',account.category,
    'foreignBalance',round(balance.fc*case when account.category='Pasivo'
      then-1 else 1 end,6),
    'bookValue',round((balance.local+coalesce(adjustment.local,0))
      *case when account.category='Pasivo'then-1 else 1 end,6)
  )order by account.account_number,balance.source_key),'[]')into result
  from balances balance
  join eligible account using(account_id)
  left join prior_adjustments adjustment
    on adjustment.source_key=balance.source_key
    and adjustment.account_id=balance.account_id
  where abs(balance.fc)>.000001;

  if exists(
    select 1 from public.customer_payment_application application
    join public.customer_payment payment using(payment_id)
    join public.invoice invoice using(invoice_id)
    where invoice.subsidiary_id=sid and invoice.currency_id=p_currency
      and payment.currency_id<>invoice.currency_id
      and application.application_date<=p_date and payment.payment_date<=p_date
  )or exists(
    select 1 from public.supplier_payment_application application
    join public.supplier_payment payment using(payment_id)
    join public.supplier_invoice invoice using(invoice_id)
    where invoice.subsidiary_id=sid and invoice.currency_id=p_currency
      and payment.currency_id<>invoice.currency_id
      and application.application_date<=p_date and payment.payment_date<=p_date
  )then
    raise exception 'Existen aplicaciones de pago en otra moneda. Concilie su importe en la moneda de la factura antes de revaluar.';
  end if;
  return result;
end
$$;

create or replace function public.fx_post_journal(
  p_run bigint,
  p_date date,
  p_sign integer,
  p_note text
)
returns bigint
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  run_row public.fx_revaluation_runs%rowtype;
  period_key bigint;
  local_currency bigint;
  transaction_type_key bigint;
  journal_key bigint;
  number_value text;
  item jsonb;
  amount_value numeric;
  total_value numeric;
  counterpart_account bigint;
begin
  if p_sign not in(-1,1)then
    raise exception 'Sentido de asiento inválido.';
  end if;
  select * into run_row from public.fx_revaluation_runs
  where run_id=p_run and subsidiary_id=public.fx_assert_access();
  if not found then raise exception 'Proceso no encontrado.';end if;
  select fiscal_period_id into period_key from public.fiscal_periods
  where subsidiary_id=run_row.subsidiary_id
    and p_date between start_date and end_date and not is_closed
    and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)
  order by start_date desc limit 1 for update;
  if period_key is null then
    raise exception 'El período de % debe estar abierto.',p_date;
  end if;
  select currency_id into local_currency from public.subsidiaries
  where subsidiary_id=run_row.subsidiary_id;
  select transaction_type_id into transaction_type_key
  from public.transaction_types where abbreviation='DIF_CAM';
  if transaction_type_key is null then
    raise exception 'Configure el tipo de transacción DIF_CAM.';
  end if;
  -- DIF_CAM was introduced after the original cross-subsidiary sequence seed.
  -- Create the missing sequence at first use, including for subsidiaries
  -- created after this migration, without resetting an existing counter.
  insert into public.number_sequences(
    scope_type,transaction_type_id,subsidiary_id,prefix,current_number,
    padding_length
  )values(
    'Transacción',transaction_type_key,run_row.subsidiary_id,'DIF_CAM-',0,8
  )on conflict(transaction_type_id,subsidiary_id)
    where scope_type='Transacción'
  do nothing;
  number_value:=public.next_transaction_number(
    transaction_type_key,run_row.subsidiary_id
  );
  select sum(abs((entry->>'signedAdjustment')::numeric))into total_value
  from jsonb_array_elements(run_row.snapshot)entry;
  if coalesce(total_value,0)<=0 then
    raise exception 'No hay ajustes por contabilizar.';
  end if;
  perform set_config('nexo.fx_posting','on',true);
  insert into public.journal(
    journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,
    exchange_rate,memo,journal_type,total_debit,total_credit,status,
    created_by,fx_revaluation_run_id
  )values(
    number_value,p_date,run_row.subsidiary_id,local_currency,period_key,1,
    p_note||' / Proceso '||run_row.run_id,'Asiento Diferencial Cambiario',
    total_value,total_value,'CONTABILIZADO',public.app_user_id(),run_row.run_id
  )returning journal_id into journal_key;
  for item in select value from jsonb_array_elements(run_row.snapshot)loop
    amount_value:=(item->>'signedAdjustment')::numeric;
    if amount_value=0 then continue;end if;
    counterpart_account:=case when amount_value>0
      then run_row.gain_account_id else run_row.loss_account_id end;
    amount_value:=amount_value*p_sign;
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,note,
      entity_type,customer_id,supplier_id,fx_source_key,
      related_company_id,original_currency_id
    )values(
      journal_key,(item->>'accountId')::bigint,greatest(amount_value,0),
      greatest(-amount_value,0),0,0,
      p_note||' '||coalesce(item->>'document',''),
      case item->>'sourceType' when'CxC'then'Cliente'
        when'CxP'then'Proveedor'end,
      case when item->>'sourceType'='CxC'
        then(item->>'entityId')::bigint end,
      case when item->>'sourceType'='CxP'
        then(item->>'entityId')::bigint end,
      item->>'sourceKey',nullif(item->>'relatedCompanyId','')::bigint,
      coalesce(nullif(item->>'currencyId','')::bigint,run_row.currency_id)
    );
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,note
    )values(
      journal_key,counterpart_account,greatest(-amount_value,0),
      greatest(amount_value,0),0,0,p_note||' - diferencial no realizado'
    );
  end loop;
  perform set_config('nexo.fx_posting','off',true);
  return journal_key;
end
$$;

revoke all on function public.fx_exposures(date,bigint),
  public.fx_post_journal(bigint,date,integer,text)
  from public,anon,authenticated;

create or replace function public.run_intercompany_loan_report(
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
  filter_related_company_id bigint:=nullif(
    p_filters->>'relatedCompanyId',''
  )::bigint;
  filter_account_id bigint:=nullif(p_filters->>'accountId','')::bigint;
  filter_currency_ids bigint[];
  filter_related_company_state text:=upper(coalesce(
    nullif(p_filters->>'relatedCompanyState',''),'ALL'
  ));
  filter_direction text:=upper(coalesce(
    nullif(p_filters->>'direction',''),'ALL'
  ));
  include_zero boolean:=coalesce(
    nullif(p_filters->>'includeZero','')::boolean,false
  );
  filter_search text:=nullif(btrim(p_filters->>'search'),'');
  date_from date:=coalesce(
    nullif(p_filters->>'dateFrom','')::date,
    date_trunc('year',current_date)::date
  );
  date_to date:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
  report jsonb;
begin
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

  -- journal_line/gl_impact do not expose a reliable line-level analytical
  -- mapping for secondary books.  Accepting one here would make a primary
  -- journal line appear as if it belonged to that book.  Until the posting
  -- model stores book-specific journal lines, this report is intentionally
  -- limited to the single active primary book of one subsidiary.
  if filter_book_id is not null and(
    cardinality(subsidiary_ids)<>1
    or not exists(
      select 1
      from public.accounting_books book
      where book.accounting_book_id=filter_book_id
        and book.subsidiary_id=subsidiary_ids[1]
        and book.is_primary and book.is_active
    )
  )then
    raise exception 'Este reporte solo admite el libro contable principal activo de una subsidiaria.';
  end if;

  if filter_related_company_state not in('ALL','ASSIGNED','UNASSIGNED')then
    raise exception 'Estado de compañía relacionada no válido.';
  end if;

  if filter_direction not in('ALL','RECEIVABLE','PAYABLE')then
    raise exception 'Tipo de saldo intercompany no válido.';
  end if;

  select coalesce(array_agg(value::bigint),array[]::bigint[])
    into filter_currency_ids
  from jsonb_array_elements_text(
    coalesce(p_filters->'currencyIds','[]'::jsonb)
  );

  with recursive requested_groups as(
    select account_group.group_id,account_group.group_code,
      account_group.group_name,account_group.parent_id,
      case when account_group.group_code='119'
        or lower(account_group.group_name)=lower(
          'Cuentas por Cobrar Compañías Relacionadas'
        )then'RECEIVABLE'else'PAYABLE'end direction,
      account_group.group_id root_group_id,
      account_group.group_code root_group_code,
      account_group.group_name root_group_name
    from public.account_group
    where not coalesce(account_group.is_inactive,false)
      and(
        account_group.group_code in('119','219')
        or lower(account_group.group_name)in(
          lower('Cuentas por Cobrar Compañías Relacionadas'),
          lower('Cuentas por Pagar Compañías Relacionadas')
        )
      )
    union all
    select child.group_id,child.group_code,child.group_name,child.parent_id,
      parent.direction,parent.root_group_id,parent.root_group_code,
      parent.root_group_name
    from public.account_group child
    join requested_groups parent on parent.group_id=child.parent_id
    where not coalesce(child.is_inactive,false)
  ),target_accounts as(
    select account.account_id,account.account_number,account.account_name,
      groups.root_group_id account_group_id,
      groups.root_group_code account_group_code,
      groups.root_group_name account_group_name,groups.direction
    from public.chart_accounts account
    join requested_groups groups
      on groups.group_id=account.account_group_id
    where not coalesce(account.is_inactive,false)
      and not coalesce(account.is_summary,false)
  ),raw_movements as(
    -- journal_line is the authoritative analytical grain.  Matching GL and
    -- journal rows by ordinal can attribute a movement to the wrong related
    -- company when the same account is repeated in one journal.  EXISTS only
    -- proves that the line's transaction/account reached the selected book;
    -- it never supplies or changes the analytical dimension.
    select line.journal_line_id id,journal.transaction_id,
      journal.journal_date date,
      coalesce(tran.tran_number,journal.journal_number)transaction_number,
      coalesce(transaction_type.name,journal.journal_type)transaction_type,
      journal.journal_id,journal.journal_number,journal.memo,line.note,
      journal.fx_revaluation_run_id,
      journal.fx_revaluation_run_id is not null is_fx_revaluation,
      journal.subsidiary_id,subsidiary.name subsidiary_name,
      account.direction,account.account_group_id,
      account.account_group_code,account.account_group_name,
      account.account_id,account.account_number,account.account_name,
      line.related_company_id,company.code related_company_code,
      company.name related_company_name,
      company.identification related_company_identification,
      coalesce(
        line.original_currency_id,fx_run.currency_id,journal.currency_id,
        subsidiary.currency_id
      )currency_id,
      subsidiary.currency_id local_currency_id,
      case when journal.fx_revaluation_run_id is not null then line.debit
        when line.opening_balance_line_id is not null then line.debit
        else line.debit*journal.exchange_rate end local_debit,
      case when journal.fx_revaluation_run_id is not null then line.credit
        when line.opening_balance_line_id is not null then line.credit
        else line.credit*journal.exchange_rate end local_credit,
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
        else coalesce(journal.exchange_rate,1)end exchange_rate
    from public.journal_line line
    join public.journal journal using(journal_id)
    join target_accounts account using(account_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    join public."transaction" tran using(transaction_id)
    join public.transaction_types transaction_type using(transaction_type_id)
    left join public.fx_revaluation_runs fx_run
      on fx_run.run_id=journal.fx_revaluation_run_id
    left join public.related_companies company
      on company.related_company_id=line.related_company_id
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
  ),movements as(
    select movement.*,
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
    from raw_movements movement
    join public.currencies currency using(currency_id)
    join public.currencies local_currency
      on local_currency.currency_id=movement.local_currency_id
    where(filter_related_company_id is null
        or movement.related_company_id=filter_related_company_id)
      and(filter_account_id is null or movement.account_id=filter_account_id)
      and(cardinality(filter_currency_ids)=0
        or movement.currency_id=any(filter_currency_ids))
      and(filter_direction='ALL'or movement.direction=filter_direction)
      and(filter_related_company_state='ALL'
        or filter_related_company_state='ASSIGNED'
          and movement.related_company_id is not null
        or filter_related_company_state='UNASSIGNED'
          and movement.related_company_id is null)
  ),running as(
    select movement.*,
      sum(movement.original_movement)over(
        partition by movement.subsidiary_id,movement.account_id,
          coalesce(movement.related_company_id,0),movement.currency_id
        order by movement.date,movement.id rows unbounded preceding
      )original_running_balance,
      sum(movement.local_movement)over(
        partition by movement.subsidiary_id,movement.account_id,
          coalesce(movement.related_company_id,0),movement.currency_id,
          movement.local_currency_id
        order by movement.date,movement.id rows unbounded preceding
      )local_running_balance
    from movements movement
  ),period_details as(
    select detail.* from running detail
    where detail.date between date_from and date_to
      and(filter_search is null or concat_ws(' ',
        detail.transaction_number,detail.transaction_type,
        detail.journal_number,detail.account_number,detail.account_name,
        detail.related_company_code,detail.related_company_name,
        detail.related_company_identification,detail.memo,detail.note,
        detail.subsidiary_name
      )ilike'%'||filter_search||'%')
  ),company_currency as(
    select movement.related_company_id,
      coalesce(movement.related_company_code,'SIN-ASIGNAR')related_company_code,
      coalesce(
        movement.related_company_name,'Sin compañía relacionada'
      )related_company_name,
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol,movement.direction,
      sum(case when movement.date<date_from
        then movement.original_movement else 0 end)opening_balance,
      sum(case when movement.date between date_from and date_to
        then movement.original_debit else 0 end)debits,
      sum(case when movement.date between date_from and date_to
        then movement.original_credit else 0 end)credits,
      sum(case when movement.date between date_from and date_to
        then movement.original_movement else 0 end)period_movement,
      sum(movement.original_movement)closing_balance
    from movements movement
    group by movement.related_company_id,
      coalesce(movement.related_company_code,'SIN-ASIGNAR'),
      coalesce(movement.related_company_name,'Sin compañía relacionada'),
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol,movement.direction
    having include_zero
      or abs(sum(movement.original_movement))>.0000005
      or abs(sum(case when movement.date between date_from and date_to
        then movement.original_debit+movement.original_credit else 0 end)
      )>.0000005
  ),position_keys as(
    select distinct related_company_id,related_company_code,
      related_company_name,currency_id,currency_code,currency_name,
      currency_symbol
    from company_currency
  ),net_positions as(
    select key.*,
      coalesce(receivable.opening_balance,0)receivable_opening,
      coalesce(payable.opening_balance,0)payable_opening,
      coalesce(receivable.debits,0)receivable_debits,
      coalesce(receivable.credits,0)receivable_credits,
      coalesce(payable.debits,0)payable_debits,
      coalesce(payable.credits,0)payable_credits,
      coalesce(receivable.closing_balance,0)receivable_closing,
      coalesce(payable.closing_balance,0)payable_closing,
      coalesce(receivable.closing_balance,0)
        -coalesce(payable.closing_balance,0)net_position
    from position_keys key
    left join company_currency receivable
      on receivable.related_company_id is not distinct from key.related_company_id
      and receivable.currency_id=key.currency_id
      and receivable.direction='RECEIVABLE'
    left join company_currency payable
      on payable.related_company_id is not distinct from key.related_company_id
      and payable.currency_id=key.currency_id
      and payable.direction='PAYABLE'
  ),local_positions as(
    -- Auditable local equivalent at the same analytical grain as netPositions.
    -- Keeping original_currency_id in the key prevents unlike currencies from
    -- being blended merely because they share a functional currency.
    select movement.subsidiary_id,movement.subsidiary_name,
      movement.related_company_id,
      coalesce(movement.related_company_code,'SIN-ASIGNAR')
        related_company_code,
      coalesce(movement.related_company_name,'Sin compañía relacionada')
        related_company_name,
      movement.currency_id original_currency_id,
      movement.currency_code original_currency_code,
      movement.currency_name original_currency_name,
      movement.currency_symbol original_currency_symbol,
      movement.local_currency_id,movement.local_currency_code,
      movement.local_currency_name,movement.local_currency_symbol,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date<date_from then movement.local_movement else 0 end)
        receivable_opening,
      sum(case when movement.direction='PAYABLE'
        and movement.date<date_from then movement.local_movement else 0 end)
        payable_opening,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date between date_from and date_to
        then movement.local_debit else 0 end)receivable_debits,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date between date_from and date_to
        then movement.local_credit else 0 end)receivable_credits,
      sum(case when movement.direction='PAYABLE'
        and movement.date between date_from and date_to
        then movement.local_debit else 0 end)payable_debits,
      sum(case when movement.direction='PAYABLE'
        and movement.date between date_from and date_to
        then movement.local_credit else 0 end)payable_credits,
      sum(case when movement.direction='RECEIVABLE'
        then movement.local_movement else 0 end)receivable_closing,
      sum(case when movement.direction='PAYABLE'
        then movement.local_movement else 0 end)payable_closing,
      sum(case when movement.direction='RECEIVABLE'
        then movement.local_movement else-movement.local_movement end)
        net_position
    from movements movement
    group by movement.subsidiary_id,movement.subsidiary_name,
      movement.related_company_id,
      coalesce(movement.related_company_code,'SIN-ASIGNAR'),
      coalesce(movement.related_company_name,'Sin compañía relacionada'),
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol,movement.local_currency_id,
      movement.local_currency_code,movement.local_currency_name,
      movement.local_currency_symbol
    having include_zero
      or abs(sum(case when movement.direction='RECEIVABLE'
        then movement.local_movement else 0 end))>.0000005
      or abs(sum(case when movement.direction='PAYABLE'
        then movement.local_movement else 0 end))>.0000005
      or abs(sum(case when movement.date between date_from and date_to
        then movement.local_debit+movement.local_credit else 0 end))>.0000005
  ),currency_summaries as(
    select currency_id,currency_code,currency_name,currency_symbol,
      sum(receivable_opening)receivable_opening,
      sum(payable_opening)payable_opening,
      sum(receivable_debits)receivable_debits,
      sum(receivable_credits)receivable_credits,
      sum(payable_debits)payable_debits,
      sum(payable_credits)payable_credits,
      sum(receivable_closing)receivable_closing,
      sum(payable_closing)payable_closing,
      sum(net_position)net_position
    from net_positions
    group by currency_id,currency_code,currency_name,currency_symbol
  ),local_summaries as(
    select movement.subsidiary_id,movement.subsidiary_name,
      movement.local_currency_id currency_id,
      movement.local_currency_code currency_code,
      movement.local_currency_name currency_name,
      movement.local_currency_symbol currency_symbol,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date<date_from then movement.local_movement else 0 end)
        receivable_opening,
      sum(case when movement.direction='PAYABLE'
        and movement.date<date_from then movement.local_movement else 0 end)
        payable_opening,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date between date_from and date_to
        then movement.local_debit else 0 end)receivable_debits,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date between date_from and date_to
        then movement.local_credit else 0 end)receivable_credits,
      sum(case when movement.direction='PAYABLE'
        and movement.date between date_from and date_to
        then movement.local_debit else 0 end)payable_debits,
      sum(case when movement.direction='PAYABLE'
        and movement.date between date_from and date_to
        then movement.local_credit else 0 end)payable_credits,
      sum(case when movement.direction='RECEIVABLE'
        then movement.local_movement else 0 end)receivable_closing,
      sum(case when movement.direction='PAYABLE'
        then movement.local_movement else 0 end)payable_closing,
      sum(case when movement.direction='RECEIVABLE'
        then movement.local_movement else-movement.local_movement end)
        net_position
    from movements movement
    group by movement.subsidiary_id,movement.subsidiary_name,
      movement.local_currency_id,movement.local_currency_code,
      movement.local_currency_name,movement.local_currency_symbol
  ),group_headers as(
    select distinct root_group_id id,root_group_code code,
      root_group_name name,direction
    from requested_groups
    where group_id=root_group_id
  )
  select jsonb_build_object(
    'report','intercompany-loans',
    'generatedAt',current_timestamp,
    'dateFrom',date_from,
    'dateTo',date_to,
    'searchScope','DETAIL_ONLY',
    'accountGroups',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',header.id,'code',header.code,'name',header.name,
        'direction',header.direction
      )order by header.code)from group_headers header
    ),'[]'::jsonb),
    'receivables',coalesce((
      select jsonb_agg(jsonb_build_object(
        'relatedCompanyId',item.related_company_id,
        'relatedCompanyCode',item.related_company_code,
        'relatedCompanyName',item.related_company_name,
        'currencyId',item.currency_id,'currencyCode',item.currency_code,
        'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'openingBalance',item.opening_balance,'debits',item.debits,
        'credits',item.credits,'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance
      )order by item.currency_code,item.related_company_name)
      from company_currency item where item.direction='RECEIVABLE'
    ),'[]'::jsonb),
    'payables',coalesce((
      select jsonb_agg(jsonb_build_object(
        'relatedCompanyId',item.related_company_id,
        'relatedCompanyCode',item.related_company_code,
        'relatedCompanyName',item.related_company_name,
        'currencyId',item.currency_id,'currencyCode',item.currency_code,
        'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'openingBalance',item.opening_balance,'debits',item.debits,
        'credits',item.credits,'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance
      )order by item.currency_code,item.related_company_name)
      from company_currency item where item.direction='PAYABLE'
    ),'[]'::jsonb),
    'netPositions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'relatedCompanyId',item.related_company_id,
        'relatedCompanyCode',item.related_company_code,
        'relatedCompanyName',item.related_company_name,
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
      )order by item.currency_code,item.related_company_name)
      from net_positions item
    ),'[]'::jsonb),
    'localPositions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'relatedCompanyId',item.related_company_id,
        'relatedCompanyCode',item.related_company_code,
        'relatedCompanyName',item.related_company_name,
        'originalCurrencyId',item.original_currency_id,
        'originalCurrencyCode',item.original_currency_code,
        'originalCurrencyName',item.original_currency_name,
        'originalCurrencySymbol',item.original_currency_symbol,
        'localCurrencyId',item.local_currency_id,
        'localCurrencyCode',item.local_currency_code,
        'localCurrencyName',item.local_currency_name,
        'localCurrencySymbol',item.local_currency_symbol,
        'receivableOpening',item.receivable_opening,
        'payableOpening',item.payable_opening,
        'receivableDebits',item.receivable_debits,
        'receivableCredits',item.receivable_credits,
        'payableDebits',item.payable_debits,
        'payableCredits',item.payable_credits,
        'receivableClosing',item.receivable_closing,
        'payableClosing',item.payable_closing,
        'netPosition',item.net_position
      )order by item.subsidiary_name,item.original_currency_code,
        item.related_company_name)from local_positions item
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
        'netPosition',item.net_position
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
      from local_summaries item
    ),'[]'::jsonb),
    'quality',jsonb_build_object(
      'movementCount',(select count(*)from period_details),
      'accountCount',(select count(distinct account_id)from movements),
      'relatedCompanyCount',(select count(distinct related_company_id)
        from movements where related_company_id is not null),
      'currencyCount',(select count(distinct currency_id)from movements),
      'fxAdjustmentMovementCount',(select count(*)from movements
        where is_fx_revaluation and date between date_from and date_to),
      'unassignedMovementCount',(select count(*)from movements
        where related_company_id is null),
      'unassignedOpeningMovementCount',(select count(*)from movements
        where related_company_id is null and date<date_from),
      'unassignedPeriodMovementCount',(select count(*)from movements
        where related_company_id is null and date>=date_from),
      'hasUnassignedDimensions',exists(select 1 from movements
        where related_company_id is null)
    ),
    'details',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',detail.id,'date',detail.date,
        'transactionId',detail.transaction_id,
        'transactionNumber',detail.transaction_number,
        'transactionType',detail.transaction_type,
        'journalId',detail.journal_id,'journalNumber',detail.journal_number,
        'fxRevaluationRunId',detail.fx_revaluation_run_id,
        'isFxRevaluation',detail.is_fx_revaluation,
        'memo',detail.memo,'note',detail.note,
        'subsidiaryId',detail.subsidiary_id,
        'subsidiaryName',detail.subsidiary_name,
        'direction',detail.direction,
        'accountGroupId',detail.account_group_id,
        'accountGroupCode',detail.account_group_code,
        'accountGroupName',detail.account_group_name,
        'accountId',detail.account_id,
        'accountNumber',detail.account_number,
        'accountName',detail.account_name,
        'relatedCompanyId',detail.related_company_id,
        'relatedCompanyCode',coalesce(
          detail.related_company_code,'SIN-ASIGNAR'
        ),
        'relatedCompanyName',coalesce(
          detail.related_company_name,'Sin compañía relacionada'
        ),
        'relatedCompanyIdentification',
          detail.related_company_identification,
        'dimensionAssigned',detail.related_company_id is not null,
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
        'localRunningBalance',detail.local_running_balance
      )order by detail.date,detail.id)from period_details detail
    ),'[]'::jsonb)
  )into report;

  return report
    ||jsonb_build_object(
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
  if p_report='intercompany-loans'then
    return public.run_intercompany_loan_report(p_filters);
  end if;
  return public.run_accounting_report_before_intercompany_loans(
    p_report,p_filters
  );
end
$$;

revoke all on function public.accounting_report_options(),
  public.run_intercompany_loan_report(jsonb),
  public.run_accounting_report(text,jsonb)
  from public,anon;

grant execute on function public.accounting_report_options(),
  public.run_intercompany_loan_report(jsonb),
  public.run_accounting_report(text,jsonb)
  to authenticated;

comment on function public.run_intercompany_loan_report(jsonb) is
  'Préstamos intercompany de los grupos 119/219, separados por moneda y dimensión Compañía relacionada, con saldos de apertura, movimientos, cierre y detalle auditable.';

notify pgrst,'reload schema';
