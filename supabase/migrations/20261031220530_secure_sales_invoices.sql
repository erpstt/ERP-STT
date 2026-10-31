-- C-04: sales invoice entry and accounting, without historical backfill.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema sales_invoice_private;
revoke all on schema sales_invoice_private from public,anon,authenticated,service_role;
grant usage on schema sales_invoice_private to authenticated;
create function sales_invoice_private.access(a text) returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=asset_posting_private.access('sales:invoices',a);begin
 if a in('create','edit') and not exists(select 1 from public.role_permissions rp join public.permissions p using(permission_id) where rp.role_id=public.app_active_role_id() and p.code=case a when 'create' then 'sales:invoice:create' else 'sales:invoice:update' end) then raise exception using errcode='42501',message='El rol activo no tiene permiso técnico de facturación.';end if;return sid;end$$;
create function sales_invoice_private.allowed(a text) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform sales_invoice_private.access(a);return true;exception when insufficient_privilege then return false;end$$;
create function sales_invoice_private.visible(id bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin return sales_invoice_private.allowed('view') and exists(select 1 from public.invoice i where i.invoice_id=id and i.subsidiary_id=asset_posting_private.identity());exception when insufficient_privilege then return false;end$$;
create function sales_invoice_private.period(id bigint,d date) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform 1 from public.fiscal_periods where fiscal_period_id=id and subsidiary_id=asset_posting_private.identity() and d between start_date and end_date and not is_closed and not coalesce(gl_closed,false) and not coalesce(ar_closed,false) and not coalesce(is_inactive,false) for share;
 if not found then raise exception using errcode='55000',message='La factura requiere un período de Ventas y GL abierto.';end if;end$$;
create function sales_invoice_private.editable(id bigint) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare i public.invoice;sid bigint:=asset_posting_private.identity();begin
 select * into i from public.invoice where invoice_id=id and subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Factura fuera de la subsidiaria activa.';end if;
 perform 1 from public."transaction" where transaction_id=i.transaction_id for update;perform 1 from public.journal where journal_id=i.journal_id for update;perform 1 from public.invoice where invoice_id=id for update;
 select * into i from public.invoice where invoice_id=id and subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Factura no disponible.';end if;
 if i.is_opening_balance or i.opening_run_id is not null or i.opening_balance_line_id is not null or i.sales_delivery_document_id is not null or i.so_id is not null
 or exists(select 1 from public.customer_payment_application where invoice_id=id)
 or exists(select 1 from public.credit_note where invoice_id=id) or exists(select 1 from public.debit_note where invoice_id=id)
 then raise exception using errcode='55000',message='La factura tiene apertura, cobros, notas u origen operativo; conserva su historial.';end if;
 if not exists(select 1 from public.journal j join public."transaction" t on t.transaction_id=i.transaction_id join public.transaction_types tt on tt.transaction_type_id=t.transaction_type_id where j.journal_id=i.journal_id and j.transaction_id=t.transaction_id and j.subsidiary_id=sid and t.subsidiary_id=sid and tt.abbreviation='FAC_VEN' and j.journal_type='Factura de Venta' and j.status='CONTABILIZADO' and j.currency_id=i.currency_id and t.currency_id=i.currency_id and j.fiscal_period_id=i.fiscal_period_id and t.fiscal_period_id=i.fiscal_period_id and j.journal_date=i.invoice_date and t.tran_date=i.invoice_date and j.exchange_rate=i.exchange_rate and t.exchange_rate=i.exchange_rate)
 or exists(select 1 from public.journal where reversed_from_journal_id=i.journal_id) then raise exception using errcode='55000',message='El origen contable requiere revisión.';end if;
 perform sales_invoice_private.period(i.fiscal_period_id,i.invoice_date);
end$$;
-- Move every historical entry point and rebind calls inside preserved engines.
do $$declare f record;body text;n text;names text[];begin
 select array_agg(proname) into names from pg_proc where pronamespace='public'::regnamespace and (proname like 'save_sales_invoice%' or proname in('ensure_sales_invoice_number_sequence','sales_invoice_official_exchange_rate','sales_invoice_delivery_snapshot','set_sales_invoice_pdf_presentation','set_sales_invoice_pdf_line_unification'));
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname=any(names) loop execute format('alter function %s set schema sales_invoice_private',f.signature);end loop;
 for f in select oid::regprocedure signature from pg_proc where pronamespace='sales_invoice_private'::regnamespace and proname=any(names) loop
 execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f.signature);body:=pg_get_functiondef(f.signature);
 foreach n in array names loop body:=replace(body,'public.'||n||'(','sales_invoice_private.'||n||'(');body:=regexp_replace(body,'(?<![a-zA-Z0-9_.])'||n||'\(','sales_invoice_private.'||n||'(','g');end loop;execute body;
 end loop;
