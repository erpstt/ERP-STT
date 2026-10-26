-- Enforce the historical exchange rate of a sales invoice at the database
-- boundary and repair the five USD invoices issued by S.T.T. Holdings Limited
-- on 19 October 2026. The repair is deliberately narrow and auditable.

create or replace function public.sales_invoice_official_exchange_rate(
  p_currency_id bigint,
  p_invoice_date date,
  p_subsidiary_id bigint
)returns numeric
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  functional_currency_id bigint;
  source_code text;
  functional_code text;
  official_rate numeric;
begin
  if p_subsidiary_id is null then
    raise exception 'No se pudo determinar la subsidiaria de la factura.';
  end if;
  if p_currency_id is null then
    raise exception 'Seleccione la moneda de la factura.';
  end if;
  if p_invoice_date is null then
    raise exception 'Seleccione la fecha de la factura.';
  end if;

  select subsidiary.currency_id,source.currency_code,functional.currency_code
    into functional_currency_id,source_code,functional_code
  from public.subsidiaries subsidiary
  join public.currencies functional
    on functional.currency_id=subsidiary.currency_id
  join public.currencies source
    on source.currency_id=p_currency_id
  where subsidiary.subsidiary_id=p_subsidiary_id;

  if functional_currency_id is null then
    raise exception 'La subsidiaria o la moneda seleccionada no existe.';
  end if;
  if p_currency_id=functional_currency_id then
    return 1;
  end if;

  select rate.spot_rate
    into official_rate
  from public.exchange_rates rate
  where rate.from_currency_id=p_currency_id
    and rate.to_currency_id=functional_currency_id
    and rate.effective_date<=p_invoice_date
    and rate.spot_rate>0
  order by rate.effective_date desc,rate.exchange_rate_id desc
  limit 1;

  if official_rate is null then
    select 1/nullif(rate.spot_rate,0)
      into official_rate
    from public.exchange_rates rate
    where rate.from_currency_id=functional_currency_id
      and rate.to_currency_id=p_currency_id
      and rate.effective_date<=p_invoice_date
      and rate.spot_rate>0
    order by rate.effective_date desc,rate.exchange_rate_id desc
    limit 1;
  end if;

  if official_rate is null or official_rate<=0 then
    raise exception 'No existe tipo de cambio % -> % vigente al % ni en una fecha anterior.',
      source_code,functional_code,to_char(p_invoice_date,'DD/MM/YYYY');
  end if;
  return official_rate;
end
$$;

-- Realized FX accounts are intentionally distinct from unrealized
-- revaluation accounts (422002 / 632002 in this chart of accounts).
create or replace function public.customer_payment_realized_fx_account(
  p_subsidiary_id bigint,
  p_gain boolean
)returns bigint
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  account_key bigint;
  required_number text:=case when p_gain then '422001' else '632001' end;
begin
  select account.account_id
    into account_key
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account.account_number=required_number
    and assignment.subsidiary_id=p_subsidiary_id
    and assignment.is_active
    and account.accepts_entries
    and not account.is_inactive
  order by account.account_id
  limit 1;

  if account_key is null then
    raise exception 'Configure la cuenta % de diferencia cambiaria realizada para la subsidiaria.',
      required_number;
  end if;
  return account_key;
end
$$;

