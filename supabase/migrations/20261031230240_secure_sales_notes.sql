-- C-04: customer credit/debit notes. No historical document updates.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema sales_note_private;
revoke all on schema sales_note_private from public,anon,authenticated,service_role;
grant usage on schema sales_note_private to authenticated;
create function sales_note_private.resource(k text) returns text language plpgsql immutable set search_path=pg_catalog as $$begin
 if k is null or k not in('CREDIT','DEBIT') then raise exception using errcode='22023',message='Tipo de nota inválido.';end if;
 return case k when 'CREDIT' then 'sales:credit-notes' else 'sales:debit-notes' end;end$$;
create function sales_note_private.access(k text,a text) returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=asset_posting_private.access(sales_note_private.resource(k),a);begin
 if a in('create','edit') and not exists(select 1 from public.role_permissions rp join public.permissions p using(permission_id) where rp.role_id=public.app_active_role_id() and p.code=case a when 'create' then 'sales:note:create' else 'sales:note:update' end) then raise exception using errcode='42501',message='El rol activo no tiene permiso técnico de notas.';end if;return sid;end$$;
create function sales_note_private.context(k text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare v boolean;c boolean;e boolean;begin
 perform asset_posting_private.identity();v:=asset_posting_private.allowed(sales_note_private.resource(k),'view');c:=asset_posting_private.allowed(sales_note_private.resource(k),'create');e:=asset_posting_private.allowed(sales_note_private.resource(k),'edit');
 if not(v or c or e) then raise exception using errcode='42501',message='Sin acceso a este tipo de nota.';end if;return jsonb_build_object('canView',v,'canCreate',c,'canEdit',e);end$$;
create function sales_note_private.visible(k text,nid bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if k is null or k not in('CREDIT','DEBIT') then return false;end if;
 return asset_posting_private.allowed(sales_note_private.resource(k),'view') and exists(select 1 from (select invoice_id from public.credit_note where k='CREDIT' and cn_id=nid union all select invoice_id from public.debit_note where k='DEBIT' and dn_id=nid)n join public.invoice i using(invoice_id) where i.subsidiary_id=asset_posting_private.identity());end$$;
create function sales_note_private.balance(iid bigint,nid bigint default null) returns numeric language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select greatest((case when exists(select 1 from public.sales_invoice_withholding where invoice_id=iid and recognized_at_invoice) then i.receivable_amount else coalesce(nullif(i.receivable_amount,0),i.total_amount) end)+coalesce((select sum(amount) from public.debit_note where invoice_id=iid),0)-coalesce((select sum(amount) from public.credit_note where invoice_id=iid and cn_id<>coalesce(nid,-1)),0)-coalesce((select sum(amount) from public.customer_payment_application where invoice_id=iid),0),0) from public.invoice i where i.invoice_id=iid$$;
alter function public.save_sales_note_without_income_autorent(text,jsonb,bigint) set schema sales_note_private;
alter function public.save_sales_note_before_intercompany_receivable(text,jsonb,bigint) set schema sales_note_private;
alter function public.save_sales_note(text,jsonb,bigint) set schema sales_note_private;
alter function public.save_sales_note_before_service_month_fix(text,jsonb,bigint) set schema sales_note_private;
alter function public.save_sales_note_before_service_country_fix(text,jsonb,bigint) set schema sales_note_private;
do $$declare f record;body text;n text;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='sales_note_private'::regnamespace and proname like 'save_sales_note%' loop
 execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f.signature);body:=pg_get_functiondef(f.signature);
 foreach n in array array['save_sales_note_without_income_autorent','save_sales_note_before_intercompany_receivable','save_sales_note','save_sales_note_before_service_month_fix','save_sales_note_before_service_country_fix'] loop body:=replace(body,'public.'||n||'(','sales_note_private.'||n||'(');end loop;execute body;
 end loop;end$$;
create function sales_note_private.prepare(k text,p jsonb,nid bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=sales_note_private.access(k,case when nid is null then 'create' else 'edit' end);i public.invoice;n record;ln jsonb;lines jsonb:='[]';prod public.products;qty numeric;price numeric;rate numeric;tax_account bigint;field text;total numeric;begin
 if jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') not between 1 and 500 then raise exception using errcode='22023',message='La nota requiere entre 1 y 500 líneas.';end if;
 if p ?| array['subsidiary_id','customer_id','transaction_id','journal_id','receivable_account_id','location_id','amount','is_opening_balance','opening_run_id'] then raise exception using errcode='42501',message='No puede sustituir el origen de la nota.';end if;
 select * into i from public.invoice where invoice_id=(p->>'invoice_id')::bigint and subsidiary_id=sid;
 if not found then raise exception using errcode='42501',message='Factura no disponible.';end if;
 -- Shared lock order with invoice editor and credit-note trigger.
 perform 1 from public."transaction" where transaction_id=i.transaction_id for update;
 perform 1 from public.journal where journal_id=i.journal_id for update;
 select * into i from public.invoice where invoice_id=i.invoice_id and subsidiary_id=sid for update;
 if not found then raise exception using errcode='42501',message='Factura no disponible.';end if;
 if not coalesce(i.is_opening_balance,false) and not exists(select 1 from public.journal j join public."transaction" t on t.transaction_id=i.transaction_id join public.transaction_types tt using(transaction_type_id) where j.journal_id=i.journal_id and j.transaction_id=t.transaction_id and tt.abbreviation='FAC_VEN' and j.status='CONTABILIZADO' and j.subsidiary_id=sid and t.subsidiary_id=sid and j.currency_id=i.currency_id and t.currency_id=i.currency_id)
 or exists(select 1 from public.journal where reversed_from_journal_id=i.journal_id) then raise exception using errcode='55000',message='La factura tiene origen contable protegido.';end if;
 if not exists(select 1 from public.customers c join public.entity_subsidiaries es using(customer_id) where c.customer_id=i.customer_id and es.subsidiary_id=sid and not coalesce((to_jsonb(c)->>'is_inactive')::boolean,false)) then raise exception using errcode='42501',message='Cliente no disponible.';end if;
 if i.location_id is not null and not inventory_balance_private.location(i.location_id) then raise exception using errcode='42501',message='Ubicación no disponible.';end if;
 if (p->>'currency_id')::bigint is distinct from i.currency_id or not exists(select 1 from public.subsidiary_currencies where subsidiary_id=sid and currency_id=i.currency_id) then raise exception using errcode='42501',message='La nota debe conservar la moneda de la factura.';end if;
 rate:=(p->>'exchange_rate')::numeric;if not asset_posting_private.finite(rate) or rate<=0 then raise exception using errcode='22023',message='Tipo de cambio inválido.';end if;
 -- Credits reverse the historical exchange rate; debit notes use the official rate.
 p:=p||jsonb_build_object('exchange_rate',case k when 'CREDIT' then i.exchange_rate else sales_invoice_private.sales_invoice_official_exchange_rate(i.currency_id,(p->>'note_date')::date,sid) end);
 perform sales_invoice_private.period((p->>'fiscal_period_id')::bigint,(p->>'note_date')::date);
 if nid is not null then
 select * into n from(select cn_id id,invoice_id,customer_id,transaction_id,journal_id,currency_id,exchange_rate,note_date,fiscal_period_id from public.credit_note where k='CREDIT' and cn_id=nid union all select dn_id,invoice_id,customer_id,transaction_id,journal_id,currency_id,exchange_rate,note_date,fiscal_period_id from public.debit_note where k='DEBIT' and dn_id=nid)x;
 if not found or n.invoice_id is distinct from i.invoice_id or n.customer_id is distinct from i.customer_id then raise exception using errcode='42501',message='Nota no disponible para esta factura.';end if;
 perform 1 from public."transaction" where transaction_id=n.transaction_id for update;perform 1 from public.journal where journal_id=n.journal_id for update;
 if k='CREDIT' then perform 1 from public.credit_note where cn_id=nid for update;else perform 1 from public.debit_note where dn_id=nid for update;end if;
 if not exists(select 1 from public.journal j join public."transaction" t on t.transaction_id=n.transaction_id join public.transaction_types tt using(transaction_type_id) where j.journal_id=n.journal_id and j.transaction_id=t.transaction_id and tt.abbreviation=case k when 'CREDIT' then 'NC_VEN' else 'ND_VEN' end and j.status='CONTABILIZADO' and j.subsidiary_id=sid and t.subsidiary_id=sid and j.currency_id=n.currency_id and t.currency_id=n.currency_id and n.currency_id=i.currency_id and j.exchange_rate=n.exchange_rate and t.exchange_rate=n.exchange_rate and j.fiscal_period_id=n.fiscal_period_id and t.fiscal_period_id=n.fiscal_period_id and j.journal_date=n.note_date and t.tran_date=n.note_date)
 or exists(select 1 from public.journal where reversed_from_journal_id=n.journal_id)
 or exists(select 1 from public.customer_payment_application where invoice_id=i.invoice_id)
 or exists(select 1 from public.customer_payment_withholding where invoice_id=i.invoice_id)
 or exists(select 1 from public.credit_note where invoice_id=i.invoice_id and(k<>'CREDIT' or cn_id<>nid))
 or exists(select 1 from public.debit_note where invoice_id=i.invoice_id and(k<>'DEBIT' or dn_id<>nid)) then raise exception using errcode='55000',message='La nota conserva su historial contable y procesos relacionados.';end if;
 perform sales_invoice_private.period(n.fiscal_period_id,n.note_date);
 end if;
 perform asset_posting_private.account(coalesce(i.receivable_account_id,public.resolve_customer_receivable_account(sid,i.customer_id)));
 for ln in select value from jsonb_array_elements(p->'lines') loop
 if jsonb_typeof(ln) is distinct from 'object' then raise exception using errcode='22023',message='Línea inválida.';end if;
 foreach field in array array['quantity','unit_price','amount','tax_rate','tax_amount','gross_amount'] loop if ln?field and not asset_posting_private.finite((ln->>field)::numeric) then raise exception using errcode='22023',message='Los importes deben ser finitos.';end if;end loop;
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
 total:=(select sum((x->>'gross_amount')::numeric) from jsonb_array_elements(lines)x);
 if k='CREDIT' and(total>sales_note_private.balance(i.invoice_id,nid)+0.000001 or total>i.total_amount+0.005) then raise exception using errcode='55000',message='La nota supera el saldo pendiente disponible.';end if;
 return p||jsonb_build_object('lines',lines);end$$;
create function public.save_sales_note(p_kind text,p_payload jsonb,p_target_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare p jsonb;r jsonb;n record;debit numeric;credit numeric;begin
 p:=sales_note_private.prepare(p_kind,p_payload,p_target_id);r:=sales_note_private.save_sales_note(p_kind,p-'supports',p_target_id);
 select * into n from(select cn_id id,journal_id,transaction_id,cn_number number from public.credit_note where p_kind='CREDIT' and cn_id=(r->>'noteId')::bigint union all select dn_id,journal_id,transaction_id,dn_number from public.debit_note where p_kind='DEBIT' and dn_id=(r->>'noteId')::bigint)x;
 if not found or n.journal_id is null or n.transaction_id is null then raise exception using errcode='55000',message='La nota no conserva su origen contable.';end if;
 -- Original editor did not align fiscal period and FX in all three records.
 update public."transaction" set fiscal_period_id=(p->>'fiscal_period_id')::bigint,exchange_rate=(p->>'exchange_rate')::numeric,currency_id=(p->>'currency_id')::bigint where transaction_id=n.transaction_id;
 update public.journal set fiscal_period_id=(p->>'fiscal_period_id')::bigint,exchange_rate=(p->>'exchange_rate')::numeric,currency_id=(p->>'currency_id')::bigint where journal_id=n.journal_id;
 perform public.sync_journal_gl_impacts(n.journal_id);
 select sum(debit_amount),sum(credit_amount) into debit,credit from public.gl_impact where transaction_id=n.transaction_id;
 if not asset_posting_private.finite(debit) or not asset_posting_private.finite(credit) or debit<=0 or abs(debit-credit)>0.000001 then raise exception using errcode='55000',message='La nota no produjo un mayor balanceado.';end if;
 if p_payload?'supports' then perform sales_invoice_private.supports(n.journal_id,p_payload->'supports');end if;
 return r||jsonb_build_object('transactionNumber',n.number,'exchangeRate',(p->>'exchange_rate')::numeric);end$$;
create function public.sales_note_access(p_kind text) returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select sales_note_private.context(p_kind)$$;
create function public.sales_note_context(p_kind text,p_note_id bigint default null,p_action text default 'create',p_invoice_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint;jid bigint;tid bigint;customer bigint;isview boolean:=p_action='view';n record;ids bigint[];begin
 if p_action is null or p_action not in('view','create','edit') then raise exception using errcode='22023',message='Acción inválida.';end if;sid:=sales_note_private.access(p_kind,p_action);
 if p_action='create' and p_note_id is not null or p_action in('view','edit') and p_note_id is null then raise exception using errcode='22023',message='Nota requerida para esta acción.';end if;
 if p_note_id is not null then
 select * into n from(select invoice_id,journal_id,transaction_id,customer_id from public.credit_note where p_kind='CREDIT' and cn_id=p_note_id union all select invoice_id,journal_id,transaction_id,customer_id from public.debit_note where p_kind='DEBIT' and dn_id=p_note_id)x;
 if not found or not exists(select 1 from public.invoice where invoice_id=n.invoice_id and subsidiary_id=sid) or p_invoice_id is not null and p_invoice_id<>n.invoice_id then raise exception using errcode='42501',message='Nota no disponible.';end if;
 p_invoice_id:=n.invoice_id;jid:=n.journal_id;tid:=n.transaction_id;customer:=n.customer_id;
 if p_action='edit' then perform sales_note_private.prepare(p_kind,jsonb_build_object('invoice_id',n.invoice_id,'note_date',(select note_date from public.credit_note where p_kind='CREDIT' and cn_id=p_note_id union all select note_date from public.debit_note where p_kind='DEBIT' and dn_id=p_note_id),'fiscal_period_id',(select fiscal_period_id from public.credit_note where p_kind='CREDIT' and cn_id=p_note_id union all select fiscal_period_id from public.debit_note where p_kind='DEBIT' and dn_id=p_note_id),'currency_id',(select currency_id from public.invoice where invoice_id=n.invoice_id),'exchange_rate',1,'lines',(select jsonb_agg(to_jsonb(l) order by line_id) from public.sales_note_line l where note_kind=p_kind and note_id=p_note_id)),p_note_id);end if;
 elsif p_invoice_id is not null and not exists(select 1 from public.invoice where invoice_id=p_invoice_id and subsidiary_id=sid) then raise exception using errcode='42501',message='Factura no disponible.';end if;
 select array_agg(invoice_id) into ids from public.invoice where subsidiary_id=sid and(not isview or invoice_id=p_invoice_id);
  return jsonb_build_object(
 'access',sales_note_private.context(p_kind),
 'credits',(select coalesce(jsonb_agg(to_jsonb(note_row)),'[]') from public.credit_note note_row where p_kind='CREDIT' and cn_id=p_note_id),
 'debits',(select coalesce(jsonb_agg(to_jsonb(note_row)),'[]') from public.debit_note note_row where p_kind='DEBIT' and dn_id=p_note_id),
 'noteLines',(select coalesce(jsonb_agg(to_jsonb(l) order by line_id),'[]') from public.sales_note_line l where note_kind=p_kind and note_id=p_note_id),
 'invoices',(select coalesce(jsonb_agg(jsonb_build_object('invoice_id',i.invoice_id,'invoice_number',i.invoice_number,'customer_id',i.customer_id,'subsidiary_id',i.subsidiary_id,'location_id',i.location_id,'currency_id',i.currency_id,'exchange_rate',i.exchange_rate,'memo',i.memo,'receivable_account_id',i.receivable_account_id,'pending',sales_note_private.balance(i.invoice_id,case when p_kind='CREDIT' then p_note_id end))),'[]') from public.invoice i where i.invoice_id=any(ids)),
 'invoiceLines',(select coalesce(jsonb_agg(to_jsonb(l) order by line_id),'[]') from public.sales_invoice_line l where not isview and l.invoice_id=p_invoice_id),
 'supports',(select coalesce(jsonb_agg(jsonb_build_object('support_id',s.support_id,'journal_id',s.journal_id,'support_type',s.support_type,'display_name',s.display_name,'support_url',s.support_url,'file_name',s.file_name,'mime_type',s.mime_type,'file_size',s.file_size,'file_data',s.file_data)),'[]') from public.journal_support s where s.journal_id=jid),
 'impacts',(select coalesce(jsonb_agg(to_jsonb(g)),'[]') from public.gl_impact g where not isview and g.transaction_id=tid and g.subsidiary_id=sid),
 'customers',(select coalesce(jsonb_agg(jsonb_build_object('customer_id',c.customer_id,'company_name',c.company_name,'email',c.email,'address',c.address,'tax_id',c.tax_id,'department_id',c.department_id,'payment_term_id',c.payment_term_id,'is_intercompany',c.is_intercompany,'subsidiary_ids',jsonb_build_array(sid),'withholding_rules',(select coalesce(jsonb_agg(jsonb_build_object('rule_id',r.rule_id,'tax_code_id',r.tax_code_id,'subsidiary_id',r.subsidiary_id)),'[]') from public.entity_withholding_rules r where r.customer_id=c.customer_id and r.subsidiary_id=sid))),'[]') from public.customers c where (not isview or c.customer_id=customer) and exists(select 1 from public.entity_subsidiaries es where es.customer_id=c.customer_id and es.subsidiary_id=sid)),
 'products',(select coalesce(jsonb_agg(jsonb_build_object('product_id',p.product_id,'item_code',p.item_code,'display_name',p.display_name,'sales_price',p.sales_price,'sales_account_id',p.sales_account_id,'product_usage',p.product_usage,'is_active',p.is_active,'subsidiary_ids',jsonb_build_array(sid))),'[]') from public.products p where exists(select 1 from public.product_subsidiaries ps where ps.product_id=p.product_id and ps.subsidiary_id=sid) and (not isview or exists(select 1 from public.sales_note_line l where l.note_kind=p_kind and l.note_id=p_note_id and l.product_id=p.product_id))),
 'taxes',(select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))),'[]') from public.tax_codes t where exists(select 1 from public.tax_code_subsidiaries s where s.tax_code_id=t.tax_code_id and s.subsidiary_id=sid) and (not isview or exists(select 1 from public.sales_note_line l where l.note_kind=p_kind and l.note_id=p_note_id and l.tax_code_id=t.tax_code_id) or exists(select 1 from public.sales_invoice_withholding w where w.invoice_id=p_invoice_id and w.tax_code_id=t.tax_code_id))),
 'taxTypes',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.tax_types t where not isview and t.applies_to in('Ventas','Ambos') and exists(select 1 from public.tax_codes tc join public.tax_code_subsidiaries ts using(tax_code_id) where tc.tax_type_id=t.tax_type_id and ts.subsidiary_id=sid)),
 'periods',(select coalesce(jsonb_agg(to_jsonb(f)),'[]') from public.fiscal_periods f where not isview and f.subsidiary_id=sid),
 'currencies',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.currencies c where (isview and c.currency_id=(select currency_id from public.invoice where invoice_id=p_invoice_id)) or (not isview and exists(select 1 from public.subsidiary_currencies s where s.currency_id=c.currency_id and s.subsidiary_id=sid))),
 'countries',(select coalesce(jsonb_agg(jsonb_build_object('country_id',c.country_id,'name',c.name)),'[]') from public.countries c where not isview or exists(select 1 from public.sales_note_line l where l.note_kind=p_kind and l.note_id=p_note_id and l.service_country_id=c.country_id) or c.country_id=(select country_id from public.subsidiaries where subsidiary_id=sid)),
 'subsidiaries',(select coalesce(jsonb_agg(jsonb_build_object('subsidiary_id',s.subsidiary_id,'name',s.name,'legal_name',s.legal_name,'address',s.address,'logo_url',s.logo_url,'tax_id',s.tax_id,'country_id',s.country_id,'currency_id',s.currency_id,'applies_income_autorent',s.applies_income_autorent,'autorent_active_account_id',s.autorent_active_account_id,'autorent_passive_account_id',s.autorent_passive_account_id,'autorent_percentage',s.autorent_percentage,'allowed_currency_ids',(select jsonb_agg(currency_id) from public.subsidiary_currencies where subsidiary_id=sid))),'[]') from public.subsidiaries s where s.subsidiary_id=sid),
 'locations',(select coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))),'[]') from public.locations l where not isview and inventory_balance_private.location(l.location_id)),
 'departments',(select coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))),'[]') from public.departments d where not isview and exists(select 1 from public.department_subsidiaries s where s.department_id=d.department_id and s.subsidiary_id=sid)),
 'costs',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.cost_centers c where not isview and c.subsidiary_id=sid),
 'classes',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))),'[]') from public.classes c where not isview and exists(select 1 from public.class_subsidiaries s where s.class_id=c.class_id and s.subsidiary_id=sid)),
 'accounts',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))),'[]') from public.chart_accounts a where not isview and exists(select 1 from public.account_subsidiaries s where s.account_id=a.account_id and s.subsidiary_id=sid)));
