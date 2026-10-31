-- Original FX helpers/callers; pure definitions, no historical repairs.
CREATE OR REPLACE FUNCTION public.apply_customer_payment_receivable_accounts(p_payment_id bigint, p_expected_total numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.rebuild_customer_payment_receivable_fx(p_payment_id bigint, p_expected_total numeric, p_subsidiary_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.save_customer_payment(p_payload jsonb, p_payment_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  payment_key bigint;
  account_keys jsonb;
begin
  result:=public.save_customer_payment_before_intercompany_receivable(
    p_payload,p_payment_id
  );
  payment_key:=nullif(result->>'id','')::bigint;
  account_keys:=public.apply_customer_payment_receivable_accounts(
    payment_key,coalesce(nullif(result->>'total','')::numeric,0)
  );
  return result||jsonb_build_object('receivableAccountIds',account_keys);
end
$function$;

CREATE OR REPLACE FUNCTION public.save_customer_payment_with_advances_before_bank_fee(p_payload jsonb, p_payment_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  payment_key bigint;
  expected_total numeric;
  account_keys jsonb;
begin
  result:=public.save_customer_payment_with_advances_before_intercompany_receivable(
    p_payload,p_payment_id
  );
  payment_key:=nullif(result->>'id','')::bigint;
  expected_total:=coalesce(
    nullif(result->>'grossTotal','')::numeric,
    nullif(result->>'total','')::numeric,
    0
  );
  account_keys:=public.apply_customer_payment_receivable_accounts(
    payment_key,expected_total
  );
  return result||jsonb_build_object('receivableAccountIds',account_keys);
end
$function$;
