-- Future outgoing bank documents and deposits only. A functional-currency
-- amount has rate one; shared locations follow their explicit memberships.
-- Existing financial rows and posting engines are not rewritten.
set local lock_timeout='5s';
set local statement_timeout='60s';
do $bank_validation$
declare target regprocedure;definition text;needle text;replacement text;expected text;kind text;
begin
 foreach kind in array array['check','deposit']loop
  if kind='check'then target:='bank_check_private.validate_payload(jsonb,bigint,bank_check)'::regprocedure;expected:='07b453f0fc9180a787c78edcbaf57edd';
  else target:='bank_deposit_private.validate_payload(jsonb,bigint,bigint)'::regprocedure;expected:='9de01928af2330448830be4ce14fce39';end if;
  if md5((select prosrc from pg_proc where oid=target))is distinct from expected then raise exception 'Reviewed bank % validation changed.',kind;end if;
  definition:=pg_get_functiondef(target);needle:=$old$rate:=(p_payload->>'exchange_rate')::numeric;$old$;
  replacement:=needle||$new$
 if ba.currency_id=(select currency_id from public.subsidiaries where subsidiary_id=p_sid)and rate is distinct from 1 then
  raise exception using errcode='22023',message='La moneda local requiere un tipo de cambio igual a 1.';
 end if;
 if rate is not null and rate<>round(rate,10)then
  raise exception using errcode='22023',message='El tipo de cambio admite como máximo diez decimales.';
 end if;$new$;
  if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected bank % exchange-rate guard.',kind;end if;
  definition:=replace(definition,needle,replacement);
  if kind='check'then
   needle:=$old$(l.subsidiary_id=p_sid or l.subsidiary_id is null)$old$;
   replacement:=$new$(l.subsidiary_id=p_sid or exists(select 1 from public.location_subsidiaries ls where ls.location_id=l.location_id and ls.subsidiary_id=p_sid))$new$;
   if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected outgoing bank location scope.';end if;
   definition:=replace(definition,needle,replacement);
  end if;
  needle:=$old$  amount:=(line->>'amount')::numeric;$old$;
  replacement:=needle||$new$
  if amount is not null and amount<>round(amount,6)then
   raise exception using errcode='22023',message='Los importes admiten como máximo seis decimales.';
  end if;$new$;
  if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected bank % amount validation.',kind;end if;
  definition:=replace(definition,needle,replacement);
  -- Match the real numeric(24,6) native/local columns and the header's
  -- numeric(24,10) exchange rate before any writer allocates records.
  -- Rounding independent lines must agree with the bank's aggregate leg.
  needle:=$old$
 end loop;$old$;
  replacement:=needle||$new$
 if exists(select 1 from(
  select sum(round((x->>'amount')::numeric,6)) native_lines,
   round(sum((x->>'amount')::numeric),6) native_bank,
   sum(round(round((x->>'amount')::numeric,6)*round(rate,10),6)) local_lines,
   round(round(sum((x->>'amount')::numeric),6)*round(rate,10),6) local_bank
  from jsonb_array_elements(p_payload->'lines')x
 )precision_check where native_lines is distinct from native_bank or local_lines is distinct from local_bank)then
  raise exception using errcode='22023',message='La conversión de las líneas no cuadra a seis decimales. Revise los importes o el tipo de cambio antes de guardar.';
 end if;$new$;
  if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected bank % line validation loop.',kind;end if;
  definition:=replace(definition,needle,replacement);
  execute definition;
 end loop;
end$bank_validation$;