end$$;
create function public.sales_note_catalog_options(p_kind text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=sales_note_private.access(p_kind,'view');ids bigint[];begin
 select array_agg(invoice_id) into ids from(select invoice_id from public.credit_note where p_kind='CREDIT' union all select invoice_id from public.debit_note where p_kind='DEBIT')n join public.invoice i using(invoice_id) where i.subsidiary_id=sid;
 return jsonb_build_object('sales/invoices',(select coalesce(jsonb_agg(jsonb_build_object('invoice_id',invoice_id,'invoice_number',invoice_number)),'[]') from public.invoice where invoice_id=any(ids)),
 'entities/customers',(select coalesce(jsonb_agg(jsonb_build_object('customer_id',c.customer_id,'company_name',c.company_name)),'[]') from public.customers c where exists(select 1 from public.invoice i where i.invoice_id=any(ids) and i.customer_id=c.customer_id)),
 'transaction-engine/transactions',(select coalesce(jsonb_agg(jsonb_build_object('transaction_id',t.transaction_id,'tran_number',t.tran_number)),'[]') from public."transaction" t where t.subsidiary_id=sid and(exists(select 1 from public.credit_note n where p_kind='CREDIT' and n.invoice_id=any(ids) and n.transaction_id=t.transaction_id) or exists(select 1 from public.debit_note n where p_kind='DEBIT' and n.invoice_id=any(ids) and n.transaction_id=t.transaction_id))));end$$;
revoke all on function public.sales_note_catalog_options(text) from public,anon,authenticated,service_role;
grant execute on function public.sales_note_catalog_options(text) to authenticated;
do $$declare t text;p record;c record;begin foreach t in array array['credit_note','debit_note','sales_note_line'] loop
 execute format('alter table public.%I enable row level security',t);for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);for c in select column_name from information_schema.columns where table_schema='public' and table_name=t loop execute format('revoke all (%I) on public.%I from public,anon,authenticated,service_role',c.column_name,t);end loop;
 execute format('grant select on public.%I to authenticated',t);end loop;end$$;
