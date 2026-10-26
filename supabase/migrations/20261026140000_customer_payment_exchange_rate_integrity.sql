create or replace function public.customer_payment_official_exchange_rate(
  p_bank_account_id bigint,
  p_payment_date date
)returns numeric
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=public.active_subsidiary_id();
  source_currency_id bigint;
  functional_currency_id bigint;
  source_code text;
  functional_code text;
  official_rate numeric;
begin
  if p_bank_account_id is null then
    raise exception 'Seleccione la cuenta bancaria del cobro.';
  end if;
  if p_payment_date is null then
    raise exception 'Seleccione la fecha del cobro.';
  end if;

  select bank.currency_id,subsidiary.currency_id,source.currency_code,functional.currency_code
    into source_currency_id,functional_currency_id,source_code,functional_code
  from public.bank_account bank
  join public.subsidiaries subsidiary on subsidiary.subsidiary_id=bank.subsidiary_id
  join public.currencies source on source.currency_id=bank.currency_id
  join public.currencies functional on functional.currency_id=subsidiary.currency_id
  where bank.bank_account_id=p_bank_account_id
    and bank.subsidiary_id=sid;

  if source_currency_id is null then
    raise exception 'La cuenta bancaria no pertenece a la subsidiaria activa.';
  end if;
  if source_currency_id=functional_currency_id then
    return 1;
  end if;

  select rate.spot_rate into official_rate
  from public.exchange_rates rate
  where rate.from_currency_id=source_currency_id
    and rate.to_currency_id=functional_currency_id
    and rate.effective_date<=p_payment_date
    and rate.spot_rate>0
  order by rate.effective_date desc
  limit 1;

  if official_rate is null then
    select 1/nullif(rate.spot_rate,0) into official_rate
    from public.exchange_rates rate
    where rate.from_currency_id=functional_currency_id
      and rate.to_currency_id=source_currency_id
      and rate.effective_date<=p_payment_date
      and rate.spot_rate>0
    order by rate.effective_date desc
    limit 1;
  end if;

  if official_rate is null or official_rate<=0 then
    raise exception 'No existe tipo de cambio % -> % vigente al %.',
      source_code,functional_code,to_char(p_payment_date,'DD/MM/YYYY');
  end if;
  return official_rate;
end
$$;

-- Los envoltorios históricos de anticipos y retenciones utilizaban la tasa
-- recibida desde el navegador. Normalizar el payload en el límite transaccional
-- garantiza que todos usen exactamente la misma tasa oficial que el cobro.
do $$
begin
  if to_regprocedure('public.save_customer_payment_before_fx_guard(jsonb,bigint)') is null then
    alter function public.save_customer_payment(jsonb,bigint)
      rename to save_customer_payment_before_fx_guard;
  end if;
  if to_regprocedure('public.save_customer_payment_with_advances_before_fx_guard(jsonb,bigint)') is null then
    alter function public.save_customer_payment_with_advances(jsonb,bigint)
      rename to save_customer_payment_with_advances_before_fx_guard;
  end if;
end
$$;

create or replace function public.save_customer_payment(
  p_payload jsonb,
  p_payment_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  normalized_payload jsonb:=coalesce(p_payload,'{}'::jsonb);
  official_rate numeric;
begin
  official_rate:=public.customer_payment_official_exchange_rate(
    nullif(trim(normalized_payload->>'account_id'),'')::bigint,
    nullif(trim(normalized_payload->>'date'),'')::date
  );
  normalized_payload:=jsonb_set(
    normalized_payload,'{rate}',to_jsonb(official_rate),true
  );
  return public.save_customer_payment_before_fx_guard(
    normalized_payload,p_payment_id
  );
end
$$;

create or replace function public.save_customer_payment_with_advances(
  p_payload jsonb,
  p_payment_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  normalized_payload jsonb:=coalesce(p_payload,'{}'::jsonb);
  official_rate numeric;
begin
  official_rate:=public.customer_payment_official_exchange_rate(
    nullif(trim(normalized_payload->>'account_id'),'')::bigint,
    nullif(trim(normalized_payload->>'date'),'')::date
  );
  normalized_payload:=jsonb_set(
    normalized_payload,'{rate}',to_jsonb(official_rate),true
  );
  return public.save_customer_payment_with_advances_before_fx_guard(
    normalized_payload,p_payment_id
  );
end
$$;

revoke all on function public.customer_payment_official_exchange_rate(bigint,date),
  public.save_customer_payment_before_fx_guard(jsonb,bigint),
  public.save_customer_payment_with_advances_before_fx_guard(jsonb,bigint),
  public.save_customer_payment(jsonb,bigint),
  public.save_customer_payment_with_advances(jsonb,bigint)
from public,anon,authenticated;

grant execute on function public.save_customer_payment(jsonb,bigint),
  public.save_customer_payment_with_advances(jsonb,bigint)
to authenticated;

notify pgrst,'reload schema';
