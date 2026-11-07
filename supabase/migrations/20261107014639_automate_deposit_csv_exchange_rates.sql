-- Both banking CSV templates use the dated system quote; ignored legacy rate
-- cells never contribute to identity. Existing posting engines remain unchanged.
set local lock_timeout='5s';set local statement_timeout='60s';
do $deposit_automatic_rate$
declare definition text;needle text;replacement text;item record;begin
 for item in select *from(values
 ('banking_csv_private.canonical_rows(text,jsonb)','7bb92bdacfbad5dc75dc46f6cdca43c8'),
 ('banking_csv_private.build_batch(text,jsonb,bigint)','cd5d79793f84d6e151c59aad9053bcd7')
 )v(signature,source_md5)loop
  if md5((select prosrc from pg_proc where oid=item.signature::regprocedure))is distinct from item.source_md5 then raise exception 'Reviewed banking CSV function changed: %',item.signature;end if;
 end loop;
 definition:=pg_get_functiondef('banking_csv_private.canonical_rows(text,jsonb)'::regprocedure);
 needle:=$old$p_kind='CHECKS'and$old$;replacement:=$new$p_kind in('CHECKS','DEPOSITS')and$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed deposit automatic-rate source changed';end if;
 definition:=replace(definition,needle,replacement);
 execute definition;
 definition:=pg_get_functiondef('banking_csv_private.build_batch(text,jsonb,bigint)'::regprocedure);
 needle:=$old$array['fecha','cuenta_bancaria','moneda','tipo_cambio','referencia_bancaria','ubicacion','nota_documento']$old$;replacement:=$new$array['fecha','cuenta_bancaria','moneda','referencia_bancaria','ubicacion','nota_documento']$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed deposit automatic-rate source changed';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$   if kind='CHECKS'then
    field:='moneda';if not exists(select 1 from public.bank_account b where b.bank_account_id=bank and b.subsidiary_id=sid and b.currency_id=currency)then raise exception using errcode='22023',message='La moneda del archivo no coincide con la moneda de la cuenta bancaria.';end if;
    rate_meta:=banking_csv_private.check_rate(currency,(select currency_id from public.subsidiaries where subsidiary_id=sid),d);rate:=(rate_meta->>'exchangeRate')::numeric;
   else
    field:='tipo_cambio';rate:=banking_csv_private.number_value(first_row->>'tipo_cambio',10,'Tipo de cambio');if currency=(select currency_id from public.subsidiaries where subsidiary_id=sid)and rate<>1 then raise exception using errcode='22023',message='La moneda local requiere tipo de cambio 1.';end if;
   end if;$old$;replacement:=$new$   field:='moneda';if not exists(select 1 from public.bank_account b where b.bank_account_id=bank and b.subsidiary_id=sid and b.currency_id=currency)then raise exception using errcode='22023',message='La moneda del archivo no coincide con la moneda de la cuenta bancaria.';end if;
   rate_meta:=banking_csv_private.check_rate(currency,(select currency_id from public.subsidiaries where subsidiary_id=sid),d);rate:=(rate_meta->>'exchangeRate')::numeric;$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed deposit automatic-rate source changed';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$field:=case when kind='CHECKS'then 'importe'else 'tipo_cambio'end;$old$;replacement:=$new$field:='importe';$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed deposit automatic-rate source changed';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$if kind='CHECKS'then summary:=summary||(rate_meta-'rateId'-'sourceRate');end if;$old$;replacement:=$new$summary:=summary||(rate_meta-'rateId'-'sourceRate');$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed deposit automatic-rate source changed';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$||case when kind='CHECKS'then jsonb_build_object('rateMetadata',rate_meta)else '{}'::jsonb end$old$;replacement:=$new$||jsonb_build_object('rateMetadata',rate_meta)$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Reviewed deposit automatic-rate source changed';end if;
 definition:=replace(definition,needle,replacement);
 execute definition;
end$deposit_automatic_rate$;
notify pgrst,'reload schema';