create policy credit_note_read on public.credit_note for select to authenticated using(sales_note_private.visible('CREDIT',cn_id));
create policy debit_note_read on public.debit_note for select to authenticated using(sales_note_private.visible('DEBIT',dn_id));
create policy sales_note_line_read on public.sales_note_line for select to authenticated using(sales_note_private.visible(note_kind,note_id));
create or replace function sales_invoice_private.support_allowed(jid bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin return not exists(select 1 from public.invoice where journal_id=jid) and not exists(select 1 from public.credit_note where journal_id=jid) and not exists(select 1 from public.debit_note where journal_id=jid);end$$;
create or replace function sales_invoice_private.support_visible(jid bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 return (not exists(select 1 from public.invoice where journal_id=jid) or exists(select 1 from public.invoice i where i.journal_id=jid and sales_invoice_private.visible(i.invoice_id)))
 and(not exists(select 1 from public.credit_note where journal_id=jid) or exists(select 1 from public.credit_note n where n.journal_id=jid and sales_note_private.visible('CREDIT',n.cn_id)))
 and(not exists(select 1 from public.debit_note where journal_id=jid) or exists(select 1 from public.debit_note n where n.journal_id=jid and sales_note_private.visible('DEBIT',n.dn_id)));end$$;
revoke all on all functions in schema sales_note_private from public,anon,authenticated,service_role;
grant execute on function sales_note_private.visible(text,bigint) to authenticated;
revoke all on function public.save_sales_note(text,jsonb,bigint),public.sales_note_access(text),public.sales_note_context(text,bigint,text,bigint),public.validate_customer_credit_note_balance() from public,anon,authenticated,service_role;
grant execute on function public.save_sales_note(text,jsonb,bigint),public.sales_note_access(text),public.sales_note_context(text,bigint,text,bigint) to authenticated;
notify pgrst,'reload schema';
