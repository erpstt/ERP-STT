-- Reference reads for invoice entry use invoice authority, not master maintenance.
-- No existing writer, access function, RLS policy or grant is changed.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema supplier_invoice_form_private;
revoke all on schema supplier_invoice_form_private from public,anon,authenticated,service_role;
create function supplier_invoice_form_private.project(p_row jsonb,p_keys text[])returns jsonb
language sql immutable security invoker set search_path=pg_catalog as $$
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)from jsonb_each(p_row)where key=any(p_keys)
$$;
create function supplier_invoice_form_private.active(p_row jsonb)returns boolean
language sql immutable security invoker set search_path=pg_catalog as $$
 select not coalesce((p_row->>'is_inactive')::boolean,false)and coalesce((p_row->>'is_active')::boolean,true)
$$;

create function public.supplier_invoice_form_options(p_invoice_id bigint default null)returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=entity_master_private.identity();access jsonb;invoice public.supplier_invoice;company public.subsidiaries;result jsonb;
begin
 access:=public.supplier_invoice_access();
 if not coalesce((access->>'canView')::boolean,false)then raise exception using errcode='42501',message='No tiene permiso para consultar las opciones de facturas.';end if;
 if p_invoice_id is null then
  if not coalesce((access->>'canCreate')::boolean,false)then raise exception using errcode='42501',message='No tiene permiso para crear facturas.';end if;
 else
  if p_invoice_id<=0 or p_invoice_id>9007199254740991 then raise exception using errcode='22023',message='Identificador de factura inválido.';end if;
  select *into invoice from public.supplier_invoice where invoice_id=p_invoice_id and subsidiary_id=sid;
  if invoice.invoice_id is null then raise exception using errcode='42501',message='Factura no disponible en la empresa activa.';end if;
 end if;
 select *into company from public.subsidiaries where subsidiary_id=sid;
 with
 selected_lines as materialized(select l.*from public.supplier_invoice_line l where l.invoice_id=invoice.invoice_id),
 historical_tax as materialized(select tax_code_id from selected_lines union select tax_code_id from public.supplier_invoice_withholding where invoice_id=invoice.invoice_id),
 historical_accounts as materialized(
  select account_id from selected_lines union select invoice.payable_account_id where invoice.invoice_id is not null
  union select w.liability_account_id from public.supplier_invoice_withholding w where w.invoice_id=invoice.invoice_id
  union select tt.asset_account_id from public.tax_types tt join public.tax_codes tc on tc.tax_type_id=tt.tax_type_id where tc.tax_code_id in(select tax_code_id from historical_tax)
  union select tt.liability_account_id from public.tax_types tt join public.tax_codes tc on tc.tax_type_id=tt.tax_type_id where tc.tax_code_id in(select tax_code_id from historical_tax)),
 taxset as materialized(
  select tc.*from public.tax_codes tc where
   (tc.country_id=company.country_id and (tc.subsidiary_id=sid or exists(select 1 from public.tax_code_subsidiaries x where x.tax_code_id=tc.tax_code_id and x.subsidiary_id=sid))and supplier_invoice_form_private.active(to_jsonb(tc))
    and exists(select 1 from public.tax_types tt where tt.tax_type_id=tc.tax_type_id and tt.applies_to in('Compras','Ambos')))
   or tc.tax_code_id in(select tax_code_id from historical_tax)),
 typeset as materialized(select tt.*from public.tax_types tt where tt.tax_type_id in(select tax_type_id from taxset)),
 accountset as materialized(select a.*from public.chart_accounts a where
  (exists(select 1 from public.account_subsidiaries x where x.account_id=a.account_id and x.subsidiary_id=sid and x.is_active)and supplier_invoice_form_private.active(to_jsonb(a)))
  or a.account_id in(select account_id from historical_accounts)),
 costset as materialized(select c.*from public.cost_centers c where
  (c.subsidiary_id=sid and supplier_invoice_form_private.active(to_jsonb(c)))or c.cost_center_id in(select cost_center_id from selected_lines)),
 supplierset as materialized(select s.*from public.suppliers s where
  (exists(select 1 from public.entity_subsidiaries x where x.supplier_id=s.supplier_id and x.subsidiary_id=sid)and supplier_invoice_form_private.active(to_jsonb(s)))or s.supplier_id=invoice.supplier_id),
 allowed_currencies as materialized(select company.currency_id currency_id union select currency_id from public.subsidiary_currencies where subsidiary_id=sid union select invoice.currency_id where invoice.invoice_id is not null)
 select jsonb_build_object(
 'context',jsonb_build_object('subsidiaryId',sid,'invoiceId',p_invoice_id),
 'accounts',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(a),array['account_id','account_number','account_name','category','account_group_id','accepts_entries','is_inactive'])||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))order by a.account_id)from accountset a),'[]'),
 'accountGroups',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(g),array['group_id','group_name','parent_id'])order by g.group_id)from public.account_group g),'[]'),
 'taxes',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(t),array['tax_code_id','code_name','rate_percentage','tax_type_id','is_withholding','withholding_calculation_base','withholding_application_moment'])||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))order by t.tax_code_id)from taxset t),'[]'),
 'taxTypes',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(t),array['tax_type_id','type_name','asset_account_id','liability_account_id'])order by t.tax_type_id)from typeset t),'[]'),
 'departments',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(d),array['department_id','name','type','is_inactive','is_active'])||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))order by d.department_id)from public.departments d where
  ((d.subsidiary_id=sid or exists(select 1 from public.department_subsidiaries x where x.department_id=d.department_id and x.subsidiary_id=sid))and supplier_invoice_form_private.active(to_jsonb(d)))or d.department_id in(select department_id from selected_lines)),'[]'),
 'classes',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(c),array['class_id','name','is_inactive','is_active'])||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))order by c.class_id)from public.classes c where
  ((c.subsidiary_id=sid or exists(select 1 from public.class_subsidiaries x where x.class_id=c.class_id and x.subsidiary_id=sid))and supplier_invoice_form_private.active(to_jsonb(c)))or c.class_id in(select class_id from selected_lines)),'[]'),
 'costs',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(c),array['cost_center_id','name','cost_center_type','department_id','customer_id','class_id','is_inactive','is_active'])||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))order by c.cost_center_id)from costset c),'[]'),
 'creditors',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(c),array['financial_creditor_id','name','is_inactive','is_active'])||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))order by c.financial_creditor_id)from public.financial_creditors c where
  ((c.subsidiary_id=sid or exists(select 1 from public.financial_creditor_subsidiaries x where x.financial_creditor_id=c.financial_creditor_id and x.subsidiary_id=sid))and supplier_invoice_form_private.active(to_jsonb(c)))or c.financial_creditor_id in(select financial_creditor_id from selected_lines)),'[]'),
 'related',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(c),array['related_company_id','name','country_id','is_inactive','is_active'])||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))order by c.related_company_id)from public.related_companies c where
  ((c.subsidiary_id=sid or exists(select 1 from public.related_company_subsidiaries x where x.related_company_id=c.related_company_id and x.subsidiary_id=sid))and supplier_invoice_form_private.active(to_jsonb(c)))or c.related_company_id in(select related_company_id from selected_lines)),'[]'),
 'customers',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(c),array['customer_id','department_id','is_inactive','is_active'])||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))order by c.customer_id)from public.customers c where
  (exists(select 1 from public.entity_subsidiaries x where x.customer_id=c.customer_id and x.subsidiary_id=sid)and supplier_invoice_form_private.active(to_jsonb(c)))or c.customer_id in(select cs.customer_id from costset cs join selected_lines l on l.cost_center_id=cs.cost_center_id)),'[]'),
 'suppliers',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(s),array['supplier_id','company_name','payment_term_id','is_intercompany','is_inactive','is_active'])||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid),
  'currency_ids',coalesce((select jsonb_agg(c.currency_id order by c.currency_id)from public.supplier_currencies c where c.supplier_id=s.supplier_id and c.currency_id in(select currency_id from allowed_currencies)),'[]'),
  'withholding_rules',coalesce((select jsonb_agg(jsonb_build_object('subsidiary_id',sid,'tax_code_id',w.tax_code_id)order by w.tax_code_id)from public.entity_withholding_rules w where w.supplier_id=s.supplier_id and w.subsidiary_id=sid and w.tax_code_id in(select tax_code_id from taxset)),'[]'))order by s.supplier_id)from supplierset s),'[]'),
 'paymentTerms',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(t),array['term_id','term_name','days_due'])order by t.term_id)from public.payment_terms t),'[]'),
 'periods',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(p),array['fiscal_period_id','period_name','subsidiary_id','fiscal_calendar_id','start_date','end_date','is_active','is_inactive','is_closed','gl_closed','ap_closed'])order by p.start_date,p.fiscal_period_id)from public.fiscal_periods p where p.subsidiary_id=sid and
  ((not p.is_closed and not coalesce(p.gl_closed,false)and not coalesce(p.ap_closed,false)and supplier_invoice_form_private.active(to_jsonb(p)))or p.fiscal_period_id=invoice.fiscal_period_id)),'[]'),
 'currencies',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(c),array['currency_id','currency_code','name'])order by c.currency_id)from public.currencies c where c.currency_id in(select currency_id from allowed_currencies)),'[]'),
 'rates',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(r),array['from_currency_id','to_currency_id','effective_date','spot_rate'])order by r.from_currency_id,r.effective_date)from public.exchange_rates r where r.to_currency_id=company.currency_id and r.from_currency_id in(select currency_id from allowed_currencies)),'[]'),
 'countries',coalesce((select jsonb_agg(jsonb_build_object('country_id',c.country_id,'name',c.name)order by c.country_id)from public.countries c),'[]'),
 'subsidiaries',jsonb_build_array(jsonb_build_object('subsidiary_id',sid,'name',company.name,'currency_id',company.currency_id,'fiscal_calendar_id',company.fiscal_calendar_id,
  'allowed_currency_ids',coalesce((select jsonb_agg(currency_id order by currency_id)from allowed_currencies),'[]'),
  'secondary_currency_ids',coalesce((select jsonb_agg(currency_id order by currency_id)from public.subsidiary_currencies where subsidiary_id=sid and currency_id<>company.currency_id),'[]'))),
 'locations',coalesce((select jsonb_agg(jsonb_build_object('location_id',l.location_id,'name',l.name,'subsidiary_ids',jsonb_build_array(sid))order by l.location_id)from public.locations l where l.subsidiary_id=sid or exists(select 1 from public.location_subsidiaries x where x.location_id=l.location_id and x.subsidiary_id=sid)or l.location_id=invoice.location_id),'[]'),
 'invoices',case when invoice.invoice_id is null then '[]'::jsonb else jsonb_build_array(supplier_invoice_form_private.project(to_jsonb(invoice),array['invoice_id','invoice_number','invoice_type','supplier_id','payment_term_id','location_id','subsidiary_id','currency_id','invoice_date','due_date','fiscal_period_id','exchange_rate','memo','journal_id','payable_account_id']))end,
 'invoiceLines',coalesce((select jsonb_agg(supplier_invoice_form_private.project(to_jsonb(l),array['invoice_id','account_id','quantity','unit_price','amount','tax_code_id','tax_rate','note','department_id','cost_center_id','class_id','financial_creditor_id','related_company_id','es_activo_fijo'])order by l.line_id)from selected_lines l),'[]')
 )into result;
 return result;
end$$;
revoke all on all functions in schema supplier_invoice_form_private from public,anon,authenticated,service_role;
revoke all on function public.supplier_invoice_form_options(bigint)from public,anon,authenticated,service_role;
grant execute on function public.supplier_invoice_form_options(bigint)to authenticated;
notify pgrst,'reload schema';
