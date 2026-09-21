alter table supplier_invoice_line add column if not exists quantity numeric(24,6) not null default 1 check(quantity>0);
-- NULL means a historical line: its original amount is the price for one unit.
alter table supplier_invoice_line add column if not exists unit_price numeric(24,6) check(unit_price>0);

create or replace function normalize_supplier_invoice_quantities(p_payload jsonb)returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare item jsonb;items jsonb:='[]';qty numeric;price numeric;total numeric;begin
 for item in select value from jsonb_array_elements(coalesce(p_payload->'lines','[]'))loop
  qty:=coalesce(nullif(item->>'quantity','')::numeric,1);
  price:=coalesce(nullif(item->>'unit_price','')::numeric,nullif(item->>'amount','')::numeric/ nullif(qty,0));
  if qty is null or price is null or qty<=0 or price<=0 or qty::text in('NaN','Infinity','-Infinity')or price::text in('NaN','Infinity','-Infinity')then raise exception 'Cada línea requiere cantidad y precio unitario mayores que cero.';end if;
  if qty<>round(qty,6)or price<>round(price,6)then raise exception 'Cantidad y precio unitario admiten hasta seis decimales.';end if;
  total:=round(qty*price,6);
  if total<=0 then raise exception 'El importe de la línea debe ser mayor que cero.';end if;
  items:=items||jsonb_build_array(item||jsonb_build_object('quantity',qty,'unit_price',price,'amount',total));
 end loop;
 return p_payload||jsonb_build_object('lines',items);
end$$;

do $$declare original text;updated text;begin
 original:=pg_get_functiondef('save_supplier_invoice_without_withholding(jsonb,bigint)'::regprocedure);
 if position('amount,quantity,unit_price,'in original)=0 then
  updated:=replace(original,'supplier_invoice_line(invoice_id,account_id,amount,','supplier_invoice_line(invoice_id,account_id,amount,quantity,unit_price,');
  updated:=replace(updated,'values(iid,(line->>''account_id'')::bigint,amount,','values(iid,(line->>''account_id'')::bigint,amount,(line->>''quantity'')::numeric,(line->>''unit_price'')::numeric,');
  if updated=original then raise exception 'No se pudo ampliar el guardado de cantidades en la factura.';end if;
  execute updated;
 end if;
 original:=pg_get_functiondef('save_supplier_invoice(jsonb,bigint)'::regprocedure);
 if position('normalize_supplier_invoice_quantities'in original)=0 then
  updated:=replace(original,'result:=save_supplier_invoice_without_withholding(payload,target_invoice_id);','payload:=normalize_supplier_invoice_quantities(payload);'||chr(10)||'  result:=save_supplier_invoice_without_withholding(payload,target_invoice_id);');
  if updated=original then raise exception 'No se encontró el punto de validación del guardado de factura.';end if;
  execute updated;
 end if;
end$$;
revoke all on function normalize_supplier_invoice_quantities(jsonb)from public,anon,authenticated;
notify pgrst,'reload schema';
