-- Invoice proceeds are recognized by Sales. The asset journal offsets that income
-- and recognizes the disposal result, without posting a second receivable or tax.
alter table public.asset_disposal add column sales_invoice_id bigint references public.invoice,
 add column reversal_credit_note_id bigint references public.credit_note;
create unique index asset_disposal_invoice_idx on public.asset_disposal(sales_invoice_id) where sales_invoice_id is not null;
alter function public.fixed_asset_disposal_accounting(text,jsonb) rename to fixed_asset_disposal_before_invoice;
revoke all on function public.fixed_asset_disposal_before_invoice(text,jsonb) from public,anon,authenticated,service_role;

create function asset_operation_private.sale_exit_lines(p_lines jsonb,p_account bigint,p_amount numeric,a public.asset) returns jsonb
language sql immutable set search_path=pg_catalog,public,pg_temp as $$
 select coalesce(jsonb_agg(x order by n) filter(where not(coalesce(x->>'note','') like 'Cobro / CxC %' or x->>'note'='Impuesto por pagar')),'[]')
 ||case when p_amount>0 then jsonb_build_array(asset_operation_private.disposal_line(p_account,p_amount,0,'Compensación ingreso factura de venta del activo',a)) else '[]'::jsonb end
 from jsonb_array_elements(p_lines) with ordinality e(x,n)
$$;

