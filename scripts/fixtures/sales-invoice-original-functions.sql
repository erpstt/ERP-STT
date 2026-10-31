-- Original function definitions inspected in production. No data or repair blocks.
CREATE OR REPLACE FUNCTION public.save_sales_invoice_without_income_autorent(payload jsonb, target_invoice_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;
begin
  result:=public.save_sales_invoice_without_service_country(payload,target_invoice_id);

  with supplied as (
    select ordinality,
      nullif(btrim(value->>'service_country_id'),'')::bigint service_country_id
    from jsonb_array_elements(payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from public.sales_invoice_line
    where invoice_id=(result->>'invoiceId')::bigint
  )
  update public.sales_invoice_line line
  set service_country_id=supplied.service_country_id
  from supplied join stored using(ordinality)
  where line.line_id=stored.line_id;

  return result;
end$function$;

CREATE OR REPLACE FUNCTION public.save_sales_invoice_without_service_country(payload jsonb, target_invoice_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;iid bigint;jid bigint;sid bigint:=active_subsidiary_id();customer_key bigint;
 subtotal numeric:=0;taxes numeric:=0;gross numeric:=0;invoice_withheld numeric:=0;all_withheld numeric:=0;
 rule record;calculation_base_amount numeric;calculated_withholding numeric;ar_account bigint;
begin
 if target_invoice_id is not null and exists(select 1 from customer_payment_application where invoice_id=target_invoice_id)then raise exception 'La factura tiene cobros aplicados y sus retenciones ya no pueden recalcularse.';end if;
 result:=save_sales_invoice_without_withholding(payload,target_invoice_id);
 iid:=(result->>'invoiceId')::bigint;jid:=(result->>'journalId')::bigint;customer_key:=(payload->>'customer_id')::bigint;
 select coalesce(sum(amount),0),coalesce(sum(tax_amount),0),coalesce(sum(gross_amount),0) into subtotal,taxes,gross from sales_invoice_line where invoice_id=iid;
 delete from sales_invoice_withholding where invoice_id=iid;
 select jl.account_id into ar_account from journal_line jl join chart_accounts ca using(account_id) where jl.journal_id=jid and jl.debit>0 and ca.category='Activo' and ca.account_name~*'cuenta.*por cobrar|cliente.*por cobrar' order by jl.debit desc limit 1;
 for rule in select r.rule_id,tc.tax_code_id,tc.code_name,tc.rate_percentage,tc.withholding_calculation_base,tc.withholding_application_moment,tt.asset_account_id
  from entity_withholding_rules r join tax_codes tc on tc.tax_code_id=r.tax_code_id join tax_types tt on tt.tax_type_id=tc.tax_type_id
  where r.customer_id=customer_key and r.subsidiary_id=sid and tc.is_withholding and tt.applies_to in('Ventas','Ambos')
 loop
  if rule.asset_account_id is null or not exists(select 1 from account_subsidiaries a where a.account_id=rule.asset_account_id and a.subsidiary_id=sid and a.is_active)then raise exception 'La retención % no tiene una Cuenta Activo vigente para la subsidiaria.',rule.code_name;end if;
  calculation_base_amount:=case rule.withholding_calculation_base when 'Importe de impuestos' then taxes when 'Total de la factura con impuestos' then gross else subtotal end;
  calculated_withholding:=round(calculation_base_amount*rule.rate_percentage/100,6);all_withheld:=all_withheld+calculated_withholding;
  insert into sales_invoice_withholding(invoice_id,entity_rule_id,tax_code_id,asset_account_id,calculation_base,base_amount,rate_percentage,withholding_amount,application_moment,recognized_at_invoice)
  values(iid,rule.rule_id,rule.tax_code_id,rule.asset_account_id,rule.withholding_calculation_base,calculation_base_amount,rule.rate_percentage,calculated_withholding,rule.withholding_application_moment,rule.withholding_application_moment='Al registrar la factura');
  if rule.withholding_application_moment='Al registrar la factura' and calculated_withholding>0 then
   invoice_withheld:=invoice_withheld+calculated_withholding;
   insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,tax_code_id,tax_rate,gross_amount,note,entity_type,customer_id)
   values(jid,rule.asset_account_id,calculated_withholding,0,calculated_withholding,0,rule.tax_code_id,rule.rate_percentage,calculation_base_amount,'Retención '||rule.code_name||' al registrar la factura','Cliente',customer_key);
  end if;
 end loop;
 if invoice_withheld>gross then raise exception 'Las retenciones al registrar no pueden superar el total de la factura.';end if;
 if invoice_withheld>0 then update journal_line jl set debit=jl.debit-invoice_withheld,debit_fx=jl.debit_fx-invoice_withheld where jl.journal_id=jid and jl.account_id=ar_account;end if;
 update invoice i set subtotal_amount=subtotal,tax_total=taxes,withholding_total=all_withheld,receivable_amount=gross-invoice_withheld where i.invoice_id=iid;
 perform sync_journal_gl_impacts(jid);
 return result||jsonb_build_object('subtotal',subtotal,'taxTotal',taxes,'withholdingTotal',all_withheld,'withholdingAtInvoice',invoice_withheld,'receivableTotal',gross-invoice_withheld);
end$function$;

CREATE OR REPLACE FUNCTION public.save_sales_invoice_without_withholding(payload jsonb, target_invoice_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=active_subsidiary_id();iid bigint:=target_invoice_id;tid bigint;jid bigint;tt bigint;st bigint;loc bigint;ar bigint;ln jsonb;prod products%rowtype;amt numeric;tax numeric;gross numeric;total numeric:=0;num text;term payment_terms%rowtype;
begin
 if not exists(select 1 from user_roles ur join role_permissions rp using(role_id) join permissions p using(permission_id) where ur.user_id=app_user_id() and p.code=case when target_invoice_id is null then 'sales:invoice:create' else 'sales:invoice:update' end) then raise exception 'No tiene permiso para crear o modificar facturas de venta.';end if;if coalesce(trim(payload->>'invoice_number'),'')='' or nullif(payload->>'customer_id','') is null then raise exception 'Número y cliente son obligatorios.';end if;if not exists(select 1 from entity_subsidiaries es where es.customer_id=(payload->>'customer_id')::bigint and es.subsidiary_id=sid) then raise exception 'El cliente no pertenece a la subsidiaria activa.';end if;if not exists(select 1 from payment_terms where term_id=(payload->>'payment_term_id')::bigint) then raise exception 'Seleccione términos de pago válidos.';end if;if not exists(select 1 from fiscal_periods f where f.fiscal_period_id=(payload->>'fiscal_period_id')::bigint and f.subsidiary_id=sid and not f.is_closed and not coalesce(f.ar_closed,false) and (payload->>'invoice_date')::date between f.start_date and f.end_date) then raise exception 'El período de Ventas no está abierto.';end if;
 if sid is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id() and subsidiary_id=sid) then raise exception 'No tiene acceso a la subsidiaria activa.';end if;if jsonb_array_length(coalesce(payload->'lines','[]'))<1 then raise exception 'La factura debe contener líneas.';end if;
 select * into term from payment_terms where term_id=(payload->>'payment_term_id')::bigint;select transaction_type_id into tt from transaction_types where abbreviation='FAC_VEN' limit 1;select status_id into st from status order by case upper(code) when 'CONTABILIZADO' then 1 when 'APROBADO' then 2 else 3 end limit 1;select l.location_id into loc from locations l join location_subsidiaries s using(location_id) where s.subsidiary_id=sid order by l.name limit 1;select a.account_id into ar from chart_accounts a join account_subsidiaries s using(account_id) where s.subsidiary_id=sid and s.is_active and a.category='Activo' and lower(a.account_name)~'(cuenta.*por cobrar|cliente.*por cobrar)' order by a.account_number limit 1;if ar is null then raise exception 'Configure una cuenta de Cuentas por Cobrar para la subsidiaria.';end if;
 for ln in select * from jsonb_array_elements(payload->'lines') loop select * into prod from products where product_id=(ln->>'product_id')::bigint and is_active and product_usage in('Venta','Ambas') and exists(select 1 from product_subsidiaries ps where ps.product_id=products.product_id and ps.subsidiary_id=sid);if not found or prod.sales_account_id is null then raise exception 'Un producto no está habilitado para venta o no tiene cuenta de ventas.';end if;if nullif(ln->>'tax_code_id','') is not null and not exists(select 1 from tax_code_subsidiaries where tax_code_id=(ln->>'tax_code_id')::bigint and subsidiary_id=sid) then raise exception 'Código de impuesto no autorizado.';end if;amt:=round((ln->>'quantity')::numeric*(ln->>'unit_price')::numeric,6);tax:=round(amt*coalesce(nullif(ln->>'tax_rate','')::numeric,0)/100,6);total:=total+amt+tax;end loop;
 if iid is null then begin num:=next_transaction_number(tt,sid);exception when others then num:='FAC_VEN-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');end;insert into "transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount,status_id,customer_id)values(num,(payload->>'invoice_date')::date,tt,sid,(payload->>'currency_id')::bigint,(payload->>'exchange_rate')::numeric,(payload->>'fiscal_period_id')::bigint,total,st,(payload->>'customer_id')::bigint)returning transaction_id into tid;insert into journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,location_id,total_debit,total_credit,status)values(num,(payload->>'invoice_date')::date,tid,sid,(payload->>'currency_id')::bigint,(payload->>'fiscal_period_id')::bigint,(payload->>'exchange_rate')::numeric,payload->>'memo','Factura de Venta',loc,total,total,'CONTABILIZADO')returning journal_id into jid;insert into invoice(invoice_number,transaction_id,customer_id,subsidiary_id,due_date,total_amount,invoice_date,fiscal_period_id,currency_id,exchange_rate,memo,journal_id,location_id,payment_term_id)values(payload->>'invoice_number',tid,(payload->>'customer_id')::bigint,sid,(payload->>'invoice_date')::date+term.days_due,total,(payload->>'invoice_date')::date,(payload->>'fiscal_period_id')::bigint,(payload->>'currency_id')::bigint,(payload->>'exchange_rate')::numeric,payload->>'memo',jid,loc,term.term_id)returning invoice_id into iid;else select transaction_id,journal_id into tid,jid from invoice where invoice_id=iid and subsidiary_id=sid;delete from sales_invoice_line where invoice_id=iid;delete from journal_line where journal_id=jid;update invoice set invoice_number=payload->>'invoice_number',customer_id=(payload->>'customer_id')::bigint,due_date=(payload->>'invoice_date')::date+term.days_due,total_amount=total,invoice_date=(payload->>'invoice_date')::date,fiscal_period_id=(payload->>'fiscal_period_id')::bigint,currency_id=(payload->>'currency_id')::bigint,exchange_rate=(payload->>'exchange_rate')::numeric,memo=payload->>'memo',payment_term_id=term.term_id where invoice_id=iid;update "transaction" set tran_date=(payload->>'invoice_date')::date,total_amount=total where transaction_id=tid;update journal set journal_date=(payload->>'invoice_date')::date,total_debit=total,total_credit=total,memo=payload->>'memo' where journal_id=jid;end if;
 for ln in select * from jsonb_array_elements(payload->'lines') loop select * into prod from products where product_id=(ln->>'product_id')::bigint;amt:=round((ln->>'quantity')::numeric*(ln->>'unit_price')::numeric,6);tax:=round(amt*coalesce(nullif(ln->>'tax_rate','')::numeric,0)/100,6);gross:=amt+tax;insert into sales_invoice_line(invoice_id,product_id,account_id,quantity,unit_price,amount,tax_code_id,tax_rate,tax_amount,gross_amount,note,department_id,cost_center_id,class_id,related_company_id)values(iid,prod.product_id,prod.sales_account_id,(ln->>'quantity')::numeric,(ln->>'unit_price')::numeric,amt,nullif(ln->>'tax_code_id','')::bigint,coalesce(nullif(ln->>'tax_rate','')::numeric,0),tax,gross,ln->>'note',nullif(ln->>'department_id','')::bigint,nullif(ln->>'cost_center_id','')::bigint,nullif(ln->>'class_id','')::bigint,nullif(ln->>'related_company_id','')::bigint);insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,tax_code_id,tax_rate,gross_amount,note,entity_type,customer_id,department_id,class_id,location_id,cost_center_id,related_company_id)values(jid,prod.sales_account_id,0,amt,0,amt,nullif(ln->>'tax_code_id','')::bigint,coalesce(nullif(ln->>'tax_rate','')::numeric,0),gross,ln->>'note','Cliente',(payload->>'customer_id')::bigint,nullif(ln->>'department_id','')::bigint,nullif(ln->>'class_id','')::bigint,loc,nullif(ln->>'cost_center_id','')::bigint,nullif(ln->>'related_company_id','')::bigint);end loop;insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,note,entity_type,customer_id,location_id)values(jid,ar,total,0,total,0,'Cuenta por cobrar · '||(payload->>'invoice_number'),'Cliente',(payload->>'customer_id')::bigint,loc);perform sync_journal_gl_impacts(jid);return jsonb_build_object('invoiceId',iid,'journalId',jid,'transactionNumber',num,'total',total);