-- Rebuild the settlement side of one customer receipt. Applications remain in
-- their original currency, while the A/R credit is measured at each invoice's
-- historical rate and the difference is posted as a realized gain or loss.
create or replace function public.rebuild_customer_payment_receivable_fx(
  p_payment_id bigint,
  p_expected_total numeric,
  p_subsidiary_id bigint
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  payment_row public.customer_payment%rowtype;
  applied_total numeric;
  settlement_total numeric:=0;
  settlement_credit numeric;
  original_amount numeric;
  local_amount numeric;
  weighted_rate numeric;
  fx_amount numeric;
  fx_account bigint;
  debit_total numeric;
  credit_total numeric;
  replaced integer;
  inserted integer:=0;
  gl_updated integer;
  account_keys jsonb;
  allocation record;
begin
  select payment.*
    into payment_row
  from public.customer_payment payment
  join public."transaction" transaction_row using(transaction_id)
  where payment.payment_id=p_payment_id
    and transaction_row.subsidiary_id=p_subsidiary_id
  for update of payment;

  if payment_row.payment_id is null then
    raise exception 'El cobro indicado no pertenece a la subsidiaria.';
  end if;
  if payment_row.exchange_rate is null or payment_row.exchange_rate<=0 then
    raise exception 'El cobro no tiene un tipo de cambio válido.';
  end if;

  update public.invoice invoice
  set receivable_account_id=public.resolve_customer_receivable_account(
    invoice.subsidiary_id,invoice.customer_id
  )
  where invoice.receivable_account_id is null
    and exists(
      select 1
      from public.customer_payment_application application
      where application.payment_id=p_payment_id
        and application.invoice_id=invoice.invoice_id
    );

  if exists(
    select 1
    from public.customer_payment_application application
    join public.invoice invoice using(invoice_id)
    where application.payment_id=p_payment_id
      and(
        invoice.currency_id<>payment_row.currency_id
        or invoice.exchange_rate is null
        or invoice.exchange_rate<=0
      )
  )then
    raise exception 'Las facturas del cobro deben compartir su moneda y tener tasa histórica válida.';
  end if;

  select coalesce(sum(application.amount),0)
    into applied_total
  from public.customer_payment_application application
  where application.payment_id=p_payment_id;

  if abs(applied_total-coalesce(p_expected_total,0))>.000001 then
    raise exception 'Las aplicaciones del cobro no coinciden con el total contabilizado.';
  end if;

  delete from public.journal_line line
  using public.chart_accounts account
  where line.journal_id=payment_row.journal_id
    and line.account_id=account.account_id
    and line.customer_id=payment_row.customer_id
    and line.entity_type='Cliente'
    and coalesce(line.debit,0)=0
    and coalesce(line.credit,0)>0
    and(
      account.account_number in('113001','113002')
      or line.account_id in(
        select invoice.receivable_account_id
        from public.customer_payment_application application
        join public.invoice invoice using(invoice_id)
        where application.payment_id=p_payment_id
      )
    );
  get diagnostics replaced=row_count;

  if replaced<1 then
    raise exception 'No fue posible identificar las líneas de cuenta por cobrar en el cobro.';
  end if;

  delete from public.journal_line
  where journal_id=payment_row.journal_id
    and note like 'Diferencial cambiario realizado · Cobro %';

  for allocation in
    select invoice.receivable_account_id account_id,
      sum(application.amount) original_amount,
      sum(application.amount*invoice.exchange_rate) local_amount
    from public.customer_payment_application application
    join public.invoice invoice using(invoice_id)
    where application.payment_id=p_payment_id
    group by invoice.receivable_account_id
    order by invoice.receivable_account_id
  loop
    original_amount:=round(allocation.original_amount,6);
    local_amount:=round(allocation.local_amount,6);
    settlement_credit:=round(local_amount/payment_row.exchange_rate,6);
    weighted_rate:=case when original_amount=0 then payment_row.exchange_rate
      else local_amount/original_amount end;
    settlement_total:=settlement_total+settlement_credit;

    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,
      note,entity_type,customer_id,historical_exchange_rate,
      original_currency_id
    )values(
      payment_row.journal_id,allocation.account_id,0,settlement_credit,0,
      local_amount,payment_row.location_id,
      'Liquidación CxC a tasa histórica · '||payment_row.payment_number,
      'Cliente',payment_row.customer_id,weighted_rate,payment_row.currency_id
    );
    inserted:=inserted+1;
  end loop;

  if inserted<1 then
    raise exception 'El cobro no contiene aplicaciones con una cuenta por cobrar válida.';
  end if;

  settlement_total:=round(settlement_total,6);
  fx_amount:=round(applied_total-settlement_total,6);
  if abs(fx_amount)>.000001 then
    fx_account:=public.customer_payment_realized_fx_account(
      p_subsidiary_id,fx_amount>0
    );
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,
      note,entity_type,customer_id,historical_exchange_rate,
      original_currency_id
    )values(
      payment_row.journal_id,fx_account,
      case when fx_amount<0 then abs(fx_amount) else 0 end,
      case when fx_amount>0 then fx_amount else 0 end,
      case when fx_amount<0 then round(abs(fx_amount)*payment_row.exchange_rate,6) else 0 end,
      case when fx_amount>0 then round(fx_amount*payment_row.exchange_rate,6) else 0 end,
      payment_row.location_id,
      'Diferencial cambiario realizado · Cobro '||payment_row.payment_number,
      'Cliente',payment_row.customer_id,payment_row.exchange_rate,
      payment_row.currency_id
    );
  end if;

  select coalesce(sum(line.debit),0),coalesce(sum(line.credit),0)
    into debit_total,credit_total
  from public.journal_line line
  where line.journal_id=payment_row.journal_id;

  if abs(debit_total-credit_total)>.00001 then
    raise exception 'El asiento del cobro no cuadra después de reconocer la diferencia cambiaria (%).',
      round(debit_total-credit_total,6);
  end if;

  update public.journal
  set total_debit=debit_total,total_credit=credit_total
  where journal_id=payment_row.journal_id;

  perform public.sync_journal_gl_impacts(payment_row.journal_id);

  -- sync_journal_gl_impacts derives original amounts from debit/credit. For
  -- A/R these are payment-rate equivalents, so restore the amount actually
  -- applied in the invoice currency for auxiliary and revaluation reports.
  for allocation in
    select invoice.receivable_account_id account_id,
      round(sum(application.amount),6) original_amount,
      round(sum(application.amount*invoice.exchange_rate),6) local_amount
    from public.customer_payment_application application
    join public.invoice invoice using(invoice_id)
    where application.payment_id=p_payment_id
    group by invoice.receivable_account_id
  loop
    update public.gl_impact impact
    set credit_fx=allocation.original_amount,
        original_currency_id=payment_row.currency_id
    where impact.transaction_id=payment_row.transaction_id
      and impact.account_id=allocation.account_id
      and abs(coalesce(impact.credit_amount,0)-allocation.local_amount)<.01
      and coalesce(impact.debit_amount,0)=0;
    get diagnostics gl_updated=row_count;
    if gl_updated<>1 then
      raise exception 'No fue posible identificar un único impacto de CxC para el cobro y la cuenta %.',
        allocation.account_id;
    end if;
  end loop;

  select coalesce(jsonb_agg(accounts.account_id order by accounts.account_id),'[]'::jsonb)
    into account_keys
  from(
    select distinct invoice.receivable_account_id account_id
    from public.customer_payment_application application
    join public.invoice invoice using(invoice_id)
    where application.payment_id=p_payment_id
  )accounts;

  return account_keys;