-- The writer is private; only the native-invoice orchestration sets this context.
do $$declare body text;patched text;begin
 body:=pg_get_functiondef('asset_operation_private.post_disposal_journal(jsonb,bigint,bigint,text,bigint)'::regprocedure);
 patched:=replace(body,'perform journal_entry_private.validate_payload(p_entry,p_sid);',
 $inject$if p_kind='DISPOSAL' and nullif(current_setting('app.asset_sale_invoice_id',true),'') is not null then
  p_entry:=jsonb_set(p_entry,'{lines}',asset_operation_private.sale_exit_lines(p_entry->'lines',
   (select l.account_id from public.sales_invoice_line l where l.invoice_id=current_setting('app.asset_sale_invoice_id')::bigint order by l.line_id limit 1),
   (select round(sum(l.amount)*i.exchange_rate,6) from public.sales_invoice_line l join public.invoice i using(invoice_id) where l.invoice_id=current_setting('app.asset_sale_invoice_id')::bigint group by i.exchange_rate),
   asset_master_private.asset(p_asset)));
 end if;
 perform journal_entry_private.validate_payload(p_entry,p_sid);$inject$);
 if patched=body then raise exception 'Unexpected disposal writer';end if;execute patched;
 body:=pg_get_functiondef('public.fixed_asset_disposal_before_invoice(text,jsonb)'::regprocedure);
 patched:=replace(body,'where subsidiary_id=sid and invoice_number=trim(p_payload->>''invoice_reference'')',
 'where subsidiary_id=sid and invoice_number=trim(p_payload->>''invoice_reference'') and invoice_id is distinct from nullif(current_setting(''app.asset_sale_invoice_id'',true),'''')::bigint');
 if patched=body then raise exception 'Unexpected invoice duplication guard';end if;execute patched;
end$$;

create function public.fixed_asset_disposal_accounting(p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;aid bigint;a public.asset;d public.asset_disposal;i public.invoice;r jsonb;v jsonb;p jsonb;
 invoice_payload jsonb;prepared jsonb;invoice_result jsonb;note_result jsonb;lines jsonb;pid bigint;ar bigint;prod public.products;
 invoice_key bigint;native_number text;previous text:=coalesce(current_setting('app.asset_sale_invoice_id',true),'');rate numeric;
begin
 if p_payload ?| array['sales_invoice_id','generated_invoice_id','invoice_journal_id'] then raise exception using errcode='42501',message='No puede sustituir el origen de la factura.';end if;
 if p_action='OPTIONS' then
  r:=public.fixed_asset_disposal_before_invoice(p_action,p_payload);sid:=asset_posting_private.identity();
  return r||jsonb_build_object(
   'products',coalesce((select jsonb_agg(jsonb_build_object('id',x.product_id,'name',x.item_code||' · '||x.display_name) order by x.item_code) from public.products x where x.is_active and x.product_usage in('Venta','Ambas') and exists(select 1 from public.product_subsidiaries s where s.product_id=x.product_id and s.subsidiary_id=sid and s.is_active)),'[]'),
   'paymentTerms',coalesce((select jsonb_agg(jsonb_build_object('id',term_id,'name',term_name) order by term_name) from public.payment_terms),'[]'),
   'countries',coalesce((select jsonb_agg(jsonb_build_object('id',country_id,'name',coalesce(to_jsonb(x)->>'country_name',to_jsonb(x)->>'name',country_id::text))) from public.countries x),'[]'),
   'countryId',(select country_id from public.subsidiaries where subsidiary_id=sid));
 end if;
 if p_action='REVERSE' then
  sid:=asset_operation_private.access('DISPOSAL','delete');v:=asset_operation_private.record('DISPOSAL',(p_payload->>'id')::bigint);
  select * into d from public.asset_disposal where disposal_id=(p_payload->>'id')::bigint;
  if d.sales_invoice_id is null or d.reversed_at is not null then return public.fixed_asset_disposal_before_invoice(p_action,p_payload);end if;
  select * into i from public.invoice where invoice_id=d.sales_invoice_id for update;
  if exists(select 1 from public.customer_payment_application where invoice_id=i.invoice_id)
   or exists(select 1 from public.credit_note where invoice_id=i.invoice_id)
   or exists(select 1 from public.debit_note where invoice_id=i.invoice_id) then raise exception using errcode='55000',message='La factura tiene cobros o notas. Resuelva sus aplicaciones antes de reversar la venta del activo.';end if;
  pid:=asset_posting_private.period((p_payload->>'date')::date);
  select jsonb_agg(jsonb_build_object('product_id',product_id,'quantity',quantity,'unit_price',unit_price,'tax_code_id',tax_code_id,'tax_rate',tax_rate,'department_id',department_id,'cost_center_id',cost_center_id,'class_id',class_id,'related_company_id',related_company_id,'service_country_id',service_country_id,'service_month',service_month,'note',note) order by line_id)
   into lines from public.sales_invoice_line where invoice_id=i.invoice_id;
  -- The credit note settles the receivable in its original currency and historical rate.
  note_result:=public.save_sales_note('CREDIT',jsonb_build_object('invoice_id',i.invoice_id,'note_date',p_payload->>'date','fiscal_period_id',pid,'currency_id',i.currency_id,'exchange_rate',i.exchange_rate,'memo','Reversión venta de activo: '||(p_payload->>'note'),'lines',lines),null);
  r:=public.fixed_asset_disposal_before_invoice(p_action,p_payload);
  update public.asset_disposal set reversal_credit_note_id=(note_result->>'noteId')::bigint where disposal_id=d.disposal_id;
  insert into asset_operation_private.disposal_journal_links values((note_result->>'journalId')::bigint,d.asset_id,'SALE_CREDIT_NOTE');
  return r||jsonb_build_object('creditNoteId',note_result->'noteId','invoiceId',i.invoice_id,'message','Venta reversada y nota de crédito generada; activo reactivado.');
 end if;
 if p_action not in('PREVIEW','POST') or p_payload->>'disposal_type' is distinct from 'VENTA' then
  return public.fixed_asset_disposal_before_invoice(p_action,p_payload);
 end if;
 sid:=asset_operation_private.access('DISPOSAL',case when p_action='POST' then 'create' else 'view' end);
 perform public.security_assert_role_access('sales:invoices','create');
 aid:=(p_payload->>'asset_id')::bigint;a:=asset_master_private.asset(aid);
 if p_action='POST' then
  select * into d from public.asset_disposal where request_id=nullif(p_payload->>'request_id','')::uuid;
  if found then
   if d.asset_id<>aid or d.accounting_snapshot->'invoiceRequest' is distinct from p_payload then raise exception using errcode='22023',message='La clave ya corresponde a otra operación.';end if;
   return jsonb_build_object('id',d.disposal_id,'number',d.disposal_number,'journalId',d.journal_id,'invoiceId',d.sales_invoice_id,'invoiceNumber',d.invoice_reference,'message','Venta ya contabilizada.');
  end if;
 end if;
 pid:=asset_posting_private.period((p_payload->>'date')::date);
 ar:=public.resolve_customer_receivable_account(sid,(p_payload->>'customer_id')::bigint);
 select * into prod from public.products where product_id=(p_payload->>'product_id')::bigint;
 p:=p_payload||jsonb_build_object('collection_account_id',ar,'invoice_reference','AF-PREVIA-'||coalesce(p_payload->>'request_id',aid::text));
 v:=public.fixed_asset_disposal_before_invoice('PREVIEW',p);rate:=(v->>'exchangeRate')::numeric;
 invoice_payload:=jsonb_build_object('invoice_number','','customer_id',p_payload->>'customer_id','invoice_date',p_payload->>'date',
  'fiscal_period_id',pid,'currency_id',p_payload->>'currency_id','exchange_rate',rate,'payment_term_id',p_payload->>'payment_term_id','memo','Venta activo '||a.asset_number||' · '||(p_payload->>'note'),
  'lines',jsonb_build_array(jsonb_build_object('product_id',p_payload->>'product_id','quantity',1,'unit_price',p_payload->>'sale_amount','tax_code_id',nullif(p_payload->>'tax_code_id',''),
   'department_id',a.department_id,'cost_center_id',a.cost_center_id,'class_id',a.class_id,'service_country_id',p_payload->>'service_country_id','note','Venta de '||a.asset_number||' · '||a.asset_name)));
 prepared:=sales_invoice_private.prepare(invoice_payload,null);
 lines:=asset_operation_private.sale_exit_lines(v->'lines',prod.sales_account_id,(v->>'saleLocal')::numeric,a);
 if p_action='PREVIEW' then return v||jsonb_build_object('lines',lines,'invoicePreview',prepared,'message',case when(v->>'canPost')::boolean then 'Se generará una factura de venta y el asiento de salida del activo.' else v->>'message' end);end if;
 if not(v->>'canPost')::boolean then raise exception using errcode='55000',message='Contabilice la depreciación al corte antes de generar la factura.';end if;
 invoice_result:=public.save_sales_invoice(prepared,null);invoice_key:=(invoice_result->>'invoiceId')::bigint;
 select * into i from public.invoice where invoice_id=invoice_key and subsidiary_id=sid;
 if not found then raise exception using errcode='55000',message='No se generó la factura de venta.';end if;
 if round(i.exchange_rate,10)<>round(rate,10) then raise exception using errcode='55000',message='El tipo de cambio de la factura no coincide con la venta del activo.';end if;
 perform set_config('app.asset_sale_invoice_id',invoice_key::text,true);
 r:=public.fixed_asset_disposal_before_invoice('POST',p||jsonb_build_object('invoice_reference',i.invoice_number));
 perform set_config('app.asset_sale_invoice_id',previous,true);
 update public.asset_disposal set sales_invoice_id=invoice_key,accounting_snapshot=accounting_snapshot||jsonb_build_object('invoiceRequest',p_payload,'invoiceId',invoice_key,'lines',lines) where disposal_id=(r->>'id')::bigint;
 -- Protect the invoice journal with the same immutable accounting boundary.
 insert into asset_operation_private.disposal_journal_links values(i.journal_id,aid,'SALE_INVOICE');
 return r||jsonb_build_object('invoiceId',invoice_key,'invoiceNumber',i.invoice_number,'message','Venta contabilizada y factura de venta generada.');
end$$;
revoke all on function public.fixed_asset_disposal_accounting(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.fixed_asset_disposal_accounting(text,jsonb) to authenticated;
revoke all on function asset_operation_private.sale_exit_lines(jsonb,bigint,numeric,public.asset) from public,anon,authenticated,service_role;

-- Keep invoice edits from separating the invoice from the disposal journal.
create function asset_operation_private.protect_asset_invoice() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if exists(select 1 from public.asset_disposal where sales_invoice_id=old.invoice_id) then raise exception using errcode='55000',message='La factura pertenece a una venta de Activos Fijos y conserva su historial. Utilice la reversión de la venta.';end if;
 if tg_op='DELETE' then return old;end if;return new;
end$$;
create trigger protect_asset_sale_invoice before update of invoice_number,customer_id,total_amount,currency_id,exchange_rate,invoice_date,journal_id,transaction_id,subsidiary_id or delete on public.invoice for each row execute function asset_operation_private.protect_asset_invoice();
revoke all on function asset_operation_private.protect_asset_invoice() from public,anon,authenticated,service_role;
do $$declare body text;begin
 body:=pg_get_functiondef('asset_operation_private.fixed_asset_operation_report(jsonb)'::regprocedure);
 body:=replace(body,'''journalId'',d.journal_id','''journalId'',d.journal_id,''invoiceId'',d.sales_invoice_id,''creditNoteId'',d.reversal_credit_note_id');execute body;
end$$;
notify pgrst,'reload schema';