end$$;
-- Payment engines keep their behavior, but their invoice/FX repair helpers are not RPCs.
do $$declare f record;body text;n text;names text[]:=array['rebuild_customer_payment_receivable_fx','apply_customer_payment_receivable_accounts'];begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname=any(names) loop execute format('alter function %s set schema sales_invoice_private',f.signature);end loop;
 for f in select p.oid::regprocedure signature from pg_proc p where p.prokind='f' and p.pronamespace in('public'::regnamespace,'sales_invoice_private'::regnamespace) and (position('rebuild_customer_payment_receivable_fx' in pg_get_functiondef(p.oid))>0 or position('apply_customer_payment_receivable_accounts' in pg_get_functiondef(p.oid))>0) loop
 execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f.signature);body:=pg_get_functiondef(f.signature);foreach n in array names loop body:=replace(body,'public.'||n||'(','sales_invoice_private.'||n||'(');body:=regexp_replace(body,'(?<![a-zA-Z0-9_.])'||n||'\(','sales_invoice_private.'||n||'(','g');end loop;execute body;
 end loop;
end$$;
create function sales_invoice_private.prepare(p jsonb,id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=sales_invoice_private.access(case when id is null then 'create' else 'edit' end);ln jsonb;lines jsonb:='[]';prod public.products;k text;qty numeric;price numeric;rate numeric;tax_account bigint;rule record;begin
 if jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') not between 1 and 500 then raise exception using errcode='22023',message='La factura requiere entre 1 y 500 líneas.';end if;
 if p?'subsidiary_id' and(p->>'subsidiary_id')::bigint is distinct from sid or p ?| array['is_opening_balance','opening_run_id','opening_balance_line_id','journal_id','transaction_id','receivable_account_id','sales_delivery_document_id','so_id','location_id'] then raise exception using errcode='42501',message='No puede sustituir la subsidiaria ni el origen contable.';end if;
 if id is not null then perform sales_invoice_private.editable(id);end if;
 perform sales_invoice_private.period((p->>'fiscal_period_id')::bigint,(p->>'invoice_date')::date);
 if not exists(select 1 from public.customers c join public.entity_subsidiaries es using(customer_id) where c.customer_id=(p->>'customer_id')::bigint and es.subsidiary_id=sid and not coalesce((to_jsonb(c)->>'is_inactive')::boolean,false)) then raise exception using errcode='42501',message='Cliente fuera del alcance activo.';end if;
 if not exists(select 1 from public.subsidiary_currencies where subsidiary_id=sid and currency_id=(p->>'currency_id')::bigint) then raise exception using errcode='42501',message='Moneda no habilitada.';end if;
 if not exists(select 1 from public.payment_terms where term_id=(p->>'payment_term_id')::bigint) then raise exception using errcode='22023',message='Términos de pago inválidos.';end if;
 perform asset_posting_private.account(public.resolve_customer_receivable_account(sid,(p->>'customer_id')::bigint));
 for ln in select value from jsonb_array_elements(p->'lines') loop
 if jsonb_typeof(ln) is distinct from 'object' then raise exception using errcode='22023',message='Línea inválida.';end if;
 foreach k in array array['quantity','unit_price','amount','tax_rate','tax_amount','gross_amount'] loop if ln?k and not asset_posting_private.finite((ln->>k)::numeric) then raise exception using errcode='22023',message='Los importes deben ser finitos.';end if;end loop;
 qty:=(ln->>'quantity')::numeric;price:=(ln->>'unit_price')::numeric;if not asset_posting_private.finite(qty) or not asset_posting_private.finite(price) or qty<=0 or price<0 then raise exception using errcode='22023',message='Cantidad positiva y precio no negativo requeridos.';end if;
 select * into prod from public.products where product_id=(ln->>'product_id')::bigint and is_active and product_usage in('Venta','Ambas') and exists(select 1 from public.product_subsidiaries ps where ps.product_id=products.product_id and ps.subsidiary_id=sid and ps.is_active);
 if not found then raise exception using errcode='42501',message='Producto no habilitado para ventas.';end if;
 perform asset_posting_private.account(prod.sales_account_id);if not exists(select 1 from public.chart_accounts where account_id=prod.sales_account_id and category='Ingreso') then raise exception using errcode='22023',message='El producto requiere cuenta de Ingreso.';end if;
 if ln?'account_id' and(ln->>'account_id')::bigint is distinct from prod.sales_account_id then raise exception using errcode='42501',message='No puede sustituir la cuenta del producto.';end if;
 perform asset_posting_private.dimensions(nullif(ln->>'department_id','')::bigint,nullif(ln->>'cost_center_id','')::bigint,nullif(ln->>'class_id','')::bigint);
 if nullif(ln->>'related_company_id','') is not null and not exists(select 1 from public.related_companies r join public.related_company_subsidiaries s using(related_company_id) where r.related_company_id=(ln->>'related_company_id')::bigint and s.subsidiary_id=sid and not r.is_inactive) then raise exception using errcode='42501',message='Compañía relacionada fuera del alcance.';end if;
 if not exists(select 1 from public.countries where country_id=nullif(ln->>'service_country_id','')::bigint) then raise exception using errcode='22023',message='País de servicio requerido.';end if;
 rate:=0;tax_account:=null;
 if nullif(ln->>'tax_code_id','') is not null then select tc.rate_percentage,tt.liability_account_id into rate,tax_account from public.tax_codes tc join public.tax_types tt using(tax_type_id) where tc.tax_code_id=(ln->>'tax_code_id')::bigint and not tc.is_withholding and tt.applies_to in('Ventas','Ambos') and exists(select 1 from public.tax_code_subsidiaries s where s.tax_code_id=tc.tax_code_id and s.subsidiary_id=sid);if not found then raise exception using errcode='42501',message='Impuesto de venta no autorizado.';end if;end if;
 if not asset_posting_private.finite(rate) or rate not between 0 and 100 or ln?'tax_rate' and(ln->>'tax_rate')::numeric is distinct from rate then raise exception using errcode='22023',message='La tasa debe coincidir con el impuesto configurado.';end if;
 if rate>0 then perform asset_posting_private.account(tax_account);end if;
 lines:=lines||jsonb_build_array(ln||jsonb_build_object('tax_rate',rate,'amount',round(qty*price,6),'tax_amount',round(round(qty*price,6)*rate/100,6),'gross_amount',round(qty*price,6)+round(round(qty*price,6)*rate/100,6)));
 end loop;
 if (select sum((x->>'gross_amount')::numeric) from jsonb_array_elements(lines)x)<=0 then raise exception using errcode='22023',message='La factura requiere total positivo.';end if;
 for rule in select tc.*,tt.asset_account_id,tt.applies_to from public.entity_withholding_rules er join public.tax_codes tc using(tax_code_id) join public.tax_types tt using(tax_type_id) where er.customer_id=(p->>'customer_id')::bigint and er.subsidiary_id=sid loop
 if not rule.is_withholding or rule.applies_to not in('Ventas','Ambos') or not exists(select 1 from public.tax_code_subsidiaries s where s.tax_code_id=rule.tax_code_id and s.subsidiary_id=sid) or not asset_posting_private.finite(rule.rate_percentage) or rule.rate_percentage not between 0 and 100 or rule.withholding_calculation_base is null or rule.withholding_application_moment is null or rule.withholding_calculation_base not in('Subtotal antes de impuestos','Importe de impuestos','Total de la factura con impuestos') or rule.withholding_application_moment not in('Al registrar la factura','Al aplicar el pago') then raise exception using errcode='22023',message='Revise la configuración de retenciones.';end if;perform asset_posting_private.account(rule.asset_account_id);
 if not exists(select 1 from public.chart_accounts where account_id=rule.asset_account_id and category='Activo') then raise exception using errcode='22023',message='Retención sin cuenta de Activo.';end if;
 end loop;
 return p||jsonb_build_object('lines',lines);
end$$;
create function sales_invoice_private.supports(jid bigint,items jsonb) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare x jsonb;id bigint;keep bigint[]:='{}';bytes bytea;mime text;begin
 if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items)>20 or pg_column_size(items)>15000000 then raise exception using errcode='22023',message='Respaldos inválidos o demasiado grandes.';end if;
 for x in select value from jsonb_array_elements(items) loop
 if jsonb_typeof(x) is distinct from 'object' then raise exception using errcode='22023',message='Respaldo inválido.';end if;id:=nullif(x->>'support_id','')::bigint;
 if id is not null then
 if id=any(keep) or not exists(select 1 from public.journal_support s where s.support_id=id and s.journal_id=jid) then raise exception using errcode='42501',message='Respaldo ajeno o duplicado.';end if;keep:=array_append(keep,id);
 -- Existing bytes and metadata are retained; replacement is an explicit new item.
 continue;end if;
 if x->>'support_type'='Enlace' then
 if coalesce(x->>'support_url','')!~'^https://[^[:space:]]+$' then raise exception using errcode='22023',message='El respaldo requiere un enlace HTTPS.';end if;
 elsif x->>'support_type'='Archivo' then
 mime:=x->>'mime_type';if mime is null or mime!~'^(application/(pdf|octet-stream|zip|vnd[.][a-zA-Z0-9.+-]+)|image/(png|jpeg|webp)|text/plain)$' or left(coalesce(x->>'file_data',''),length('data:'||mime||';base64,'))<>'data:'||mime||';base64,' or length(x->>'file_data')>7000000 then raise exception using errcode='22023',message='Tipo o contenido del respaldo no permitido.';end if;
 begin bytes:=decode(substr(x->>'file_data',length('data:'||mime||';base64,')+1),'base64');exception when others then raise exception using errcode='22023',message='Archivo codificado inválido.';end;
 if octet_length(bytes)>5242880 or octet_length(bytes)=0 or octet_length(bytes) is distinct from (x->>'file_size')::bigint then raise exception using errcode='22023',message='Tamaño de archivo inválido.';end if;
 else raise exception using errcode='22023',message='Tipo de respaldo inválido.';end if;
 insert into public.journal_support(journal_id,support_type,display_name,support_url,file_name,mime_type,file_size,file_data) values(jid,x->>'support_type',left(coalesce(x->>'display_name',x->>'file_name','Respaldo'),250),case when x->>'support_type'='Enlace' then x->>'support_url' end,case when x->>'support_type'='Archivo' then x->>'file_name' end,case when x->>'support_type'='Archivo' then mime end,case when x->>'support_type'='Archivo' then octet_length(bytes) end,case when x->>'support_type'='Archivo' then x->>'file_data' end) returning support_id into id;keep:=array_append(keep,id);
 end loop;
 delete from public.journal_support where journal_id=jid and not(support_id=any(keep));
