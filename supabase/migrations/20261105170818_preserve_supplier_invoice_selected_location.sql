-- Keep the invoice's selected location through the protected writer and its
-- journal lines. No historical invoice or financial amount is rewritten.
set local lock_timeout='5s';
set local statement_timeout='60s';

create function supplier_invoice_private.resolve_location(p jsonb,p_id bigint)returns bigint
language plpgsql stable set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();chosen bigint;receipt_id bigint;receipt_location bigint;receipt_number text;explicit_location boolean:=p?'location_id';
begin
 if sid is null then raise exception using errcode='42501',message='Seleccione una empresa autorizada.';end if;
 if explicit_location then
  if jsonb_typeof(p->'location_id')not in('number','string')or p->>'location_id'is null or p->>'location_id'!~'^[1-9][0-9]{0,15}$'or(p->>'location_id')::numeric>9007199254740991 then raise exception using errcode='22023',message='Seleccione una ubicación válida.';end if;
  chosen:=(p->>'location_id')::bigint;
 elsif p_id is not null then
  select location_id into chosen from public.supplier_invoice where invoice_id=p_id and subsidiary_id=sid;
  if not found then raise exception using errcode='42501',message='Factura no disponible en la empresa activa.';end if;
 end if;
 receipt_id:=nullif(p->>'purchase_receipt_document_id','')::bigint;receipt_number:=substring(coalesce(p->>'memo','')from'(REC_INV-[A-Za-z0-9_-]+)');
 if receipt_id is not null or receipt_number is not null then
  select document_id,location_id into receipt_id,receipt_location from public.purchase_document
   where document_type='RECEIPT'and subsidiary_id=sid and(case when receipt_id is not null then document_id=receipt_id else document_number=receipt_number end);
  if not found then raise exception using errcode='42501',message='Recepción no disponible en la empresa activa.';end if;
  if explicit_location and chosen is distinct from receipt_location then raise exception using errcode='42501',message='La ubicación de la factura debe conservar la de la recepción.';end if;
  chosen:=receipt_location;
 elsif not explicit_location and p_id is null then
  -- Preserve the existing default only for clients that omit this field.
  select l.location_id into chosen from public.locations l join public.location_subsidiaries ls using(location_id)where ls.subsidiary_id=sid order by l.name,l.location_id limit 1;
 end if;
 if chosen is not null and not exists(select 1 from public.locations l where l.location_id=chosen and(l.subsidiary_id=sid or exists(select 1 from public.location_subsidiaries ls where ls.location_id=l.location_id and ls.subsidiary_id=sid)))then raise exception using errcode='42501',message='La ubicación no pertenece a la empresa activa.';end if;
 return chosen;
end$$;
revoke all on function supplier_invoice_private.resolve_location(jsonb,bigint)from public,anon,authenticated,service_role;

do $location$
declare target regprocedure;definition text;needle text;replacement text;
begin
 target:='supplier_invoice_private.prepare_before_receipt(jsonb,bigint)'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))is distinct from'13472ce2deac522ef3c442d5d4efb55b'then raise exception 'Reviewed supplier invoice preparation changed.';end if;
 definition:=pg_get_functiondef(target);needle:=$old$perform supplier_invoice_private.period((p->>'fiscal_period_id')::bigint,(p->>'invoice_date')::date);$old$;
 replacement:=$new$perform supplier_invoice_private.resolve_location(p,p_id);
 perform supplier_invoice_private.period((p->>'fiscal_period_id')::bigint,(p->>'invoice_date')::date);$new$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected invoice preparation location insertion.';end if;
 execute replace(definition,needle,replacement);
 target:='supplier_invoice_private.save_supplier_invoice_without_withholding(jsonb,bigint)'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))is distinct from'd62a7083f4d185535ba5606ccd044867'then raise exception 'Reviewed supplier invoice accounting engine changed.';end if;
 definition:=pg_get_functiondef(target);needle:=$old$select l.location_id into loc from locations l join location_subsidiaries ls using(location_id) where ls.subsidiary_id=sid order by l.name,l.location_id limit 1;$old$;
 replacement:=$new$loc:=supplier_invoice_private.resolve_location(payload,target_invoice_id);$new$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected invoice accounting location selection.';end if;
 execute replace(definition,needle,replacement);
 target:='supplier_invoice_private.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint)'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))is distinct from'4b4681f77a5ed6c52548eaac61b91c47'then raise exception 'Reviewed supplier invoice withholding engine changed.';end if;
 definition:=pg_get_functiondef(target);
 needle:=$old$insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,tax_code_id,tax_rate,gross_amount,note,entity_type,supplier_id)$old$;
 replacement:=$new$insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,tax_code_id,tax_rate,gross_amount,note,entity_type,supplier_id,location_id)$new$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected invoice withholding location columns.';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$'Proveedor',supplier_key);$old$;
 replacement:=$new$'Proveedor',supplier_key,(select i.location_id from public.supplier_invoice i where i.invoice_id=iid and i.subsidiary_id=sid));$new$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected invoice withholding location value.';end if;
 execute replace(definition,needle,replacement);
end$location$;
