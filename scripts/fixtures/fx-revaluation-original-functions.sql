CREATE OR REPLACE FUNCTION public.fx_assert_access()
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=active_subsidiary_id();
begin
  if sid is null or app_user_id() is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id() and subsidiary_id=sid) then raise exception 'Seleccione una subsidiaria autorizada.';end if;
  return sid;
end$function$;

CREATE OR REPLACE FUNCTION public.fx_calculate(p_date date, p_currency bigint, p_rate numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare rows jsonb;result jsonb;
begin
  if p_rate is null or p_rate<=0 or p_rate>1000000000 then raise exception 'Indique un tipo de cambio de cierre positivo y valido.';end if;
  rows:=fx_exposures(p_date,p_currency);
  select coalesce(jsonb_agg(x||jsonb_build_object('historicalRate',case when (x->>'foreignBalance')::numeric<>0 then (x->>'bookValue')::numeric/(x->>'foreignBalance')::numeric else null end,
    'revaluedBalance',round((x->>'foreignBalance')::numeric*p_rate,2),
    'adjustment',round(round((x->>'foreignBalance')::numeric*p_rate,2)-(x->>'bookValue')::numeric,2),
    'signedAdjustment',round(round((x->>'foreignBalance')::numeric*p_rate,2)-(x->>'bookValue')::numeric,2)*case when x->>'category'='Pasivo' then -1 else 1 end,
    'impact',case when round(round((x->>'foreignBalance')::numeric*p_rate,2)-(x->>'bookValue')::numeric,2)=0 then 'SIN AJUSTE'
      when (round((x->>'foreignBalance')::numeric*p_rate,2)-(x->>'bookValue')::numeric)*case when x->>'category'='Pasivo' then -1 else 1 end>0 then 'GANANCIA NO REALIZADA' else 'PERDIDA NO REALIZADA' end)),'[]') into result
  from jsonb_array_elements(rows)x;
  return result;
end$function$;

CREATE OR REPLACE FUNCTION public.fx_cancel(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=fx_assert_access();r fx_revaluation_runs%rowtype;jid bigint;rev bigint;reason text:=nullif(trim(p_payload->>'reason'),'');
begin
  perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
  if reason is null then raise exception 'Indique el motivo de anulacion.';end if;
  select * into r from fx_revaluation_runs where run_id=(p_payload->>'runId')::bigint and subsidiary_id=sid for update;
  if not found then raise exception 'Proceso no encontrado.';end if;
  perform pg_advisory_xact_lock(hashtextextended('fx:'||sid||':'||r.fiscal_period_id||':'||r.currency_id,0));
  if r.status='REVERSADO' then return to_jsonb(r);end if;
  if r.status<>'CONTABILIZADO' then raise exception 'Solo puede anular un proceso contabilizado.';end if;
  if exists(select 1 from fx_revaluation_runs where subsidiary_id=sid and currency_id=r.currency_id and closing_date>r.closing_date and status='CONTABILIZADO') then raise exception 'Anule primero las revaluaciones posteriores de esta moneda.';end if;
  jid:=fx_post_journal(r.run_id,r.closing_date,-1,'Anulacion de revaluacion: '||reason);
  if r.reversal_journal_id is not null then rev:=fx_post_journal(r.run_id,r.reversal_date,1,'Anulacion de reversion programada: '||reason);end if;
  update fx_revaluation_runs set status='REVERSADO',cancellation_journal_id=jid,cancellation_reversal_id=rev,cancelled_by=app_user_id(),cancelled_at=now(),cancellation_reason=reason where run_id=r.run_id returning * into r;
  return to_jsonb(r);
end$function$;

CREATE OR REPLACE FUNCTION public.fx_execute(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=fx_assert_access();r fx_revaluation_runs%rowtype;data jsonb;jid bigint;rev bigint;official numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
  select * into r from fx_revaluation_runs where run_id=(p_payload->>'runId')::bigint and subsidiary_id=sid for update;
  if not found then raise exception 'Proceso no encontrado.';end if;
  perform pg_advisory_xact_lock(hashtextextended('fx:'||sid||':'||r.fiscal_period_id||':'||r.currency_id,0));
  if r.status='CONTABILIZADO' then return to_jsonb(r);end if;
  if r.status<>'PENDIENTE' then raise exception 'Genere una nueva vista previa.';end if;
  if p_payload->>'fingerprint' is distinct from r.fingerprint then raise exception 'La vista previa cambio. Vuelva a visualizar el asiento.';end if;
  if exists(select 1 from fx_revaluation_runs where subsidiary_id=sid and fiscal_period_id=r.fiscal_period_id and currency_id=r.currency_id and status='CONTABILIZADO') then raise exception 'El periodo y moneda ya estan contabilizados.';end if;
  perform fx_validate_accounts(r.gain_account_id,r.loss_account_id);
  if r.rate_source='CATALOGO' then
    select spot_rate into official from exchange_rates where from_currency_id=r.currency_id and to_currency_id=(select currency_id from subsidiaries where subsidiary_id=sid) and effective_date=r.closing_date order by exchange_rate_id desc limit 1;
    if official is distinct from r.closing_rate then raise exception 'El tipo de cambio fue modificado. Genere una nueva vista previa.';end if;
  end if;
  lock table gl_impact,customer_payment_application,supplier_payment_application in share row exclusive mode;
  data:=fx_calculate(r.closing_date,r.currency_id,r.closing_rate);
  if data is distinct from r.snapshot then raise exception 'Los saldos cambiaron desde la vista previa. Vuelva a visualizar el asiento.';end if;
  jid:=fx_post_journal(r.run_id,r.closing_date,1,'Revaluacion de cierre');
  if r.auto_reverse then rev:=fx_post_journal(r.run_id,r.reversal_date,-1,'Reversion automatica de revaluacion');end if;
  update fx_revaluation_runs set status='CONTABILIZADO',journal_id=jid,reversal_journal_id=rev,posted_at=now() where run_id=r.run_id returning * into r;
  return to_jsonb(r);
end$function$;

CREATE OR REPLACE FUNCTION public.fx_exposures(p_date date, p_currency bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.fx_journal_type()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.fx_revaluation_run_id is not null then
    update "transaction" set transaction_type_id=(select transaction_type_id from transaction_types where abbreviation='DIF_CAM') where transaction_id=new.transaction_id;
  end if;
  return new;
end$function$;

CREATE OR REPLACE FUNCTION public.fx_local_only_gl()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if exists(select 1 from journal j where j.transaction_id=new.transaction_id and j.fx_revaluation_run_id is not null) then
    new.debit_fx:=0;new.credit_fx:=0;
  end if;
  return new;
end$function$;

CREATE OR REPLACE FUNCTION public.fx_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=fx_assert_access();result jsonb;
begin
 select jsonb_build_object(
  'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id,'currency',c.currency_code),
  'settings',(select to_jsonb(x)from fx_revaluation_settings x where subsidiary_id=sid),
  'currencies',coalesce((select jsonb_agg(jsonb_build_object('id',cu.currency_id,'code',cu.currency_code,'name',cu.name)order by cu.currency_code)
   from currencies cu where cu.currency_id<>s.currency_id and(
    exists(select 1 from subsidiary_currencies sc where sc.subsidiary_id=sid and sc.currency_id=cu.currency_id)
    or exists(select 1 from "transaction"t where t.subsidiary_id=sid and t.currency_id=cu.currency_id)
    or exists(select 1 from gl_impact g where g.subsidiary_id=sid and g.original_currency_id=cu.currency_id)
   )),'[]'),
  'periods',coalesce((select jsonb_agg(jsonb_build_object('id',fiscal_period_id,'name',period_name,'start',start_date,'end',end_date,'closed',is_closed or coalesce(gl_closed,false)or coalesce(is_inactive,false))order by start_date desc)from fiscal_periods where subsidiary_id=sid),'[]'),
  'rates',coalesce((select jsonb_agg(jsonb_build_object('currencyId',from_currency_id,'date',effective_date,'rate',spot_rate)order by effective_date desc)from exchange_rates where to_currency_id=s.currency_id),'[]'),
  'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name,'category',a.category,'eligible',a.pending_fx_revaluation)order by a.account_number)from chart_accounts a join account_subsidiaries sc using(account_id)where sc.subsidiary_id=sid and sc.is_active and a.accepts_entries and not a.is_inactive),'[]')
 )into result from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=sid;
 return result;
end$function$;

CREATE OR REPLACE FUNCTION public.fx_post_journal(p_run bigint, p_date date, p_sign integer, p_note text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.fx_prepare(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=fx_assert_access();d date:=(p_payload->>'date')::date;cur bigint:=(p_payload->>'currencyId')::bigint;rate numeric;official numeric;
  per fiscal_periods%rowtype;settings fx_revaluation_settings%rowtype;data jsonb;rid bigint;automatic boolean:=coalesce((p_payload->>'autoReverse')::boolean,true);reason text:=nullif(trim(p_payload->>'rateReason'),'');revdate date;
begin
  perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
  select * into per from fiscal_periods where subsidiary_id=sid and end_date=d and not coalesce(is_inactive,false) order by start_date desc limit 1 for update;
  if per.fiscal_period_id is null or per.is_closed or coalesce(per.gl_closed,false) then raise exception 'Seleccione la fecha final de un periodo contable abierto.';end if;
  if not exists(select 1 from currencies c where c.currency_id=cur and c.currency_id<>(select currency_id from subsidiaries where subsidiary_id=sid)) then raise exception 'Seleccione una moneda extranjera valida.';end if;
  perform pg_advisory_xact_lock(hashtextextended('fx:'||sid||':'||per.fiscal_period_id||':'||cur,0));
  if exists(select 1 from fx_revaluation_runs where subsidiary_id=sid and fiscal_period_id=per.fiscal_period_id and currency_id=cur and status='CONTABILIZADO') then raise exception 'Este periodo y moneda ya fueron revaluados. Anule el proceso anterior para repetirlo.';end if;
  select * into settings from fx_revaluation_settings where subsidiary_id=sid;
  perform fx_validate_accounts(settings.gain_account_id,settings.loss_account_id);
  select spot_rate into official from exchange_rates where from_currency_id=cur and to_currency_id=(select currency_id from subsidiaries where subsidiary_id=sid) and effective_date=d order by exchange_rate_id desc limit 1;
  rate:=coalesce(nullif(p_payload->>'rate','')::numeric,official);
  if rate is distinct from official and reason is null then raise exception 'Indique el motivo y referencia de la tasa manual de cierre.';end if;
  if automatic then
    select start_date into revdate from fiscal_periods where subsidiary_id=sid and start_date=d+1 and not coalesce(is_inactive,false) and not is_closed and not coalesce(gl_closed,false) order by fiscal_period_id limit 1;
    if revdate is null then raise exception 'Abra el periodo siguiente, con inicio al dia siguiente del cierre, para generar la reversion.';end if;
  end if;
  data:=fx_calculate(d,cur,rate);
  select run_id into rid from fx_revaluation_runs where subsidiary_id=sid and fiscal_period_id=per.fiscal_period_id and currency_id=cur and status='PENDIENTE' order by run_id desc limit 1;
  if rid is null then
    insert into fx_revaluation_runs(subsidiary_id,fiscal_period_id,currency_id,closing_date,closing_rate,rate_source,rate_reason,auto_reverse,reversal_date,snapshot,fingerprint,gain_account_id,loss_account_id,gain_taxable,loss_deductible,tax_note,created_by)
    values(sid,per.fiscal_period_id,cur,d,rate,case when rate=official then 'CATALOGO' else 'MANUAL' end,reason,automatic,revdate,data,md5(jsonb_build_array(data,rate,automatic,revdate,settings.gain_account_id,settings.loss_account_id,settings.gain_taxable,settings.loss_deductible,settings.tax_note,reason)::text),settings.gain_account_id,settings.loss_account_id,settings.gain_taxable,settings.loss_deductible,settings.tax_note,app_user_id()) returning run_id into rid;
  else
    update fx_revaluation_runs set closing_rate=rate,rate_source=case when rate=official then 'CATALOGO' else 'MANUAL' end,rate_reason=reason,auto_reverse=automatic,reversal_date=revdate,snapshot=data,fingerprint=md5(jsonb_build_array(data,rate,automatic,revdate,settings.gain_account_id,settings.loss_account_id,settings.gain_taxable,settings.loss_deductible,settings.tax_note,reason)::text),gain_account_id=settings.gain_account_id,loss_account_id=settings.loss_account_id,gain_taxable=settings.gain_taxable,loss_deductible=settings.loss_deductible,tax_note=settings.tax_note,created_by=app_user_id(),created_at=now() where run_id=rid;
  end if;
  return (select to_jsonb(r) from fx_revaluation_runs r where run_id=rid);
end$function$;

CREATE OR REPLACE FUNCTION public.fx_protect_journals()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare managed boolean;
begin
  if tg_table_name='journal' then
    managed:=coalesce((to_jsonb(new)->>'fx_revaluation_run_id')::bigint,(to_jsonb(old)->>'fx_revaluation_run_id')::bigint) is not null;
    if managed and current_user in('authenticated','anon') then raise exception 'Este asiento se administra desde Revaluación de moneda extranjera.';end if;
    if managed and current_setting('nexo.fx_posting',true) is distinct from 'on' then raise exception 'Anule el proceso desde Revaluación de moneda extranjera.';end if;
    if managed and tg_op<>'DELETE' then
      if new.exchange_rate<>1 or new.currency_id<>(select currency_id from subsidiaries where subsidiary_id=new.subsidiary_id) then raise exception 'La revaluación solo puede contabilizarse en moneda local con tasa 1.';end if;
    end if;
  else
    select exists(select 1 from journal where journal_id in(new.journal_id,old.journal_id) and fx_revaluation_run_id is not null) into managed;
    if managed then
      if current_user in('authenticated','anon') or current_setting('nexo.fx_posting',true) is distinct from 'on' then raise exception 'Las líneas de revaluación no pueden editarse manualmente.';end if;
      if tg_op<>'DELETE' then new.debit_fx:=0;new.credit_fx:=0;end if;
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end$function$;

CREATE OR REPLACE FUNCTION public.fx_report(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=fx_assert_access();result jsonb;
begin
  select jsonb_build_object('runs',coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('period',p.period_name,'currency',c.currency_code,
    'effective_status',case when r.status='CONTABILIZADO' and r.reversal_journal_id is not null and r.reversal_date<=(now() at time zone 'America/Costa_Rica')::date then 'REVERSADO' else r.status end,
    'journalNumber',j.journal_number,'reversalNumber',rev.journal_number,
    'accounts',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from(select x->>'accountNumber' number,x->>'accountName' name,sum((x->>'foreignBalance')::numeric) foreign_balance,sum((x->>'bookValue')::numeric) book_value,sum((x->>'revaluedBalance')::numeric) revalued_balance,sum((x->>'adjustment')::numeric) adjustment,sum(greatest((x->>'signedAdjustment')::numeric,0)) gain,sum(greatest(-(x->>'signedAdjustment')::numeric,0)) loss from jsonb_array_elements(r.snapshot)x group by x->>'accountNumber',x->>'accountName' order by x->>'accountNumber')a)) order by r.closing_date desc,r.run_id desc),'[]')) into result
  from fx_revaluation_runs r join fiscal_periods p using(fiscal_period_id) join currencies c using(currency_id) left join journal j on j.journal_id=r.journal_id left join journal rev on rev.journal_id=r.reversal_journal_id
  where r.subsidiary_id=sid and (nullif(p_payload->>'runId','') is null or r.run_id=(p_payload->>'runId')::bigint)
    and (nullif(p_payload->>'currencyId','') is null or r.currency_id=(p_payload->>'currencyId')::bigint)
    and r.closing_date between coalesce(nullif(p_payload->>'from','')::date,'1900-01-01') and coalesce(nullif(p_payload->>'to','')::date,'2999-12-31');
  return result;
end$function$;

CREATE OR REPLACE FUNCTION public.fx_save_settings(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=fx_assert_access();g bigint:=(p_payload->>'gain_account_id')::bigint;l bigint:=(p_payload->>'loss_account_id')::bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
  perform fx_validate_accounts(g,l);
  insert into fx_revaluation_settings(subsidiary_id,gain_account_id,loss_account_id,gain_taxable,loss_deductible,tax_note,updated_by)
  values(sid,g,l,coalesce((p_payload->>'gain_taxable')::boolean,false),coalesce((p_payload->>'loss_deductible')::boolean,false),p_payload->>'tax_note',app_user_id())
  on conflict(subsidiary_id) do update set gain_account_id=g,loss_account_id=l,gain_taxable=excluded.gain_taxable,loss_deductible=excluded.loss_deductible,tax_note=excluded.tax_note,updated_by=app_user_id(),updated_at=now();
  return jsonb_build_object('saved',true);
end$function$;

CREATE OR REPLACE FUNCTION public.fx_validate_accounts(p_gain bigint, p_loss bigint)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=fx_assert_access();
begin
  if p_gain=p_loss or p_gain is null or p_loss is null then raise exception 'Seleccione cuentas distintas de ganancia y pérdida no realizadas.';end if;
  if not exists(select 1 from chart_accounts a join account_subsidiaries s using(account_id) where a.account_id=p_gain and s.subsidiary_id=sid and s.is_active and not a.is_inactive and a.accepts_entries and a.category='Ingreso') then raise exception 'Seleccione una cuenta de ingreso activa de la subsidiaria para la ganancia no realizada.';end if;
  if not exists(select 1 from chart_accounts a join account_subsidiaries s using(account_id) where a.account_id=p_loss and s.subsidiary_id=sid and s.is_active and not a.is_inactive and a.accepts_entries and a.category='Gasto') then raise exception 'Seleccione una cuenta de gasto activa de la subsidiaria para la pérdida no realizada.';end if;
end$function$;
