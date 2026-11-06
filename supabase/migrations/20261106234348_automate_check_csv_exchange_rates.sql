-- CHECKS CSV rates are derived from the same dated catalog as manual entry.
-- Deposits retain their published explicit-rate contract and fingerprints.
set local lock_timeout='5s';set local statement_timeout='60s';
create function banking_csv_private.canonical_rows(p_kind text,p_rows jsonb)returns jsonb
language sql immutable security invoker set search_path=pg_catalog as $$
 select case when p_kind='CHECKS'and jsonb_typeof(p_rows)='array'then
  coalesce((select jsonb_agg(case when jsonb_typeof(value)='object'then value-'tipo_cambio'else value end order by ord)
   from jsonb_array_elements(p_rows)with ordinality x(value,ord)),'[]'::jsonb)
 else p_rows end
$$;

create function banking_csv_private.check_rate(p_currency bigint,p_local bigint,p_date date)returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog,public,pg_temp as $$
declare quote numeric;applied numeric;effective date;source_id bigint;matches integer;source_name text:='DIRECT';begin
 if p_currency is null or p_local is null or p_date is null or not isfinite(p_date)then
  raise exception using errcode='22023',message='No se puede resolver la tasa automática sin moneda local y fecha válidas.';end if;
 if p_currency=p_local then return jsonb_build_object('exchangeRate','1','rateDate',null,'rateSource','LOCAL','rateId',null,'sourceRate','1');end if;
 select count(*),min(r.spot_rate),min(r.exchange_rate_id),min(r.effective_date)into matches,quote,source_id,effective
 from public.exchange_rates r where r.from_currency_id=p_currency and r.to_currency_id=p_local
 and r.effective_date=(select max(x.effective_date)from public.exchange_rates x where x.from_currency_id=p_currency and x.to_currency_id=p_local and x.effective_date<=p_date);
 if matches=0 then
  source_name:='INVERSE';
  select count(*),min(r.spot_rate),min(r.exchange_rate_id),min(r.effective_date)into matches,quote,source_id,effective
  from public.exchange_rates r where r.from_currency_id=p_local and r.to_currency_id=p_currency
  and r.effective_date=(select max(x.effective_date)from public.exchange_rates x where x.from_currency_id=p_local and x.to_currency_id=p_currency and x.effective_date<=p_date);
 end if;
 if matches=0 then raise exception using errcode='22023',message='No existe un tipo de cambio vigente para la moneda del archivo en la fecha del documento.';end if;
 if matches<>1 or quote is null or quote::text in('NaN','Infinity','-Infinity')or quote<=0 then
  raise exception using errcode='22023',message='El tipo de cambio vigente del catálogo no es único, positivo y finito. Revise su configuración.';end if;
 applied:=round(case when source_name='INVERSE'then 1/quote else quote end,10);
 if applied<=0 or applied::text in('NaN','Infinity','-Infinity')then raise exception using errcode='22023',message='La tasa automática no puede representarse con diez decimales. Revise el catálogo.';end if;
 return jsonb_build_object('exchangeRate',applied::text,'rateDate',effective,'rateSource',source_name,'rateId',source_id,'sourceRate',quote::text);
end$$;
revoke all on function banking_csv_private.canonical_rows(text,jsonb),banking_csv_private.check_rate(bigint,bigint,date)from public,anon,authenticated,service_role;