end$$;
create function public.save_sales_invoice(payload jsonb,target_invoice_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare p jsonb;result jsonb;i public.invoice;sid bigint;debit numeric;credit numeric;begin
 p:=sales_invoice_private.prepare(payload,target_invoice_id);sid:=asset_posting_private.identity();
 result:=sales_invoice_private.save_sales_invoice(p-'supports',target_invoice_id);
 select * into i from public.invoice where invoice_id=(result->>'invoiceId')::bigint and subsidiary_id=sid;
 if not found or i.journal_id is null or i.transaction_id is null then raise exception using errcode='55000',message='La factura no conserva su origen contable.';end if;
 select sum(debit_amount),sum(credit_amount) into debit,credit from public.gl_impact where transaction_id=i.transaction_id;
 if not asset_posting_private.finite(debit) or not asset_posting_private.finite(credit) or debit<=0 or abs(debit-credit)>0.000001 then raise exception using errcode='55000',message='La factura no produjo un mayor balanceado.';end if;
 if payload?'supports' then perform sales_invoice_private.supports(i.journal_id,payload->'supports');end if;
 return result;
end$$;
create function public.sales_invoice_access() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform asset_posting_private.identity();if not(sales_invoice_private.allowed('view') or sales_invoice_private.allowed('create') or sales_invoice_private.allowed('edit')) then raise exception using errcode='42501',message='Sin acceso a facturas de clientes.';end if;
 return jsonb_build_object('canView',sales_invoice_private.allowed('view'),'canCreate',sales_invoice_private.allowed('create'),'canEdit',sales_invoice_private.allowed('edit'));
end$$;
create function public.sales_invoice_delivery_snapshot(p_invoice_id bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if sales_invoice_private.visible(p_invoice_id) is not true then raise exception using errcode='42501',message='Factura no disponible.';end if;return sales_invoice_private.sales_invoice_delivery_snapshot(p_invoice_id);
end$$;
create function public.set_sales_invoice_pdf_presentation(p_invoice_id bigint,p_unify boolean,p_description text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform sales_invoice_private.access('edit');if not exists(select 1 from public.invoice where invoice_id=p_invoice_id and subsidiary_id=asset_posting_private.identity()) then raise exception using errcode='42501',message='Factura no disponible.';end if;
 return sales_invoice_private.set_sales_invoice_pdf_presentation(p_invoice_id,p_unify,p_description);
end$$;
create function public.set_sales_invoice_pdf_line_unification(p_invoice_id bigint,p_unify boolean) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform sales_invoice_private.access('edit');if not exists(select 1 from public.invoice where invoice_id=p_invoice_id and subsidiary_id=asset_posting_private.identity()) then raise exception using errcode='42501',message='Factura no disponible.';end if;return sales_invoice_private.set_sales_invoice_pdf_line_unification(p_invoice_id,p_unify);
end$$;
create function public.sales_invoice_official_exchange_rate(p_currency_id bigint,p_invoice_date date,p_subsidiary_id bigint) returns numeric language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform public.sales_invoice_access();if p_subsidiary_id is distinct from asset_posting_private.identity() then raise exception using errcode='42501',message='Subsidiaria ajena.';end if;return sales_invoice_private.sales_invoice_official_exchange_rate(p_currency_id,p_invoice_date,p_subsidiary_id);
end$$;
create function public.sales_invoice_context(p_invoice_id bigint default null,p_action text default 'create') returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint;jid bigint;tid bigint;customer bigint;isview boolean:=p_action='view';begin
 if p_action not in('view','create','edit') or p_action is null then raise exception using errcode='22023',message='Acción inválida.';end if;sid:=sales_invoice_private.access(p_action);
 if p_action='create' and p_invoice_id is not null or p_action in('view','edit') and p_invoice_id is null then raise exception using errcode='22023',message='Factura requerida para esta acción.';end if;
 if p_invoice_id is not null then select journal_id,transaction_id,customer_id into jid,tid,customer from public.invoice where invoice_id=p_invoice_id and subsidiary_id=sid;if not found then raise exception using errcode='42501',message='Factura no disponible.';end if;if p_action='edit' then perform sales_invoice_private.editable(p_invoice_id);end if;end if;
 return jsonb_build_object(
 'access',public.sales_invoice_access(),
 'invoices',(select coalesce(jsonb_agg(to_jsonb(i)),'[]') from public.invoice i where i.invoice_id=p_invoice_id and i.subsidiary_id=sid),
 'invoiceLines',(select coalesce(jsonb_agg(to_jsonb(l) order by line_id),'[]') from public.sales_invoice_line l where l.invoice_id=p_invoice_id),
 'withholdings',(select coalesce(jsonb_agg(to_jsonb(w)),'[]') from public.sales_invoice_withholding w where w.invoice_id=p_invoice_id),
 'supports',(select coalesce(jsonb_agg(jsonb_build_object('support_id',s.support_id,'journal_id',s.journal_id,'support_type',s.support_type,'display_name',s.display_name,'support_url',s.support_url,'file_name',s.file_name,'mime_type',s.mime_type,'file_size',s.file_size,'file_data',s.file_data)),'[]') from public.journal_support s where s.journal_id=jid),
 'impacts',(select coalesce(jsonb_agg(to_jsonb(g)),'[]') from public.gl_impact g where g.transaction_id=tid and g.subsidiary_id=sid),
 'customers',(select coalesce(jsonb_agg(jsonb_build_object('customer_id',c.customer_id,'company_name',c.company_name,'email',c.email,'address',c.address,'tax_id',c.tax_id,'department_id',c.department_id,'payment_term_id',c.payment_term_id,'is_intercompany',c.is_intercompany,'subsidiary_ids',jsonb_build_array(sid),'withholding_rules',(select coalesce(jsonb_agg(jsonb_build_object('rule_id',r.rule_id,'tax_code_id',r.tax_code_id,'subsidiary_id',r.subsidiary_id)),'[]') from public.entity_withholding_rules r where r.customer_id=c.customer_id and r.subsidiary_id=sid))),'[]') from public.customers c where (not isview or c.customer_id=customer) and exists(select 1 from public.entity_subsidiaries es where es.customer_id=c.customer_id and es.subsidiary_id=sid)),
 'products',(select coalesce(jsonb_agg(jsonb_build_object('product_id',p.product_id,'item_code',p.item_code,'display_name',p.display_name,'sales_price',p.sales_price,'sales_account_id',p.sales_account_id,'product_usage',p.product_usage,'is_active',p.is_active,'subsidiary_ids',jsonb_build_array(sid))),'[]') from public.products p where exists(select 1 from public.product_subsidiaries ps where ps.product_id=p.product_id and ps.subsidiary_id=sid) and (not isview or exists(select 1 from public.sales_invoice_line l where l.invoice_id=p_invoice_id and l.product_id=p.product_id))),
 'taxes',(select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))),'[]') from public.tax_codes t where exists(select 1 from public.tax_code_subsidiaries s where s.tax_code_id=t.tax_code_id and s.subsidiary_id=sid)),
 'taxTypes',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.tax_types t where t.applies_to in('Ventas','Ambos')),
 'terms',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.payment_terms t),
 'periods',(select coalesce(jsonb_agg(to_jsonb(f)),'[]') from public.fiscal_periods f where f.subsidiary_id=sid),
 'currencies',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.currencies c where exists(select 1 from public.subsidiary_currencies s where s.currency_id=c.currency_id and s.subsidiary_id=sid)),
 'rates',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from public.exchange_rates r where r.to_currency_id=(select currency_id from public.subsidiaries where subsidiary_id=sid) or r.from_currency_id=(select currency_id from public.subsidiaries where subsidiary_id=sid)),
 'countries',(select coalesce(jsonb_agg(jsonb_build_object('country_id',c.country_id,'name',c.name)),'[]') from public.countries c),
 'subsidiaries',(select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('allowed_currency_ids',(select jsonb_agg(currency_id) from public.subsidiary_currencies where subsidiary_id=sid))),'[]') from public.subsidiaries s where s.subsidiary_id=sid),
 'locations',(select coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))),'[]') from public.locations l where inventory_balance_private.location(l.location_id)),
 'departments',(select coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))),'[]') from public.departments d where exists(select 1 from public.department_subsidiaries s where s.department_id=d.department_id and s.subsidiary_id=sid)),
 'costs',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.cost_centers c where c.subsidiary_id=sid),
 'classes',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))),'[]') from public.classes c where exists(select 1 from public.class_subsidiaries s where s.class_id=c.class_id and s.subsidiary_id=sid)),
 'accounts',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))),'[]') from public.chart_accounts a where exists(select 1 from public.account_subsidiaries s where s.account_id=a.account_id and s.subsidiary_id=sid)));
