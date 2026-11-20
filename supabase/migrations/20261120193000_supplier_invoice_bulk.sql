create schema supplier_invoice_bulk_private;
revoke all on schema supplier_invoice_bulk_private from public,anon,authenticated,service_role;
create table supplier_invoice_bulk_private.imports(subsidiary_id bigint,user_id bigint,request_id uuid,payload_hash text not null,result jsonb not null,primary key(subsidiary_id,user_id,request_id));
alter table supplier_invoice_bulk_private.imports enable row level security;
revoke all on supplier_invoice_bulk_private.imports from public,anon,authenticated,service_role;
create function public.import_supplier_invoices(p_action text,p_rows jsonb,p_subsidiary_id bigint,p_request_id uuid default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;uid bigint;r jsonb;p jsonb;ln jsonb;h jsonb;groups jsonb:='{}';k text;idx integer:=0;source_row integer;pid bigint;cur bigint;base bigint;rate numeric;prepared jsonb;errors jsonb:='[]';preview jsonb:='[]';saved jsonb:='[]';answer jsonb;previous record;begin
 sid:=supplier_invoice_private.assert_write(null);uid:=public.app_user_id();if p_subsidiary_id is distinct from sid then raise exception using errcode='42501',message='La plantilla pertenece a otra subsidiaria.';end if;
 if p_action is null or p_action not in('VALIDATE','IMPORT') or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 500 then raise exception using errcode='22023',message='Seleccione entre 1 y 500 líneas válidas.';end if;
 if p_action='IMPORT' then
  if p_request_id is null then raise exception using errcode='22023',message='Falta la clave del lote.';end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-import:'||sid||':'||uid||':'||p_request_id,0));
  select * into previous from supplier_invoice_bulk_private.imports where subsidiary_id=sid and user_id=uid and request_id=p_request_id;
  if found then if previous.payload_hash<>md5(p_rows::text) then raise exception using errcode='22023',message='La clave corresponde a otro archivo.';end if;return previous.result;end if;
 end if;
 select currency_id into base from public.subsidiaries where subsidiary_id=sid;
 for r in select value from jsonb_array_elements(p_rows) loop
  idx:=idx+1;source_row:=idx+1;
  begin
   source_row:=coalesce((r->>'__row')::integer,idx+1);if source_row not between 2 and 501 then source_row:=idx+1;end if;
   if jsonb_typeof(r) is distinct from 'object' or coalesce(btrim(r->>'Factura'),'')='' then raise exception using errcode='22023',message='Número de factura requerido.';end if;
   cur:=(r->>'MonedaID')::bigint;
   if coalesce(r->>'Fecha','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception using errcode='22023',message='Fecha requerida en formato AAAA-MM-DD.';end if;
   select fiscal_period_id into pid from public.fiscal_periods where subsidiary_id=sid and (r->>'Fecha')::date between start_date and end_date and not is_closed and not coalesce(ap_closed,false) and not coalesce(gl_closed,false) and not coalesce(is_inactive,false) order by start_date desc,fiscal_period_id desc limit 1;
   if pid is null then raise exception using errcode='22023',message='No existe período abierto para la fecha.';end if;
   rate:=1;if cur<>base then select spot_rate into rate from public.exchange_rates where from_currency_id=cur and to_currency_id=base and effective_date=(r->>'Fecha')::date order by exchange_rate_id desc limit 1;if rate is null then raise exception using errcode='22023',message='Falta el tipo de cambio oficial de la fecha.';end if;end if;
   h:=jsonb_build_object('invoice_number',btrim(r->>'Factura'),'invoice_date',r->>'Fecha','supplier_id',nullif(r->>'ProveedorID','')::bigint,'currency_id',cur,'location_id',nullif(r->>'UbicacionID','')::bigint,'payment_term_id',nullif(r->>'CondicionPagoID','')::bigint,'invoice_type',coalesce(nullif(r->>'TipoFactura',''),'Factura estándar'),'memo',coalesce(r->>'NotaFactura',''),'fiscal_period_id',pid,'exchange_rate',rate);
   if (h->>'supplier_id') is null or cur is null or h->>'location_id' is null or h->>'payment_term_id' is null then raise exception using errcode='22023',message='Complete proveedor, moneda, ubicación y condición de pago.';end if;
   if exists(select 1 from public.supplier_invoice where supplier_id=(h->>'supplier_id')::bigint and invoice_number=h->>'invoice_number') then raise exception using errcode='22023',message='Factura ya registrada para este proveedor.';end if;
   ln:=jsonb_build_object('account_id',nullif(r->>'CuentaID','')::bigint,'quantity',(r->>'Cantidad')::numeric,'unit_price',(r->>'PrecioUnitario')::numeric,'tax_code_id',nullif(r->>'ImpuestoID','')::bigint,'department_id',nullif(r->>'DepartamentoID','')::bigint,'cost_center_id',nullif(r->>'CentroCostoID','')::bigint,'class_id',nullif(r->>'ClaseID','')::bigint,'service_country_id',nullif(r->>'PaisServicioID','')::bigint,'note',coalesce(r->>'NotaLinea',''),'es_activo_fijo',h->>'invoice_type'='Factura Activos Fijos');
   if not asset_posting_private.finite((ln->>'quantity')::numeric) or (ln->>'quantity')::numeric<=0 or not asset_posting_private.finite((ln->>'unit_price')::numeric) or(ln->>'unit_price')::numeric<0 then raise exception using errcode='22023',message='Cantidad positiva y precio no negativo requeridos.';end if;
   k:=jsonb_build_array(h->>'supplier_id',h->>'invoice_number')::text;
   if groups?k then if (groups->k)-'lines'-'sourceRow'<>h then raise exception using errcode='22023',message='Las líneas de una factura deben repetir los mismos datos de cabecera.';end if;
    groups:=jsonb_set(groups,array[k,'lines'],groups->k->'lines'||jsonb_build_array(ln));
   else groups:=groups||jsonb_build_object(k,h||jsonb_build_object('lines',jsonb_build_array(ln),'sourceRow',source_row));end if;
  exception when others then errors:=errors||jsonb_build_array(jsonb_build_object('row',source_row,'invoice',r->>'Factura','message',case when sqlstate='22023' then sqlerrm when sqlstate='42501' then 'Referencia no autorizada para la subsidiaria.' else 'Revise los IDs, fechas y valores numéricos de esta fila.' end));end;
 end loop;
 if (select count(*) from jsonb_each(groups))>100 then return jsonb_build_object('valid',false,'errors',jsonb_build_array(jsonb_build_object('row',0,'message','El lote admite hasta 100 facturas.')),'invoices','[]'::jsonb);end if;
 for k,p in select key,value from jsonb_each(groups) loop
  begin
   prepared:=supplier_invoice_private.prepare(p-'sourceRow',null);
   preview:=preview||jsonb_build_array(jsonb_build_object('invoice',p->>'invoice_number','supplierId',p->'supplier_id','currencyId',p->'currency_id','lines',jsonb_array_length(p->'lines'),'date',p->>'invoice_date','subtotal',(select sum((x->>'quantity')::numeric*(x->>'unit_price')::numeric) from jsonb_array_elements(p->'lines')x)));
  exception when others then errors:=errors||jsonb_build_array(jsonb_build_object('row',p->'sourceRow','invoice',p->>'invoice_number','message',case when sqlstate in('22023','55000') then left(sqlerrm,300) when sqlstate='42501' then 'Proveedor, cuenta o dimensión no autorizados. Revise los catálogos.' else 'No se pudo validar la factura; revise sus referencias y configuración.' end));end;
 end loop;
 if jsonb_array_length(preview)>100 then errors:=errors||jsonb_build_array(jsonb_build_object('row',0,'message','El lote admite hasta 100 facturas.'));end if;
 if jsonb_array_length(errors)>0 or p_action='VALIDATE' then return jsonb_build_object('valid',jsonb_array_length(errors)=0,'errors',errors,'invoices',preview);end if;
 for k,p in select key,value from jsonb_each(groups) order by key loop
  answer:=public.save_supplier_invoice(p-'sourceRow',null);
  if nullif(answer->>'invoiceId','') is null then raise exception using errcode='55000',message='Una factura no pudo registrarse. El lote completo fue revertido; revise el control presupuestario.';end if;
  saved:=saved||jsonb_build_array(jsonb_build_object('invoice',p->>'invoice_number','invoiceId',answer->'invoiceId','journalId',answer->'journalId'));
 end loop;
 answer:=jsonb_build_object('valid',true,'imported',jsonb_array_length(saved),'invoices',saved,'message','Lote registrado correctamente.');
 insert into supplier_invoice_bulk_private.imports values(sid,uid,p_request_id,md5(p_rows::text),answer);return answer;
end$$;
revoke all on function public.import_supplier_invoices(text,jsonb,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.import_supplier_invoices(text,jsonb,bigint,uuid) to authenticated;
notify pgrst,'reload schema';