do $automatic_check_rate$
declare target regprocedure;definition text;needle text;replacement text;item record;begin
 for item in select *from(values
  ('banking_csv_private.build_batch(text,jsonb,bigint)','2c5777163defc8227a5f9c7511dfb22b'),
  ('public.banking_csv_preview(text,jsonb,bigint)','65cb94948269218eb08737de31d2894a'),
  ('public.banking_csv_import(text,jsonb,bigint,jsonb,text,text)','f05e41718e072148d3de281411dc877d')
 )v(signature,source_md5)loop
  target:=item.signature::regprocedure;
  if md5((select prosrc from pg_proc where oid=target))is distinct from item.source_md5 then raise exception 'Reviewed banking CSV function changed: %',item.signature;end if;
 end loop;
 target:='banking_csv_private.build_batch(text,jsonb,bigint)'::regprocedure;definition:=pg_get_functiondef(target);
 needle:='fingerprint text;grp record;';replacement:='fingerprint text;rate_meta jsonb;grp record;';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed batch declaration changed';end if;
 definition:=replace(definition,needle,replacement);
 needle:='fingerprint:=banking_csv_private.sha(rows::text);';replacement:='rows:=banking_csv_private.canonical_rows(kind,rows);'||chr(10)||' fingerprint:=banking_csv_private.sha(rows::text);';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed batch fingerprint changed';end if;
 definition:=replace(definition,needle,replacement);
 needle:='header_keys:=header_keys||array[''tipo_movimiento'',''beneficiario''];';replacement:='header_keys:=array_remove(header_keys,''tipo_cambio'')||array[''tipo_movimiento'',''beneficiario''];';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed batch header consistency changed';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$   field:='tipo_cambio';rate:=banking_csv_private.number_value(first_row->>'tipo_cambio',10,'Tipo de cambio');if currency=(select currency_id from public.subsidiaries where subsidiary_id=sid)and rate<>1 then raise exception using errcode='22023',message='La moneda local requiere tipo de cambio 1.';end if;$old$;
 replacement:=$new$   if kind='CHECKS'then
    field:='moneda';if not exists(select 1 from public.bank_account b where b.bank_account_id=bank and b.subsidiary_id=sid and b.currency_id=currency)then raise exception using errcode='22023',message='La moneda del archivo no coincide con la moneda de la cuenta bancaria.';end if;
    rate_meta:=banking_csv_private.check_rate(currency,(select currency_id from public.subsidiaries where subsidiary_id=sid),d);rate:=(rate_meta->>'exchangeRate')::numeric;
   else
    field:='tipo_cambio';rate:=banking_csv_private.number_value(first_row->>'tipo_cambio',10,'Tipo de cambio');if currency=(select currency_id from public.subsidiaries where subsidiary_id=sid)and rate<>1 then raise exception using errcode='22023',message='La moneda local requiere tipo de cambio 1.';end if;
   end if;$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed explicit CSV rate changed';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$   field:='tipo_cambio';row_number:=header_row;$old$;replacement:=$new$   field:=case when kind='CHECKS'then 'importe'else 'tipo_cambio'end;row_number:=header_row;$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed rate precision guard changed';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$   batch:=batch||jsonb_build_array(jsonb_build_object('reference',grp.reference,'row',header_row,'payload',payload,'summary',summary,'signature',banking_csv_private.sha(payload::text)));entries:=entries||jsonb_build_array(summary);$old$;
 replacement:=$new$   if kind='CHECKS'then summary:=summary||(rate_meta-'rateId'-'sourceRate');end if;
   batch:=batch||jsonb_build_array(jsonb_build_object('reference',grp.reference,'row',header_row,'payload',payload,'summary',summary,'signature',banking_csv_private.sha(payload::text))||case when kind='CHECKS'then jsonb_build_object('rateMetadata',rate_meta)else '{}'::jsonb end);entries:=entries||jsonb_build_array(summary);$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed batch rate metadata changed';end if;
 definition:=replace(definition,needle,replacement);execute definition;

 target:='public.banking_csv_preview(text,jsonb,bigint)'::regprocedure;definition:=pg_get_functiondef(target);
 needle:='begin'||chr(10)||' select result into previous';replacement:='begin'||chr(10)||' p_rows:=banking_csv_private.canonical_rows(p_kind,p_rows);'||chr(10)||' select result into previous';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed preview receipt lookup changed';end if;
 execute replace(definition,needle,replacement);
 target:='public.banking_csv_import(text,jsonb,bigint,jsonb,text,text)'::regprocedure;definition:=pg_get_functiondef(target);
 needle:='begin'||chr(10)||' if ctx is distinct';replacement:='begin'||chr(10)||' p_rows:=banking_csv_private.canonical_rows(p_kind,p_rows);'||chr(10)||' if ctx is distinct';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed import fingerprint changed';end if;
 execute replace(definition,needle,replacement);
end$automatic_check_rate$;
notify pgrst,'reload schema';