end$$;
create function public.sales_invoice_catalog_options() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=sales_invoice_private.access('view');begin return jsonb_build_object(
 'entities/customers',(select coalesce(jsonb_agg(jsonb_build_object('customer_id',c.customer_id,'company_name',c.company_name)),'[]') from public.customers c where exists(select 1 from public.invoice i where i.customer_id=c.customer_id and i.subsidiary_id=sid)),
 'transaction-engine/transactions',(select coalesce(jsonb_agg(jsonb_build_object('transaction_id',t.transaction_id,'tran_number',t.tran_number)),'[]') from public."transaction" t where t.subsidiary_id=sid and exists(select 1 from public.invoice i where i.transaction_id=t.transaction_id and i.subsidiary_id=sid)),
 'organization/subsidiaries',(select coalesce(jsonb_agg(jsonb_build_object('subsidiary_id',s.subsidiary_id,'name',s.name)),'[]') from public.subsidiaries s where s.subsidiary_id=sid),
 'sales/sales-orders','[]'::jsonb);end$$;
do $$declare t text;p record;c record;predicate text;begin
 foreach t in array array['invoice','sales_invoice_line','sales_invoice_withholding'] loop
 execute format('alter table public.%I enable row level security',t);for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);for c in select column_name from information_schema.columns where table_schema='public' and table_name=t loop execute format('revoke all (%I) on public.%I from public,anon,authenticated,service_role',c.column_name,t);end loop;
 execute format('grant select on public.%I to authenticated',t);execute format('create policy sales_invoice_read on public.%I for select to authenticated using(sales_invoice_private.visible(invoice_id))',t);
 end loop;