end$function$;

CREATE OR REPLACE FUNCTION public.save_sales_invoice_before_intercompany_receivable(payload jsonb, target_invoice_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  invoice_key bigint;
  description_value text;
begin
  if payload ? 'unificar_lineas_pdf_descripcion' then
    if jsonb_typeof(payload->'unificar_lineas_pdf_descripcion') <> 'string' then
      raise exception 'La descripción de las líneas del PDF debe ser texto.';
    end if;
    description_value:=btrim(payload->>'unificar_lineas_pdf_descripcion');
  elsif target_invoice_id is null then
    description_value:='Bienes y servicios según detalle de la factura';
  else
    select invoice.unificar_lineas_pdf_descripcion
      into description_value
    from public.invoice invoice
    where invoice.invoice_id=target_invoice_id
      and invoice.subsidiary_id=public.active_subsidiary_id();
  end if;

  if description_value is null or char_length(description_value) not between 1 and 500 then
    raise exception 'La descripción de las líneas del PDF debe contener entre 1 y 500 caracteres.';
  end if;

  result:=public.save_sales_invoice_before_pdf_description(payload,target_invoice_id);
  invoice_key:=nullif(result->>'invoiceId','')::bigint;
  if invoice_key is null then
    raise exception 'La factura guardada no devolvió un identificador válido.';
  end if;

  update public.invoice invoice
  set unificar_lineas_pdf_descripcion=description_value
  where invoice.invoice_id=invoice_key
    and invoice.subsidiary_id=public.active_subsidiary_id();
  if not found then
    raise exception 'La factura guardada no pertenece a la subsidiaria activa.';
  end if;

  return result||jsonb_build_object('unifiedLineDescription',description_value);
end
$function$;

CREATE OR REPLACE FUNCTION public.set_sales_invoice_pdf_presentation(p_invoice_id bigint, p_unify boolean, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid bigint:=public.active_subsidiary_id();
  invoice_number_value text;
  description_value text:=btrim(p_description);
begin
  if public.app_user_id() is null or sid is null or public.app_active_role_id() is null then
    raise exception using errcode='42501',
      message='Debe iniciar sesión, seleccionar una subsidiaria y un rol activo.';
  end if;
  if p_invoice_id is null or p_invoice_id<=0 then
    raise exception 'La factura de venta no es válida.';
  end if;
  if p_unify is null then
    raise exception 'Indique si las líneas deben unificarse en el PDF.';
  end if;
  if description_value is null or char_length(description_value) not between 1 and 500 then
    raise exception 'La descripción de las líneas del PDF debe contener entre 1 y 500 caracteres.';
  end if;
  if not exists(
    select 1
    from public.role_permissions role_permission
    join public.permissions permission using(permission_id)
    where role_permission.role_id=public.app_active_role_id()
      and permission.code='sales:invoice:update'
  ) then
    raise exception using errcode='42501',
      message='No tiene permiso para modificar la presentación PDF de la factura.';
  end if;

  update public.invoice invoice
  set unificar_lineas_pdf=p_unify,
      unificar_lineas_pdf_descripcion=description_value
  where invoice.invoice_id=p_invoice_id
    and invoice.subsidiary_id=sid
  returning invoice.invoice_number into invoice_number_value;
  if not found then
    raise exception 'La factura no existe en la subsidiaria activa.';
  end if;

  return jsonb_build_object(
    'invoiceId',p_invoice_id,
    'invoiceNumber',invoice_number_value,
    'unifyLinesPdf',p_unify,
    'unifiedLineDescription',description_value
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.sales_invoice_delivery_snapshot(p_invoice_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid bigint:=public.active_subsidiary_id();
  result jsonb;
begin
  if public.app_user_id() is null or sid is null then
    raise exception 'Debe iniciar sesión y seleccionar una subsidiaria.';
  end if;

  select jsonb_build_object(
    'id',i.invoice_id,
    'number',i.invoice_number,
    'issueDate',i.invoice_date,
    'dueDate',i.due_date,
    'memo',coalesce(i.memo,''),
    'total',i.total_amount,
    'receivable',coalesce(nullif(i.receivable_amount,0),i.total_amount),
    'unifyLinesPdf',coalesce(i.unificar_lineas_pdf,false),
    'unifiedLineDescription',i.unificar_lineas_pdf_descripcion,
    'company',jsonb_build_object(
      'name',s.name,'address',coalesce(s.address,''),'logo',s.logo_url
    ),
    'customer',jsonb_build_object(
      'name',c.company_name,'email',coalesce(c.email,''),
      'address',coalesce(c.address,''),'taxId',coalesce(c.tax_id,'')
    ),
    'currency',jsonb_build_object(
      'code',cu.currency_code,'name',cu.name,
      'symbol',coalesce(cu.symbol,cu.currency_code)
    ),
    'paymentTerm',coalesce(pt.term_name,''),
    'lines',coalesce((
      select jsonb_agg(jsonb_build_object(
        'product',coalesce(p.display_name,'Producto'),
        'description',coalesce(l.note,''),
        'serviceCountry',coalesce(country.name,'—'),
        'quantity',l.quantity,'unitPrice',l.unit_price,'amount',l.amount,
        'taxCodeId',l.tax_code_id,
        'taxCode',coalesce(tax.code_name,'Sin impuesto'),
        'taxRate',l.tax_rate,'taxAmount',l.tax_amount,
        'grossAmount',l.gross_amount
      ) order by l.line_id)
      from public.sales_invoice_line l
      left join public.products p using(product_id)
      left join public.countries country on country.country_id=l.service_country_id
      left join public.tax_codes tax on tax.tax_code_id=l.tax_code_id
      where l.invoice_id=i.invoice_id
    ),'[]'::jsonb),
    'withholdingTotal',coalesce((
      select sum(w.withholding_amount)
      from public.sales_invoice_withholding w
      where w.invoice_id=i.invoice_id
    ),0),
    'supports',coalesce((
      select jsonb_agg(jsonb_build_object(
        'type',case when js.support_type='Archivo' then 'Archivo' else 'Enlace' end,
        'name',coalesce(js.display_name,js.file_name,'Respaldo'),
        'url',js.support_url,'fileName',js.file_name,
        'mimeType',js.mime_type,'fileSize',js.file_size,'fileData',js.file_data
      ) order by js.support_id)
      from public.journal_support js
      where js.journal_id=i.journal_id
    ),'[]'::jsonb)
  ) into result
  from public.invoice i
  join public.subsidiaries s on s.subsidiary_id=i.subsidiary_id
  join public.customers c on c.customer_id=i.customer_id
  join public.currencies cu on cu.currency_id=i.currency_id
  left join public.payment_terms pt on pt.term_id=i.payment_term_id
  where i.invoice_id=p_invoice_id and i.subsidiary_id=sid;

  if result is null then
    raise exception 'La factura no existe en la subsidiaria activa.';
  end if;
  return result;
end
$function$;

CREATE OR REPLACE FUNCTION public.save_sales_invoice_before_service_month_fix(payload jsonb, target_invoice_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  invoice_key bigint;
  journal_key bigint;
  subsidiary_key bigint;
  location_key bigint;
  configured boolean;
  country_key bigint;
  active_account_key bigint;
  passive_account_key bigint;
  configured_rate numeric;
  applied_rate numeric:=0;
  taxable_base numeric:=0;
  autorent_amount numeric:=0;
  prior_journal_key bigint;
  prior_active_account_key bigint;
  prior_passive_account_key bigint;
  credited_base numeric:=0;
  credited_autorent numeric:=0;
begin
  -- Capture the historical rate and accounts before the established workflow
  -- rebuilds all journal lines during an edit.
  if target_invoice_id is not null then
    select i.autorent_percentage_applied,i.journal_id
      into applied_rate,prior_journal_key
    from public.invoice i
    where i.invoice_id=target_invoice_id and i.subsidiary_id=public.active_subsidiary_id();
    if found and applied_rate>0 then
      select l.account_id into prior_active_account_key
      from public.journal_line l
      where l.journal_id=prior_journal_key
        and l.note='Autorretencion de renta - anticipo' and l.debit>0
      order by l.journal_line_id limit 1;
      select l.account_id into prior_passive_account_key
      from public.journal_line l
      where l.journal_id=prior_journal_key
        and l.note='Autorretencion de renta - por pagar' and l.credit>0
      order by l.journal_line_id limit 1;
    end if;
  end if;

  result:=public.save_sales_invoice_without_income_autorent(payload,target_invoice_id);
  invoice_key:=(result->>'invoiceId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  select i.subsidiary_id,i.location_id,s.country_id,s.applies_income_autorent,
    s.autorent_active_account_id,s.autorent_passive_account_id,s.autorent_percentage
  into subsidiary_key,location_key,country_key,configured,
    active_account_key,passive_account_key,configured_rate
  from public.invoice i join public.subsidiaries s using(subsidiary_id)
  where i.invoice_id=invoice_key;

  if target_invoice_id is null then
    if configured then
      perform public.validate_income_autorent_configuration(
        subsidiary_key,country_key,configured,active_account_key,
        passive_account_key,configured_rate
      );
      applied_rate:=configured_rate;
    else
      applied_rate:=0;
      active_account_key:=null;
      passive_account_key:=null;
    end if;
  elsif applied_rate>0 then
    -- An issued document keeps its original rate and accounts even if the
    -- subsidiary master is changed or disabled later.
    active_account_key:=coalesce(prior_active_account_key,active_account_key);
    passive_account_key:=coalesce(prior_passive_account_key,passive_account_key);
    if active_account_key is null or passive_account_key is null then
      raise exception 'No fue posible recuperar las cuentas historicas de autorretencion de la factura.';
    end if;
  else
    active_account_key:=null;
    passive_account_key:=null;
  end if;

  if applied_rate>0 then
    select round(coalesce(sum(l.amount),0),4)
      into taxable_base
    from public.sales_invoice_line l
    join public.chart_accounts a using(account_id)
    where l.invoice_id=invoice_key and a.category='Ingreso';
    autorent_amount:=round(taxable_base*applied_rate,4);
  end if;

  -- Credit notes reverse only the autorent of their source invoice. Debit
  -- notes have their own independently frozen autorent and do not expand it.
  select coalesce(sum(n.autorent_base_amount),0),coalesce(sum(n.autorent_total_amount),0)
    into credited_base,credited_autorent
  from public.credit_note n where n.invoice_id=invoice_key;
  if credited_base>taxable_base+0.0001 or credited_autorent>autorent_amount+0.0001 then
    raise exception 'La factura no puede quedar por debajo de la autorretencion ya reversada mediante notas de credito.';
  end if;

  update public.invoice set
    autorent_base_amount=taxable_base,
    autorent_percentage_applied=applied_rate,
    autorent_total_amount=autorent_amount
  where invoice_id=invoice_key;

  delete from public.journal_line
  where journal_id=journal_key
    and note in('Autorretencion de renta - anticipo','Autorretencion de renta - por pagar');

  if autorent_amount>0 then
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note
    )values
      (journal_key,active_account_key,autorent_amount,0,autorent_amount,0,location_key,
       'Autorretencion de renta - anticipo'),
      (journal_key,passive_account_key,0,autorent_amount,0,autorent_amount,location_key,
       'Autorretencion de renta - por pagar');
  end if;

  -- The tax counterpart is materialized by sync_journal_gl_impacts and is not
  -- a raw journal_line. Keep the header on the document total plus the balanced
  -- internal autorent movement instead of summing only raw lines.
  update public.journal set
    total_debit=(result->>'total')::numeric+autorent_amount,
    total_credit=(result->>'total')::numeric+autorent_amount
  where journal_id=journal_key;
  -- journal_transaction_sync mirrors the journal header into transaction.
  -- Restore the commercial document total because autorent is internal and
  -- must never inflate CxC or the transaction amount shown to the customer.
  update public."transaction" t set total_amount=(result->>'total')::numeric
  from public.journal j
  where j.journal_id=journal_key and t.transaction_id=j.transaction_id;
  perform public.sync_journal_gl_impacts(journal_key);

  return result||jsonb_build_object(
    'autorentBase',taxable_base,
    'autorentPercentageApplied',applied_rate,
    'autorentTotal',autorent_amount
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.save_sales_invoice_before_service_country_integrity(payload jsonb, target_invoice_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  effective_payload jsonb:=payload;
  effective_lines jsonb;
  invoice_key bigint;
  journal_key bigint;
begin
  -- Preserve saved months when an older client edits without sending the key.
  if target_invoice_id is not null then
    with supplied as (
      select value item,ordinality
      from jsonb_array_elements(coalesce(payload->'lines','[]'::jsonb)) with ordinality
    ), stored as (
      select service_month,row_number() over(order by line_id) ordinality
      from public.sales_invoice_line where invoice_id=target_invoice_id
    )
    select coalesce(jsonb_agg(
      case when supplied.item ? 'service_month' then supplied.item
           else supplied.item||jsonb_build_object('service_month',stored.service_month)
      end order by supplied.ordinality
    ),'[]'::jsonb)
    into effective_lines
    from supplied left join stored using(ordinality);
    effective_payload:=jsonb_set(payload,'{lines}',effective_lines,true);
  end if;

  if exists(
    select 1 from jsonb_array_elements(coalesce(effective_payload->'lines','[]'::jsonb)) item
    where nullif(btrim(item->>'service_month'),'') is not null
      and item->>'service_month' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  )then
    raise exception 'Mes de servicio inválido. Utilice el formato AAAA-MM.';
  end if;

  result:=public.save_sales_invoice_before_service_month_fix(
    effective_payload,target_invoice_id
  );
  invoice_key:=(result->>'invoiceId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  with supplied as (
    select ordinality,nullif(btrim(value->>'service_month'),'') service_month
    from jsonb_array_elements(effective_payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from public.sales_invoice_line where invoice_id=invoice_key
  )
  update public.sales_invoice_line line
  set service_month=supplied.service_month
  from supplied join stored using(ordinality)
  where line.line_id=stored.line_id;

  with commercial as (
    select line.service_month,line.service_country_id,
      row_number() over(order by line.line_id) ordinality
    from public.sales_invoice_line line where line.invoice_id=invoice_key
  ), accounting as (
    select line.journal_line_id,
      row_number() over(order by line.journal_line_id) ordinality
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=journal_key and account.category='Ingreso'
  ), mapped as (
    select accounting.journal_line_id,commercial.service_month,commercial.service_country_id
    from commercial join accounting using(ordinality)
  )
  update public.journal_line target
  set service_month=mapped.service_month,
      service_country_id=mapped.service_country_id
  from mapped where target.journal_line_id=mapped.journal_line_id;

  return result;
end
$function$;

CREATE OR REPLACE FUNCTION public.save_sales_invoice_before_pdf_line_unification(payload jsonb, target_invoice_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  effective_payload jsonb:=payload;
  effective_lines jsonb;
  subsidiary_country_key bigint;
  invoice_key bigint;
  journal_key bigint;
begin
  select country_id into subsidiary_country_key
  from public.subsidiaries where subsidiary_id=public.active_subsidiary_id();

  with supplied as (
    select value item,ordinality
    from jsonb_array_elements(coalesce(payload->'lines','[]'::jsonb)) with ordinality
  ), stored as (
    select service_country_id,row_number() over(order by line_id) ordinality
    from public.sales_invoice_line
    where target_invoice_id is not null and invoice_id=target_invoice_id
  )
  select coalesce(jsonb_agg(
    supplied.item||jsonb_build_object(
      'service_country_id',coalesce(
        case when coalesce(supplied.item->>'service_country_id','') ~ '^[0-9]+$'
          then (supplied.item->>'service_country_id')::bigint end,
        stored.service_country_id,subsidiary_country_key
      )
    ) order by supplied.ordinality
  ),'[]'::jsonb)
  into effective_lines
  from supplied left join stored using(ordinality);
  effective_payload:=jsonb_set(payload,'{lines}',effective_lines,true);

  if exists(
    select 1 from jsonb_array_elements(effective_payload->'lines') item
    where nullif(item->>'service_country_id','') is null
      or coalesce(item->>'service_country_id','') !~ '^[0-9]+$'
      or not exists(
        select 1 from public.countries country
        where country.country_id=(item->>'service_country_id')::bigint
      )
  )then
    raise exception 'Seleccione un País de servicio válido en cada línea de la factura.';
  end if;

  result:=public.save_sales_invoice_before_service_country_integrity(
    effective_payload,target_invoice_id
  );
  invoice_key:=(result->>'invoiceId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  with supplied as (
    select ordinality,(value->>'service_country_id')::bigint service_country_id
    from jsonb_array_elements(effective_payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from public.sales_invoice_line where invoice_id=invoice_key
  )
  update public.sales_invoice_line line
  set service_country_id=supplied.service_country_id
  from supplied join stored using(ordinality)
  where line.line_id=stored.line_id;

  with commercial as (
    select line.service_country_id,
      row_number() over(order by line.line_id) ordinality
    from public.sales_invoice_line line where line.invoice_id=invoice_key
  ), accounting as (
    select line.journal_line_id,
      row_number() over(order by line.journal_line_id) ordinality
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=journal_key and account.category='Ingreso'
  ), mapped as (
    select accounting.journal_line_id,commercial.service_country_id
    from commercial join accounting using(ordinality)
  )
  update public.journal_line target
  set service_country_id=mapped.service_country_id
  from mapped where target.journal_line_id=mapped.journal_line_id;

  return result;
end
$function$;

CREATE OR REPLACE FUNCTION public.ensure_sales_invoice_number_sequence(p_subsidiary_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  transaction_type_key bigint;
  canonical_max bigint:=0;
begin
  if p_subsidiary_id is null
    or not exists(
      select 1
      from public.subsidiaries subsidiary
      where subsidiary.subsidiary_id=p_subsidiary_id
    ) then
    raise exception 'La subsidiaria indicada no existe.';
  end if;

  select transaction_type.transaction_type_id
    into transaction_type_key
  from public.transaction_types transaction_type
  where transaction_type.abbreviation='FAC_VEN'
  order by transaction_type.transaction_type_id
  limit 1;

  if transaction_type_key is null then
    raise exception 'No existe el tipo de transacción FAC_VEN.';
  end if;

  -- Use the same lock as next_transaction_number.  This makes discovery of
  -- the historical maximum and the subsequent increment one atomic sequence
  -- with respect to every normal invoice creation.
  perform pg_advisory_xact_lock(
    hashtextextended('transaction-number:'||transaction_type_key::text,0)
  );

  select coalesce(max(canonical.number_value),0)
    into canonical_max
  from (
    select substring(invoice.invoice_number from '^FAC-([0-9]+)$')::bigint
      as number_value
    from public.invoice invoice
    where invoice.subsidiary_id=p_subsidiary_id
      and invoice.invoice_number~'^FAC-[0-9]+$'

    union all

    select substring(transaction_row.tran_number from '^FAC-([0-9]+)$')::bigint
    from public."transaction" transaction_row
    where transaction_row.subsidiary_id=p_subsidiary_id
      and transaction_row.tran_number~'^FAC-[0-9]+$'

    union all

    select substring(journal.journal_number from '^FAC-([0-9]+)$')::bigint
    from public.journal journal
    where journal.subsidiary_id=p_subsidiary_id
      and journal.journal_number~'^FAC-[0-9]+$'
  )canonical;

  insert into public.number_sequences(
    scope_type,transaction_type_id,subsidiary_id,prefix,suffix,
    current_number,padding_length
  )values(
    'Transacción',transaction_type_key,p_subsidiary_id,'FAC-',null,
    canonical_max,8
  )
  on conflict(transaction_type_id,subsidiary_id)
    where scope_type='Transacción'
  do update set
    current_number=greatest(
      public.number_sequences.current_number,
      case
        -- Existing configured series are preserved.  Only a FAC- series is
        -- synchronized against the imported canonical FAC- history.
        when public.number_sequences.prefix='FAC-'
          and public.number_sequences.suffix is null
          then excluded.current_number
        else public.number_sequences.current_number
      end
    );
end
$function$;

CREATE OR REPLACE FUNCTION public.save_sales_invoice_before_number_integrity(payload jsonb, target_invoice_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  invoice_key bigint;
  journal_key bigint;
  transaction_key bigint;
  customer_key bigint;
  subsidiary_key bigint;
  prior_customer_key bigint;
  requested_customer_key bigint:=nullif(payload->>'customer_id','')::bigint;
  prior_account_key bigint;
  account_key bigint;
  affected integer;
begin
  if target_invoice_id is not null then
    select invoice.customer_id,invoice.receivable_account_id
      into prior_customer_key,prior_account_key
    from public.invoice invoice
    where invoice.invoice_id=target_invoice_id
      and invoice.subsidiary_id=public.active_subsidiary_id();

    if prior_customer_key is distinct from requested_customer_key
      and(
        exists(
          select 1 from public.customer_payment_application application
          where application.invoice_id=target_invoice_id
        )
        or exists(
          select 1 from public.credit_note note
          where note.invoice_id=target_invoice_id
        )
        or exists(
          select 1 from public.debit_note note
          where note.invoice_id=target_invoice_id
        )
      )
    then
      raise exception 'No se puede cambiar el cliente porque la factura tiene cobros o notas aplicadas.';
    end if;
  end if;

  result:=public.save_sales_invoice_before_intercompany_receivable(
    payload,target_invoice_id
  );
  invoice_key:=nullif(result->>'invoiceId','')::bigint;

  select invoice.journal_id,invoice.transaction_id,invoice.customer_id,
    invoice.subsidiary_id
    into journal_key,transaction_key,customer_key,subsidiary_key
  from public.invoice invoice
  where invoice.invoice_id=invoice_key
    and invoice.subsidiary_id=public.active_subsidiary_id();

  if not found then
    raise exception 'La factura guardada no pertenece a la subsidiaria activa.';
  end if;

  if prior_account_key is not null and prior_customer_key=customer_key then
    account_key:=prior_account_key;
  else
    account_key:=public.resolve_customer_receivable_account(
      subsidiary_key,customer_key
    );
  end if;

  update public.invoice
  set receivable_account_id=account_key
  where invoice_id=invoice_key;

  -- The legacy editor did not mirror a changed customer to the transaction
  -- header.  Keep the document, journal dimensions and account snapshot aligned.
  update public."transaction"
  set customer_id=customer_key
  where transaction_id=transaction_key;

  update public.journal_line line
  set account_id=account_key
  where line.journal_id=journal_key
    and line.customer_id=customer_key
    and line.entity_type='Cliente'
    and lower(coalesce(line.note,'')) like 'cuenta por cobrar%';
  get diagnostics affected=row_count;

  if affected<>1 then
    raise exception 'No fue posible identificar una única línea de cuenta por cobrar en la factura.';
  end if;

  perform public.sync_journal_gl_impacts(journal_key);

  return result||jsonb_build_object('receivableAccountId',account_key);
end
$function$;

CREATE OR REPLACE FUNCTION public.save_sales_invoice_before_fx_guard(payload jsonb, target_invoice_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid bigint:=public.active_subsidiary_id();
  effective_payload jsonb:=coalesce(payload,'{}'::jsonb);
  result jsonb;
  invoice_key bigint;
  invoice_number_value text;
  transaction_number_value text;
  journal_number_value text;
  transaction_key bigint;
  journal_key bigint;
  automatic_number boolean;
  generated_number text;
begin
  -- Editing preserves every historical/external document number and must not
  -- consume a new sequence value.
  if target_invoice_id is not null then
    return public.save_sales_invoice_before_number_integrity(
      effective_payload,target_invoice_id
    );
  end if;

  if sid is null then
    raise exception 'Debe seleccionar una subsidiaria antes de crear la factura.';
  end if;

  perform public.ensure_sales_invoice_number_sequence(sid);
  automatic_number:=coalesce(btrim(effective_payload->>'invoice_number'),'')=''
    or upper(btrim(effective_payload->>'invoice_number'))='AUTO';
  if automatic_number then
    effective_payload:=effective_payload
      ||jsonb_build_object('invoice_number','AUTO');
  end if;

  result:=public.save_sales_invoice_before_number_integrity(
    effective_payload,null
  );
  invoice_key:=nullif(result->>'invoiceId','')::bigint;
  generated_number:=coalesce(result->>'transactionNumber','');

  if invoice_key is null then
    raise exception 'La factura guardada no devolvió un identificador válido.';
  end if;

  select invoice.invoice_number,invoice.transaction_id,invoice.journal_id,
         transaction_row.tran_number,journal.journal_number
    into invoice_number_value,transaction_key,journal_key,
         transaction_number_value,journal_number_value
  from public.invoice invoice
  join public."transaction" transaction_row
    on transaction_row.transaction_id=invoice.transaction_id
  join public.journal journal
    on journal.journal_id=invoice.journal_id
  where invoice.invoice_id=invoice_key
    and invoice.subsidiary_id=sid;

  if not found then
    raise exception
      'La factura creada no conserva sus vínculos contables de numeración.';
  end if;

  if generated_number~'^FAC_VEN-[0-9]{17}$'
    or transaction_number_value~'^FAC_VEN-[0-9]{17}$'
    or journal_number_value~'^FAC_VEN-[0-9]{17}$'
    or (automatic_number and invoice_number_value~'^FAC_VEN-[0-9]{17}$') then
    raise exception
      'No fue posible obtener la secuencia configurada. La creación de la factura fue revertida.';
  end if;

  if generated_number=''
    or transaction_number_value<>generated_number
    or journal_number_value<>generated_number then
    raise exception
      'La numeración de la transacción y el asiento no coincide; la creación fue revertida.';
  end if;

  if automatic_number
    and invoice_number_value<>generated_number then
    raise exception
      'La numeración automática de la factura, la transacción y el asiento no coincide; la creación fue revertida.';
  end if;

  -- The original routine builds this note from the input token AUTO.  Replace
  -- it only after the three stored document numbers have passed validation.
  update public.journal_line
  set note='Cuenta por cobrar · '||invoice_number_value
  where journal_id=journal_key
    and note='Cuenta por cobrar · AUTO';

  return result;
end
$function$;

CREATE OR REPLACE FUNCTION public.sales_invoice_official_exchange_rate(p_currency_id bigint, p_invoice_date date, p_subsidiary_id bigint)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.save_sales_invoice(payload jsonb, target_invoice_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.save_sales_invoice_before_pdf_description(payload jsonb, target_invoice_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  invoice_key bigint;
  unify_lines boolean;
begin
  if payload ? 'unificar_lineas_pdf' then
    if jsonb_typeof(payload->'unificar_lineas_pdf') <> 'boolean' then
      raise exception 'La opción de unificar líneas del PDF debe ser verdadera o falsa.';
    end if;
    unify_lines := (payload->>'unificar_lineas_pdf')::boolean;
  elsif target_invoice_id is null then
    unify_lines := false;
  else
    -- Older clients do not send the new key. Preserve the stored preference
    -- when they edit an existing invoice instead of silently resetting it.
    select invoice.unificar_lineas_pdf
      into unify_lines
    from public.invoice invoice
    where invoice.invoice_id=target_invoice_id
      and invoice.subsidiary_id=public.active_subsidiary_id();
  end if;

  result := public.save_sales_invoice_before_pdf_line_unification(
    payload,target_invoice_id
  );
  invoice_key := nullif(result->>'invoiceId','')::bigint;

  if invoice_key is null then
    raise exception 'La factura guardada no devolvió un identificador válido.';
  end if;

  update public.invoice invoice
  set unificar_lineas_pdf=coalesce(unify_lines,false)
  where invoice.invoice_id=invoice_key
    and invoice.subsidiary_id=public.active_subsidiary_id();

  if not found then
    raise exception 'La factura guardada no pertenece a la subsidiaria activa.';
  end if;

  return result||jsonb_build_object(
    'unifyLinesPdf',coalesce(unify_lines,false)
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.set_sales_invoice_pdf_line_unification(p_invoice_id bigint, p_unify boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid bigint:=public.active_subsidiary_id();
  invoice_number_value text;
begin
  if public.app_user_id() is null or sid is null or public.app_active_role_id() is null then
    raise exception using errcode='42501',
      message='Debe iniciar sesión, seleccionar una subsidiaria y un rol activo.';
  end if;
  if p_invoice_id is null or p_invoice_id<=0 then
    raise exception 'La factura de venta no es válida.';
  end if;
  if p_unify is null then
    raise exception 'Indique si las líneas deben unificarse en el PDF.';
  end if;
  if not exists(
    select 1
    from public.role_permissions role_permission
    join public.permissions permission using(permission_id)
    where role_permission.role_id=public.app_active_role_id()
      and permission.code='sales:invoice:update'
  ) then
    raise exception using errcode='42501',
      message='No tiene permiso para modificar la presentación PDF de la factura.';
  end if;

  update public.invoice invoice
  set unificar_lineas_pdf=p_unify
  where invoice.invoice_id=p_invoice_id
    and invoice.subsidiary_id=sid
  returning invoice.invoice_number into invoice_number_value;

  if not found then
    raise exception 'La factura no existe en la subsidiaria activa.';
  end if;

  return jsonb_build_object(
    'invoiceId',p_invoice_id,
    'invoiceNumber',invoice_number_value,
    'unifyLinesPdf',p_unify
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.assign_sales_invoice_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$begin if new.invoice_number='AUTO' then select tran_number into new.invoice_number from "transaction" where transaction_id=new.transaction_id;end if;return new;end$function$;

CREATE OR REPLACE FUNCTION public.resolve_customer_receivable_account(p_subsidiary_id bigint, p_customer_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  intercompany boolean;
  required_number text;
  account_key bigint;
begin
  if p_subsidiary_id is null then
    raise exception 'No se pudo determinar la subsidiaria para asignar la cuenta por cobrar.';
  end if;

  select coalesce(customer.is_intercompany,false)
    into intercompany
  from public.customers customer
  where customer.customer_id=p_customer_id;

  if not found then
    raise exception 'No se encontró el cliente para asignar la cuenta por cobrar.';
  end if;

  required_number:=case when intercompany then '113002' else '113001' end;

  select account.account_id
    into account_key
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account.account_number=required_number
    and assignment.subsidiary_id=p_subsidiary_id
    and assignment.is_active
    and account.accepts_entries
    and not account.is_inactive
    and account.category='Activo'
    and account.nature='Deudora'
    and account.financial_statement='Balance General'
  order by account.account_id
  limit 1;

  if account_key is null then
    raise exception 'La cuenta % no está activa y vinculada a la subsidiaria.',required_number;
  end if;

  return account_key;
end
$function$;

CREATE OR REPLACE FUNCTION public.validate_income_autorent_configuration(p_subsidiary_id bigint, p_country_id bigint, p_applies boolean, p_active_account_id bigint, p_passive_account_id bigint, p_percentage numeric)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not coalesce(p_applies,false) then return;end if;

  if not exists(
    select 1 from public.countries c
    where c.country_id=p_country_id
      and(
        upper(coalesce(c.country_code_iso2,''))='CO'
        or upper(coalesce(c.country_code_iso3,''))='COL'
        or lower(btrim(c.name))='colombia'
      )
  )then
    raise exception 'La autorretencion de renta solo puede activarse para subsidiarias de Colombia.';
  end if;
  if p_percentage is null or p_percentage<=0 or p_percentage>1 then
    raise exception 'La tarifa de autorretencion debe ser un factor mayor que cero y menor o igual a uno (0.0110 equivale a 1.10%%).';
  end if;
  if p_active_account_id is null or p_passive_account_id is null then
    raise exception 'Configure las cuentas de activo y pasivo para la autorretencion de renta.';
  end if;
  if p_active_account_id=p_passive_account_id then
    raise exception 'Las cuentas de activo y pasivo de autorretencion deben ser diferentes.';
  end if;
  if not exists(
    select 1
    from public.chart_accounts a
    join public.account_subsidiaries sa using(account_id)
    where a.account_id=p_active_account_id and sa.subsidiary_id=p_subsidiary_id
      and sa.is_active and a.accepts_entries and not a.is_inactive
      and a.category='Activo' and a.financial_statement='Balance General'
  )then
    raise exception 'La cuenta de anticipo de autorretencion debe ser una cuenta activa de Activo, de Balance General, que acepte movimientos en la subsidiaria.';
  end if;
  if not exists(
    select 1
    from public.chart_accounts a
    join public.account_subsidiaries sa using(account_id)
    where a.account_id=p_passive_account_id and sa.subsidiary_id=p_subsidiary_id
      and sa.is_active and a.accepts_entries and not a.is_inactive
      and a.category='Pasivo' and a.financial_statement='Balance General'
  )then
    raise exception 'La cuenta por pagar de autorretencion debe ser una cuenta activa de Pasivo, de Balance General, que acepte movimientos en la subsidiaria.';
  end if;
end
$function$;
