-- Purpose-specific, read-only projections for the manual journal form.
-- Separate the small header from line catalogs; attachments are fetched only
-- for the selected journal, when the user opens the supports tab.
set local lock_timeout='5s';
set local statement_timeout='30s';

create function journal_entry_private.form_context(p_journal_id bigint)
returns bigint language plpgsql stable security invoker
set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 sid:=journal_entry_private.assert_access(case when p_journal_id is null then 'create' else 'edit' end);
 if p_journal_id is not null then
  if p_journal_id<=0 then raise exception using errcode='22023',message='Seleccione un asiento válido.';end if;
  if not exists(select 1 from public.journal j where j.journal_id=p_journal_id and j.subsidiary_id=sid
    and j.status in('CONTABILIZADO','BORRADOR') and exists(select 1 from public.transaction_types t
      where t.name=j.journal_type and t.abbreviation in('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ'))) then
   raise exception using errcode='42501',message='El asiento manual no está disponible en la subsidiaria activa.';
  end if;
 end if;
 return sid;
end$$;

create function journal_entry_private.form_options(p_section text,p_journal_id bigint default null)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;country bigint;local_currency bigint;result jsonb;
begin
 sid:=journal_entry_private.form_context(p_journal_id);
 if p_section is null or p_section not in('header','lines') then
  raise exception using errcode='22023',message='Seleccione una sección válida del formulario.';
 end if;
 select s.country_id,s.currency_id into country,local_currency from public.subsidiaries s where s.subsidiary_id=sid;
 if p_section='header' then
  select jsonb_build_object(
   'transactionTypes',coalesce((select jsonb_agg(jsonb_build_object('transaction_type_id',t.transaction_type_id,
     'abbreviation',t.abbreviation,'name',t.name) order by case t.abbreviation when 'ASI_DIA' then 1 when 'ASI_PEN' then 2 when 'ASI_NOM' then 3 else 4 end)
     from public.transaction_types t where t.abbreviation in('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ')),'[]'::jsonb),
   'subsidiaries',coalesce((select jsonb_agg(jsonb_build_object('subsidiary_id',s.subsidiary_id,'name',s.name,
     'country_id',s.country_id,'currency_id',s.currency_id,'allowed_currency_ids',coalesce((select jsonb_agg(sc.currency_id order by sc.currency_id)
       from public.subsidiary_currencies sc where sc.subsidiary_id=sid),'[]'::jsonb))) from public.subsidiaries s where s.subsidiary_id=sid),'[]'::jsonb),
   'locations',coalesce((select jsonb_agg(jsonb_build_object('location_id',l.location_id,'name',l.name,'subsidiary_ids',jsonb_build_array(sid)) order by l.name,l.location_id)
     from public.locations l where exists(select 1 from public.location_subsidiaries ls where ls.location_id=l.location_id and ls.subsidiary_id=sid)),'[]'::jsonb),
   'currencies',coalesce((select jsonb_agg(jsonb_build_object('currency_id',c.currency_id,'currency_code',c.currency_code,'name',c.name) order by c.currency_code,c.currency_id)
     from public.currencies c where c.currency_id=local_currency or exists(select 1 from public.subsidiary_currencies sc where sc.subsidiary_id=sid and sc.currency_id=c.currency_id)),'[]'::jsonb),
   'periods',coalesce((select jsonb_agg(jsonb_build_object('fiscal_period_id',f.fiscal_period_id,'period_name',f.period_name,
     'subsidiary_id',f.subsidiary_id,'start_date',f.start_date,'end_date',f.end_date,'is_inactive',f.is_inactive,'is_closed',f.is_closed,'gl_closed',f.gl_closed) order by f.start_date,f.fiscal_period_id)
     from public.fiscal_periods f where f.subsidiary_id=sid),'[]'::jsonb),
   'rates',coalesce((select jsonb_agg(jsonb_build_object('exchange_rate_id',r.exchange_rate_id,'from_currency_id',r.from_currency_id,
     'to_currency_id',r.to_currency_id,'effective_date',r.effective_date,'spot_rate',r.spot_rate) order by r.effective_date,r.exchange_rate_id)
     from public.exchange_rates r where r.to_currency_id=local_currency and (r.from_currency_id=local_currency or exists(
       select 1 from public.subsidiary_currencies sc where sc.subsidiary_id=sid and sc.currency_id=r.from_currency_id))),'[]'::jsonb)
  ) into result;
 else
  select jsonb_build_object(
   'accounts',coalesce((select jsonb_agg(jsonb_build_object('account_id',a.account_id,'account_number',a.account_number,
     'account_name',a.account_name,'is_inactive',a.is_inactive,'accepts_entries',a.accepts_entries,'subsidiary_ids',jsonb_build_array(sid)) order by a.account_number,a.account_id)
     from public.chart_accounts a where not coalesce(a.is_inactive,false) and not coalesce(a.is_summary,false) and coalesce(a.accepts_entries,true)
       and exists(select 1 from public.account_subsidiaries scope where scope.account_id=a.account_id and scope.subsidiary_id=sid and scope.is_active)),'[]'::jsonb),
   'taxes',coalesce((select jsonb_agg(jsonb_build_object('tax_code_id',t.tax_code_id,'code_name',t.code_name,'rate_percentage',t.rate_percentage,
     'tax_type_id',t.tax_type_id,'subsidiary_id',t.subsidiary_id) order by t.code_name,t.tax_code_id) from public.tax_codes t
     where t.subsidiary_id=sid or (t.subsidiary_id is null and (t.country_id is null or t.country_id=country))),'[]'::jsonb),
   'taxTypes',coalesce((select jsonb_agg(jsonb_build_object('tax_type_id',t.tax_type_id,'asset_account_id',t.asset_account_id,
     'liability_account_id',t.liability_account_id) order by t.tax_type_id) from public.tax_types t where exists(select 1 from public.tax_codes c
       where c.tax_type_id=t.tax_type_id and (c.subsidiary_id=sid or (c.subsidiary_id is null and (c.country_id is null or c.country_id=country))))),'[]'::jsonb),
   'departments',coalesce((select jsonb_agg(jsonb_build_object('department_id',d.department_id,'name',d.name,'type',d.type,'subsidiary_ids',jsonb_build_array(sid)) order by d.name,d.department_id)
     from public.departments d where not coalesce(d.is_inactive,false) and exists(select 1 from public.department_subsidiaries scope where scope.department_id=d.department_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'classes',coalesce((select jsonb_agg(jsonb_build_object('class_id',c.class_id,'name',c.name,'subsidiary_ids',jsonb_build_array(sid)) order by c.name,c.class_id)
     from public.classes c where not coalesce(c.is_inactive,false) and exists(select 1 from public.class_subsidiaries scope where scope.class_id=c.class_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'costs',coalesce((select jsonb_agg(jsonb_build_object('cost_center_id',c.cost_center_id,'name',c.name,'customer_id',c.customer_id,
     'class_id',c.class_id,'subsidiary_id',c.subsidiary_id) order by c.name,c.cost_center_id) from public.cost_centers c where c.subsidiary_id=sid and not coalesce(c.is_inactive,false)),'[]'::jsonb),
   'creditors',coalesce((select jsonb_agg(jsonb_build_object('financial_creditor_id',c.financial_creditor_id,'name',c.name,'subsidiary_ids',jsonb_build_array(sid)) order by c.name,c.financial_creditor_id)
     from public.financial_creditors c where not coalesce(c.is_inactive,false) and exists(select 1 from public.financial_creditor_subsidiaries scope where scope.financial_creditor_id=c.financial_creditor_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'related',coalesce((select jsonb_agg(jsonb_build_object('related_company_id',c.related_company_id,'name',c.name,'country_id',c.country_id,'subsidiary_ids',jsonb_build_array(sid)) order by c.name,c.related_company_id)
     from public.related_companies c where not coalesce(c.is_inactive,false) and exists(select 1 from public.related_company_subsidiaries scope where scope.related_company_id=c.related_company_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'customers',coalesce((select jsonb_agg(jsonb_build_object('customer_id',c.customer_id,'company_name',c.company_name,'department_id',c.department_id,'subsidiary_ids',jsonb_build_array(sid)) order by c.company_name,c.customer_id)
     from public.customers c where exists(select 1 from public.entity_subsidiaries scope where scope.customer_id=c.customer_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'suppliers',coalesce((select jsonb_agg(jsonb_build_object('supplier_id',s.supplier_id,'company_name',s.company_name,'subsidiary_ids',jsonb_build_array(sid)) order by s.company_name,s.supplier_id)
     from public.suppliers s where exists(select 1 from public.entity_subsidiaries scope where scope.supplier_id=s.supplier_id and scope.subsidiary_id=sid)),'[]'::jsonb),
   'employees',coalesce((select jsonb_agg(jsonb_build_object('employee_id',e.employee_id,'first_name',e.first_name,'last_name',e.last_name,'subsidiary_id',e.subsidiary_id) order by e.first_name,e.last_name,e.employee_id)
     from public.employees e where e.subsidiary_id=sid and e.is_active),'[]'::jsonb),
   'countries',coalesce((select jsonb_agg(jsonb_build_object('country_id',c.country_id,'name',c.name) order by c.name,c.country_id) from public.countries c),'[]'::jsonb)
  ) into result;
 end if;
 return result;
end$$;

create function journal_entry_private.form_detail(p_journal_id bigint)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;result jsonb;
begin
 if p_journal_id is null then raise exception using errcode='22023',message='Seleccione un asiento válido.';end if;
 sid:=journal_entry_private.form_context(p_journal_id);
 select jsonb_build_object('journal',jsonb_build_object('journal_id',j.journal_id,'journal_number',j.journal_number,
   'journal_date',j.journal_date,'journal_type',j.journal_type,'subsidiary_id',j.subsidiary_id,'currency_id',j.currency_id,
   'fiscal_period_id',j.fiscal_period_id,'exchange_rate',j.exchange_rate,'memo',j.memo,'status',j.status),
  'lines',coalesce((select jsonb_agg(jsonb_build_object('journal_line_id',l.journal_line_id,'journal_id',l.journal_id,
    'account_id',l.account_id,'debit',l.debit,'credit',l.credit,'tax_code_id',l.tax_code_id,'tax_rate',l.tax_rate,
    'gross_amount',l.gross_amount,'service_month',l.service_month,'service_country_id',l.service_country_id,'note',l.note,
    'entity_type',l.entity_type,'customer_id',l.customer_id,'supplier_id',l.supplier_id,'employee_id',l.employee_id,
    'department_id',l.department_id,'cost_center_id',l.cost_center_id,'class_id',l.class_id,
    'financial_creditor_id',l.financial_creditor_id,'related_company_id',l.related_company_id) order by l.journal_line_id)
    from public.journal_line l where l.journal_id=p_journal_id),'[]'::jsonb)) into result
 from public.journal j where j.journal_id=p_journal_id and j.subsidiary_id=sid;
 return result;
end$$;

create function journal_entry_private.form_supports(p_journal_id bigint)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;result jsonb;
begin
 if p_journal_id is null then raise exception using errcode='22023',message='Seleccione un asiento válido.';end if;
 sid:=journal_entry_private.form_context(p_journal_id);
 select coalesce(jsonb_agg(jsonb_build_object('support_id',s.support_id,'journal_id',s.journal_id,'support_type',s.support_type,
   'display_name',s.display_name,'support_url',s.support_url,'file_name',s.file_name,'mime_type',s.mime_type,'file_size',s.file_size,
   'file_data',s.file_data) order by s.support_id),'[]'::jsonb) into result from public.journal_support s
 where s.journal_id=p_journal_id and exists(select 1 from public.journal j where j.journal_id=s.journal_id and j.subsidiary_id=sid);
 return result;
end$$;

-- Thin invoker wrappers keep privileged implementations in the private schema.
-- Only the three independently-authorized read functions become callable;
-- all pre-existing private writers and helpers retain their revoked ACLs.
create function public.manual_journal_form_options(p_section text,p_journal_id bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public,pg_temp
as $$select journal_entry_private.form_options(p_section,p_journal_id)$$;
create function public.manual_journal_form_detail(p_journal_id bigint)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public,pg_temp
as $$select journal_entry_private.form_detail(p_journal_id)$$;
create function public.manual_journal_form_supports(p_journal_id bigint)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public,pg_temp
as $$select journal_entry_private.form_supports(p_journal_id)$$;

revoke all on function journal_entry_private.form_context(bigint),journal_entry_private.form_options(text,bigint),
 journal_entry_private.form_detail(bigint),journal_entry_private.form_supports(bigint),
 public.manual_journal_form_options(text,bigint),public.manual_journal_form_detail(bigint),public.manual_journal_form_supports(bigint)
 from public,anon,authenticated,service_role;
grant usage on schema journal_entry_private to authenticated;
grant execute on function journal_entry_private.form_options(text,bigint),journal_entry_private.form_detail(bigint),
 journal_entry_private.form_supports(bigint),public.manual_journal_form_options(text,bigint),
 public.manual_journal_form_detail(bigint),public.manual_journal_form_supports(bigint) to authenticated;

notify pgrst,'reload schema';