end$$;
-- Existing journal attachments remain available to other document workflows.
create function sales_invoice_private.support_allowed(jid bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin return not exists(select 1 from public.invoice where journal_id=jid);end$$;
create function sales_invoice_private.support_visible(jid bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin return not exists(select 1 from public.invoice where journal_id=jid) or exists(select 1 from public.invoice i where i.journal_id=jid and sales_invoice_private.visible(i.invoice_id));end$$;
create policy sales_support_read on public.journal_support as restrictive for select to authenticated using(sales_invoice_private.support_visible(journal_id));
create policy sales_support_insert on public.journal_support as restrictive for insert to authenticated with check(sales_invoice_private.support_allowed(journal_id));
create policy sales_support_update on public.journal_support as restrictive for update to authenticated using(sales_invoice_private.support_allowed(journal_id)) with check(sales_invoice_private.support_allowed(journal_id));
create policy sales_support_delete on public.journal_support as restrictive for delete to authenticated using(sales_invoice_private.support_allowed(journal_id));
revoke all on all functions in schema sales_invoice_private from public,anon,authenticated,service_role;
grant execute on function sales_invoice_private.visible(bigint),sales_invoice_private.support_allowed(bigint),sales_invoice_private.support_visible(bigint) to authenticated;
revoke all on function public.save_sales_invoice(jsonb,bigint),public.sales_invoice_access(),public.sales_invoice_context(bigint,text),public.sales_invoice_catalog_options(),public.sales_invoice_delivery_snapshot(bigint),public.set_sales_invoice_pdf_presentation(bigint,boolean,text),public.set_sales_invoice_pdf_line_unification(bigint,boolean),public.sales_invoice_official_exchange_rate(bigint,date,bigint) from public,anon,authenticated,service_role;
grant execute on function public.save_sales_invoice(jsonb,bigint),public.sales_invoice_access(),public.sales_invoice_context(bigint,text),public.sales_invoice_catalog_options(),public.sales_invoice_delivery_snapshot(bigint),public.set_sales_invoice_pdf_presentation(bigint,boolean,text),public.set_sales_invoice_pdf_line_unification(bigint,boolean),public.sales_invoice_official_exchange_rate(bigint,date,bigint) to authenticated;
notify pgrst,'reload schema';