end
$$;

create or replace function public.apply_customer_payment_receivable_accounts(
  p_payment_id bigint,
  p_expected_total numeric
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=public.active_subsidiary_id();
begin
  if sid is null then
    raise exception 'Debe seleccionar una subsidiaria antes de registrar el cobro.';
  end if;
  return public.rebuild_customer_payment_receivable_fx(
    p_payment_id,p_expected_total,sid
  );
end
$$;

-- Preserve the complete numbering and intercompany-account wrapper chain and
-- add the FX validation as its outer transaction boundary.
do $$
begin
  if to_regprocedure(
      'public.save_sales_invoice_before_fx_guard(jsonb,bigint)'
    ) is null then
    if to_regprocedure('public.save_sales_invoice(jsonb,bigint)') is null then
      raise exception 'No existe la función save_sales_invoice que se debe proteger.';
    end if;
    alter function public.save_sales_invoice(jsonb,bigint)
      rename to save_sales_invoice_before_fx_guard;
  end if;
end
$$;

revoke all on function public.save_sales_invoice_before_fx_guard(jsonb,bigint)
from public,anon,authenticated;

create or replace function public.save_sales_invoice(
  payload jsonb,
  target_invoice_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=public.active_subsidiary_id();
  normalized_payload jsonb:=coalesce(payload,'{}'::jsonb);
  currency_key bigint;
  invoice_day date;
  period_key bigint;
  official_rate numeric;
  result jsonb;
  invoice_key bigint;
  transaction_key bigint;
  journal_key bigint;
begin
  if sid is null then
    raise exception 'Debe seleccionar una subsidiaria antes de guardar la factura.';
  end if;

  currency_key:=nullif(trim(normalized_payload->>'currency_id'),'')::bigint;
  invoice_day:=nullif(trim(normalized_payload->>'invoice_date'),'')::date;
  period_key:=nullif(trim(normalized_payload->>'fiscal_period_id'),'')::bigint;
  official_rate:=public.sales_invoice_official_exchange_rate(
    currency_key,invoice_day,sid
  );
  normalized_payload:=jsonb_set(
    normalized_payload,'{exchange_rate}',to_jsonb(official_rate),true
  );

  result:=public.save_sales_invoice_before_fx_guard(
    normalized_payload,target_invoice_id
  );
  invoice_key:=nullif(result->>'invoiceId','')::bigint;

  select invoice.transaction_id,invoice.journal_id
    into transaction_key,journal_key
  from public.invoice invoice
  where invoice.invoice_id=invoice_key
    and invoice.subsidiary_id=sid
  for update;

  if not found or transaction_key is null or journal_key is null then
    raise exception 'La factura guardada no conserva sus vínculos contables.';
  end if;

  -- The historical editor only changed the invoice header. Keep all three
  -- accounting headers aligned when date, period, currency or rate changes.
  update public.invoice
  set currency_id=currency_key,exchange_rate=official_rate,
      invoice_date=invoice_day,fiscal_period_id=period_key
  where invoice_id=invoice_key;

  update public."transaction"
  set currency_id=currency_key,exchange_rate=official_rate,
      tran_date=invoice_day,fiscal_period_id=period_key
  where transaction_id=transaction_key;

  update public.journal
  set currency_id=currency_key,exchange_rate=official_rate,
      journal_date=invoice_day,fiscal_period_id=period_key
  where journal_id=journal_key;

  update public.journal_line
  set debit_fx=round(coalesce(debit,0)*official_rate,6),
      credit_fx=round(coalesce(credit,0)*official_rate,6),
      historical_exchange_rate=official_rate,
      original_currency_id=currency_key
  where journal_id=journal_key;

  perform public.sync_journal_gl_impacts(journal_key);

  return result||jsonb_build_object(
    'exchangeRate',official_rate,'exchangeRateSource','CATALOGO_HISTORICO'
  );
end
$$;

create table if not exists public.sales_invoice_fx_correction_audit(
  invoice_id bigint primary key references public.invoice(invoice_id),
  invoice_number text not null,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id),
  currency_id bigint not null references public.currencies(currency_id),
  invoice_date date not null,
  old_invoice_rate numeric(24,10) not null,
  old_transaction_rate numeric(24,10) not null,
  old_journal_rate numeric(24,10) not null,
  corrected_rate numeric(24,10) not null,
  rate_effective_date date not null,
  linked_payment_ids jsonb not null default '[]'::jsonb,
  reason text not null,
  corrected_at timestamptz not null default now()
);

alter table public.sales_invoice_fx_correction_audit enable row level security;
revoke all on public.sales_invoice_fx_correction_audit
from public,anon,authenticated;

do $$
declare
  target_sid constant bigint:=24;
  target_date constant date:='2026-10-19';
  target_rate constant numeric:=158.9838;
  candidate_count integer;
  audit_count integer;
  invoice_row record;
  payment_key bigint;
  expected_payment_total numeric;
  actual_gain_local numeric;
begin
  if not exists(
    select 1 from public.subsidiaries subsidiary
    join public.currencies currency on currency.currency_id=subsidiary.currency_id
    where subsidiary.subsidiary_id=target_sid
      and upper(subsidiary.name)='S.T.T. HOLDINGS LIMITED'
      and currency.currency_code='JMD'
  )then
    raise exception 'La subsidiaria objetivo 24 no coincide con S.T.T. HOLDINGS LIMITED / JMD.';
  end if;

  if abs(public.sales_invoice_official_exchange_rate(
      (select currency_id from public.currencies where currency_code='USD'),
      target_date,target_sid
    )-target_rate)>.0000000001 then
    raise exception 'La tasa oficial USD/JMD del 19/10/2026 no coincide con 158.9838.';
  end if;

  select count(*) into audit_count
  from public.sales_invoice_fx_correction_audit
  where invoice_number in(
    'FAC-00000669','FAC-00000670','FAC-00000671','FAC-00000672','FAC-00000673'
  );

  select count(*) into candidate_count
  from public.invoice invoice
  join public.currencies currency using(currency_id)
  where invoice.subsidiary_id=target_sid
    and invoice.invoice_date=target_date
    and currency.currency_code='USD'
    and invoice.invoice_number in(
      'FAC-00000669','FAC-00000670','FAC-00000671','FAC-00000672','FAC-00000673'
    )
    and abs(invoice.exchange_rate-1)<.0000000001;

  if audit_count=0 and candidate_count<>5 then
    raise exception 'La reparación esperaba exactamente 5 facturas USD con tasa 1 y encontró %.',
      candidate_count;
  end if;

  for invoice_row in
    select invoice.invoice_id,invoice.invoice_number,invoice.currency_id,
      invoice.invoice_date,invoice.transaction_id,invoice.journal_id,
      invoice.exchange_rate old_invoice_rate,
      transaction_row.exchange_rate old_transaction_rate,
      journal_row.exchange_rate old_journal_rate
    from public.invoice invoice
    join public."transaction" transaction_row using(transaction_id)
    join public.journal journal_row using(journal_id)
    join public.currencies currency on currency.currency_id=invoice.currency_id
    where invoice.subsidiary_id=target_sid
      and invoice.invoice_date=target_date
      and currency.currency_code='USD'
      and invoice.invoice_number in(
        'FAC-00000669','FAC-00000670','FAC-00000671','FAC-00000672','FAC-00000673'
      )
      and abs(invoice.exchange_rate-1)<.0000000001
    order by invoice.invoice_id
    for update of invoice,transaction_row,journal_row
  loop
    insert into public.sales_invoice_fx_correction_audit(
      invoice_id,invoice_number,subsidiary_id,currency_id,invoice_date,
      old_invoice_rate,old_transaction_rate,old_journal_rate,corrected_rate,
      rate_effective_date,linked_payment_ids,reason
    )values(
      invoice_row.invoice_id,invoice_row.invoice_number,target_sid,
      invoice_row.currency_id,invoice_row.invoice_date,
      invoice_row.old_invoice_rate,invoice_row.old_transaction_rate,
      invoice_row.old_journal_rate,target_rate,target_date,
      coalesce((
        select jsonb_agg(payment_id order by payment_id)
        from(
          select distinct application.payment_id
          from public.customer_payment_application application
          where application.invoice_id=invoice_row.invoice_id
        )payments
      ),'[]'::jsonb),
      'Corrección de tasa USD/JMD omitida por el formulario de factura de venta.'
    )on conflict(invoice_id)do nothing;

    update public.invoice set exchange_rate=target_rate
    where invoice_id=invoice_row.invoice_id;
    update public."transaction" set exchange_rate=target_rate
    where transaction_id=invoice_row.transaction_id;
    update public.journal set exchange_rate=target_rate
    where journal_id=invoice_row.journal_id;
    update public.journal_line
    set debit_fx=round(coalesce(debit,0)*target_rate,6),
        credit_fx=round(coalesce(credit,0)*target_rate,6),
        historical_exchange_rate=target_rate,
        original_currency_id=invoice_row.currency_id
    where journal_id=invoice_row.journal_id;
    perform public.sync_journal_gl_impacts(invoice_row.journal_id);
  end loop;

  -- Rebuild only receipts linked to the five audited invoices. Bank, fee and
  -- application records are intentionally left untouched.
  for payment_key in
    select distinct application.payment_id
    from public.customer_payment_application application
    join public.sales_invoice_fx_correction_audit audit using(invoice_id)
    where audit.invoice_number in(
      'FAC-00000669','FAC-00000670','FAC-00000671','FAC-00000672','FAC-00000673'
    )
    order by application.payment_id
  loop
    select coalesce(sum(amount),0) into expected_payment_total
    from public.customer_payment_application
    where payment_id=payment_key;
    perform public.rebuild_customer_payment_receivable_fx(
      payment_key,expected_payment_total,target_sid
    );
  end loop;

  if exists(
    select 1
    from public.sales_invoice_fx_correction_audit audit
    join public.invoice invoice using(invoice_id)
    join public."transaction" transaction_row using(transaction_id)
    join public.journal journal_row using(journal_id)
    where abs(invoice.exchange_rate-target_rate)>.0000000001
      or abs(transaction_row.exchange_rate-target_rate)>.0000000001
      or abs(journal_row.exchange_rate-target_rate)>.0000000001
  )then
    raise exception 'Una factura reparada no conserva la tasa en sus tres encabezados.';
  end if;

  select coalesce(sum(line.credit*journal.exchange_rate-line.debit*journal.exchange_rate),0)
    into actual_gain_local
  from public.journal_line line
  join public.journal journal using(journal_id)
  join public.chart_accounts account using(account_id)
  where account.account_number='422001'
    and line.note like 'Diferencial cambiario realizado · Cobro %'
    and journal.journal_id in(
      select distinct payment.journal_id
      from public.customer_payment payment
      join public.customer_payment_application application using(payment_id)
      join public.sales_invoice_fx_correction_audit audit using(invoice_id)
    );

  if abs(actual_gain_local-42180.035163)>.02 then
    raise exception 'La ganancia cambiaria realizada esperada es JMD 42180.035163 y se obtuvo %.',
      round(actual_gain_local,6);
  end if;
end
$$;

revoke all on function public.sales_invoice_official_exchange_rate(bigint,date,bigint),
  public.customer_payment_realized_fx_account(bigint,boolean),
  public.rebuild_customer_payment_receivable_fx(bigint,numeric,bigint),
  public.apply_customer_payment_receivable_accounts(bigint,numeric),
  public.save_sales_invoice(jsonb,bigint)
from public,anon,authenticated;

grant execute on function public.save_sales_invoice(jsonb,bigint)
to authenticated;

notify pgrst,'reload schema';
