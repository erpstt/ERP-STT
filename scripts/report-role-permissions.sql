-- Per-report grants. Existing grants are inherited once; new reports default to denied.
-- Functions remain at their existing identities with unchanged owners and ACLs.
create schema if not exists report_access_private;
revoke all on schema report_access_private from public,anon,authenticated;
create or replace function report_access_private.enter(p_key text) returns void
language plpgsql volatile security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 -- One PostgREST RPC is one transaction. An authorized root report may invoke
 -- its report dependencies (e.g. classification uses aging) without granting
 -- those dependencies as independent reports. This helper is never exposed.
 if nullif(current_setting('erp.authorized_report_root',true),'') is not null then return;end if;
 if p_key is null or p_key !~ '^[a-z0-9-]+$' then raise exception using errcode='42501',message='Informe no autorizado.';end if;
 perform public.security_assert_role_access('reports:'||p_key,'view');
 perform set_config('erp.authorized_report_root',p_key,true);
end $$;
revoke all on function report_access_private.enter(text) from public,anon,authenticated;

insert into public.role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete,updated_by,
 created_by_id,created_by_email,created_by_name,actor_type,actor_source,execution_context_id)
select m.role_id,'reports:'||r.key,true,false,false,false,m.updated_by,
 m.created_by_id,m.created_by_email,m.created_by_name,m.actor_type,m.actor_source,m.execution_context_id
from public.role_access_matrix m join (values
('balance-sheet','reports:accounting-reports'),
('income-statement','reports:accounting-reports'),
('cash-flow','reports:accounting-reports'),
('equity-changes','reports:accounting-reports'),
('trial-balance','reports:accounting-reports'),
('general-ledger','reports:accounting-reports'),
('journal','reports:accounting-reports'),
('pending-invoice-control','reports:accounting-reports'),
('sales-transactions','reports:accounting-reports'),
('purchase-transactions','reports:accounting-reports'),
('receivables-aging','reports:accounting-reports'),
('payables-aging','reports:accounting-reports'),
('payroll-journals','reports:accounting-reports'),
('accrued-payroll-payables','reports:accounting-reports'),
('supplier-advances','reports:accounting-reports'),
('bank-reconciliation','reports:accounting-reports'),
('bank-balances','reports:accounting-reports'),
('classified-receivables','reports:accounting-reports'),
('income-forecast','reports:accounting-reports'),
('vat-declaration','reports:accounting-reports'),
('eight-column-balance','reports:accounting-reports'),
('fx-revaluation','reports:accounting-reports'),
('intercompany-loans','reports:accounting-reports'),
('intercompany-commercial','reports:accounting-reports'),
('settled-sales-invoices','reports:accounting-reports'),
('settled-supplier-invoices','reports:accounting-reports'),
('payment-requests','reports:accounting-reports'),
('customer-payment-fees','reports:accounting-reports'),
('asset-depreciation','fixed-assets:reports'),
('asset-summary','fixed-assets:reports'),
('asset-history','fixed-assets:reports'),
('asset-movements','fixed-assets:reports'),
('asset-reconciliation','fixed-assets:reports'),
('asset-projection','fixed-assets:reports'),
('asset-impairment','fixed-assets:reports'),
('fx-revaluation','accounting:fx-revaluation'),
('fx-revaluation','accounting:fx-revaluation-analysis'),
('customer-payment-fees','sales:customer-payments')
)r(key,source) on m.resource_key=r.source and m.can_view
on conflict(role_id,resource_key)do nothing;
-- Preserve specialized entry paths that previously did not need the common menu.
insert into public.role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete,updated_by,
 created_by_id,created_by_email,created_by_name,actor_type,actor_source,execution_context_id)
select distinct on(m.role_id)m.role_id,'reports:accounting-reports',true,false,false,false,m.updated_by,
 m.created_by_id,m.created_by_email,m.created_by_name,m.actor_type,m.actor_source,m.execution_context_id
from public.role_access_matrix m where m.resource_key like 'reports:%' and m.resource_key<>'reports:accounting-reports' and m.can_view
on conflict(role_id,resource_key)do nothing;
CREATE OR REPLACE FUNCTION public.bank_reconciliation_close_report(p_bank_account_id bigint, p_cutoff date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('bank-reconciliation');
 begin perform reconciliation_private.access('reports:accounting-reports','view');perform reconciliation_private.bank_scope(p_bank_account_id); return reconciliation_private.bank_reconciliation_close_report(p_bank_account_id,p_cutoff);end;
end
$function$;
CREATE OR REPLACE FUNCTION public.fx_report(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 if p_payload->>'runId' is null then perform report_access_private.enter('fx-revaluation');end if;
 declare sid bigint:=fx_revaluation_private.context_access();r public.fx_revaluation_runs;result jsonb;begin
 if not fx_revaluation_private.history_allowed()then perform fx_revaluation_private.access('create');r:=fx_revaluation_private.run(nullif(p_payload->>'runId','')::bigint);end if;
 result:=fx_revaluation_private.fx_report(p_payload);
 return jsonb_set(result,'{runs}',coalesce((select jsonb_agg(x||jsonb_build_object('canCancel',fx_revaluation_private.can_cancel() and x->>'status'='CONTABILIZADO' and not exists(select 1 from public.fx_revaluation_runs later where later.subsidiary_id=sid and later.currency_id=(x->>'currency_id')::bigint and later.closing_date>(x->>'closing_date')::date and later.status='CONTABILIZADO')))from jsonb_array_elements(coalesce(result->'runs','[]'::jsonb))x),'[]'::jsonb));end;
end
$function$;
CREATE OR REPLACE FUNCTION public.income_forecast_save(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('income-forecast');
 begin perform report_template_private.enter('reports:accounting-reports','view');
begin
 perform income_forecast_source(p->'configuration');
 return income_forecast_save_before_scope(p);
end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.income_forecast_source(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('income-forecast');
 begin perform report_template_private.enter('reports:accounting-reports','view');

declare scoped jsonb:=coalesce(p,'{}');sid bigint:=active_subsidiary_id();requested bigint[];begin
 if sid is null then raise exception 'Seleccione una empresa activa.';end if;
 if coalesce((scoped->>'consolidated')::boolean,false)then
  if not consolidation_has_permission('ACC_CONSOLIDATION_RUN')then raise exception 'No tiene permiso para consultar proyecciones consolidadas.';end if;
  if nullif(scoped->>'holdingId','')is null then raise exception 'Seleccione la holding de consolidación.';end if;
 else
  select array_agg(value::bigint)into requested from jsonb_array_elements_text(coalesce(scoped->'subsidiaryIds','[]'));
  if cardinality(coalesce(requested,array[]::bigint[]))<>1 or requested[1]<>sid then raise exception 'El Estado de Resultados Proyectado corresponde únicamente a la empresa activa.';end if;
  scoped:=scoped||jsonb_build_object('subsidiaryIds',jsonb_build_array(sid),'consolidated',false,'holdingId',null);
 end if;
 return income_forecast_source_before_scope(scoped);
end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.purchase_transaction_support(p_support_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('purchase-transactions');
 begin perform report_template_private.enter('reports:accounting-reports','view');
begin perform asset_posting_private.access('reports:accounting-reports','view');if not exists(select 1 from public.journal_support s join public.journal j using(journal_id) where s.support_id=p_support_id and j.subsidiary_id=asset_posting_private.identity()) then raise exception using errcode='42501',message='Respaldo no disponible.';end if;return supplier_invoice_private.purchase_transaction_support(p_support_id);end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_accounting_report(p_report text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter(p_report);
 begin perform report_template_private.enter('reports:accounting-reports','view');

begin
  if p_report='intercompany-commercial'then
    return public.run_intercompany_commercial_report(p_filters);
  end if;
  return public.run_accounting_report_before_intercompany_commercial(
    p_report,p_filters
  );
end
;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_accrued_payroll_payables_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('accrued-payroll-payables');
 declare sid bigint;uid bigint;from_date date;to_date date;book bigint;account bigint;currency bigint;department bigint;cost bigint;
 only_nonzero boolean:=true;page_no integer:=1;page_size integer:=50;key text;filter_value text;group_count bigint;group_info jsonb;local_currency jsonb;result jsonb;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 uid:=public.app_user_id();sid:=public.active_subsidiary_id();
 if uid is null or sid is null or not exists(select 1 from public.users u join public.user_subsidiaries s using(user_id)where u.user_id=uid and u.is_active and s.subsidiary_id=sid)then
  raise exception using errcode='42501',message='La empresa activa no está autorizada.';
 end if;
 if p_filters is null or jsonb_typeof(p_filters)<>'object'or exists(select 1 from jsonb_object_keys(p_filters)k where k not in('subsidiaryIds','dateFrom','dateTo','bookId','accountId','currencyId','departmentId','costCenterId','onlyNonzero','page','pageSize'))then
  raise exception using errcode='22023',message='Los filtros del reporte no son válidos.';
 end if;
 if jsonb_typeof(p_filters->'subsidiaryIds')is distinct from'array'or jsonb_array_length(p_filters->'subsidiaryIds')<>1 or coalesce(p_filters#>>'{subsidiaryIds,0}','')!~'^[1-9][0-9]{0,18}$'then
  raise exception using errcode='22023',message='Seleccione una sola empresa.';
 end if;
 begin
  if(p_filters#>>'{subsidiaryIds,0}')::bigint<>sid then raise exception using errcode='42501',message='La empresa solicitada no coincide con la empresa activa.';end if;
  if coalesce(p_filters->>'dateFrom','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'or coalesce(p_filters->>'dateTo','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'then
   raise exception using errcode='22023',message='El período no es válido.';
  end if;
  from_date:=(p_filters->>'dateFrom')::date;to_date:=(p_filters->>'dateTo')::date;
  if from_date>to_date then raise exception using errcode='22023',message='La fecha inicial no puede superar la final.';end if;
  foreach key in array array['bookId','accountId','currencyId','departmentId','costCenterId']loop
   filter_value:=p_filters->>key;
   if filter_value is not null and filter_value!~'^[1-9][0-9]{0,18}$'then raise exception using errcode='22023',message='El identificador de un filtro no es válido.';end if;
   case key when'bookId'then book:=filter_value::bigint;when'accountId'then account:=filter_value::bigint;when'currencyId'then currency:=filter_value::bigint;when'departmentId'then department:=filter_value::bigint;else cost:=filter_value::bigint;end case;
  end loop;
  if p_filters?'onlyNonzero'then
   if jsonb_typeof(p_filters->'onlyNonzero')<>'boolean'then raise exception using errcode='22023',message='El filtro de actividad no es válido.';end if;
   only_nonzero:=(p_filters->>'onlyNonzero')::boolean;
  end if;
  foreach key in array array['page','pageSize']loop
   if p_filters?key then filter_value:=p_filters->>key;
    if filter_value is null or filter_value!~'^[1-9][0-9]{0,9}$'then raise exception using errcode='22023',message='La paginación no es válida.';end if;
    if key='page'then page_no:=filter_value::integer;else page_size:=filter_value::integer;end if;
   end if;
  end loop;
 exception when numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode='22023',message='Los filtros del reporte no son válidos.';
 end;
 if page_size>250 then raise exception using errcode='22023',message='El tamaño de página no es válido.';end if;
 if book is not null and not exists(select 1 from public.accounting_books b where b.accounting_book_id=book and b.subsidiary_id=sid)then raise exception using errcode='42501',message='El libro no pertenece a la empresa activa.';end if;
 select count(*),jsonb_build_object('id',min(group_id),'code','223','name',min(group_name))into group_count,group_info from public.account_group where group_code='223';
 if group_count>1 then raise exception using errcode='55000',message='El grupo 223 no tiene una identificación única.';end if;
 if account is not null and not exists(with recursive groups as(select group_id from public.account_group where group_code='223'union select g.group_id from public.account_group g join groups p on g.parent_id=p.group_id)select 1 from public.chart_accounts a where a.account_id=account and a.account_group_id in(select group_id from groups))then
  raise exception using errcode='22023',message='La cuenta no pertenece al grupo 223.';
 end if;
 select jsonb_build_object('id',c.currency_id,'code',c.currency_code)into local_currency from public.subsidiaries s left join public.currencies c on c.currency_id=s.currency_id where s.subsidiary_id=sid;
 with recursive groups as(select group_id from public.account_group where group_code='223'union select g.group_id from public.account_group g join groups p on g.parent_id=p.group_id),
 eligible_accounts as materialized(select a.*from public.chart_accounts a where a.account_group_id in(select group_id from groups)),
 control as materialized(
  select coalesce(sum(g.credit_amount-g.debit_amount)filter(where g.posting_date<from_date),0)opening,
   coalesce(sum(g.debit_amount)filter(where g.posting_date>=from_date),0)debit,
   coalesce(sum(g.credit_amount)filter(where g.posting_date>=from_date),0)credit,
   coalesce(sum(g.credit_amount-g.debit_amount),0)closing
  from public.gl_impact g join eligible_accounts a using(account_id)
  where g.subsidiary_id=sid and g.posting_date<=to_date and(book is null or g.accounting_book_id=book)
 ),all_source as materialized(select *from accrued_payroll_report_private.source_rows(sid,to_date,book)),
 selected as materialized(
  select r.*from all_source r where(account is null or r.account_id=account)and(currency is null or r.currency_id=currency)
   and(department is null or r.department_id=department)and(cost is null or r.cost_center_id=cost)
 ),leaf_state as materialized(
  select account_id,max(account_number)account_number,max(account_name)account_name,currency_id,max(currency_code)currency_code,
   department_id,max(department_name)department_name,cost_center_id,max(cost_center_code)cost_center_code,max(cost_center_name)cost_center_name,
   bool_and(currency_id is not null and debit_original is not null and credit_original is not null)native_complete,
   bool_or(quality_reason is not null or currency_id is null)has_quality,
   count(*)filter(where posting_date<from_date)previous_count,count(*)filter(where posting_date>=from_date)movement_count,
   count(*)filter(where posting_date<from_date and(quality_reason is not null or currency_id is null))unattributed_opening,
   count(*)filter(where posting_date>=from_date and(quality_reason is not null or currency_id is null))unattributed_movements,
   coalesce(sum(credit_original-debit_original)filter(where posting_date<from_date),0)opening_original,
   coalesce(sum(credit_local-debit_local)filter(where posting_date<from_date),0)opening_local,
   coalesce(sum(credit_original-debit_original)filter(where posting_date>=from_date and movement_type='payroll'),0)payroll_original,
   coalesce(sum(credit_local-debit_local)filter(where posting_date>=from_date and movement_type='payroll'),0)payroll_local,
   coalesce(sum(debit_original-credit_original)filter(where posting_date>=from_date and movement_type='payment'),0)payment_original,
   coalesce(sum(debit_local-credit_local)filter(where posting_date>=from_date and movement_type='payment'),0)payment_local,
   coalesce(sum(credit_original-debit_original)filter(where posting_date>=from_date and movement_type='other'),0)other_original,
   coalesce(sum(credit_local-debit_local)filter(where posting_date>=from_date and movement_type='other'),0)other_local,
   coalesce(sum(debit_original)filter(where posting_date>=from_date),0)debit_original,coalesce(sum(credit_original)filter(where posting_date>=from_date),0)credit_original,
   coalesce(sum(debit_local)filter(where posting_date>=from_date),0)debit_local,coalesce(sum(credit_local)filter(where posting_date>=from_date),0)credit_local,
   coalesce(sum(credit_original-debit_original),0)closing_original,coalesce(sum(credit_local-debit_local),0)closing_local
  from selected group by account_id,currency_id,department_id,cost_center_id
 ),active_leaves as materialized(
  select s.*,case when previous_count>0 and(not only_nonzero or opening_original<>0 or opening_local<>0 or unattributed_opening>0 or not native_complete)then 1 else 0 end virtual_count
  from leaf_state s where not only_nonzero or movement_count>0 or opening_original<>0 or opening_local<>0 or closing_original<>0 or closing_local<>0 or has_quality
 ),period_rows as(
  select r.*,case when l.native_complete then l.opening_original+sum(r.credit_original-r.debit_original)over w end running_original,
   l.opening_local+sum(r.credit_local-r.debit_local)over w running_local
  from selected r join active_leaves l on l.account_id=r.account_id and l.currency_id is not distinct from r.currency_id
   and l.department_id is not distinct from r.department_id and l.cost_center_id is not distinct from r.cost_center_id
  where r.posting_date>=from_date
  window w as(partition by r.account_id,r.currency_id,r.department_id,r.cost_center_id order by r.posting_date,r.source_key rows unbounded preceding)
 ),display_rows as materialized(
  select r.source_key,'movement'::text row_kind,r.posting_date,r.account_id,r.account_number,r.account_name,r.currency_id,r.currency_code,r.department_id,r.department_name,r.cost_center_id,r.cost_center_code,r.cost_center_name,
   r.book_id,r.book_name,r.journal_id,r.journal_number,r.document_number,r.note,r.movement_type,r.quality_reason,
   r.debit_original,r.credit_original,r.debit_local,r.credit_local,0::numeric opening_original,0::numeric opening_local,
   case when r.movement_type='payroll'then r.credit_original-r.debit_original else 0 end payroll_original,
   case when r.movement_type='payroll'then r.credit_local-r.debit_local else 0 end payroll_local,
   case when r.movement_type='payment'then r.debit_original-r.credit_original else 0 end payment_original,
   case when r.movement_type='payment'then r.debit_local-r.credit_local else 0 end payment_local,
   case when r.movement_type='other'then r.credit_original-r.debit_original else 0 end other_original,
   case when r.movement_type='other'then r.credit_local-r.debit_local else 0 end other_local,
   r.running_original closing_original,r.running_local closing_local,r.running_original,r.running_local
  from period_rows r
  union all
  select 'opening:'||jsonb_build_array(l.account_id,l.currency_id,l.department_id,l.cost_center_id)::text,'opening',from_date,
   l.account_id,l.account_number,l.account_name,l.currency_id,l.currency_code,l.department_id,l.department_name,l.cost_center_id,l.cost_center_code,l.cost_center_name,
   book,(select b.book_name from public.accounting_books b where b.accounting_book_id=book and b.subsidiary_id=sid),null::bigint,null::text,null::text,'Saldo anterior al período',null::text,
   case when l.unattributed_opening>0 or not l.native_complete then'Incluye movimientos anteriores no identificados.'end,
   0,0,0,0,case when l.native_complete then l.opening_original end,l.opening_local,0,0,0,0,0,0,
   case when l.native_complete then l.opening_original end,l.opening_local,case when l.native_complete then l.opening_original end,l.opening_local
  from active_leaves l where l.virtual_count=1
 ),paged as(
  select *from display_rows order by account_number,currency_code nulls last,department_name nulls last,department_id nulls last,cost_center_code nulls last,cost_center_id nulls last,
   posting_date,case row_kind when'opening'then 0 else 1 end,source_key limit page_size offset((page_no::bigint-1)*page_size)
 ),rollup as(
  select case grouping(l.currency_id,l.department_id,l.cost_center_id)when 7 then'account'when 3 then'currency'when 1 then'department'else'leaf'end level,
   l.account_id,max(l.account_number)account_number,max(l.account_name)account_name,l.currency_id,
   case when grouping(l.currency_id)=0 then max(l.currency_code)end currency_code,l.department_id,
   case when grouping(l.department_id)=0 then max(l.department_name)end department_name,l.cost_center_id,
   case when grouping(l.cost_center_id)=0 then max(l.cost_center_code)end cost_center_code,
   case when grouping(l.cost_center_id)=0 then max(l.cost_center_name)end cost_center_name,
   sum(l.movement_count)movement_count,sum(l.movement_count+l.virtual_count)total_rows,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.opening_original)end opening_original,sum(l.opening_local)opening_local,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.payroll_original)end payroll_original,sum(l.payroll_local)payroll_local,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.payment_original)end payment_original,sum(l.payment_local)payment_local,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.other_original)end other_original,sum(l.other_local)other_local,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.debit_original)end debit_original,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.credit_original)end credit_original,
   sum(l.debit_local)debit_local,sum(l.credit_local)credit_local,
   case when count(distinct l.currency_id)=1 and bool_and(l.native_complete)then sum(l.closing_original)end closing_original,sum(l.closing_local)closing_local,
   case when bool_or(l.has_quality)then'Incluye movimientos no identificados.'end quality_reason
  from active_leaves l group by grouping sets((l.account_id),(l.account_id,l.currency_id),(l.account_id,l.currency_id,l.department_id),(l.account_id,l.currency_id,l.department_id,l.cost_center_id))
 ),totals_json as materialized(
  select r.level,r.account_number,r.currency_code,r.department_name,r.cost_center_code,jsonb_build_object(
   'accountId',r.account_id,'accountNumber',r.account_number,'accountName',r.account_name,'currencyId',r.currency_id,'currencyCode',r.currency_code,
   'departmentId',r.department_id,'departmentName',r.department_name,'costCenterId',r.cost_center_id,'costCenterCode',r.cost_center_code,'costCenterName',r.cost_center_name,
   'movementCount',r.movement_count,'totalRows',r.total_rows,'openingOriginal',r.opening_original,'openingLocal',r.opening_local,
   'payrollOriginal',r.payroll_original,'payrollLocal',r.payroll_local,'paymentOriginal',r.payment_original,'paymentLocal',r.payment_local,
   'otherOriginal',r.other_original,'otherLocal',r.other_local,'debitOriginal',r.debit_original,'creditOriginal',r.credit_original,'debitLocal',r.debit_local,'creditLocal',r.credit_local,
   'closingOriginal',r.closing_original,'closingLocal',r.closing_local,'qualityReason',r.quality_reason)value from rollup r
 )
 select jsonb_build_object('context',jsonb_build_object('subsidiaryId',sid,'dateFrom',from_date,'dateTo',to_date,'bookId',book,'accountId',account,'currencyId',currency,'departmentId',department,'costCenterId',cost,'onlyNonzero',only_nonzero),
  'group',group_info,'localCurrency',local_currency,
  'filterOptions',jsonb_build_object(
   'accounts',(select coalesce(jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name)order by a.account_number),'[]')from eligible_accounts a where exists(select 1 from public.account_subsidiaries s where s.account_id=a.account_id and s.subsidiary_id=sid)or a.account_id in(select account_id from all_source)),
   'currencies',(select coalesce(jsonb_agg(jsonb_build_object('id',c.currency_id,'code',c.currency_code)order by c.currency_code),'[]')from public.currencies c where exists(select 1 from public.subsidiary_currencies s where s.currency_id=c.currency_id and s.subsidiary_id=sid)or c.currency_id in(select currency_id from all_source)),
   'departments',(select coalesce(jsonb_agg(jsonb_build_object('id',d.department_id,'name',d.name)order by d.name,d.department_id),'[]')from public.departments d where d.subsidiary_id=sid or exists(select 1 from public.department_subsidiaries s where s.department_id=d.department_id and s.subsidiary_id=sid)),
   'costCenters',(select coalesce(jsonb_agg(jsonb_build_object('id',c.cost_center_id,'code',c.code,'name',c.name)order by c.code,c.cost_center_id),'[]')from public.cost_centers c where c.subsidiary_id=sid)),
  'totalRows',(select count(*)from display_rows),'movementCount',(select coalesce(sum(movement_count),0)from active_leaves),'page',page_no,'pageSize',page_size,
  'dataFingerprint',(select md5(coalesce(jsonb_agg(to_jsonb(r)order by source_key),'[]')::text)from display_rows r),
  'rows',(select coalesce(jsonb_agg(jsonb_build_object('rowId',source_key,'sourceKey',source_key,'rowKind',row_kind,'date',posting_date,
   'accountId',account_id,'accountNumber',account_number,'accountName',account_name,'currencyId',currency_id,'currencyCode',currency_code,
   'departmentId',department_id,'departmentName',department_name,'costCenterId',cost_center_id,'costCenterCode',cost_center_code,'costCenterName',cost_center_name,
   'bookId',book_id,'bookName',book_name,'journalId',journal_id,'journalNumber',journal_number,'documentNumber',document_number,'note',note,'movementType',movement_type,'qualityReason',quality_reason,
   'debitOriginal',debit_original,'creditOriginal',credit_original,'debitLocal',debit_local,'creditLocal',credit_local,
   'openingOriginal',opening_original,'openingLocal',opening_local,'payrollOriginal',payroll_original,'payrollLocal',payroll_local,'paymentOriginal',payment_original,'paymentLocal',payment_local,
   'otherOriginal',other_original,'otherLocal',other_local,'closingOriginal',closing_original,'closingLocal',closing_local,'runningBalanceOriginal',running_original,'runningBalanceLocal',running_local)
   order by account_number,currency_code nulls last,department_name nulls last,department_id nulls last,cost_center_code nulls last,cost_center_id nulls last,posting_date,case row_kind when'opening'then 0 else 1 end,source_key),'[]')from paged),
  'accountTotals',(select coalesce(jsonb_agg(value order by account_number),'[]')from totals_json where level='account'),
  'currencyTotals',(select coalesce(jsonb_agg(value order by account_number,currency_code nulls last),'[]')from totals_json where level='currency'),
  'departmentTotals',(select coalesce(jsonb_agg(value order by account_number,currency_code nulls last,department_name nulls last),'[]')from totals_json where level='department'),
  'leafTotals',(select coalesce(jsonb_agg(value order by account_number,currency_code nulls last,department_name nulls last,cost_center_code nulls last),'[]')from totals_json where level='leaf'),
  'summary',jsonb_build_object('controlOpeningLocal',(select opening from control),'controlDebitLocal',(select debit from control),'controlCreditLocal',(select credit from control),'controlClosingLocal',(select closing from control),
   'reportedOpeningLocal',(select coalesce(sum(opening_local),0)from active_leaves),'reportedClosingLocal',(select coalesce(sum(closing_local),0)from active_leaves),
   'differenceLocal',case when account is null and currency is null and department is null and cost is null then(select coalesce(sum(closing_local),0)from active_leaves)-(select closing from control)end,
   'reconciliationAvailable',account is null and currency is null and department is null and cost is null,
   'reconciliationReason',case when account is not null or currency is not null or department is not null or cost is not null then'FILTERED_SELECTION'end,
   'unattributedMovementCount',(select coalesce(sum(unattributed_movements),0)from active_leaves),
   'unattributedOpeningCount',(select coalesce(sum(unattributed_opening),0)from active_leaves)))into result;
 return result;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_aging_report(p_kind text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter(case p_kind when 'AR' then 'receivables-aging' when 'AP' then 'payables-aging' else null end);
 begin perform report_template_private.enter('reports:accounting-reports','view');

declare filter_invoice_type text:=report_delivery_private.payable_invoice_type_filter(p_kind,p_filters);all_type_totals jsonb:='[]';all_advances jsonb:='[]';scaled_type_totals jsonb;scaled_advances jsonb;consolidated boolean:=coalesce((p_filters->>'consolidated')::boolean,false);cutoff date:=nullif(p_filters->>'dateTo','')::date;period_key text;holding_id bigint;usd_id bigint;company record;report jsonb;item jsonb;application jsonb;scaled_applications jsonb;all_rows jsonb:='[]';rate numeric;summary jsonb:=jsonb_build_object('subledger',0,'advances',0,'netBalance',0,'controlBalance',0,'difference',0);page_no int:=greatest(coalesce((p_filters->>'page')::int,1),1);page_size int:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),250);company_page int;total_rows int;begin
 if not consolidated then return run_aging_report_before_consolidation(p_kind,p_filters);end if;
 if cutoff is null then raise exception 'La fecha de corte es obligatoria.';end if;period_key:=to_char(cutoff,'YYYY-MM');
 select subsidiary_id into holding_id from subsidiaries where lower(trim(name))='stt group latin american'limit 1;select currency_id into usd_id from currencies where currency_code='USD';
 if usd_id is null then raise exception 'Configure la moneda USD para generar el consolidado.';end if;
 for company in select s.subsidiary_id,s.name,s.currency_id from subsidiaries s join user_subsidiaries us using(subsidiary_id)where us.user_id=app_user_id()and s.is_active order by s.name loop
  rate:=operational_usd_closing_rate(company.subsidiary_id,cutoff);if rate is null then raise exception 'Falta la tasa de cierre hacia USD para % en %.',company.name,period_key;end if;
  company_page:=1;
  loop
   report:=run_aging_report_before_consolidation(p_kind,(p_filters-'consolidated')||jsonb_build_object('subsidiaryIds',jsonb_build_array(company.subsidiary_id),'agingCurrencyMode','LOCAL','page',company_page,'pageSize',250));
   for item in select value from jsonb_array_elements(coalesce(report->'rows','[]')) loop
    select coalesce(jsonb_agg(a.value||jsonb_build_object('amount',round(coalesce((a.value->>'amount')::numeric,0)*rate,2))),'[]')into scaled_applications from jsonb_array_elements(coalesce(item->'applications','[]'))a(value);
    all_rows:=all_rows||jsonb_build_array(item||jsonb_build_object('subsidiary_id',company.subsidiary_id,'subsidiary_name',company.name,'presentation_currency','USD','conversion_rate',rate,'original_amount',round(coalesce((item->>'original_amount')::numeric,0)*rate,2),'applied_amount',round(coalesce((item->>'applied_amount')::numeric,0)*rate,2),'pending',round(coalesce((item->>'pending')::numeric,0)*rate,2),'entity_advances',round(coalesce((item->>'entity_advances')::numeric,0)*rate,2),'applications',scaled_applications));
   end loop;
   exit when jsonb_array_length(coalesce(report->'rows','[]'))=0 or company_page*250>=coalesce((report->>'total')::int,0);company_page:=company_page+1;
  end loop;
  if p_kind='AP'then
    select coalesce(jsonb_agg(metadata_row||jsonb_build_object('currencyId',usd_id,'currencyCode','USD',
      'originalAmount',(metadata_row->>'originalAmount')::numeric*rate,'appliedAmount',(metadata_row->>'appliedAmount')::numeric*rate,
      'pending',(metadata_row->>'pending')::numeric*rate,'buckets',(select jsonb_object_agg(key,(value#>>'{}')::numeric*rate)from jsonb_each(metadata_row->'buckets')))),'[]'::jsonb)
      into scaled_type_totals from jsonb_array_elements(coalesce(report->'invoiceTypeTotals','[]'::jsonb))x(metadata_row);
    all_type_totals:=all_type_totals||scaled_type_totals;
    select coalesce(jsonb_agg(metadata_row||jsonb_build_object('currencyId',usd_id,'currencyCode','USD','amount',(metadata_row->>'amount')::numeric*rate)),'[]'::jsonb)
      into scaled_advances from jsonb_array_elements(coalesce(report->'unallocatedAdvancesByEntity','[]'::jsonb))x(metadata_row);
    all_advances:=all_advances||scaled_advances;
  end if;
  summary:=jsonb_build_object('subledger',(summary->>'subledger')::numeric+coalesce((report->'summary'->>'subledger')::numeric,0)*rate,'advances',(summary->>'advances')::numeric+coalesce((report->'summary'->>'advances')::numeric,0)*rate,'netBalance',(summary->>'netBalance')::numeric+coalesce((report->'summary'->>'netBalance')::numeric,0)*rate,'controlBalance',(summary->>'controlBalance')::numeric+coalesce((report->'summary'->>'controlBalance')::numeric,0)*rate,'difference',(summary->>'difference')::numeric+coalesce((report->'summary'->>'difference')::numeric,0)*rate);
 end loop;
 total_rows:=jsonb_array_length(all_rows);
 return jsonb_build_object('rows',coalesce((select jsonb_agg(value)from(select value,row_number()over()n from jsonb_array_elements(all_rows))x where n between(page_no-1)*page_size+1 and page_no*page_size),'[]'),'total',total_rows,'page',page_no,'pageSize',page_size,'summary',case when p_kind='AP'then report_delivery_private.payable_aging_type_summary(summary,filter_invoice_type)else summary end,'consolidated',true,'currency','USD','companies',(select coalesce(jsonb_agg(jsonb_build_object('id',s.subsidiary_id,'name',s.name)order by s.name),'[]')from subsidiaries s join user_subsidiaries us using(subsidiary_id)where us.user_id=app_user_id()and s.is_active))||case when p_kind='AP'then jsonb_build_object('invoiceTypeTotals',report_delivery_private.merge_payable_invoice_type_totals(all_type_totals),'unallocatedAdvancesByEntity',all_advances)else'{}'::jsonb end;
end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_bank_balance_period_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('bank-balances');
 begin perform report_template_private.enter('reports:accounting-reports','view');

declare sid bigint:=active_subsidiary_id();period_key bigint:=nullif(p_filters->>'periodId','')::bigint;period_row fiscal_periods%rowtype;local_currency record;result jsonb;
begin
 if period_key is null then raise exception 'Seleccione el período contable que desea consultar.';end if;
 select*into period_row from fiscal_periods where fiscal_period_id=period_key and subsidiary_id=sid;
 if period_row.fiscal_period_id is null then raise exception 'El período seleccionado no pertenece a la empresa activa.';end if;
 select c.currency_id,c.currency_code,c.name,c.symbol into local_currency from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=sid;
 with accounts as(
  select ba.bank_account_id,b.bank_name,ba.account_number,ba.account_id,ca.account_number ledger_account_number,ca.account_name ledger_account_name,c.currency_id,c.currency_code,c.name currency_name,c.symbol,fx.run_id revaluation_run_id,fx.status revaluation_run_status,fx.journal_number revaluation_journal,fx.posted_at revalued_at,coalesce(fx.includes_account,false)revaluation_includes_account,
   coalesce((select sum(bt.amount)from bank_transaction bt where bt.bank_account_id=ba.bank_account_id and bt.tran_date<=period_row.end_date),0)foreign_balance,
   coalesce((select sum(g.debit_amount-g.credit_amount)from gl_impact g where g.subsidiary_id=sid and g.account_id=ba.account_id and g.posting_date<=period_row.end_date),0)ledger_balance,
   case when c.currency_id=local_currency.currency_id then 1 else coalesce((select er.spot_rate from exchange_rates er where er.from_currency_id=c.currency_id and er.to_currency_id=local_currency.currency_id and er.effective_date<=period_row.end_date order by er.effective_date desc,er.exchange_rate_id desc limit 1),(select 1/er.spot_rate from exchange_rates er where er.from_currency_id=local_currency.currency_id and er.to_currency_id=c.currency_id and er.effective_date<=period_row.end_date order by er.effective_date desc,er.exchange_rate_id desc limit 1))end closing_rate
  from bank_account ba join banks b using(bank_id)join currencies c using(currency_id)join chart_accounts ca using(account_id)
  left join lateral(select r.run_id,r.status,r.posted_at,j.journal_number,exists(select 1 from jsonb_array_elements(coalesce(r.snapshot,'[]'::jsonb))item where(item->>'accountId')::bigint=ba.account_id)includes_account from fx_revaluation_runs r left join journal j on j.journal_id=r.journal_id where r.subsidiary_id=sid and r.fiscal_period_id=period_row.fiscal_period_id and r.currency_id=ba.currency_id order by case r.status when'CONTABILIZADO'then 1 when'PENDIENTE'then 2 else 3 end,r.run_id desc limit 1)fx on true
  where ba.subsidiary_id=sid and not coalesce(ba.is_credit_card,false)
 ),rows as(select*,case when closing_rate is null then null else round(foreign_balance*closing_rate,2)end local_equivalent from accounts),validation_groups as(
  select account_id,ledger_account_number,ledger_account_name,currency_id=local_currency.currency_id is_local,sum(local_equivalent)bank_total,max(ledger_balance)ledger_balance,bool_or(closing_rate is null)missing_rate,
   case when bool_or(closing_rate is null)then null else round(sum(local_equivalent)-max(ledger_balance),2)end difference
  from rows group by account_id,ledger_account_number,ledger_account_name,currency_id=local_currency.currency_id
 )
 select jsonb_build_object(
  'period',jsonb_build_object('id',period_row.fiscal_period_id,'name',period_row.period_name,'start',period_row.start_date,'end',period_row.end_date),
  'localCurrency',jsonb_build_object('id',local_currency.currency_id,'code',local_currency.currency_code,'name',local_currency.name,'symbol',local_currency.symbol),
  'localAccounts',coalesce((select jsonb_agg(jsonb_build_object('id',bank_account_id,'bank',bank_name,'account',account_number,'currency',currency_code,'currencyName',currency_name,'symbol',symbol,'balance',foreign_balance,'rate',closing_rate,'localEquivalent',local_equivalent,'ledgerAccount',ledger_account_number,'ledgerAccountName',ledger_account_name)order by bank_name,account_number)from rows where currency_id=local_currency.currency_id),'[]'::jsonb),
  'foreignAccounts',coalesce((select jsonb_agg(jsonb_build_object('id',bank_account_id,'bank',bank_name,'account',account_number,'currency',currency_code,'currencyName',currency_name,'symbol',symbol,'balance',foreign_balance,'rate',closing_rate,'localEquivalent',local_equivalent,'ledgerAccount',ledger_account_number,'ledgerAccountName',ledger_account_name,'missingRate',closing_rate is null,'revalued',revaluation_run_status='CONTABILIZADO'and revaluation_includes_account,'revaluationStatus',case when revaluation_run_id is null then'NO_REVALUADA'when revaluation_run_status='CONTABILIZADO'and revaluation_includes_account then'REVALUADA'when revaluation_run_status='CONTABILIZADO'then'NO_INCLUIDA'else revaluation_run_status end,'revaluationRunId',revaluation_run_id,'revaluationJournal',revaluation_journal,'revaluedAt',revalued_at)order by currency_code,bank_name,account_number)from rows where currency_id<>local_currency.currency_id),'[]'::jsonb),
  'localValidationGroups',coalesce((select jsonb_agg(jsonb_build_object('ledgerAccount',ledger_account_number,'ledgerAccountName',ledger_account_name,'bankTotal',bank_total,'ledgerBalance',ledger_balance,'difference',difference,'matches',abs(difference)<.005,'missingRate',missing_rate)order by ledger_account_number)from validation_groups where is_local),'[]'::jsonb),
  'foreignValidationGroups',coalesce((select jsonb_agg(jsonb_build_object('ledgerAccount',ledger_account_number,'ledgerAccountName',ledger_account_name,'bankTotal',bank_total,'ledgerBalance',ledger_balance,'difference',difference,'matches',case when difference is null then false else abs(difference)<.005 end,'missingRate',missing_rate)order by ledger_account_number)from validation_groups where not is_local),'[]'::jsonb),
  'summary',jsonb_build_object('localBankBalance',coalesce((select sum(bank_total)from validation_groups where is_local),0),'localLedgerBalance',coalesce((select sum(ledger_balance)from validation_groups where is_local),0),'foreignLocalEquivalent',coalesce((select sum(bank_total)from validation_groups where not is_local),0),'foreignLedgerBalance',coalesce((select sum(ledger_balance)from validation_groups where not is_local),0),'totalLocalEquivalent',coalesce((select sum(bank_total)from validation_groups),0),'totalLedgerBalance',coalesce((select sum(ledger_balance)from validation_groups),0),'allMatch',not exists(select 1 from validation_groups where difference is null or abs(difference)>=.005),'missingRates',coalesce((select count(*)from rows where currency_id<>local_currency.currency_id and closing_rate is null),0))
 )into result;return result;
end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_bank_reconciliation_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('bank-reconciliation');
 begin perform report_template_private.enter('reports:accounting-reports','view');
begin perform reconciliation_private.access('reports:accounting-reports','view');perform reconciliation_private.bank_scope(nullif(p_filters->>'bankAccountId','')::bigint); return (
  with report_source as materialized(
   with original_report as materialized(
   select reconciliation_private.run_bank_reconciliation_report(p_filters) payload
  ),close_evidence as materialized(
   select reconciliation_private.bank_closing_context(nullif(p_filters->>'bankAccountId','')::bigint,nullif(p_filters->>'dateTo','')::date,0::numeric) value
  )select r.payload||jsonb_build_object('closingContext',c.value)
   ||case when c.value->>'mode'='NO_MOVEMENTS'then jsonb_build_object('summary',
    coalesce(r.payload->'summary','{}'::jsonb)||jsonb_build_object(
     'statementBalance',(c.value->>'balance')::numeric,
     'difference',coalesce((r.payload#>>'{summary,bookBalance}')::numeric,0)
      +coalesce((r.payload#>>'{summary,transitPayments}')::numeric,0)
      -coalesce((r.payload#>>'{summary,transitDeposits}')::numeric,0)
      +coalesce((r.payload#>>'{summary,bankAdjustments}')::numeric,0)
      -(c.value->>'balance')::numeric))else '{}'::jsonb end payload
   from original_report r cross join close_evidence c
  ),params as materialized(
   select nullif(p_filters->>'bankAccountId','')::bigint bank_id,public.active_subsidiary_id() subsidiary_id,
    reconciliation_private.allowed('banking:bank-reconciliations','edit') can_edit
  ),erp_rows as materialized(
   select value payload,ordinality position from report_source,
    jsonb_array_elements(payload->'rows')with ordinality
  ),statement_rows as materialized(
   select value payload,ordinality position from report_source,
    jsonb_array_elements(payload->'statementLines')with ordinality
  ),closed_after as materialized(
   select
    (select max(r.reconciliation_date)from public.bank_reconciliation r,params p
     where r.bank_account_id=p.bank_id and r.status='CERRADA') classic_date,
    (select max((make_date(q.period_year,q.period_month,1)+interval'1 month'-interval'1 day')::date)
     from public.quadratic_bank_reconciliations q,params p
     where q.bank_account_id=p.bank_id and q.status in('approved','closed')) quadratic_date
  ),matched_sources as materialized(
   select m.match_id,m.bank_tran_id,m.statement_line_id,bt.transaction_id,r.reconciliation_id,
    r.reconciliation_date reconciliation_cutoff,
    coalesce(p.can_edit and r.status='ABIERTA'and r.closed_at is null
     and bt.reconciliation_status='CONCILIADO'and sl.reconciliation_status='CONCILIADO'
     and bt.tran_type<>'SALDO_INICIAL'
     and bt.tran_date<=r.reconciliation_date and sl.bank_date<=r.reconciliation_date
     and st.statement_date<=r.reconciliation_date
     and reconciliation_private.finite(bt.amount)and reconciliation_private.finite(sl.amount)
     and abs(bt.amount-sl.amount)<.005
     and(bt.transaction_id is null or t.transaction_id is not null and t.subsidiary_id=p.subsidiary_id)
     and(c.classic_date is null or c.classic_date<least(r.reconciliation_date,bt.tran_date,st.statement_date))
     and(c.quadratic_date is null or c.quadratic_date<least(r.reconciliation_date,bt.tran_date,st.statement_date)),false) eligible
   from public.bank_reconciliation_match m
   join public.bank_reconciliation r on r.reconciliation_id=m.reconciliation_id
   join public.bank_transaction bt on bt.bank_tran_id=m.bank_tran_id
   left join public."transaction" t on t.transaction_id=bt.transaction_id
   join public.bank_statement_line sl on sl.statement_line_id=m.statement_line_id
   join public.bank_statement st on st.statement_id=sl.statement_id
   cross join params p cross join closed_after c
   where r.bank_account_id=p.bank_id and bt.bank_account_id=p.bank_id and st.bank_account_id=p.bank_id
    and(m.bank_tran_id in(select nullif(payload->>'id','')::bigint from erp_rows)
     or m.statement_line_id in(select nullif(payload->>'statement_line_id','')::bigint from statement_rows))
  ),foreign_journal_references as materialized(
   select distinct m.match_id from matched_sources m join public.journal j on j.transaction_id=m.transaction_id
    cross join params p where j.subsidiary_id is distinct from p.subsidiary_id
  ),quadratic_references as materialized(
   select m.match_id from matched_sources m join public.quadratic_reconciliation_matches q
    on q.bank_tran_id=m.bank_tran_id or q.statement_line_id=m.statement_line_id
   union
   select m.match_id from matched_sources m join public.quadratic_reconciliation_items q
    on q.bank_tran_id=m.bank_tran_id or q.statement_line_id=m.statement_line_id
  ),classic_conflicts as materialized(
   select distinct m.match_id from matched_sources m join public.bank_reconciliation_match other
    on other.match_id<>m.match_id and(other.bank_tran_id=m.bank_tran_id or other.statement_line_id=m.statement_line_id)
  ),erp_metadata as(
   select m.bank_tran_id,
    case when count(*)=1 then min(m.match_id)end match_id,
    case when count(*)=1 then min(m.reconciliation_id)end reconciliation_id,
    case when count(*)=1 then min(m.reconciliation_cutoff)end reconciliation_cutoff,
    count(*)=1 and bool_and(m.eligible and q.match_id is null and x.match_id is null and j.match_id is null)can_unmatch
   from matched_sources m left join quadratic_references q using(match_id)left join classic_conflicts x using(match_id)
    left join foreign_journal_references j using(match_id)
   group by m.bank_tran_id
  ),statement_metadata as(
   select m.statement_line_id,
    case when count(*)=1 then min(m.match_id)end match_id,
    case when count(*)=1 then min(m.reconciliation_id)end reconciliation_id,
    case when count(*)=1 then min(m.reconciliation_cutoff)end reconciliation_cutoff,
    count(*)=1 and bool_and(m.eligible and q.match_id is null and x.match_id is null and j.match_id is null)can_unmatch
   from matched_sources m left join quadratic_references q using(match_id)left join classic_conflicts x using(match_id)
    left join foreign_journal_references j using(match_id)
   group by m.statement_line_id
  )
  select report_source.payload||jsonb_build_object(
   'canUnmatchAll',(select coalesce(p.can_edit and(
    select count(*)=1 and coalesce(bool_and(
     (c.classic_date is null or c.classic_date<s.statement_date)
     and(c.quadratic_date is null or c.quadratic_date<s.statement_date)),false)
    from public.bank_statement s
    where s.bank_account_id=p.bank_id
     and s.statement_date=nullif(p_filters->>'dateTo','')::date
   ),false)from params p cross join closed_after c),
   'rows',coalesce((select jsonb_agg(v.payload||jsonb_build_object(
    'match_id',m.match_id,'reconciliation_id',m.reconciliation_id,
    'reconciliation_cutoff',m.reconciliation_cutoff,'can_unmatch',coalesce(m.can_unmatch,false))order by v.position)
    from erp_rows v left join erp_metadata m on m.bank_tran_id=nullif(v.payload->>'id','')::bigint),'[]'::jsonb),
   'statementLines',coalesce((select jsonb_agg(v.payload||jsonb_build_object(
    'match_id',m.match_id,'reconciliation_id',m.reconciliation_id,
    'reconciliation_cutoff',m.reconciliation_cutoff,'can_unmatch',coalesce(m.can_unmatch,false))order by v.position)
    from statement_rows v left join statement_metadata m on m.statement_line_id=nullif(v.payload->>'statement_line_id','')::bigint),'[]'::jsonb)
  )from report_source
 );end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_classified_receivables_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('classified-receivables');
 declare result jsonb; enriched jsonb;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 result:=public.run_aging_report('AR',p_filters);
 select coalesce(jsonb_agg(item.value||jsonb_build_object(
   'discounted',coalesce(mark.discounted,false),
   'discount_updated_at',mark.updated_at,
   'discount_subsidiary_id',invoice.subsidiary_id,
   'financial_creditor_id',mark.financial_creditor_id,'financial_creditor_name',creditor.name,
   'operation_number',mark.operation_number,'operation_due_date',mark.operation_due_date,
   'intercompany',case when account.account_id is not null then account.account_number='113002' else coalesce(customer.is_intercompany,false) end
 ) order by item.ordinality),'[]'::jsonb) into enriched
 from jsonb_array_elements(coalesce(result->'rows','[]'::jsonb)) with ordinality item(value,ordinality)
 join public.invoice invoice on invoice.invoice_id=(item.value->>'document_id')::bigint
 join public.customers customer on customer.customer_id=invoice.customer_id
 left join public.chart_accounts account on account.account_id=invoice.receivable_account_id
 left join report_delivery_private.receivable_discount_marks mark using(invoice_id)
 left join public.financial_creditors creditor on creditor.financial_creditor_id=mark.financial_creditor_id
 where exists(select 1 from public.user_subsidiaries access where access.user_id=public.app_user_id() and access.subsidiary_id=invoice.subsidiary_id);
 return result||jsonb_build_object('rows',enriched,'financialCreditors',(
 select coalesce(jsonb_agg(jsonb_build_object('id',c.financial_creditor_id,'name',c.name,'subsidiaryId',a.subsidiary_id) order by c.name,c.financial_creditor_id),'[]'::jsonb)
 from public.financial_creditors c join public.financial_creditor_subsidiaries a using(financial_creditor_id)
 where not coalesce(c.is_inactive,false) and exists(select 1 from public.user_subsidiaries u where u.user_id=public.app_user_id() and u.subsidiary_id=a.subsidiary_id)
 ));
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_eight_column_balance_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('eight-column-balance');
 begin perform report_template_private.enter('reports:accounting-reports','view');

declare
  uid bigint:=public.app_user_id();
  sid bigint:=nullif(p_filters->>'subsidiaryId','')::bigint;
  requested_book_id bigint:=nullif(p_filters->>'bookId','')::bigint;
  selected_book_id bigint;
  date_from date;
  date_to date;
  detail_level integer:=coalesce(nullif(coalesce(p_filters->>'detailLevel',p_filters->>'hierarchy'),'')::integer,4);
  include_zero boolean:=lower(coalesce(nullif(p_filters->>'includeZero',''),'false')) in ('true','1','yes','si');
  result jsonb;
begin
  if uid is null then
    raise exception using errcode='42501',message='La sesión no identifica un usuario.';
  end if;
  if sid is null then
    raise exception 'Seleccione la subsidiaria del reporte.';
  end if;
  if not exists(
    select 1 from public.user_subsidiaries access
    where access.user_id=uid and access.subsidiary_id=sid
  )then
    raise exception using errcode='42501',message='No tiene acceso a la subsidiaria seleccionada.';
  end if;

  perform public.security_assert_role_access('reports:accounting-reports','view');

  begin
    date_from:=nullif(p_filters->>'dateFrom','')::date;
    date_to:=nullif(p_filters->>'dateTo','')::date;
  exception when invalid_datetime_format then
    raise exception 'El rango de fechas no es válido.';
  end;
  if date_from is null or date_to is null then
    raise exception 'Indique las fechas inicial y final del reporte.';
  end if;
  if date_from>date_to then
    raise exception 'La fecha inicial no puede ser posterior a la fecha final.';
  end if;
  if detail_level not between 1 and 4 then
    raise exception 'El nivel de detalle debe estar entre 1 y 4.';
  end if;

  if requested_book_id is null then
    select book.accounting_book_id into selected_book_id
    from public.accounting_books book
    where book.subsidiary_id=sid and book.is_active
    order by book.is_primary desc,book.accounting_book_id
    limit 1;
  else
    select book.accounting_book_id into selected_book_id
    from public.accounting_books book
    where book.accounting_book_id=requested_book_id
      and book.subsidiary_id=sid and book.is_active;
  end if;
  if selected_book_id is null then
    raise exception 'La subsidiaria no tiene un libro contable activo disponible.';
  end if;

  with recursive group_ancestry as(
    select leaf.group_id leaf_group_id,leaf.group_id,leaf.group_code,leaf.group_name,
      leaf.level,leaf.parent_id,leaf.category,0 depth
    from public.account_group leaf
    union all
    select ancestry.leaf_group_id,parent.group_id,parent.group_code,parent.group_name,
      parent.level,parent.parent_id,parent.category,ancestry.depth+1
    from group_ancestry ancestry
    join public.account_group parent on parent.group_id=ancestry.parent_id
    where ancestry.depth<20
  ),group_paths as(
    select ancestry.leaf_group_id,
      jsonb_agg(
        jsonb_build_object(
          'id',ancestry.group_id,
          'code',ancestry.group_code,
          'name',ancestry.group_name,
          'level',ancestry.level,
          'parentId',ancestry.parent_id,
          'category',ancestry.category
        ) order by coalesce(ancestry.level,100),ancestry.depth desc,ancestry.group_code
      )group_path
    from group_ancestry ancestry
    group by ancestry.leaf_group_id
  ),account_universe as(
    -- Cuentas imputables actualmente habilitadas: permiten mostrar ceros.
    select account.account_id,account.account_number,account.account_name,
      account.account_group_id,account.category account_category,
      account.nature account_nature,account.is_inactive,account.accepts_entries
    from public.account_subsidiaries assignment
    join public.chart_accounts account using(account_id)
    where assignment.subsidiary_id=sid and assignment.is_active
      and not account.is_inactive and account.accepts_entries
    union
    -- Cuentas con historia en el periodo, aun si fueron desactivadas después.
    select account.account_id,account.account_number,account.account_name,
      account.account_group_id,account.category account_category,
      account.nature account_nature,account.is_inactive,account.accepts_entries
    from public.gl_impact impact
    join public.chart_accounts account using(account_id)
    where impact.subsidiary_id=sid
      and impact.accounting_book_id=selected_book_id
      and impact.posting_date between date_from and date_to
  ),movements as(
    select impact.account_id,
      coalesce(sum(impact.debit_amount),0)::numeric(24,6) debit,
      coalesce(sum(impact.credit_amount),0)::numeric(24,6) credit
    from public.gl_impact impact
    where impact.subsidiary_id=sid
      and impact.accounting_book_id=selected_book_id
      and impact.posting_date between date_from and date_to
    group by impact.account_id
  ),classified as(
    select account.account_id,account.account_number,account.account_name,
      account.account_group_id group_id,grp.group_code,grp.group_name,
      grp.level group_level,grp.parent_id group_parent_id,
      coalesce(paths.group_path,'[]'::jsonb)group_path,
      coalesce(account.account_category,grp.category,'Sin clasificar')category,
      coalesce(account.account_nature,grp.nature,'Deudora')nature,
      case coalesce(account.account_category,grp.category)
        when 'Activo'then'ACTIVO'
        when 'Pasivo'then'PASIVO'
        when 'Patrimonio'then'PASIVO'
        when 'Costo'then'PERDIDA'
        when 'Gasto'then'PERDIDA'
        when 'Ingreso'then'GANANCIA'
        else'SIN_CLASIFICAR'
      end classification,
      coalesce(movement.debit,0)::numeric(24,6)debit,
      coalesce(movement.credit,0)::numeric(24,6)credit,
      account.is_inactive,account.accepts_entries
    from account_universe account
    join public.account_group grp on grp.group_id=account.account_group_id
    left join group_paths paths on paths.leaf_group_id=grp.group_id
    left join movements movement using(account_id)
  ),eligible as(
    select * from classified
    where include_zero or debit<>0 or credit<>0
  ),row_values as(
    select account_id,account_number,account_name,group_id,group_code,group_name,
      group_level,group_parent_id,group_path,category,nature,classification,
      debit,credit,
      greatest(debit-credit,0)::numeric(24,6)debtor_balance,
      greatest(credit-debit,0)::numeric(24,6)creditor_balance,
      case when classification='ACTIVO'then debit-credit else 0 end::numeric(24,6)asset,
      case when classification='PASIVO'then credit-debit else 0 end::numeric(24,6)liability,
      case when classification='PERDIDA'then debit-credit else 0 end::numeric(24,6)loss,
      case when classification='GANANCIA'then credit-debit else 0 end::numeric(24,6)gain,
      is_inactive,accepts_entries
    from eligible
  ),totals as(
    select
      coalesce(sum(debit),0)::numeric(24,6)debit,
      coalesce(sum(credit),0)::numeric(24,6)credit,
      coalesce(sum(debtor_balance),0)::numeric(24,6)debtor_balance,
      coalesce(sum(creditor_balance),0)::numeric(24,6)creditor_balance,
      coalesce(sum(asset),0)::numeric(24,6)asset,
      coalesce(sum(liability),0)::numeric(24,6)liability,
      coalesce(sum(loss),0)::numeric(24,6)loss,
      coalesce(sum(gain),0)::numeric(24,6)gain,
      count(*)::integer account_count,
      count(*)filter(where classification='SIN_CLASIFICAR')::integer unclassified_count,
      coalesce(sum(debit-credit)filter(where classification='SIN_CLASIFICAR'),0)::numeric(24,6)unclassified_net
    from row_values
  ),calculation as(
    select totals.*,
      (gain-loss)::numeric(24,6)exercise_result,
      (asset-liability)::numeric(24,6)inventory_difference,
      (gain-loss)::numeric(24,6)result_difference,
      greatest(-(gain-loss),0)::numeric(24,6)result_asset,
      greatest(gain-loss,0)::numeric(24,6)result_liability,
      greatest(gain-loss,0)::numeric(24,6)result_loss,
      greatest(-(gain-loss),0)::numeric(24,6)result_gain
    from totals
  ),final_totals as(
    select calculation.*,
      (asset+result_asset)::numeric(24,6)equalized_asset,
      (liability+result_liability)::numeric(24,6)equalized_liability,
      (loss+result_loss)::numeric(24,6)equalized_loss,
      (gain+result_gain)::numeric(24,6)equalized_gain
    from calculation
  )
  select jsonb_build_object(
    'header',jsonb_build_object(
      'subsidiaryId',company.subsidiary_id,
      'subsidiary',company.name,
      'legalName',company.legal_name,
      'taxId',company.tax_id,
      'currency',currency.currency_code,
      'currencyName',currency.name,
      'symbol',currency.symbol,
      'dateFrom',date_from,
      'dateTo',date_to,
      'bookId',book.accounting_book_id,
      'bookName',book.book_name,
      'detailLevel',detail_level,
      'includeZero',include_zero
    ),
    'rows',coalesce((
      select jsonb_agg(jsonb_build_object(
        'accountId',row_value.account_id,
        'accountNumber',row_value.account_number,
        'accountName',row_value.account_name,
        'groupId',row_value.group_id,
        'groupCode',row_value.group_code,
        'groupName',row_value.group_name,
        'groupLevel',row_value.group_level,
        'groupParentId',row_value.group_parent_id,
        'groupPath',row_value.group_path,
        'category',row_value.category,
        'nature',row_value.nature,
        'classification',row_value.classification,
        'debit',row_value.debit,
        'credit',row_value.credit,
        'debtorBalance',row_value.debtor_balance,
        'creditorBalance',row_value.creditor_balance,
        'asset',row_value.asset,
        'liability',row_value.liability,
        'loss',row_value.loss,
        'gain',row_value.gain,
        'isInactive',row_value.is_inactive,
        'acceptsEntries',row_value.accepts_entries
      )order by
        case row_value.classification when 'ACTIVO' then 1 when 'PASIVO' then 2 when 'PERDIDA' then 3 when 'GANANCIA' then 4 else 9 end,
        row_value.account_number,row_value.account_id)
      from row_values row_value
    ),'[]'::jsonb),
    'total',(select account_count from final_totals),
    'summary',(select jsonb_build_object(
      'debit',summary.debit,
      'credit',summary.credit,
      'debtorBalance',summary.debtor_balance,
      'creditorBalance',summary.creditor_balance,
      'asset',summary.asset,
      'liability',summary.liability,
      'loss',summary.loss,
      'gain',summary.gain,
      'exerciseResult',summary.exercise_result,
      'inventoryDifference',summary.inventory_difference,
      'resultDifference',summary.result_difference,
      'accountCount',summary.account_count,
      'unclassifiedCount',summary.unclassified_count,
      'unclassifiedNet',summary.unclassified_net,
      'resultRow',jsonb_build_object(
        'label','Resultado del ejercicio',
        'asset',summary.result_asset,
        'liability',summary.result_liability,
        'loss',summary.result_loss,
        'gain',summary.result_gain
      ),
      'equalized',jsonb_build_object(
        'asset',summary.equalized_asset,
        'liability',summary.equalized_liability,
        'loss',summary.equalized_loss,
        'gain',summary.equalized_gain
      ),
      'validations',jsonb_build_object(
        'debitsCreditsBalanced',summary.debit=summary.credit,
        'balancesBalanced',summary.debtor_balance=summary.creditor_balance,
        'resultBridgeBalanced',summary.inventory_difference=summary.result_difference,
        'equalizedBalanceSheet',summary.equalized_asset=summary.equalized_liability,
        'equalizedResults',summary.equalized_loss=summary.equalized_gain,
        'allBalanced',summary.debit=summary.credit
          and summary.debtor_balance=summary.creditor_balance
          and summary.inventory_difference=summary.result_difference
          and summary.equalized_asset=summary.equalized_liability
          and summary.equalized_loss=summary.equalized_gain
          and summary.unclassified_count=0
      ),
      'warnings',case when summary.unclassified_count>0 then
        jsonb_build_array(format(
          '%s cuenta(s) con movimiento no tienen una categoría financiera válida; revise el plan de cuentas.',
          summary.unclassified_count
        ))else'[]'::jsonb end
    )from final_totals summary)
  )into result
  from public.subsidiaries company
  join public.currencies currency using(currency_id)
  join public.accounting_books book on book.accounting_book_id=selected_book_id
  where company.subsidiary_id=sid;

  return result;
end
;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_financial_statement_presentation(p_report text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter(p_report);
 declare mode text;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 p_filters:=coalesce(p_filters,'{}');mode:=upper(coalesce(nullif(trim(p_filters->>'presentationCurrency'),''),'LOCAL'));
 if p_report is null or p_report not in('balance-sheet','income-statement')or mode not in('LOCAL','USD')then raise exception 'Presentación financiera inválida.';end if;
 if mode='LOCAL'then
  if p_report='income-statement'and upper(coalesce(nullif(p_filters->>'columnView',''),'TOTAL'))<>'TOTAL'then return public.run_income_statement_matrix(p_filters);end if;
  return public.run_accounting_report(p_report,p_filters);
 end if;
 return report_delivery_private.run_financial_statement_presentation(p_report,p_filters||jsonb_build_object('presentationCurrency','USD'),public.app_user_id());
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_general_journal_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('journal');
 begin perform report_template_private.enter('reports:accounting-reports','view');

declare
  sids bigint[];
  date_from date;
  date_to date;
  book_id bigint;
  filter_department_id bigint;
  filter_location_id bigint;
  filter_class_id bigint;
  filter_cost_id bigint;
  filter_department_type text;
  module_filter text;
  status_filter text;
  search_text text;
  page_no int;
  page_size int;
  result jsonb;
begin
  select coalesce(array_agg(value::bigint),array[]::bigint[])
    into sids
  from jsonb_array_elements_text(coalesce(p_filters->'subsidiaryIds','[]'::jsonb));

  if cardinality(sids)=0 then
    sids:=array[active_subsidiary_id()];
  end if;
  if sids[1] is null or exists(
    select 1 from unnest(sids) selected_id
    where not exists(
      select 1 from user_subsidiaries access
      where access.user_id=app_user_id()
        and access.subsidiary_id=selected_id
    )
  ) then
    raise exception 'No tiene acceso a una o más subsidiarias seleccionadas.';
  end if;

  date_from:=nullif(p_filters->>'dateFrom','')::date;
  date_to:=nullif(p_filters->>'dateTo','')::date;
  if date_from is null or date_to is null then
    raise exception 'El rango de fechas es obligatorio.';
  end if;
  if date_from>date_to then
    raise exception 'El rango de fechas no es válido.';
  end if;

  book_id:=nullif(p_filters->>'bookId','')::bigint;
  filter_department_id:=nullif(p_filters->>'departmentId','')::bigint;
  filter_location_id:=nullif(p_filters->>'locationId','')::bigint;
  filter_class_id:=nullif(p_filters->>'classId','')::bigint;
  filter_cost_id:=nullif(p_filters->>'costCenterId','')::bigint;
  filter_department_type:=nullif(p_filters->>'departmentType','');
  module_filter:=nullif(p_filters->>'moduleCategory','');
  status_filter:=nullif(p_filters->>'journalStatus','');
  search_text:=lower(nullif(trim(p_filters->>'search'),''));
  page_no:=greatest(coalesce((p_filters->>'page')::int,1),1);
  page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,20),10),100);

  with journal_scope as materialized (
    select
      j.journal_id,j.journal_number,j.journal_date,j.transaction_id,
      j.subsidiary_id,j.exchange_rate,j.memo,j.status,
      report_book.accounting_book_id report_book_id,
      t.tran_number document_number,
      tt.code transaction_code,tt.abbreviation,tt.name transaction_type,
      tt.module_category,st.code transaction_status,
      coalesce(u.first_name||' '||u.last_name,u.email,'Sistema') created_by_name
    from journal j
    left join "transaction" t using(transaction_id)
    left join transaction_types tt using(transaction_type_id)
    left join status st on st.status_id=t.status_id
    left join users u on u.user_id=j.created_by
    left join lateral (
      select available_book.accounting_book_id
      from accounting_books available_book
      where available_book.subsidiary_id=j.subsidiary_id
        and available_book.is_active
      order by available_book.is_primary desc,available_book.accounting_book_id
      limit 1
    ) report_book on true
    where j.subsidiary_id=any(sids)
      and j.journal_date between date_from and date_to
      and (status_filter is null or j.status=status_filter)
      and (module_filter is null or tt.module_category=module_filter)
      and (
        book_id is null
        or exists(
          select 1 from gl_impact selected_book_impact
          where selected_book_impact.transaction_id=j.transaction_id
            and selected_book_impact.accounting_book_id=book_id
        )
      )
      -- Dimension filters select complete vouchers.  Returning only the
      -- matching side of an entry would itself create a false imbalance.
      and (filter_department_id is null or exists(
        select 1 from journal_line dimension_line
        where dimension_line.journal_id=j.journal_id
          and dimension_line.department_id=filter_department_id
      ))
      and (filter_location_id is null or exists(
        select 1 from journal_line dimension_line
        where dimension_line.journal_id=j.journal_id
          and dimension_line.location_id=filter_location_id
      ))
      and (filter_class_id is null or exists(
        select 1 from journal_line dimension_line
        where dimension_line.journal_id=j.journal_id
          and dimension_line.class_id=filter_class_id
      ))
      and (filter_cost_id is null or exists(
        select 1 from journal_line dimension_line
        where dimension_line.journal_id=j.journal_id
          and dimension_line.cost_center_id=filter_cost_id
      ))
      and (filter_department_type is null or exists(
        select 1
        from journal_line dimension_line
        join departments selected_department using(department_id)
        where dimension_line.journal_id=j.journal_id
          and lower(selected_department.type)=lower(filter_department_type)
      ))
      and (
        search_text is null
        or lower(j.journal_number) like '%'||search_text||'%'
        or lower(coalesce(t.tran_number,'')) like '%'||search_text||'%'
        or lower(coalesce(j.memo,'')) like '%'||search_text||'%'
        or exists(
          select 1
          from journal_line search_line
          left join customers c using(customer_id)
          left join suppliers sp using(supplier_id)
          left join employees e using(employee_id)
          where search_line.journal_id=j.journal_id
            and lower(concat_ws(' ',c.company_name,c.tax_id,sp.company_name,
              sp.tax_id,e.first_name,e.last_name,e.identification,
              search_line.note)) like '%'||search_text||'%'
        )
      )
  ), posted_lines as materialized (
    select
      scope.journal_id,
      impact.gl_impact_id sort_id,
      coalesce(direct_line.journal_line_id,tax_source.journal_line_id) line_id,
      impact.account_id,
      coalesce(direct_line.entity_type,tax_source.entity_type) entity_type,
      coalesce(direct_line.entity_name,tax_source.entity_name) entity_name,
      coalesce(direct_line.cost_center,tax_source.cost_center) cost_center,
      coalesce(
        direct_line.note,
        case when tax_source.tax_code is not null
          then 'Impuesto generado automáticamente · '||tax_source.tax_code
        end,
        'Movimiento contabilizado'
      ) note,
      impact.debit_amount debit,
      impact.credit_amount credit,
      direct_line.journal_line_id is null and tax_source.journal_line_id is not null
        as system_generated
    from journal_scope scope
    join gl_impact impact on impact.transaction_id=scope.transaction_id
      and impact.accounting_book_id=coalesce(book_id,scope.report_book_id)
    left join lateral (
      select
        line.journal_line_id,line.entity_type,
        coalesce(c.company_name,sp.company_name,concat_ws(' ',e.first_name,e.last_name)) entity_name,
        cc.code cost_center,line.note
      from journal_line line
      left join customers c using(customer_id)
      left join suppliers sp using(supplier_id)
      left join employees e using(employee_id)
      left join cost_centers cc using(cost_center_id)
      where line.journal_id=scope.journal_id
        and line.account_id=impact.account_id
        and abs(line.debit*scope.exchange_rate-impact.debit_amount)<0.0005
        and abs(line.credit*scope.exchange_rate-impact.credit_amount)<0.0005
      order by line.journal_line_id
      limit 1
    ) direct_line on true
    left join lateral (
      select
        line.journal_line_id,line.entity_type,
        coalesce(c.company_name,sp.company_name,concat_ws(' ',e.first_name,e.last_name)) entity_name,
        cc.code cost_center,line.note,tax_code.code_name tax_code
      from journal_line line
      join tax_codes tax_code using(tax_code_id)
      join tax_types tax_type using(tax_type_id)
      left join customers c using(customer_id)
      left join suppliers sp using(supplier_id)
      left join employees e using(employee_id)
      left join cost_centers cc using(cost_center_id)
      where direct_line.journal_line_id is null
        and line.journal_id=scope.journal_id
        and case when line.debit>0
          then tax_type.asset_account_id
          else tax_type.liability_account_id
        end=impact.account_id
        and abs(
          greatest(line.debit,line.credit)
          *coalesce(line.tax_rate,tax_code.rate_percentage,0)/100
          *scope.exchange_rate
          -greatest(impact.debit_amount,impact.credit_amount)
        )<0.0005
        and (line.debit>0)=(impact.debit_amount>0)
      order by line.journal_line_id
      limit 1
    ) tax_source on true
  ), fallback_lines as materialized (
    -- A draft/manual voucher without a ledger impact remains inspectable.  It
    -- is converted to local currency so the report keeps one monetary basis.
    select
      scope.journal_id,line.journal_line_id sort_id,line.journal_line_id,
      line.account_id,line.entity_type,
      coalesce(c.company_name,sp.company_name,concat_ws(' ',e.first_name,e.last_name)) entity_name,
      cc.code cost_center,line.note,
      line.debit*scope.exchange_rate debit,
      line.credit*scope.exchange_rate credit,
      false system_generated
    from journal_scope scope
    join journal_line line using(journal_id)
    left join customers c using(customer_id)
    left join suppliers sp using(supplier_id)
    left join employees e using(employee_id)
    left join cost_centers cc using(cost_center_id)
    where book_id is null
      and not exists(
        select 1 from gl_impact impact
        where impact.transaction_id=scope.transaction_id
          and impact.accounting_book_id=scope.report_book_id
      )
  ), report_lines as materialized (
    select * from posted_lines
    union all
    select * from fallback_lines
  ), journal_totals as materialized (
    select journal_id,coalesce(sum(debit),0) journal_debit,
      coalesce(sum(credit),0) journal_credit
    from report_lines
    group by journal_id
  ), eligible as materialized (
    select scope.*,totals.journal_debit,totals.journal_credit
    from journal_scope scope
    join journal_totals totals using(journal_id)
  ), counted as (
    select eligible.*,count(*) over() total_count
    from eligible
  ), paged as (
    select * from counted
    order by journal_date,journal_id
    limit page_size offset (page_no-1)*page_size
  )
  select jsonb_build_object(
    'rows',coalesce(jsonb_agg(jsonb_build_object(
      'journal_id',paged.journal_id,
      'journal_number',paged.journal_number,
      'status',paged.status,
      'date',paged.journal_date,
      'transaction_code',coalesce(paged.abbreviation,paged.transaction_code),
      'transaction_type',paged.transaction_type,
      'module_category',paged.module_category,
      'document_number',paged.document_number,
      'memo',paged.memo,
      'created_by',paged.created_by_name,
      'debit',paged.journal_debit,
      'credit',paged.journal_credit,
      'difference',paged.journal_debit-paged.journal_credit,
      'lines',coalesce((
        select jsonb_agg(jsonb_build_object(
          'line_id',line.line_id,
          'account_number',account.account_number,
          'account_name',account.account_name,
          'entity_type',line.entity_type,
          'entity_name',line.entity_name,
          'cost_center',line.cost_center,
          'note',line.note,
          'debit',line.debit,
          'credit',line.credit,
          'system_generated',line.system_generated
        ) order by line.sort_id)
        from report_lines line
        join chart_accounts account using(account_id)
        where line.journal_id=paged.journal_id
      ),'[]'::jsonb)
    ) order by paged.journal_date,paged.journal_id),'[]'::jsonb),
    'total',coalesce(max(paged.total_count),0),
    'page',page_no,
    'pageSize',page_size,
    'summary',jsonb_build_object(
      'debit',coalesce((select sum(journal_debit) from eligible),0),
      'credit',coalesce((select sum(journal_credit) from eligible),0)
    )
  ) into result
  from paged;

  return coalesce(result,jsonb_build_object(
    'rows','[]'::jsonb,
    'total',0,
    'page',page_no,
    'pageSize',page_size,
    'summary',jsonb_build_object('debit',0,'credit',0)
  ));
end
;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_general_ledger_export(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('general-ledger');
 begin
 perform report_template_private.enter('reports:accounting-reports','view');
 return report_delivery_private.general_ledger_export_rows(p_filters);
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_income_statement_matrix(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('income-statement');
 begin perform report_template_private.enter('reports:accounting-reports','view');

declare
 sids bigint[];date_from date;date_to date;book_id bigint;column_view text;department_type text;exclude_zero boolean;
 filter_department bigint;filter_class bigint;filter_location bigint;filter_cost bigint;result jsonb;
begin
 select coalesce(array_agg(value::bigint),array[]::bigint[])into sids from jsonb_array_elements_text(coalesce(p_filters->'subsidiaryIds','[]'::jsonb));
 if cardinality(sids)=0 then sids:=array[active_subsidiary_id()];end if;
 if sids[1] is null or exists(select 1 from unnest(sids)x where not exists(select 1 from user_subsidiaries u where u.user_id=app_user_id()and u.subsidiary_id=x))then raise exception'No tiene acceso a una o más subsidiarias seleccionadas.';end if;
 date_from:=coalesce(nullif(p_filters->>'dateFrom','')::date,date_trunc('year',current_date)::date);date_to:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
 if date_from>date_to then raise exception'La fecha inicial no puede ser posterior a la fecha final.';end if;
 book_id:=nullif(p_filters->>'bookId','')::bigint;column_view:=upper(coalesce(nullif(p_filters->>'columnView',''),'TOTAL'));department_type:=nullif(p_filters->>'departmentType','');exclude_zero:=coalesce((p_filters->>'excludeZero')::boolean,true);
 if column_view not in('DEPARTMENT','CLASS','LOCATION','COST_CENTER','ACCOUNTING_PERIOD')then raise exception'Seleccione una columna válida para el desglose.';end if;
 filter_department:=nullif(p_filters->>'departmentId','')::bigint;filter_class:=nullif(p_filters->>'classId','')::bigint;filter_location:=nullif(p_filters->>'locationId','')::bigint;filter_cost:=nullif(p_filters->>'costCenterId','')::bigint;
 with movement as(
  select a.account_id,a.account_number,a.account_name,a.account_group_id group_id,coalesce(a.category,ag.category)category,
   case column_view when'DEPARTMENT'then jl.department_id::text when'CLASS'then jl.class_id::text when'LOCATION'then jl.location_id::text when'COST_CENTER'then jl.cost_center_id::text else to_char(j.journal_date,'YYYY-MM')end dimension_id,
   sum(jl.debit*j.exchange_rate)debit,sum(jl.credit*j.exchange_rate)credit,
   sum(case when coalesce(a.category,ag.category)='Ingreso'then(jl.credit-jl.debit)*j.exchange_rate else(jl.debit-jl.credit)*j.exchange_rate end)amount
  from journal_line jl join journal j using(journal_id)join chart_accounts a using(account_id)join account_group ag on ag.group_id=a.account_group_id
  left join lateral(select accounting_book_id from accounting_books b where b.subsidiary_id=j.subsidiary_id and b.is_primary and b.is_active order by b.accounting_book_id limit 1)primary_book on true
  where j.subsidiary_id=any(sids)and j.journal_date between date_from and date_to and j.status='CONTABILIZADO'and coalesce(a.category,ag.category)in('Ingreso','Costo','Gasto')
   and(book_id is null or primary_book.accounting_book_id=book_id)
   and(filter_department is null or jl.department_id=filter_department)and(filter_class is null or jl.class_id=filter_class)and(filter_location is null or jl.location_id=filter_location)and(filter_cost is null or jl.cost_center_id=filter_cost)
   and(department_type is null or exists(select 1 from departments selected_department where selected_department.department_id=jl.department_id and lower(selected_department.type)=lower(department_type)))
  group by a.account_id,a.account_number,a.account_name,a.account_group_id,a.category,ag.category,dimension_id
 ),dimension_catalog as(
  select distinct m.dimension_id id,coalesce(case column_view when'DEPARTMENT'then d.name when'CLASS'then c.name when'LOCATION'then l.name else coalesce(nullif(cc.code,'')||' · ','')||cc.name end,'Dimensión '||m.dimension_id)name
  from movement m
  left join departments d on column_view='DEPARTMENT'and d.department_id::text=m.dimension_id
  left join classes c on column_view='CLASS'and c.class_id::text=m.dimension_id
  left join locations l on column_view='LOCATION'and l.location_id::text=m.dimension_id
  left join cost_centers cc on column_view='COST_CENTER'and cc.cost_center_id::text=m.dimension_id
  where column_view<>'ACCOUNTING_PERIOD'and m.dimension_id is not null and abs(m.amount)>=0.000001
  union all
  select to_char(month_value,'YYYY-MM'),case extract(month from month_value)::int when 1 then'Enero'when 2 then'Febrero'when 3 then'Marzo'when 4 then'Abril'when 5 then'Mayo'when 6 then'Junio'when 7 then'Julio'when 8 then'Agosto'when 9 then'Septiembre'when 10 then'Octubre'when 11 then'Noviembre'else'Diciembre'end||' '||to_char(month_value,'YYYY')
  from generate_series(date_trunc('month',date_from),date_trunc('month',date_to),interval'1 month')month_value where column_view='ACCOUNTING_PERIOD'
 ),account_rows as(
  select account_id,account_number,account_name,group_id,category,sum(debit)debit,sum(credit)credit,sum(amount)amount,jsonb_object_agg(coalesce(dimension_id,'unassigned'),amount order by coalesce(dimension_id,'unassigned'))dimensions
  from movement group by account_id,account_number,account_name,group_id,category
 ),eligible as(select*from account_rows where not exclude_zero or abs(amount)>=0.000001)
 select jsonb_build_object(
  'columns',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name)order by case when column_view='ACCOUNTING_PERIOD'then id end,name)from dimension_catalog),'[]'::jsonb),
  'rows',coalesce((select jsonb_agg(to_jsonb(e)order by case category when'Ingreso'then 1 when'Costo'then 2 else 3 end,account_number)from eligible e),'[]'::jsonb),
  'total',(select count(*)from eligible),'page',1,'pageSize',500,
  'summary',jsonb_build_object('periodResult',coalesce((select sum(case when category='Ingreso'then amount else-amount end)from eligible),0),'columnView',column_view,'source','MAYOR_GENERAL_CONTABILIZADO')
 )into result;
 return result;
end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_intercompany_commercial_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('intercompany-commercial');
 begin perform report_template_private.enter('reports:accounting-reports','view');

declare
  subsidiary_ids bigint[];
  filter_book_id bigint:=nullif(p_filters->>'bookId','')::bigint;
  filter_currency_ids bigint[];
  filter_direction text:=upper(coalesce(
    nullif(p_filters->>'direction',''),'ALL'
  ));
  filter_party_key text:=upper(nullif(btrim(p_filters->>'partyKey'),''));
  filter_party_type text;
  filter_party_id bigint;
  filter_search text:=nullif(btrim(p_filters->>'search'),'');
  only_pending boolean:=coalesce(
    nullif(p_filters->>'onlyPending','')::boolean,true
  );
  include_zero boolean:=coalesce(
    nullif(p_filters->>'includeZero','')::boolean,false
  );
  date_from date:=coalesce(
    nullif(p_filters->>'dateFrom','')::date,
    date_trunc('year',current_date)::date
  );
  date_to date:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
  report jsonb;
begin
  perform public.security_assert_role_access(
    'reports:accounting-reports','view'
  );

  select coalesce(array_agg(value::bigint),array[]::bigint[])
    into subsidiary_ids
  from jsonb_array_elements_text(
    coalesce(p_filters->'subsidiaryIds','[]'::jsonb)
  );

  if cardinality(subsidiary_ids)=0 then
    subsidiary_ids:=array[public.active_subsidiary_id()];
  end if;

  if subsidiary_ids[1]is null or exists(
    select 1 from unnest(subsidiary_ids)selected(subsidiary_id)
    where not exists(
      select 1 from public.user_subsidiaries access
      where access.user_id=public.app_user_id()
        and access.subsidiary_id=selected.subsidiary_id
    )
  )then
    raise exception 'No tiene acceso a una o más subsidiarias seleccionadas.';
  end if;

  if date_from>date_to then
    raise exception 'La fecha inicial no puede ser posterior a la fecha final.';
  end if;

  if filter_direction not in('ALL','RECEIVABLE','PAYABLE')then
    raise exception 'Tipo de cuenta comercial intercompany no válido.';
  end if;

  if filter_party_key is not null then
    if filter_party_key!~'^(CUSTOMER|SUPPLIER):[0-9]+$'then
      raise exception 'El tercero seleccionado no es válido.';
    end if;
    filter_party_type:=split_part(filter_party_key,':',1);
    filter_party_id:=split_part(filter_party_key,':',2)::bigint;
  end if;

  select coalesce(array_agg(value::bigint),array[]::bigint[])
    into filter_currency_ids
  from jsonb_array_elements_text(
    coalesce(p_filters->'currencyIds','[]'::jsonb)
  );

  -- journal_line stores the customer/supplier analytical grain. As in the
  -- loan report, a secondary book cannot be mapped safely to a journal line.
  if filter_book_id is not null and(
    cardinality(subsidiary_ids)<>1
    or not exists(
      select 1 from public.accounting_books book
      where book.accounting_book_id=filter_book_id
        and book.subsidiary_id=subsidiary_ids[1]
        and book.is_primary and book.is_active
    )
  )then
    raise exception 'Este reporte solo admite el libro contable principal activo de una subsidiaria.';
  end if;

  with target_accounts as(
    select account.account_id,account.account_number,account.account_name,
      case account.account_number when'113002'then'RECEIVABLE'
        else'PAYABLE'end direction,
      case account.account_number when'113002'then'CUSTOMER'
        else'SUPPLIER'end party_type
    from public.chart_accounts account
    where account.account_number in('113002','211002')
      and not coalesce(account.is_summary,false)
  ),raw_ledger as(
    select line.journal_line_id id,journal.transaction_id,
      journal.journal_date date,
      coalesce(tran.tran_number,journal.journal_number)transaction_number,
      coalesce(transaction_type.name,journal.journal_type)transaction_type,
      journal.journal_id,journal.journal_number,journal.memo,line.note,
      journal.fx_revaluation_run_id,
      journal.fx_revaluation_run_id is not null is_fx_revaluation,
      journal.subsidiary_id,subsidiary.name subsidiary_name,
      account.account_id,account.account_number,account.account_name,
      account.direction,account.party_type,
      case when account.direction='RECEIVABLE'
        then coalesce(line.customer_id,tran.customer_id)
        else coalesce(line.supplier_id,tran.supplier_id)end party_id,
      case when account.direction='RECEIVABLE'
        then customer.customer_number else supplier.supplier_number end
        party_code,
      case when account.direction='RECEIVABLE'
        then customer.company_name else supplier.company_name end party_name,
      case when account.direction='RECEIVABLE'
        then customer.tax_id else supplier.tax_id end identification,
      case when account.direction='RECEIVABLE'
        then coalesce(customer.is_intercompany,false)
        else coalesce(supplier.is_intercompany,false)end master_intercompany,
      coalesce(
        line.original_currency_id,fx_run.currency_id,journal.currency_id,
        tran.currency_id,subsidiary.currency_id
      )currency_id,
      subsidiary.currency_id local_currency_id,
      case when journal.fx_revaluation_run_id is not null then line.debit
        when line.opening_balance_line_id is not null then line.debit
        else line.debit*coalesce(journal.exchange_rate,1)end local_debit,
      case when journal.fx_revaluation_run_id is not null then line.credit
        when line.opening_balance_line_id is not null then line.credit
        else line.credit*coalesce(journal.exchange_rate,1)end local_credit,
      case when journal.fx_revaluation_run_id is not null then 0::numeric
        when line.original_currency_id is not null
          or line.opening_balance_line_id is not null then line.debit_fx
        else line.debit end original_debit,
      case when journal.fx_revaluation_run_id is not null then 0::numeric
        when line.original_currency_id is not null
          or line.opening_balance_line_id is not null then line.credit_fx
        else line.credit end original_credit,
      case when journal.fx_revaluation_run_id is not null
        then coalesce(fx_run.closing_rate,1)
        when line.opening_balance_line_id is not null
        then coalesce(line.historical_exchange_rate,journal.exchange_rate,1)
        else coalesce(journal.exchange_rate,1)end exchange_rate,
      line.opening_balance_line_id
    from public.journal_line line
    join public.journal journal using(journal_id)
    join target_accounts account using(account_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    left join public."transaction" tran using(transaction_id)
    left join public.transaction_types transaction_type using(transaction_type_id)
    left join public.fx_revaluation_runs fx_run
      on fx_run.run_id=journal.fx_revaluation_run_id
    left join public.customers customer
      on customer.customer_id=coalesce(line.customer_id,tran.customer_id)
      and account.direction='RECEIVABLE'
    left join public.suppliers supplier
      on supplier.supplier_id=coalesce(line.supplier_id,tran.supplier_id)
      and account.direction='PAYABLE'
    where journal.subsidiary_id=any(subsidiary_ids)
      and journal.journal_date<=date_to
      and(line.debit>0 or line.credit>0)
      and exists(
        select 1
        from public.gl_impact impact
        join public.accounting_books book using(accounting_book_id)
        where impact.transaction_id=journal.transaction_id
          and impact.account_id=line.account_id
          and impact.subsidiary_id=journal.subsidiary_id
          and impact.posting_date=journal.journal_date
          and(
            filter_book_id is not null
              and impact.accounting_book_id=filter_book_id
            or filter_book_id is null and book.is_primary and book.is_active
          )
      )
  ),ledger as(
    select movement.*,
      movement.party_type||':'||coalesce(movement.party_id::text,'0')
        party_key,
      currency.currency_code,currency.name currency_name,
      currency.symbol currency_symbol,
      local_currency.currency_code local_currency_code,
      local_currency.name local_currency_name,
      local_currency.symbol local_currency_symbol,
      case when movement.direction='RECEIVABLE'
        then movement.original_debit-movement.original_credit
        else movement.original_credit-movement.original_debit
      end original_movement,
      case when movement.direction='RECEIVABLE'
        then movement.local_debit-movement.local_credit
        else movement.local_credit-movement.local_debit
      end local_movement
    from raw_ledger movement
    join public.currencies currency using(currency_id)
    join public.currencies local_currency
      on local_currency.currency_id=movement.local_currency_id
    where(filter_direction='ALL'or movement.direction=filter_direction)
      and(cardinality(filter_currency_ids)=0
        or movement.currency_id=any(filter_currency_ids))
      and(filter_party_key is null or(
        movement.party_type=filter_party_type
        and movement.party_id=filter_party_id
      ))
  ),ledger_summary as(
    select movement.subsidiary_id,movement.subsidiary_name,
      movement.direction,movement.party_type,movement.party_id,
      movement.party_key,
      coalesce(movement.party_code,'SIN-ASIGNAR')party_code,
      coalesce(movement.party_name,
        case movement.direction when'RECEIVABLE'then'Cliente sin asignar'
          else'Proveedor sin asignar'end)party_name,
      movement.identification,movement.master_intercompany,
      movement.account_id,movement.account_number,movement.account_name,
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol,
      sum(case when movement.date<date_from
        then movement.original_movement else 0 end)opening_balance,
      sum(case when movement.date between date_from and date_to
        then movement.original_debit else 0 end)debits,
      sum(case when movement.date between date_from and date_to
        then movement.original_credit else 0 end)credits,
      sum(case when movement.date between date_from and date_to
        then movement.original_movement else 0 end)period_movement,
      sum(movement.original_movement)closing_balance
    from ledger movement
    group by movement.subsidiary_id,movement.subsidiary_name,
      movement.direction,movement.party_type,movement.party_id,
      movement.party_key,movement.party_code,movement.party_name,
      movement.identification,movement.master_intercompany,
      movement.account_id,movement.account_number,movement.account_name,
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol
  ),local_summary as(
    select movement.subsidiary_id,movement.subsidiary_name,
      movement.direction,movement.party_type,movement.party_id,
      movement.party_key,
      coalesce(movement.party_code,'SIN-ASIGNAR')party_code,
      coalesce(movement.party_name,
        case movement.direction when'RECEIVABLE'then'Cliente sin asignar'
          else'Proveedor sin asignar'end)party_name,
      movement.identification,movement.master_intercompany,
      movement.currency_id original_currency_id,
      movement.currency_code original_currency_code,
      movement.currency_name original_currency_name,
      movement.currency_symbol original_currency_symbol,
      movement.local_currency_id,movement.local_currency_code,
      movement.local_currency_name,movement.local_currency_symbol,
      sum(case when movement.date<date_from
        then movement.local_movement else 0 end)opening_balance,
      sum(case when movement.date between date_from and date_to
        then movement.local_debit else 0 end)debits,
      sum(case when movement.date between date_from and date_to
        then movement.local_credit else 0 end)credits,
      sum(case when movement.date between date_from and date_to
        then movement.local_movement else 0 end)period_movement,
      sum(movement.local_movement)closing_balance
    from ledger movement
    group by movement.subsidiary_id,movement.subsidiary_name,
      movement.direction,movement.party_type,movement.party_id,
      movement.party_key,movement.party_code,movement.party_name,
      movement.identification,movement.master_intercompany,
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol,movement.local_currency_id,
      movement.local_currency_code,movement.local_currency_name,
      movement.local_currency_symbol
  ),document_source as(
    select 'RECEIVABLE'::text direction,'CUSTOMER'::text party_type,
      invoice.invoice_id document_id,'AR:'||invoice.invoice_id source_key,
      customer.customer_id party_id,'CUSTOMER:'||customer.customer_id party_key,
      customer.customer_number party_code,customer.company_name party_name,
      customer.tax_id identification,customer.is_intercompany master_intercompany,
      invoice.subsidiary_id,subsidiary.name subsidiary_name,
      account.account_id,account.account_number,account.account_name,
      invoice.invoice_number document_number,
      coalesce(invoice.invoice_date,tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date)issue_date,
      invoice.due_date,
      coalesce(tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date,invoice.invoice_date)posting_date,
      coalesce(invoice.currency_id,tran.currency_id,subsidiary.currency_id)
        currency_id,
      subsidiary.currency_id local_currency_id,
      coalesce(nullif(invoice.exchange_rate,0),
        nullif(tran.exchange_rate,0),1)exchange_rate,
      case when invoice.receivable_amount=0
          and coalesce(invoice.withholding_total,0)=0
          and invoice.total_amount<>0 then invoice.total_amount
        else invoice.receivable_amount end original_amount,
      coalesce(application.applied,0)applied_amount,
      coalesce(credit.amount,0)credit_amount,
      coalesce(debit.amount,0)debit_amount,
      (case when invoice.receivable_amount=0
          and coalesce(invoice.withholding_total,0)=0
          and invoice.total_amount<>0 then invoice.total_amount
        else invoice.receivable_amount end)
        -coalesce(application.applied,0)-coalesce(credit.amount,0)
        +coalesce(debit.amount,0)outstanding,
      coalesce(direct_journal.journal_id,fallback_journal.journal_id)journal_id,
      coalesce(invoice.transaction_id,direct_journal.transaction_id,
        fallback_journal.transaction_id)transaction_id,
      invoice.is_opening_balance
    from public.invoice invoice
    join target_accounts account
      on account.account_id=invoice.receivable_account_id
      and account.account_number='113002'
    join public.customers customer using(customer_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    left join public."transaction" tran
      on tran.transaction_id=invoice.transaction_id
    left join public.status invoice_status
      on invoice_status.status_id=tran.status_id
    left join public.journal direct_journal
      on direct_journal.journal_id=invoice.journal_id
    left join lateral(
      select fallback.journal_id,fallback.journal_date,
        fallback.transaction_id
      from public.journal fallback
      where invoice.journal_id is null
        and fallback.transaction_id=invoice.transaction_id
      order by fallback.journal_id limit 1
    )fallback_journal on true
    left join lateral(
      select sum(case when coalesce(
          payment.currency_id,payment_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then item.amount
        else item.amount*coalesce(
          nullif(payment.exchange_rate,0),
          nullif(payment_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)applied
      from public.customer_payment_application item
      join public.customer_payment payment using(payment_id)
      left join public."transaction" payment_transaction
        on payment_transaction.transaction_id=payment.transaction_id
      left join public.status payment_status
        on payment_status.status_id=payment_transaction.status_id
      where item.invoice_id=invoice.invoice_id
        and item.application_date<=date_to
        and coalesce(payment_transaction.tran_date,payment.payment_date,
          item.application_date)<=date_to
        and upper(coalesce(payment.status,'APROBADO'))
          not in('ANULADO','CANCELADO')
        and upper(coalesce(payment_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )application on true
    left join lateral(
      select sum(case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
      from public.credit_note note
      left join public."transaction" note_transaction
        on note_transaction.transaction_id=note.transaction_id
      left join public.status note_status
        on note_status.status_id=note_transaction.status_id
      where note.invoice_id=invoice.invoice_id
        and coalesce(note_transaction.tran_date,note.note_date)<=date_to
        and upper(coalesce(note_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )credit on true
    left join lateral(
      select sum(case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
      from public.debit_note note
      left join public."transaction" note_transaction
        on note_transaction.transaction_id=note.transaction_id
      left join public.status note_status
        on note_status.status_id=note_transaction.status_id
      where note.invoice_id=invoice.invoice_id
        and coalesce(note_transaction.tran_date,note.note_date)<=date_to
        and upper(coalesce(note_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )debit on true
    where invoice.subsidiary_id=any(subsidiary_ids)
      and coalesce(tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date,invoice.invoice_date)<=date_to
      and upper(coalesce(invoice_status.code,'APROBADO'))
        not in('ANULADO','CANCELADO')

    union all

    select 'PAYABLE','SUPPLIER',invoice.invoice_id,
      'AP:'||invoice.invoice_id,supplier.supplier_id,
      'SUPPLIER:'||supplier.supplier_id,supplier.supplier_number,
      supplier.company_name,supplier.tax_id,supplier.is_intercompany,
      invoice.subsidiary_id,subsidiary.name,account.account_id,
      account.account_number,account.account_name,invoice.invoice_number,
      coalesce(invoice.invoice_date,tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date),invoice.due_date,
      coalesce(tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date,invoice.invoice_date),
      coalesce(invoice.currency_id,tran.currency_id,subsidiary.currency_id),
      subsidiary.currency_id,
      coalesce(nullif(invoice.exchange_rate,0),
        nullif(tran.exchange_rate,0),1),
      case when invoice.payable_amount=0
          and coalesce(invoice.withholding_total,0)=0
          and invoice.total_amount<>0 then invoice.total_amount
        else invoice.payable_amount end,
      coalesce(application.applied,0),coalesce(credit.amount,0),
      coalesce(debit.amount,0),
      (case when invoice.payable_amount=0
          and coalesce(invoice.withholding_total,0)=0
          and invoice.total_amount<>0 then invoice.total_amount
        else invoice.payable_amount end)
        -coalesce(application.applied,0)-coalesce(credit.amount,0)
        +coalesce(debit.amount,0),
      coalesce(direct_journal.journal_id,fallback_journal.journal_id),
      coalesce(invoice.transaction_id,direct_journal.transaction_id,
        fallback_journal.transaction_id),invoice.is_opening_balance
    from public.supplier_invoice invoice
    join target_accounts account
      on account.account_id=invoice.payable_account_id
      and account.account_number='211002'
    join public.suppliers supplier using(supplier_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    left join public."transaction" tran
      on tran.transaction_id=invoice.transaction_id
    left join public.status invoice_status
      on invoice_status.status_id=tran.status_id
    left join public.journal direct_journal
      on direct_journal.journal_id=invoice.journal_id
    left join lateral(
      select fallback.journal_id,fallback.journal_date,
        fallback.transaction_id
      from public.journal fallback
      where invoice.journal_id is null
        and fallback.transaction_id=invoice.transaction_id
      order by fallback.journal_id limit 1
    )fallback_journal on true
    left join lateral(
      select sum(case when coalesce(
          payment.currency_id,payment_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then item.amount
        else item.amount*coalesce(
          nullif(payment.exchange_rate,0),
          nullif(payment_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)applied
      from public.supplier_payment_application item
      join public.supplier_payment payment using(payment_id)
      left join public."transaction" payment_transaction
        on payment_transaction.transaction_id=payment.transaction_id
      left join public.status payment_status
        on payment_status.status_id=payment_transaction.status_id
      where item.invoice_id=invoice.invoice_id
        and item.application_date<=date_to
        and coalesce(payment_transaction.tran_date,payment.payment_date,
          item.application_date)<=date_to
        and upper(coalesce(payment.status,'APROBADO'))
          not in('ANULADO','CANCELADO')
        and upper(coalesce(payment_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )application on true
    left join lateral(
      select sum(case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
      from public.supplier_credit_note note
      left join public."transaction" note_transaction
        on note_transaction.transaction_id=note.transaction_id
      left join public.status note_status
        on note_status.status_id=note_transaction.status_id
      where note.invoice_id=invoice.invoice_id
        and coalesce(note_transaction.tran_date,note.note_date)<=date_to
        and upper(coalesce(note_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )credit on true
    left join lateral(
      select sum(case when coalesce(
          note.currency_id,note_transaction.currency_id,
          invoice.currency_id,tran.currency_id
        )=coalesce(invoice.currency_id,tran.currency_id)
        then note.amount
        else note.amount*coalesce(
          nullif(note.exchange_rate,0),
          nullif(note_transaction.exchange_rate,0),1
        )/coalesce(
          nullif(invoice.exchange_rate,0),nullif(tran.exchange_rate,0),1
        )end)amount
      from public.supplier_debit_note note
      left join public."transaction" note_transaction
        on note_transaction.transaction_id=note.transaction_id
      left join public.status note_status
        on note_status.status_id=note_transaction.status_id
      where note.invoice_id=invoice.invoice_id
        and coalesce(note_transaction.tran_date,note.note_date)<=date_to
        and upper(coalesce(note_status.code,'APROBADO'))
          not in('ANULADO','CANCELADO')
    )debit on true
    where invoice.subsidiary_id=any(subsidiary_ids)
      and coalesce(tran.tran_date,direct_journal.journal_date,
        fallback_journal.journal_date,invoice.invoice_date)<=date_to
      and upper(coalesce(invoice_status.code,'APROBADO'))
        not in('ANULADO','CANCELADO')
  ),documents as(
    select document.*,currency.currency_code,currency.name currency_name,
      currency.symbol currency_symbol,
      local_currency.currency_code local_currency_code,
      local_currency.name local_currency_name,
      local_currency.symbol local_currency_symbol,
      document.outstanding*document.exchange_rate historical_local_outstanding,
      greatest(date_to-document.due_date,0)overdue_days,
      case when date_to<=document.due_date then'CURRENT'
        when date_to-document.due_date<=30 then'1_30'
        when date_to-document.due_date<=60 then'31_60'
        when date_to-document.due_date<=90 then'61_90'
        when date_to-document.due_date<=120 then'91_120'
        else'OVER_120'end aging_bucket
    from document_source document
    join public.currencies currency using(currency_id)
    join public.currencies local_currency
      on local_currency.currency_id=document.local_currency_id
    where(filter_direction='ALL'or document.direction=filter_direction)
      and(cardinality(filter_currency_ids)=0
        or document.currency_id=any(filter_currency_ids))
      and(filter_party_key is null or(
        document.party_type=filter_party_type
        and document.party_id=filter_party_id
      ))
  ),subledger_summary as(
    select document.subsidiary_id,document.subsidiary_name,
      document.direction,document.party_type,document.party_id,
      document.party_key,document.party_code,document.party_name,
      document.identification,document.master_intercompany,
      document.account_id,document.account_number,document.account_name,
      document.currency_id,document.currency_code,document.currency_name,
      document.currency_symbol,
      sum(document.outstanding)document_balance,
      count(*)filter(where abs(document.outstanding)>.005)open_document_count,
      sum(document.original_amount)document_original_total,
      sum(document.applied_amount+document.credit_amount
        -document.debit_amount)settled_total
    from documents document
    group by document.subsidiary_id,document.subsidiary_name,
      document.direction,document.party_type,document.party_id,
      document.party_key,document.party_code,document.party_name,
      document.identification,document.master_intercompany,
      document.account_id,document.account_number,document.account_name,
      document.currency_id,document.currency_code,document.currency_name,
      document.currency_symbol
  ),summary_keys as(
    select subsidiary_id,direction,party_type,party_id,currency_id
    from ledger_summary
    union
    select subsidiary_id,direction,party_type,party_id,currency_id
    from subledger_summary
  ),reconciliation as(
    select key.subsidiary_id,
      coalesce(ledger_item.subsidiary_name,subledger_item.subsidiary_name)
        subsidiary_name,key.direction,key.party_type,key.party_id,
      key.party_type||':'||coalesce(key.party_id::text,'0')party_key,
      coalesce(ledger_item.party_code,subledger_item.party_code,
        'SIN-ASIGNAR')party_code,
      coalesce(ledger_item.party_name,subledger_item.party_name,
        case key.direction when'RECEIVABLE'then'Cliente sin asignar'
          else'Proveedor sin asignar'end)party_name,
      coalesce(ledger_item.identification,subledger_item.identification)
        identification,
      coalesce(ledger_item.master_intercompany,
        subledger_item.master_intercompany,false)master_intercompany,
      coalesce(ledger_item.account_id,subledger_item.account_id)account_id,
      coalesce(ledger_item.account_number,subledger_item.account_number)
        account_number,
      coalesce(ledger_item.account_name,subledger_item.account_name)
        account_name,key.currency_id,
      coalesce(ledger_item.currency_code,subledger_item.currency_code)
        currency_code,
      coalesce(ledger_item.currency_name,subledger_item.currency_name)
        currency_name,
      coalesce(ledger_item.currency_symbol,subledger_item.currency_symbol)
        currency_symbol,
      coalesce(ledger_item.opening_balance,0)opening_balance,
      coalesce(ledger_item.debits,0)debits,
      coalesce(ledger_item.credits,0)credits,
      coalesce(ledger_item.period_movement,0)period_movement,
      coalesce(ledger_item.closing_balance,0)closing_balance,
      coalesce(subledger_item.document_balance,0)document_balance,
      coalesce(subledger_item.open_document_count,0)open_document_count,
      coalesce(subledger_item.document_original_total,0)
        document_original_total,
      coalesce(subledger_item.settled_total,0)settled_total,
      coalesce(subledger_item.document_balance,0)
        -coalesce(ledger_item.closing_balance,0)difference
    from summary_keys key
    left join ledger_summary ledger_item
      on ledger_item.subsidiary_id=key.subsidiary_id
      and ledger_item.direction=key.direction
      and ledger_item.party_type=key.party_type
      and ledger_item.party_id is not distinct from key.party_id
      and ledger_item.currency_id=key.currency_id
    left join subledger_summary subledger_item
      on subledger_item.subsidiary_id=key.subsidiary_id
      and subledger_item.direction=key.direction
      and subledger_item.party_type=key.party_type
      and subledger_item.party_id is not distinct from key.party_id
      and subledger_item.currency_id=key.currency_id
  ),visible_reconciliation as(
    select *from reconciliation item
    where include_zero
      or abs(item.closing_balance)>.0000005
      or abs(item.document_balance)>.0000005
      or abs(item.debits)+abs(item.credits)>.0000005
  ),currency_summaries as(
    select item.currency_id,item.currency_code,item.currency_name,
      item.currency_symbol,
      sum(case when item.direction='RECEIVABLE'
        then item.opening_balance else 0 end)receivable_opening,
      sum(case when item.direction='PAYABLE'
        then item.opening_balance else 0 end)payable_opening,
      sum(case when item.direction='RECEIVABLE'
        then item.debits else 0 end)receivable_debits,
      sum(case when item.direction='RECEIVABLE'
        then item.credits else 0 end)receivable_credits,
      sum(case when item.direction='PAYABLE'
        then item.debits else 0 end)payable_debits,
      sum(case when item.direction='PAYABLE'
        then item.credits else 0 end)payable_credits,
      sum(case when item.direction='RECEIVABLE'
        then item.closing_balance else 0 end)receivable_closing,
      sum(case when item.direction='PAYABLE'
        then item.closing_balance else 0 end)payable_closing,
      sum(case when item.direction='RECEIVABLE'
        then item.closing_balance else-item.closing_balance end)net_position,
      sum(case when item.direction='RECEIVABLE'
        then item.document_balance else 0 end)receivable_documents,
      sum(case when item.direction='PAYABLE'
        then item.document_balance else 0 end)payable_documents
    from visible_reconciliation item
    group by item.currency_id,item.currency_code,item.currency_name,
      item.currency_symbol
  ),local_currency_summaries as(
    select item.subsidiary_id,item.subsidiary_name,
      item.local_currency_id currency_id,
      item.local_currency_code currency_code,
      item.local_currency_name currency_name,
      item.local_currency_symbol currency_symbol,
      sum(case when item.direction='RECEIVABLE'
        then item.opening_balance else 0 end)receivable_opening,
      sum(case when item.direction='PAYABLE'
        then item.opening_balance else 0 end)payable_opening,
      sum(case when item.direction='RECEIVABLE'
        then item.debits else 0 end)receivable_debits,
      sum(case when item.direction='RECEIVABLE'
        then item.credits else 0 end)receivable_credits,
      sum(case when item.direction='PAYABLE'
        then item.debits else 0 end)payable_debits,
      sum(case when item.direction='PAYABLE'
        then item.credits else 0 end)payable_credits,
      sum(case when item.direction='RECEIVABLE'
        then item.closing_balance else 0 end)receivable_closing,
      sum(case when item.direction='PAYABLE'
        then item.closing_balance else 0 end)payable_closing,
      sum(case when item.direction='RECEIVABLE'
        then item.closing_balance else-item.closing_balance end)net_position
    from local_summary item
    group by item.subsidiary_id,item.subsidiary_name,
      item.local_currency_id,item.local_currency_code,
      item.local_currency_name,item.local_currency_symbol
  ),running_ledger as(
    select detail.*,
      sum(detail.original_movement)over(
        partition by detail.subsidiary_id,detail.account_id,
          detail.party_type,coalesce(detail.party_id,0),detail.currency_id
        order by detail.date,detail.id rows unbounded preceding
      )original_running_balance,
      sum(detail.local_movement)over(
        partition by detail.subsidiary_id,detail.account_id,
          detail.party_type,coalesce(detail.party_id,0),detail.currency_id,
          detail.local_currency_id
        order by detail.date,detail.id rows unbounded preceding
      )local_running_balance
    from ledger detail
  ),period_details as(
    select detail.*
    from running_ledger detail
    where detail.date between date_from and date_to
      and(filter_search is null or concat_ws(' ',
        detail.transaction_number,detail.transaction_type,
        detail.journal_number,detail.account_number,detail.account_name,
        detail.party_code,detail.party_name,detail.identification,
        detail.memo,detail.note,detail.subsidiary_name
      )ilike'%'||filter_search||'%')
  ),document_details as(
    select document.*
    from documents document
    where(not only_pending or abs(document.outstanding)>.005)
      and(filter_search is null or concat_ws(' ',
        document.document_number,document.party_code,document.party_name,
        document.identification,document.account_number,
        document.account_name,document.currency_code,
        document.subsidiary_name
      )ilike'%'||filter_search||'%')
  )
  select jsonb_build_object(
    'report','intercompany-commercial',
    'generatedAt',current_timestamp,
    'dateFrom',date_from,'dateTo',date_to,
    'searchScope','DETAIL_ONLY',
    'accounts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',account.account_id,'number',account.account_number,
        'name',account.account_name,'direction',account.direction
      )order by account.account_number)from target_accounts account
    ),'[]'::jsonb),
    'receivables',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'direction',item.direction,'partyType',item.party_type,
        'partyId',item.party_id,'partyKey',item.party_key,
        'partyCode',item.party_code,'partyName',item.party_name,
        'identification',item.identification,
        'masterIntercompany',item.master_intercompany,
        'accountId',item.account_id,'accountNumber',item.account_number,
        'accountName',item.account_name,'currencyId',item.currency_id,
        'currencyCode',item.currency_code,'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'openingBalance',item.opening_balance,'debits',item.debits,
        'credits',item.credits,'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance,
        'documentBalance',item.document_balance,
        'openDocumentCount',item.open_document_count,
        'documentOriginalTotal',item.document_original_total,
        'settledTotal',item.settled_total,'difference',item.difference
      )order by item.currency_code,item.party_name,item.subsidiary_name)
      from visible_reconciliation item
      where item.direction='RECEIVABLE'
    ),'[]'::jsonb),
    'payables',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'direction',item.direction,'partyType',item.party_type,
        'partyId',item.party_id,'partyKey',item.party_key,
        'partyCode',item.party_code,'partyName',item.party_name,
        'identification',item.identification,
        'masterIntercompany',item.master_intercompany,
        'accountId',item.account_id,'accountNumber',item.account_number,
        'accountName',item.account_name,'currencyId',item.currency_id,
        'currencyCode',item.currency_code,'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'openingBalance',item.opening_balance,'debits',item.debits,
        'credits',item.credits,'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance,
        'documentBalance',item.document_balance,
        'openDocumentCount',item.open_document_count,
        'documentOriginalTotal',item.document_original_total,
        'settledTotal',item.settled_total,'difference',item.difference
      )order by item.currency_code,item.party_name,item.subsidiary_name)
      from visible_reconciliation item
      where item.direction='PAYABLE'
    ),'[]'::jsonb),
    'reconciliation',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'direction',item.direction,'partyType',item.party_type,
        'partyId',item.party_id,'partyKey',item.party_key,
        'partyCode',item.party_code,'partyName',item.party_name,
        'identification',item.identification,
        'masterIntercompany',item.master_intercompany,
        'accountId',item.account_id,'accountNumber',item.account_number,
        'accountName',item.account_name,'currencyId',item.currency_id,
        'currencyCode',item.currency_code,'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'openingBalance',item.opening_balance,'debits',item.debits,
        'credits',item.credits,'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance,
        'documentBalance',item.document_balance,
        'openDocumentCount',item.open_document_count,
        'documentOriginalTotal',item.document_original_total,
        'settledTotal',item.settled_total,'difference',item.difference
      )order by item.account_number,item.currency_code,item.party_name,
        item.subsidiary_name)
      from visible_reconciliation item
    ),'[]'::jsonb),
    'currencySummaries',coalesce((
      select jsonb_agg(jsonb_build_object(
        'currencyId',item.currency_id,'currencyCode',item.currency_code,
        'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'receivableOpening',item.receivable_opening,
        'payableOpening',item.payable_opening,
        'receivableDebits',item.receivable_debits,
        'receivableCredits',item.receivable_credits,
        'payableDebits',item.payable_debits,
        'payableCredits',item.payable_credits,
        'receivableClosing',item.receivable_closing,
        'payableClosing',item.payable_closing,
        'netPosition',item.net_position,
        'receivableDocuments',item.receivable_documents,
        'payableDocuments',item.payable_documents
      )order by item.currency_code)from currency_summaries item
    ),'[]'::jsonb),
    'localCurrencySummaries',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'currencyId',item.currency_id,'currencyCode',item.currency_code,
        'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'receivableOpening',item.receivable_opening,
        'payableOpening',item.payable_opening,
        'receivableDebits',item.receivable_debits,
        'receivableCredits',item.receivable_credits,
        'payableDebits',item.payable_debits,
        'payableCredits',item.payable_credits,
        'receivableClosing',item.receivable_closing,
        'payableClosing',item.payable_closing,
        'netPosition',item.net_position
      )order by item.subsidiary_name,item.currency_code)
      from local_currency_summaries item
    ),'[]'::jsonb),
    'localPositions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'direction',item.direction,'partyType',item.party_type,
        'partyId',item.party_id,'partyKey',item.party_key,
        'partyCode',item.party_code,'partyName',item.party_name,
        'identification',item.identification,
        'masterIntercompany',item.master_intercompany,
        'originalCurrencyId',item.original_currency_id,
        'originalCurrencyCode',item.original_currency_code,
        'originalCurrencyName',item.original_currency_name,
        'originalCurrencySymbol',item.original_currency_symbol,
        'localCurrencyId',item.local_currency_id,
        'localCurrencyCode',item.local_currency_code,
        'localCurrencyName',item.local_currency_name,
        'localCurrencySymbol',item.local_currency_symbol,
        'openingBalance',item.opening_balance,
        'debits',item.debits,'credits',item.credits,
        'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance,
        'receivableClosing',case when item.direction='RECEIVABLE'
          then item.closing_balance else 0 end,
        'payableClosing',case when item.direction='PAYABLE'
          then item.closing_balance else 0 end,
        'netPosition',case when item.direction='RECEIVABLE'
          then item.closing_balance else-item.closing_balance end
      )order by item.subsidiary_name,item.original_currency_code,
        item.party_name,item.direction)
      from local_summary item
      where include_zero or abs(item.closing_balance)>.0000005
        or abs(item.debits)+abs(item.credits)>.0000005
    ),'[]'::jsonb),
    'documents',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',document.source_key,'direction',document.direction,
        'partyType',document.party_type,'partyId',document.party_id,
        'partyKey',document.party_key,'partyCode',document.party_code,
        'partyName',document.party_name,
        'identification',document.identification,
        'masterIntercompany',document.master_intercompany,
        'subsidiaryId',document.subsidiary_id,
        'subsidiaryName',document.subsidiary_name,
        'accountId',document.account_id,
        'accountNumber',document.account_number,
        'accountName',document.account_name,
        'documentId',document.document_id,
        'documentNumber',document.document_number,
        'issueDate',document.issue_date,'dueDate',document.due_date,
        'postingDate',document.posting_date,
        'overdueDays',document.overdue_days,
        'agingBucket',document.aging_bucket,
        'currencyId',document.currency_id,
        'currencyCode',document.currency_code,
        'currencyName',document.currency_name,
        'currencySymbol',document.currency_symbol,
        'exchangeRate',document.exchange_rate,
        'originalAmount',document.original_amount,
        'appliedAmount',document.applied_amount,
        'creditAmount',document.credit_amount,
        'debitAmount',document.debit_amount,
        'outstanding',document.outstanding,
        'localCurrencyId',document.local_currency_id,
        'localCurrencyCode',document.local_currency_code,
        'localCurrencyName',document.local_currency_name,
        'localCurrencySymbol',document.local_currency_symbol,
        'historicalLocalOutstanding',
          document.historical_local_outstanding,
        'journalId',document.journal_id,
        'transactionId',document.transaction_id,
        'isOpeningBalance',document.is_opening_balance
      )order by document.direction,document.currency_code,
        document.party_name,document.due_date,document.document_number)
      from document_details document
    ),'[]'::jsonb),
    'details',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',detail.id,'date',detail.date,
        'transactionId',detail.transaction_id,
        'transactionNumber',detail.transaction_number,
        'transactionType',detail.transaction_type,
        'journalId',detail.journal_id,
        'journalNumber',detail.journal_number,
        'memo',detail.memo,'note',detail.note,
        'subsidiaryId',detail.subsidiary_id,
        'subsidiaryName',detail.subsidiary_name,
        'direction',detail.direction,
        'partyType',detail.party_type,'partyId',detail.party_id,
        'partyKey',detail.party_key,'partyCode',coalesce(
          detail.party_code,'SIN-ASIGNAR'),
        'partyName',coalesce(detail.party_name,
          case detail.direction when'RECEIVABLE'then'Cliente sin asignar'
            else'Proveedor sin asignar'end),
        'identification',detail.identification,
        'partyAssigned',detail.party_id is not null,
        'masterIntercompany',detail.master_intercompany,
        'accountId',detail.account_id,
        'accountNumber',detail.account_number,
        'accountName',detail.account_name,
        'currencyId',detail.currency_id,
        'currencyCode',detail.currency_code,
        'currencyName',detail.currency_name,
        'currencySymbol',detail.currency_symbol,
        'exchangeRate',detail.exchange_rate,
        'originalDebit',detail.original_debit,
        'originalCredit',detail.original_credit,
        'originalMovement',detail.original_movement,
        'originalRunningBalance',detail.original_running_balance,
        'localCurrencyId',detail.local_currency_id,
        'localCurrencyCode',detail.local_currency_code,
        'localCurrencyName',detail.local_currency_name,
        'localCurrencySymbol',detail.local_currency_symbol,
        'localDebit',detail.local_debit,
        'localCredit',detail.local_credit,
        'localMovement',detail.local_movement,
        'localRunningBalance',detail.local_running_balance,
        'isFxRevaluation',detail.is_fx_revaluation
      )order by detail.date,detail.id)from period_details detail
    ),'[]'::jsonb),
    'quality',jsonb_build_object(
      'movementCount',(select count(*)from period_details),
      'documentCount',(select count(*)from document_details),
      'openDocumentCount',(select count(*)from documents
        where abs(outstanding)>.005),
      'partyCount',(select count(distinct party_type||':'||party_id)
        from reconciliation where party_id is not null),
      'thirdPartyCount',(select count(distinct party_type||':'||party_id)
        from reconciliation where party_id is not null),
      'currencyCount',(select count(distinct currency_id)from reconciliation),
      'unassignedPartyMovementCount',(select count(*)from ledger
        where party_id is null),
      'missingThirdPartyCount',(select count(*)from ledger
        where party_id is null),
      'unassignedOpeningPartyMovementCount',(select count(*)from ledger
        where party_id is null and date<date_from),
      'missingOpeningThirdPartyCount',(select count(*)from ledger
        where party_id is null and date<date_from),
      'unassignedPeriodPartyMovementCount',(select count(*)from ledger
        where party_id is null and date>=date_from),
      'missingPeriodThirdPartyCount',(select count(*)from ledger
        where party_id is null and date>=date_from),
      'classificationMismatchCount',(select count(*)from documents
        where not master_intercompany),
      'reconciliationDifferenceCount',(select count(*)
        from reconciliation where abs(difference)>.005),
      'fxAdjustmentMovementCount',(select count(*)from ledger
        where is_fx_revaluation and date between date_from and date_to),
      'hasReconciliationDifferences',exists(select 1
        from reconciliation where abs(difference)>.005),
      'valid',not exists(select 1 from ledger where party_id is null)
        and not exists(select 1 from reconciliation
          where abs(difference)>.005)
        and not exists(select 1 from documents
          where not master_intercompany),
      'issues',coalesce((
        select jsonb_agg(issue)from(values
          (case when exists(select 1 from ledger where party_id is null)
            then jsonb_build_object('code','MISSING_PARTY',
              'message','Hay movimientos de 113002/211002 sin cliente o proveedor asignado.')end),
          (case when exists(select 1 from reconciliation
              where abs(difference)>.005)
            then jsonb_build_object('code','RECONCILIATION_DIFFERENCE',
              'message','El auxiliar comercial no coincide con el Mayor para uno o más terceros y monedas.')end),
          (case when exists(select 1 from documents
              where not master_intercompany)
            then jsonb_build_object('code','MASTER_CLASSIFICATION',
              'message','Hay documentos históricos de 113002/211002 cuyo tercero ya no está marcado como intercompany.')end)
        )warning(issue)where issue is not null
      ),'[]'::jsonb)
    )
  )into report;

  return report||jsonb_build_object(
    'rows',report->'details',
    'total',jsonb_array_length(report->'details')
  );
end
;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_intercompany_loan_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('intercompany-loans');
 begin perform report_template_private.enter('reports:accounting-reports','view');

declare
  subsidiary_ids bigint[];
  filter_book_id bigint:=nullif(p_filters->>'bookId','')::bigint;
  filter_related_company_id bigint:=nullif(
    p_filters->>'relatedCompanyId',''
  )::bigint;
  filter_account_id bigint:=nullif(p_filters->>'accountId','')::bigint;
  filter_currency_ids bigint[];
  filter_related_company_state text:=upper(coalesce(
    nullif(p_filters->>'relatedCompanyState',''),'ALL'
  ));
  filter_direction text:=upper(coalesce(
    nullif(p_filters->>'direction',''),'ALL'
  ));
  include_zero boolean:=coalesce(
    nullif(p_filters->>'includeZero','')::boolean,false
  );
  filter_search text:=nullif(btrim(p_filters->>'search'),'');
  date_from date:=coalesce(
    nullif(p_filters->>'dateFrom','')::date,
    date_trunc('year',current_date)::date
  );
  date_to date:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
  report jsonb;
begin
  select coalesce(array_agg(value::bigint),array[]::bigint[])
    into subsidiary_ids
  from jsonb_array_elements_text(
    coalesce(p_filters->'subsidiaryIds','[]'::jsonb)
  );

  if cardinality(subsidiary_ids)=0 then
    subsidiary_ids:=array[public.active_subsidiary_id()];
  end if;

  if subsidiary_ids[1]is null or exists(
    select 1 from unnest(subsidiary_ids)selected(subsidiary_id)
    where not exists(
      select 1 from public.user_subsidiaries access
      where access.user_id=public.app_user_id()
        and access.subsidiary_id=selected.subsidiary_id
    )
  )then
    raise exception 'No tiene acceso a una o más subsidiarias seleccionadas.';
  end if;

  if date_from>date_to then
    raise exception 'La fecha inicial no puede ser posterior a la fecha final.';
  end if;

  -- journal_line/gl_impact do not expose a reliable line-level analytical
  -- mapping for secondary books.  Accepting one here would make a primary
  -- journal line appear as if it belonged to that book.  Until the posting
  -- model stores book-specific journal lines, this report is intentionally
  -- limited to the single active primary book of one subsidiary.
  if filter_book_id is not null and(
    cardinality(subsidiary_ids)<>1
    or not exists(
      select 1
      from public.accounting_books book
      where book.accounting_book_id=filter_book_id
        and book.subsidiary_id=subsidiary_ids[1]
        and book.is_primary and book.is_active
    )
  )then
    raise exception 'Este reporte solo admite el libro contable principal activo de una subsidiaria.';
  end if;

  if filter_related_company_state not in('ALL','ASSIGNED','UNASSIGNED')then
    raise exception 'Estado de compañía relacionada no válido.';
  end if;

  if filter_direction not in('ALL','RECEIVABLE','PAYABLE')then
    raise exception 'Tipo de saldo intercompany no válido.';
  end if;

  select coalesce(array_agg(value::bigint),array[]::bigint[])
    into filter_currency_ids
  from jsonb_array_elements_text(
    coalesce(p_filters->'currencyIds','[]'::jsonb)
  );

  with recursive requested_groups as(
    select account_group.group_id,account_group.group_code,
      account_group.group_name,account_group.parent_id,
      case when account_group.group_code='119'
        or lower(account_group.group_name)=lower(
          'Cuentas por Cobrar Compañías Relacionadas'
        )then'RECEIVABLE'else'PAYABLE'end direction,
      account_group.group_id root_group_id,
      account_group.group_code root_group_code,
      account_group.group_name root_group_name
    from public.account_group
    where not coalesce(account_group.is_inactive,false)
      and(
        account_group.group_code in('119','219')
        or lower(account_group.group_name)in(
          lower('Cuentas por Cobrar Compañías Relacionadas'),
          lower('Cuentas por Pagar Compañías Relacionadas')
        )
      )
    union all
    select child.group_id,child.group_code,child.group_name,child.parent_id,
      parent.direction,parent.root_group_id,parent.root_group_code,
      parent.root_group_name
    from public.account_group child
    join requested_groups parent on parent.group_id=child.parent_id
    where not coalesce(child.is_inactive,false)
  ),target_accounts as(
    select account.account_id,account.account_number,account.account_name,
      groups.root_group_id account_group_id,
      groups.root_group_code account_group_code,
      groups.root_group_name account_group_name,groups.direction
    from public.chart_accounts account
    join requested_groups groups
      on groups.group_id=account.account_group_id
    where not coalesce(account.is_inactive,false)
      and not coalesce(account.is_summary,false)
  ),raw_movements as(
    -- journal_line is the authoritative analytical grain.  Matching GL and
    -- journal rows by ordinal can attribute a movement to the wrong related
    -- company when the same account is repeated in one journal.  EXISTS only
    -- proves that the line's transaction/account reached the selected book;
    -- it never supplies or changes the analytical dimension.
    select line.journal_line_id id,journal.transaction_id,
      journal.journal_date date,
      coalesce(tran.tran_number,journal.journal_number)transaction_number,
      coalesce(transaction_type.name,journal.journal_type)transaction_type,
      journal.journal_id,journal.journal_number,journal.memo,line.note,
      journal.fx_revaluation_run_id,
      journal.fx_revaluation_run_id is not null is_fx_revaluation,
      journal.subsidiary_id,subsidiary.name subsidiary_name,
      account.direction,account.account_group_id,
      account.account_group_code,account.account_group_name,
      account.account_id,account.account_number,account.account_name,
      line.related_company_id,company.code related_company_code,
      company.name related_company_name,
      company.identification related_company_identification,
      coalesce(
        line.original_currency_id,fx_run.currency_id,journal.currency_id,
        subsidiary.currency_id
      )currency_id,
      subsidiary.currency_id local_currency_id,
      case when journal.fx_revaluation_run_id is not null then line.debit
        when line.opening_balance_line_id is not null then line.debit
        else line.debit*journal.exchange_rate end local_debit,
      case when journal.fx_revaluation_run_id is not null then line.credit
        when line.opening_balance_line_id is not null then line.credit
        else line.credit*journal.exchange_rate end local_credit,
      case when journal.fx_revaluation_run_id is not null then 0::numeric
        when line.original_currency_id is not null
          or line.opening_balance_line_id is not null then line.debit_fx
        else line.debit end original_debit,
      case when journal.fx_revaluation_run_id is not null then 0::numeric
        when line.original_currency_id is not null
          or line.opening_balance_line_id is not null then line.credit_fx
        else line.credit end original_credit,
      case when journal.fx_revaluation_run_id is not null
        then coalesce(fx_run.closing_rate,1)
        when line.opening_balance_line_id is not null
        then coalesce(line.historical_exchange_rate,journal.exchange_rate,1)
        else coalesce(journal.exchange_rate,1)end exchange_rate
    from public.journal_line line
    join public.journal journal using(journal_id)
    join target_accounts account using(account_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    join public."transaction" tran using(transaction_id)
    join public.transaction_types transaction_type using(transaction_type_id)
    left join public.fx_revaluation_runs fx_run
      on fx_run.run_id=journal.fx_revaluation_run_id
    left join public.related_companies company
      on company.related_company_id=line.related_company_id
    where journal.subsidiary_id=any(subsidiary_ids)
      and journal.journal_date<=date_to
      and(line.debit>0 or line.credit>0)
      and exists(
        select 1
        from public.gl_impact impact
        join public.accounting_books book using(accounting_book_id)
        where impact.transaction_id=journal.transaction_id
          and impact.account_id=line.account_id
          and impact.subsidiary_id=journal.subsidiary_id
          and impact.posting_date=journal.journal_date
          and(
            filter_book_id is not null
              and impact.accounting_book_id=filter_book_id
            or filter_book_id is null and book.is_primary and book.is_active
          )
      )
  ),movements as(
    select movement.*,
      currency.currency_code,currency.name currency_name,
      currency.symbol currency_symbol,
      local_currency.currency_code local_currency_code,
      local_currency.name local_currency_name,
      local_currency.symbol local_currency_symbol,
      case when movement.direction='RECEIVABLE'
        then movement.original_debit-movement.original_credit
        else movement.original_credit-movement.original_debit
      end original_movement,
      case when movement.direction='RECEIVABLE'
        then movement.local_debit-movement.local_credit
        else movement.local_credit-movement.local_debit
      end local_movement
    from raw_movements movement
    join public.currencies currency using(currency_id)
    join public.currencies local_currency
      on local_currency.currency_id=movement.local_currency_id
    where(filter_related_company_id is null
        or movement.related_company_id=filter_related_company_id)
      and(filter_account_id is null or movement.account_id=filter_account_id)
      and(cardinality(filter_currency_ids)=0
        or movement.currency_id=any(filter_currency_ids))
      and(filter_direction='ALL'or movement.direction=filter_direction)
      and(filter_related_company_state='ALL'
        or filter_related_company_state='ASSIGNED'
          and movement.related_company_id is not null
        or filter_related_company_state='UNASSIGNED'
          and movement.related_company_id is null)
  ),running as(
    select movement.*,
      sum(movement.original_movement)over(
        partition by movement.subsidiary_id,movement.account_id,
          coalesce(movement.related_company_id,0),movement.currency_id
        order by movement.date,movement.id rows unbounded preceding
      )original_running_balance,
      sum(movement.local_movement)over(
        partition by movement.subsidiary_id,movement.account_id,
          coalesce(movement.related_company_id,0),movement.currency_id,
          movement.local_currency_id
        order by movement.date,movement.id rows unbounded preceding
      )local_running_balance
    from movements movement
  ),period_details as(
    select detail.* from running detail
    where detail.date between date_from and date_to
      and(filter_search is null or concat_ws(' ',
        detail.transaction_number,detail.transaction_type,
        detail.journal_number,detail.account_number,detail.account_name,
        detail.related_company_code,detail.related_company_name,
        detail.related_company_identification,detail.memo,detail.note,
        detail.subsidiary_name
      )ilike'%'||filter_search||'%')
  ),company_currency as(
    select movement.related_company_id,
      coalesce(movement.related_company_code,'SIN-ASIGNAR')related_company_code,
      coalesce(
        movement.related_company_name,'Sin compañía relacionada'
      )related_company_name,
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol,movement.direction,
      sum(case when movement.date<date_from
        then movement.original_movement else 0 end)opening_balance,
      sum(case when movement.date between date_from and date_to
        then movement.original_debit else 0 end)debits,
      sum(case when movement.date between date_from and date_to
        then movement.original_credit else 0 end)credits,
      sum(case when movement.date between date_from and date_to
        then movement.original_movement else 0 end)period_movement,
      sum(movement.original_movement)closing_balance
    from movements movement
    group by movement.related_company_id,
      coalesce(movement.related_company_code,'SIN-ASIGNAR'),
      coalesce(movement.related_company_name,'Sin compañía relacionada'),
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol,movement.direction
    having include_zero
      or abs(sum(movement.original_movement))>.0000005
      or abs(sum(case when movement.date between date_from and date_to
        then movement.original_debit+movement.original_credit else 0 end)
      )>.0000005
  ),position_keys as(
    select distinct related_company_id,related_company_code,
      related_company_name,currency_id,currency_code,currency_name,
      currency_symbol
    from company_currency
  ),net_positions as(
    select key.*,
      coalesce(receivable.opening_balance,0)receivable_opening,
      coalesce(payable.opening_balance,0)payable_opening,
      coalesce(receivable.debits,0)receivable_debits,
      coalesce(receivable.credits,0)receivable_credits,
      coalesce(payable.debits,0)payable_debits,
      coalesce(payable.credits,0)payable_credits,
      coalesce(receivable.closing_balance,0)receivable_closing,
      coalesce(payable.closing_balance,0)payable_closing,
      coalesce(receivable.closing_balance,0)
        -coalesce(payable.closing_balance,0)net_position
    from position_keys key
    left join company_currency receivable
      on receivable.related_company_id is not distinct from key.related_company_id
      and receivable.currency_id=key.currency_id
      and receivable.direction='RECEIVABLE'
    left join company_currency payable
      on payable.related_company_id is not distinct from key.related_company_id
      and payable.currency_id=key.currency_id
      and payable.direction='PAYABLE'
  ),local_positions as(
    -- Auditable local equivalent at the same analytical grain as netPositions.
    -- Keeping original_currency_id in the key prevents unlike currencies from
    -- being blended merely because they share a functional currency.
    select movement.subsidiary_id,movement.subsidiary_name,
      movement.related_company_id,
      coalesce(movement.related_company_code,'SIN-ASIGNAR')
        related_company_code,
      coalesce(movement.related_company_name,'Sin compañía relacionada')
        related_company_name,
      movement.currency_id original_currency_id,
      movement.currency_code original_currency_code,
      movement.currency_name original_currency_name,
      movement.currency_symbol original_currency_symbol,
      movement.local_currency_id,movement.local_currency_code,
      movement.local_currency_name,movement.local_currency_symbol,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date<date_from then movement.local_movement else 0 end)
        receivable_opening,
      sum(case when movement.direction='PAYABLE'
        and movement.date<date_from then movement.local_movement else 0 end)
        payable_opening,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date between date_from and date_to
        then movement.local_debit else 0 end)receivable_debits,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date between date_from and date_to
        then movement.local_credit else 0 end)receivable_credits,
      sum(case when movement.direction='PAYABLE'
        and movement.date between date_from and date_to
        then movement.local_debit else 0 end)payable_debits,
      sum(case when movement.direction='PAYABLE'
        and movement.date between date_from and date_to
        then movement.local_credit else 0 end)payable_credits,
      sum(case when movement.direction='RECEIVABLE'
        then movement.local_movement else 0 end)receivable_closing,
      sum(case when movement.direction='PAYABLE'
        then movement.local_movement else 0 end)payable_closing,
      sum(case when movement.direction='RECEIVABLE'
        then movement.local_movement else-movement.local_movement end)
        net_position
    from movements movement
    group by movement.subsidiary_id,movement.subsidiary_name,
      movement.related_company_id,
      coalesce(movement.related_company_code,'SIN-ASIGNAR'),
      coalesce(movement.related_company_name,'Sin compañía relacionada'),
      movement.currency_id,movement.currency_code,movement.currency_name,
      movement.currency_symbol,movement.local_currency_id,
      movement.local_currency_code,movement.local_currency_name,
      movement.local_currency_symbol
    having include_zero
      or abs(sum(case when movement.direction='RECEIVABLE'
        then movement.local_movement else 0 end))>.0000005
      or abs(sum(case when movement.direction='PAYABLE'
        then movement.local_movement else 0 end))>.0000005
      or abs(sum(case when movement.date between date_from and date_to
        then movement.local_debit+movement.local_credit else 0 end))>.0000005
  ),currency_summaries as(
    select currency_id,currency_code,currency_name,currency_symbol,
      sum(receivable_opening)receivable_opening,
      sum(payable_opening)payable_opening,
      sum(receivable_debits)receivable_debits,
      sum(receivable_credits)receivable_credits,
      sum(payable_debits)payable_debits,
      sum(payable_credits)payable_credits,
      sum(receivable_closing)receivable_closing,
      sum(payable_closing)payable_closing,
      sum(net_position)net_position
    from net_positions
    group by currency_id,currency_code,currency_name,currency_symbol
  ),local_summaries as(
    select movement.subsidiary_id,movement.subsidiary_name,
      movement.local_currency_id currency_id,
      movement.local_currency_code currency_code,
      movement.local_currency_name currency_name,
      movement.local_currency_symbol currency_symbol,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date<date_from then movement.local_movement else 0 end)
        receivable_opening,
      sum(case when movement.direction='PAYABLE'
        and movement.date<date_from then movement.local_movement else 0 end)
        payable_opening,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date between date_from and date_to
        then movement.local_debit else 0 end)receivable_debits,
      sum(case when movement.direction='RECEIVABLE'
        and movement.date between date_from and date_to
        then movement.local_credit else 0 end)receivable_credits,
      sum(case when movement.direction='PAYABLE'
        and movement.date between date_from and date_to
        then movement.local_debit else 0 end)payable_debits,
      sum(case when movement.direction='PAYABLE'
        and movement.date between date_from and date_to
        then movement.local_credit else 0 end)payable_credits,
      sum(case when movement.direction='RECEIVABLE'
        then movement.local_movement else 0 end)receivable_closing,
      sum(case when movement.direction='PAYABLE'
        then movement.local_movement else 0 end)payable_closing,
      sum(case when movement.direction='RECEIVABLE'
        then movement.local_movement else-movement.local_movement end)
        net_position
    from movements movement
    group by movement.subsidiary_id,movement.subsidiary_name,
      movement.local_currency_id,movement.local_currency_code,
      movement.local_currency_name,movement.local_currency_symbol
  ),group_headers as(
    select distinct root_group_id id,root_group_code code,
      root_group_name name,direction
    from requested_groups
    where group_id=root_group_id
  )
  select jsonb_build_object(
    'report','intercompany-loans',
    'generatedAt',current_timestamp,
    'dateFrom',date_from,
    'dateTo',date_to,
    'searchScope','DETAIL_ONLY',
    'accountGroups',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',header.id,'code',header.code,'name',header.name,
        'direction',header.direction
      )order by header.code)from group_headers header
    ),'[]'::jsonb),
    'receivables',coalesce((
      select jsonb_agg(jsonb_build_object(
        'relatedCompanyId',item.related_company_id,
        'relatedCompanyCode',item.related_company_code,
        'relatedCompanyName',item.related_company_name,
        'currencyId',item.currency_id,'currencyCode',item.currency_code,
        'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'openingBalance',item.opening_balance,'debits',item.debits,
        'credits',item.credits,'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance
      )order by item.currency_code,item.related_company_name)
      from company_currency item where item.direction='RECEIVABLE'
    ),'[]'::jsonb),
    'payables',coalesce((
      select jsonb_agg(jsonb_build_object(
        'relatedCompanyId',item.related_company_id,
        'relatedCompanyCode',item.related_company_code,
        'relatedCompanyName',item.related_company_name,
        'currencyId',item.currency_id,'currencyCode',item.currency_code,
        'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'openingBalance',item.opening_balance,'debits',item.debits,
        'credits',item.credits,'periodMovement',item.period_movement,
        'closingBalance',item.closing_balance
      )order by item.currency_code,item.related_company_name)
      from company_currency item where item.direction='PAYABLE'
    ),'[]'::jsonb),
    'netPositions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'relatedCompanyId',item.related_company_id,
        'relatedCompanyCode',item.related_company_code,
        'relatedCompanyName',item.related_company_name,
        'currencyId',item.currency_id,'currencyCode',item.currency_code,
        'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'receivableOpening',item.receivable_opening,
        'payableOpening',item.payable_opening,
        'receivableDebits',item.receivable_debits,
        'receivableCredits',item.receivable_credits,
        'payableDebits',item.payable_debits,
        'payableCredits',item.payable_credits,
        'receivableClosing',item.receivable_closing,
        'payableClosing',item.payable_closing,
        'netPosition',item.net_position
      )order by item.currency_code,item.related_company_name)
      from net_positions item
    ),'[]'::jsonb),
    'localPositions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'relatedCompanyId',item.related_company_id,
        'relatedCompanyCode',item.related_company_code,
        'relatedCompanyName',item.related_company_name,
        'originalCurrencyId',item.original_currency_id,
        'originalCurrencyCode',item.original_currency_code,
        'originalCurrencyName',item.original_currency_name,
        'originalCurrencySymbol',item.original_currency_symbol,
        'localCurrencyId',item.local_currency_id,
        'localCurrencyCode',item.local_currency_code,
        'localCurrencyName',item.local_currency_name,
        'localCurrencySymbol',item.local_currency_symbol,
        'receivableOpening',item.receivable_opening,
        'payableOpening',item.payable_opening,
        'receivableDebits',item.receivable_debits,
        'receivableCredits',item.receivable_credits,
        'payableDebits',item.payable_debits,
        'payableCredits',item.payable_credits,
        'receivableClosing',item.receivable_closing,
        'payableClosing',item.payable_closing,
        'netPosition',item.net_position
      )order by item.subsidiary_name,item.original_currency_code,
        item.related_company_name)from local_positions item
    ),'[]'::jsonb),
    'currencySummaries',coalesce((
      select jsonb_agg(jsonb_build_object(
        'currencyId',item.currency_id,'currencyCode',item.currency_code,
        'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'receivableOpening',item.receivable_opening,
        'payableOpening',item.payable_opening,
        'receivableDebits',item.receivable_debits,
        'receivableCredits',item.receivable_credits,
        'payableDebits',item.payable_debits,
        'payableCredits',item.payable_credits,
        'receivableClosing',item.receivable_closing,
        'payableClosing',item.payable_closing,
        'netPosition',item.net_position
      )order by item.currency_code)from currency_summaries item
    ),'[]'::jsonb),
    'localCurrencySummaries',coalesce((
      select jsonb_agg(jsonb_build_object(
        'subsidiaryId',item.subsidiary_id,
        'subsidiaryName',item.subsidiary_name,
        'currencyId',item.currency_id,'currencyCode',item.currency_code,
        'currencyName',item.currency_name,
        'currencySymbol',item.currency_symbol,
        'receivableOpening',item.receivable_opening,
        'payableOpening',item.payable_opening,
        'receivableDebits',item.receivable_debits,
        'receivableCredits',item.receivable_credits,
        'payableDebits',item.payable_debits,
        'payableCredits',item.payable_credits,
        'receivableClosing',item.receivable_closing,
        'payableClosing',item.payable_closing,
        'netPosition',item.net_position
      )order by item.subsidiary_name,item.currency_code)
      from local_summaries item
    ),'[]'::jsonb),
    'quality',jsonb_build_object(
      'movementCount',(select count(*)from period_details),
      'accountCount',(select count(distinct account_id)from movements),
      'relatedCompanyCount',(select count(distinct related_company_id)
        from movements where related_company_id is not null),
      'currencyCount',(select count(distinct currency_id)from movements),
      'fxAdjustmentMovementCount',(select count(*)from movements
        where is_fx_revaluation and date between date_from and date_to),
      'unassignedMovementCount',(select count(*)from movements
        where related_company_id is null),
      'unassignedOpeningMovementCount',(select count(*)from movements
        where related_company_id is null and date<date_from),
      'unassignedPeriodMovementCount',(select count(*)from movements
        where related_company_id is null and date>=date_from),
      'hasUnassignedDimensions',exists(select 1 from movements
        where related_company_id is null)
    ),
    'details',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',detail.id,'date',detail.date,
        'transactionId',detail.transaction_id,
        'transactionNumber',detail.transaction_number,
        'transactionType',detail.transaction_type,
        'journalId',detail.journal_id,'journalNumber',detail.journal_number,
        'fxRevaluationRunId',detail.fx_revaluation_run_id,
        'isFxRevaluation',detail.is_fx_revaluation,
        'memo',detail.memo,'note',detail.note,
        'subsidiaryId',detail.subsidiary_id,
        'subsidiaryName',detail.subsidiary_name,
        'direction',detail.direction,
        'accountGroupId',detail.account_group_id,
        'accountGroupCode',detail.account_group_code,
        'accountGroupName',detail.account_group_name,
        'accountId',detail.account_id,
        'accountNumber',detail.account_number,
        'accountName',detail.account_name,
        'relatedCompanyId',detail.related_company_id,
        'relatedCompanyCode',coalesce(
          detail.related_company_code,'SIN-ASIGNAR'
        ),
        'relatedCompanyName',coalesce(
          detail.related_company_name,'Sin compañía relacionada'
        ),
        'relatedCompanyIdentification',
          detail.related_company_identification,
        'dimensionAssigned',detail.related_company_id is not null,
        'currencyId',detail.currency_id,
        'currencyCode',detail.currency_code,
        'currencyName',detail.currency_name,
        'currencySymbol',detail.currency_symbol,
        'exchangeRate',detail.exchange_rate,
        'originalDebit',detail.original_debit,
        'originalCredit',detail.original_credit,
        'originalMovement',detail.original_movement,
        'originalRunningBalance',detail.original_running_balance,
        'localCurrencyId',detail.local_currency_id,
        'localCurrencyCode',detail.local_currency_code,
        'localCurrencyName',detail.local_currency_name,
        'localCurrencySymbol',detail.local_currency_symbol,
        'localDebit',detail.local_debit,
        'localCredit',detail.local_credit,
        'localMovement',detail.local_movement,
        'localRunningBalance',detail.local_running_balance
      )order by detail.date,detail.id)from period_details detail
    ),'[]'::jsonb)
  )into report;

  return report
    ||jsonb_build_object(
      'rows',report->'details',
      'total',jsonb_array_length(report->'details')
    );
end
;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_payment_request_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('payment-requests');
 begin perform report_template_private.enter('reports:accounting-reports','view');
begin perform asset_posting_private.access('reports:accounting-reports','view');return payment_request_private.run_payment_request_report(p_filters);end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_payroll_journal_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('payroll-journals');
 declare sid bigint;uid bigint;df date;dt date;kind text;aid bigint;rows jsonb;accounts jsonb;company jsonb;begin
 perform public.security_assert_role_access('reports:accounting-reports','view');
 uid:=public.app_user_id();sid:=public.active_subsidiary_id();
 if uid is null or sid is null or not exists(select 1 from public.users u join public.user_subsidiaries s using(user_id) where u.user_id=uid and u.is_active and s.subsidiary_id=sid) then raise exception using errcode='42501',message='La subsidiaria activa no está autorizada.';end if;
 if jsonb_typeof(p_filters) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_filters) k where k not in('dateFrom','dateTo','transactionType','accountId','noteMode')) then raise exception using errcode='22023',message='Filtros inválidos.';end if;
 if coalesce(p_filters->>'dateFrom','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_filters->>'dateTo','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception using errcode='22023',message='Seleccione un rango de fechas válido.';end if;
 if coalesce(p_filters->>'noteMode','HEADER') not in('LINE','HEADER') then raise exception using errcode='22023',message='Agrupacion invalida.';end if;
 df:=(p_filters->>'dateFrom')::date;dt:=(p_filters->>'dateTo')::date;
 if df>dt or date_trunc('month',df)<>date_trunc('month',dt) then raise exception using errcode='22023',message='Seleccione fechas ordenadas dentro del mismo mes.';end if;
 kind:=coalesce(p_filters->>'transactionType','ALL');
 if kind not in('ALL','ASI_NOM','ASI_LIQ','ASI_UTI','ASI_UTI') then raise exception using errcode='22023',message='Seleccione nómina, liquidación o ambos tipos.';end if;
 if nullif(p_filters->>'accountId','') is not null then
  if p_filters->>'accountId'!~'^[1-9][0-9]{0,18}$' then raise exception using errcode='22023',message='Cuenta inválida.';end if;aid:=(p_filters->>'accountId')::bigint;
 end if;
 with recursive g as(select group_id from public.account_group where group_code='223' union select x.group_id from public.account_group x join g on x.parent_id=g.group_id)
 select coalesce(jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name) order by a.account_number),'[]') into accounts from public.chart_accounts a
 where a.account_group_id in(select group_id from g) and (exists(select 1 from public.account_subsidiaries s where s.account_id=a.account_id and s.subsidiary_id=sid) or exists(select 1 from public.journal_line l join public.journal j using(journal_id) where l.account_id=a.account_id and j.subsidiary_id=sid));
 if aid is not null and not exists(select 1 from jsonb_array_elements(accounts) x where (x->>'id')::bigint=aid) then raise exception using errcode='42501',message='Cuenta fuera del grupo o subsidiaria.';end if;
 if exists(select 1 from public.journal j join public.journal_line l using(journal_id) join public."transaction" t on t.transaction_id=j.transaction_id and t.subsidiary_id=sid join public.transaction_types tt using(transaction_type_id)
  where j.subsidiary_id=sid and j.status='CONTABILIZADO' and j.journal_date between df and dt and tt.abbreviation in('ASI_NOM','ASI_LIQ','ASI_UTI') and(kind='ALL' or tt.abbreviation=kind)
  and l.account_id in(select (x->>'id')::bigint from jsonb_array_elements(accounts)x) and(aid is null or l.account_id=aid)
  and(j.exchange_rate is null or j.exchange_rate<=0 or j.exchange_rate::text in('NaN','Infinity','-Infinity') or l.debit is null or l.credit is null or l.debit::text in('NaN','Infinity','-Infinity') or l.credit::text in('NaN','Infinity','-Infinity'))) then raise exception using errcode='55000',message='Existen asientos con importes o tipo de cambio inválidos.';end if;
 with detail as(
  select a.account_id,a.account_number,a.account_name,j.journal_id,j.journal_number,j.journal_date,tt.abbreviation,
   case when coalesce(p_filters->>'noteMode','HEADER')='HEADER' then coalesce(nullif(btrim(j.memo),''),'Sin nota del asiento') else coalesce(nullif(btrim(l.note),''),nullif(btrim(j.memo),''),'Sin nota') end note,l.department_id,coalesce(d.name,'Sin departamento') department,
   j.currency_id,cu.currency_code,sum(l.debit) debit_original,sum(l.credit) credit_original,
   sum(round(l.debit*j.exchange_rate,6)) debit,sum(round(l.credit*j.exchange_rate,6)) credit
  from public.journal j join public.journal_line l using(journal_id) join public.chart_accounts a using(account_id)
  join public."transaction" t on t.transaction_id=j.transaction_id and t.subsidiary_id=sid
  join public.transaction_types tt using(transaction_type_id) left join public.departments d on d.department_id=l.department_id left join public.currencies cu on cu.currency_id=j.currency_id
  where j.subsidiary_id=sid and j.status='CONTABILIZADO' and j.journal_date between df and dt
  and tt.abbreviation in('ASI_NOM','ASI_LIQ','ASI_UTI') and(kind='ALL' or tt.abbreviation=kind)
  and a.account_id in(select (x->>'id')::bigint from jsonb_array_elements(accounts)x) and(aid is null or a.account_id=aid)
  group by a.account_id,a.account_number,a.account_name,j.journal_id,j.journal_number,j.journal_date,tt.abbreviation,j.memo,case when coalesce(p_filters->>'noteMode','HEADER')='HEADER' then coalesce(nullif(btrim(j.memo),''),'Sin nota del asiento') else coalesce(nullif(btrim(l.note),''),nullif(btrim(j.memo),''),'Sin nota') end,l.department_id,d.name,j.currency_id,cu.currency_code
 ) select coalesce(jsonb_agg(jsonb_build_object('accountId',account_id,'accountNumber',account_number,'accountName',account_name,'journalId',journal_id,'journalNumber',journal_number,'date',journal_date,'type',abbreviation,'note',note,'departmentId',department_id,'department',department,'currencyId',currency_id,'currency',currency_code,'debit',debit,'credit',credit,'net',credit-debit,'debitOriginal',debit_original,'creditOriginal',credit_original,'netOriginal',credit_original-debit_original) order by account_number,note,journal_date,journal_number,journal_id,department,department_id),'[]') into rows from detail;
 if jsonb_array_length(rows)>10000 then raise exception using errcode='22023',message='El resultado supera 10000 filas. Reduzca las fechas o seleccione una cuenta.';end if;
 select jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currency',c.currency_code) into company from public.subsidiaries s join public.currencies c using(currency_id) where s.subsidiary_id=sid;
 return jsonb_build_object('subsidiary',company,'group','223','filters',p_filters||jsonb_build_object('noteMode',coalesce(p_filters->>'noteMode','HEADER'),'transactionType',kind),'accounts',accounts,'rows',rows,'netDefinition','Haber menos Debe',
 'total',(select coalesce(sum((x->>'net')::numeric),0) from jsonb_array_elements(rows)x));
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_pending_invoice_control_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('pending-invoice-control');
 begin perform report_template_private.enter('reports:accounting-reports','view');
declare sid bigint:=pending_invoice_private.access('reports:accounting-reports','view');begin
 if coalesce((p_filters->>'consolidated')::boolean,false) then perform consolidation_private.assert_scope(to_char(coalesce(nullif(p_filters->>'dateTo','')::date,current_date),'YYYY-MM'));
 else
  if p_filters?'subsidiaryIds' and exists(select 1 from jsonb_array_elements_text(p_filters->'subsidiaryIds')x where x::bigint<>sid) then raise exception using errcode='42501',message='Active la filial que desea consultar.';end if;
  if nullif(p_filters->>'subsidiaryId','') is not null and (p_filters->>'subsidiaryId')::bigint<>sid then raise exception using errcode='42501',message='Filial no disponible.';end if;
  p_filters:=p_filters||jsonb_build_object('subsidiaryIds',jsonb_build_array(sid),'subsidiaryId',sid);
 end if;return pending_invoice_private.run_pending_invoice_control_report(p_filters);end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_purchase_transaction_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('purchase-transactions');
 begin perform report_template_private.enter('reports:accounting-reports','view');

declare sid bigint:=asset_posting_private.access('reports:accounting-reports','view');begin
 if p_filters?'subsidiaryIds' and p_filters->'subsidiaryIds'<>jsonb_build_array(sid) then raise exception using errcode='42501',message='El reporte corresponde a la subsidiaria activa.';end if;return supplier_invoice_private.run_purchase_transaction_report(p_filters||jsonb_build_object('subsidiaryIds',jsonb_build_array(sid)));
end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_sales_transaction_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
#variable_conflict use_variable
begin
 perform report_access_private.enter('sales-transactions');
 begin perform report_template_private.enter('reports:accounting-reports','view');
declare sid bigint;date_from date;date_to date;customer_key bigint;seller_key bigint;cost_key bigint;currency_mode text;group_mode text;exclude_cancelled boolean;selected_types text[];page_no int;page_size int;result jsonb;
begin
 sid:=nullif(p_filters->'subsidiaryIds'->>0,'')::bigint;date_from:=nullif(p_filters->>'dateFrom','')::date;date_to:=nullif(p_filters->>'dateTo','')::date;
 customer_key:=nullif(p_filters->>'salesCustomerId','')::bigint;seller_key:=nullif(p_filters->>'salesRepresentativeId','')::bigint;cost_key:=nullif(p_filters->>'salesCostCenterId','')::bigint;
 currency_mode:=coalesce(nullif(p_filters->>'salesCurrencyMode',''),'BASE');group_mode:=coalesce(nullif(p_filters->>'salesGroupMode',''),'TRANSACTION');exclude_cancelled:=coalesce((p_filters->>'excludeCancelled')::boolean,true);
 select coalesce(array_agg(value),array['FAC_VEN','NC_VEN','ND_VEN']) into selected_types from jsonb_array_elements_text(coalesce(p_filters->'salesTransactionTypes','["FAC_VEN","NC_VEN","ND_VEN"]'::jsonb));
 page_no:=greatest(coalesce((p_filters->>'page')::int,1),1);page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),250);
 if sid is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id() and subsidiary_id=sid) then raise exception 'No tiene acceso a la subsidiaria seleccionada.';end if;
 if date_from is null or date_to is null then raise exception 'El rango de fechas es obligatorio.';end if;
 with documents as(
  select 'FAC_VEN' document_type,i.invoice_id document_id,i.invoice_number document_number,null::text referenced_document,i.customer_id,i.transaction_id,i.subsidiary_id,i.total_amount raw_total from invoice i
  union all select 'NC_VEN',n.cn_id,n.cn_number,i.invoice_number,n.customer_id,n.transaction_id,i.subsidiary_id,n.amount from credit_note n join invoice i using(invoice_id)
  union all select 'ND_VEN',n.dn_id,n.dn_number,i.invoice_number,n.customer_id,n.transaction_id,i.subsidiary_id,n.amount from debit_note n join invoice i using(invoice_id)
 ),base as(
  select d.*,t.tran_date issue_date,t.exchange_rate,c.currency_code,currency_mode,cu.tax_id customer_tax_id,cu.company_name customer_name,concat_ws(' ',e.first_name,e.last_name) seller_name,coalesce(st.code,'CONTABILIZADO') document_status,j.journal_id,
   coalesce((select sum(abs(g.credit_amount-g.debit_amount)) from gl_impact g join chart_accounts a using(account_id) where g.transaction_id=d.transaction_id and a.category='Ingreso'),0) revenue_amount,
   coalesce((select string_agg(distinct cc.code,', ' order by cc.code) from journal_line jl join cost_centers cc using(cost_center_id) where jl.journal_id=j.journal_id),'—') cost_centers
  from documents d
  join "transaction" t on t.transaction_id=d.transaction_id
  join currencies c on c.currency_id=t.currency_id
  join customers cu on cu.customer_id=d.customer_id
  left join employees e on e.employee_id=cu.sales_representative_id
  left join status st on st.status_id=t.status_id
  left join journal j on j.transaction_id=d.transaction_id
  where d.subsidiary_id=sid and t.tran_date between date_from and date_to and d.document_type=any(selected_types) and (customer_key is null or d.customer_id=customer_key) and (seller_key is null or cu.sales_representative_id=seller_key) and (not exclude_cancelled or upper(coalesce(st.code,''))<>'ANULADO') and (cost_key is null or exists(select 1 from journal_line jl where jl.journal_id=j.journal_id and jl.cost_center_id=cost_key))
 ),calculated as(
  select *,case when document_type='NC_VEN' then -1 else 1 end sign_value,case when currency_mode='BASE' then exchange_rate else 1 end conversion,
   case when revenue_amount>0 then revenue_amount else raw_total end calculated_base,count(*) over() total_count from base
 ),rows_data as(
  select document_type,document_id,document_number,referenced_document,transaction_id,journal_id,issue_date,customer_tax_id,customer_name,coalesce(seller_name,'—') seller_name,document_status,cost_centers,currency_code,
   0::numeric discount,sign_value*calculated_base*conversion subtotal,sign_value*calculated_base*conversion taxable_base,sign_value*greatest(raw_total-calculated_base,0)*conversion tax,sign_value*raw_total*conversion total,total_count
  from calculated
 ),paged as(select * from rows_data order by issue_date,transaction_id limit page_size offset(page_no-1)*page_size)
 select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(p)-'total_count' order by issue_date,transaction_id) from paged p),'[]'::jsonb),'total',coalesce((select max(total_count) from rows_data),0),'page',page_no,'pageSize',page_size,
  'summary',jsonb_build_object('invoices',coalesce((select sum(abs(total)) from rows_data where document_type='FAC_VEN'),0),'debitNotes',coalesce((select sum(abs(total)) from rows_data where document_type='ND_VEN'),0),'creditNotes',coalesce((select sum(abs(total)) from rows_data where document_type='NC_VEN'),0),'netSales',coalesce((select sum(total) from rows_data),0),'netBase',coalesce((select sum(taxable_base) from rows_data),0),'groupMode',group_mode)) into result;
 return result;
end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_settled_sales_invoice_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('settled-sales-invoices');
 begin perform report_template_private.enter('reports:accounting-reports','view');

declare
  sid bigint:=active_subsidiary_id();
  month_value text:=coalesce(nullif(p_filters->>'periodMonth',''),to_char(current_date,'YYYY-MM'));
  start_date date;
  end_date date;
  seller_ids bigint[]:=array(select value::bigint from jsonb_array_elements_text(coalesce(p_filters->'salesRepresentativeIds','[]'::jsonb)));
  settlement_filter text:=coalesce(nullif(p_filters->>'settlementType',''),'ALL');
  group_results boolean:=coalesce((p_filters->>'groupBySettlementType')::boolean,true);
  export_all boolean:=coalesce((p_filters->>'export')::boolean,false);
  page_number integer:=greatest(coalesce((p_filters->>'page')::integer,1),1);
  page_size integer:=least(greatest(coalesce((p_filters->>'pageSize')::integer,50),10),250);
  result jsonb;
begin
  if month_value!~'^[0-9]{4}-(0[1-9]|1[0-2])$'then raise exception 'Seleccione un mes de liquidación válido.';end if;
  if settlement_filter not in('ALL','CASH_PAYMENTS_ONLY','CREDIT_NOTES_ONLY')then raise exception 'El tipo de liquidación seleccionado no es válido.';end if;
  if sid is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id()and subsidiary_id=sid)then raise exception 'No tiene acceso a la subsidiaria activa.';end if;
  if exists(select 1 from unnest(seller_ids)x where not exists(select 1 from employees e where e.employee_id=x and e.subsidiary_id=sid))then raise exception 'Uno de los vendedores seleccionados no pertenece a la subsidiaria activa.';end if;
  start_date:=to_date(month_value||'-01','YYYY-MM-DD');
  end_date:=(start_date+interval'1 month'-interval'1 day')::date;

  with invoice_base as(
    select i.invoice_id,i.invoice_number,i.customer_id,i.subsidiary_id,
      coalesce(i.invoice_date,t.tran_date)issue_date,i.due_date,i.total_amount,
      coalesce(nullif(i.receivable_amount,0),i.total_amount)base_due,
      coalesce(i.exchange_rate,t.exchange_rate,1)exchange_rate,cu.currency_code,cu.symbol,
      c.company_name customer_name,c.tax_id customer_tax_id,
      coalesce(i.sales_representative_id,c.sales_representative_id)sales_representative_id,
      coalesce(nullif(concat_ws(' ',rep.first_name,rep.last_name),''),'Sin vendedor')sales_representative_name
    from invoice i join "transaction"t using(transaction_id)
    join customers c on c.customer_id=i.customer_id
    join currencies cu on cu.currency_id=coalesce(i.currency_id,t.currency_id)
    left join employees rep on rep.employee_id=coalesce(i.sales_representative_id,c.sales_representative_id)
    left join status invoice_status on invoice_status.status_id=t.status_id
    where i.subsidiary_id=sid
      and upper(coalesce(invoice_status.code,'APROBADO'))not in('ANULADO','CANCELADO')
  ),payment_events as(
    select a.invoice_id,a.application_date event_date,1 sort_order,'PAYMENT'::text event_type,
      'Cobro de cliente'::text type_label,p.payment_number reference,p.bank_reference secondary_reference,
      b.bank_name method,a.amount reduction,0::numeric addition,
      a.amount*coalesce(p.exchange_rate,1)local_reduction,0::numeric local_addition,
      coalesce(bank.cash_amount,0)*a.amount/nullif(payment_total.applied_amount,0)cash_amount,
      coalesce(bank.cash_amount,0)*a.amount/nullif(payment_total.applied_amount,0)*coalesce(p.exchange_rate,1)local_cash_amount,
      coalesce(advance.advance_amount,0)*a.amount/nullif(payment_total.applied_amount,0)advance_amount,
      coalesce(advance.advance_amount,0)*a.amount/nullif(payment_total.applied_amount,0)*coalesce(p.exchange_rate,1)local_advance_amount,
      coalesce(withholding.withholding_amount,0)withholding_amount,
      coalesce(withholding.withholding_amount,0)*coalesce(p.exchange_rate,1)local_withholding_amount,
      greatest(a.amount
        -coalesce(bank.cash_amount,0)*a.amount/nullif(payment_total.applied_amount,0)
        -coalesce(advance.advance_amount,0)*a.amount/nullif(payment_total.applied_amount,0)
        -coalesce(withholding.withholding_amount,0),0)other_funding_amount,
      greatest(a.amount
        -coalesce(bank.cash_amount,0)*a.amount/nullif(payment_total.applied_amount,0)
        -coalesce(advance.advance_amount,0)*a.amount/nullif(payment_total.applied_amount,0)
        -coalesce(withholding.withholding_amount,0),0)*coalesce(p.exchange_rate,1)local_other_funding_amount
    from customer_payment_application a join customer_payment p using(payment_id)
    left join "transaction"pt on pt.transaction_id=p.transaction_id
    left join status payment_status on payment_status.status_id=pt.status_id
    left join bank_account ba using(bank_account_id)left join banks b using(bank_id)
    left join lateral(select sum(pa.amount)applied_amount from customer_payment_application pa where pa.payment_id=p.payment_id)payment_total on true
    left join lateral(select sum(abs(bt.amount))cash_amount from bank_transaction bt where bt.transaction_id=p.transaction_id)bank on true
    left join lateral(select sum(caa.amount)advance_amount from customer_advance_application caa where caa.payment_id=p.payment_id)advance on true
    left join lateral(select sum(cpw.withholding_amount)withholding_amount from customer_payment_withholding cpw where cpw.payment_id=p.payment_id and cpw.invoice_id=a.invoice_id)withholding on true
    where upper(coalesce(p.status,'APROBADO'))not in('ANULADO','CANCELADO')
      and upper(coalesce(payment_status.code,'APROBADO'))not in('ANULADO','CANCELADO')
  ),credit_events as(
    select n.invoice_id,coalesce(n.note_date,nt.tran_date)event_date,2 sort_order,'CREDIT_NOTE'::text event_type,
      'Nota de Crédito'::text type_label,n.cn_number reference,null::text secondary_reference,
      'Compensación'::text method,n.amount reduction,0::numeric addition,
      n.amount*coalesce(n.exchange_rate,nt.exchange_rate,ib.exchange_rate,1)local_reduction,
      0::numeric local_addition,0::numeric cash_amount,0::numeric local_cash_amount,
      0::numeric advance_amount,0::numeric local_advance_amount,
      0::numeric withholding_amount,0::numeric local_withholding_amount,
      0::numeric other_funding_amount,0::numeric local_other_funding_amount
    from credit_note n join invoice_base ib using(invoice_id)
    left join "transaction"nt on nt.transaction_id=n.transaction_id
    left join status note_status on note_status.status_id=nt.status_id
    where upper(coalesce(note_status.code,'APROBADO'))not in('ANULADO','CANCELADO')
  ),debit_events as(
    select n.invoice_id,coalesce(n.note_date,nt.tran_date)event_date,3 sort_order,'DEBIT_NOTE'::text event_type,
      'Nota de Débito'::text type_label,n.dn_number reference,null::text secondary_reference,
      'Reapertura de saldo'::text method,0::numeric reduction,n.amount addition,
      0::numeric local_reduction,n.amount*coalesce(n.exchange_rate,nt.exchange_rate,ib.exchange_rate,1)local_addition,
      0::numeric cash_amount,0::numeric local_cash_amount,
      0::numeric advance_amount,0::numeric local_advance_amount,
      0::numeric withholding_amount,0::numeric local_withholding_amount,
      0::numeric other_funding_amount,0::numeric local_other_funding_amount
    from debit_note n join invoice_base ib using(invoice_id)
    left join "transaction"nt on nt.transaction_id=n.transaction_id
    left join status note_status on note_status.status_id=nt.status_id
    where upper(coalesce(note_status.code,'APROBADO'))not in('ANULADO','CANCELADO')
  ),events as(
    select * from payment_events union all select * from credit_events union all select * from debit_events
  ),day_events as(
    select invoice_id,event_date,sum(addition-reduction)delta
    from events where event_date is not null group by invoice_id,event_date
  ),running as(
    select d.invoice_id,d.event_date,
      b.base_due+coalesce(sum(d.delta)over(partition by d.invoice_id order by d.event_date rows between unbounded preceding and 1 preceding),0)balance_before,
      b.base_due+sum(d.delta)over(partition by d.invoice_id order by d.event_date rows unbounded preceding)balance_after
    from day_events d join invoice_base b using(invoice_id)
  ),current_state as(
    select b.invoice_id,b.base_due+coalesce(sum(e.addition-e.reduction),0)raw_balance
    from invoice_base b left join events e using(invoice_id) group by b.invoice_id,b.base_due
  ),final_close as(
    select distinct on(r.invoice_id)r.invoice_id,r.event_date settlement_date
    from running r join current_state s using(invoice_id)
    where s.raw_balance<=.005 and r.balance_before>.005 and r.balance_after<=.005
    order by r.invoice_id,r.event_date desc
  ),event_totals as(
    select e.invoice_id,
      coalesce(sum(e.reduction)filter(where e.event_type='PAYMENT'),0)payment_amount,
      coalesce(sum(e.reduction)filter(where e.event_type='CREDIT_NOTE'),0)credit_amount,
      coalesce(sum(e.addition)filter(where e.event_type='DEBIT_NOTE'),0)debit_amount,
      coalesce(sum(e.local_reduction)filter(where e.event_type='PAYMENT'),0)local_payment_amount,
      coalesce(sum(e.local_reduction)filter(where e.event_type='CREDIT_NOTE'),0)local_credit_amount,
      coalesce(sum(e.local_addition)filter(where e.event_type='DEBIT_NOTE'),0)local_debit_amount,
      coalesce(sum(e.cash_amount)filter(where e.event_type='PAYMENT'),0)cash_amount,
      coalesce(sum(e.local_cash_amount)filter(where e.event_type='PAYMENT'),0)local_cash_amount,
      coalesce(sum(e.advance_amount)filter(where e.event_type='PAYMENT'),0)advance_amount,
      coalesce(sum(e.local_advance_amount)filter(where e.event_type='PAYMENT'),0)local_advance_amount,
      coalesce(sum(e.withholding_amount)filter(where e.event_type='PAYMENT'),0)withholding_amount,
      coalesce(sum(e.local_withholding_amount)filter(where e.event_type='PAYMENT'),0)local_withholding_amount,
      coalesce(sum(e.other_funding_amount)filter(where e.event_type='PAYMENT'),0)other_funding_amount,
      coalesce(sum(e.local_other_funding_amount)filter(where e.event_type='PAYMENT'),0)local_other_funding_amount,
      bool_or(e.event_type='PAYMENT')has_payment,bool_or(e.event_type='CREDIT_NOTE')has_credit,
      coalesce(string_agg(e.reference,' · 'order by e.event_date,e.sort_order,e.reference)
        filter(where e.event_type in('PAYMENT','CREDIT_NOTE')),'—')settlement_references,
      coalesce(jsonb_agg(jsonb_build_object(
        'date',e.event_date,'type',e.event_type,'typeLabel',e.type_label,
        'reference',e.reference,'secondaryReference',e.secondary_reference,
        'method',e.method,'amount',case when e.event_type='DEBIT_NOTE'then-e.addition else e.reduction end,
        'cashAmount',e.cash_amount,'advanceAmount',e.advance_amount,
        'withholdingAmount',e.withholding_amount,'otherFundingAmount',e.other_funding_amount
      )order by e.event_date,e.sort_order,e.reference),'[]'::jsonb)applications
    from events e group by e.invoice_id
  ),settled as(
    select b.*,f.settlement_date,s.raw_balance,greatest(s.raw_balance,0)balance_due,
      greatest(-s.raw_balance,0)overapplied_amount,
      e.payment_amount,e.credit_amount,e.debit_amount,e.local_payment_amount,e.local_credit_amount,e.local_debit_amount,
      e.cash_amount,e.local_cash_amount,e.advance_amount,e.local_advance_amount,
      e.withholding_amount,e.local_withholding_amount,e.other_funding_amount,e.local_other_funding_amount,
      e.settlement_references,e.applications,
      case when e.has_payment and e.has_credit then'MIXED'
           when e.has_payment then'PAYMENT'else'CREDIT_NOTE'end settlement_type,
      greatest(f.settlement_date-b.issue_date,0)days_to_collect,
      b.total_amount*b.exchange_rate local_invoice_amount,b.base_due*b.exchange_rate local_receivable_amount,
      b.base_due*b.exchange_rate+e.local_debit_amount local_settlement_base_amount,
      e.local_payment_amount+e.local_credit_amount local_applied_amount,
      greatest(e.local_payment_amount+e.local_credit_amount-(b.base_due*b.exchange_rate+e.local_debit_amount),0)local_overapplied_amount
    from invoice_base b join current_state s using(invoice_id)
    join final_close f using(invoice_id)join event_totals e using(invoice_id)
    where e.payment_amount+e.credit_amount>.005
  ),filtered as(
    select * from settled
    where settlement_date between start_date and end_date
      and(cardinality(seller_ids)=0 or sales_representative_id=any(seller_ids))
      and(settlement_filter='ALL'
        or settlement_filter='CASH_PAYMENTS_ONLY'and settlement_type in('PAYMENT','MIXED')
        or settlement_filter='CREDIT_NOTES_ONLY'and settlement_type='CREDIT_NOTE')
  ),paged as(
    select * from filtered order by settlement_date desc,invoice_number
    limit case when export_all then null else page_size end
    offset case when export_all then 0 else(page_number-1)*page_size end
  )
  select jsonb_build_object(
    'header',(select jsonb_build_object(
      'subsidiaryId',s.subsidiary_id,'subsidiary',s.name,'legalName',s.legal_name,'taxId',s.tax_id,'logoUrl',s.logo_url,
      'currency',cur.currency_code,'currencyName',cur.name,'symbol',cur.symbol,
      'periodMonth',month_value,'periodStart',start_date,'periodEnd',end_date,
      'settlementType',settlement_filter,'groupBySettlementType',group_results,'generatedAt',clock_timestamp()
    )from subsidiaries s join currencies cur using(currency_id)where s.subsidiary_id=sid),
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'invoiceId',p.invoice_id,'invoiceNumber',p.invoice_number,
      'customerName',p.customer_name,'customerTaxId',p.customer_tax_id,
      'salesRepresentativeId',p.sales_representative_id,'salesRepresentative',p.sales_representative_name,
      'issueDate',p.issue_date,'dueDate',p.due_date,'invoiceAmount',p.total_amount,
      'receivableAmount',p.base_due,'currency',p.currency_code,'symbol',p.symbol,
      'settlementDate',p.settlement_date,'settlementType',p.settlement_type,
      'settlementTypeLabel',case p.settlement_type when'PAYMENT'then'Cobro de cliente'when'CREDIT_NOTE'then'Nota de Crédito'else'Mixto'end,
      'settlementReferences',p.settlement_references,'paymentAmount',p.payment_amount,
      'creditNoteAmount',p.credit_amount,'debitNoteAmount',p.debit_amount,
      'cashAmount',p.cash_amount,'advanceAmount',p.advance_amount,
      'withholdingAmount',p.withholding_amount,'otherFundingAmount',p.other_funding_amount,
      'grossAppliedAmount',p.payment_amount+p.credit_amount,
      'netAppliedAmount',p.payment_amount+p.credit_amount-p.debit_amount,
      'settlementBaseAmount',p.base_due+p.debit_amount,
      'appliedAmount',p.payment_amount+p.credit_amount,'balanceDue',p.balance_due,
      'rawBalance',p.raw_balance,'overappliedAmount',p.overapplied_amount,
      'daysToCollect',p.days_to_collect,'applications',p.applications
    )order by p.settlement_date desc,p.invoice_number)from paged p),'[]'::jsonb),
    'summary',(select jsonb_build_object(
      'invoiceCount',count(*),'invoiceAmount',coalesce(sum(local_invoice_amount),0),
      'receivableAmount',coalesce(sum(local_receivable_amount),0),
      'settlementBaseAmount',coalesce(sum(local_settlement_base_amount),0),
      'appliedAmount',coalesce(sum(local_applied_amount),0),
      'netAppliedAmount',coalesce(sum(local_payment_amount+local_credit_amount-local_debit_amount),0),
      'paymentAppliedAmount',coalesce(sum(local_payment_amount),0),
      'cashAmount',coalesce(sum(local_cash_amount),0),
      'advanceAmount',coalesce(sum(local_advance_amount),0),
      'withholdingAmount',coalesce(sum(local_withholding_amount),0),
      'otherFundingAmount',coalesce(sum(local_other_funding_amount),0),
      'creditNoteAmount',coalesce(sum(local_credit_amount),0),
      'debitNoteAmount',coalesce(sum(local_debit_amount),0),
      'paymentCount',count(*)filter(where settlement_type='PAYMENT'),
      'creditNoteCount',count(*)filter(where settlement_type='CREDIT_NOTE'),
      'mixedCount',count(*)filter(where settlement_type='MIXED'),
      'overappliedCount',count(*)filter(where overapplied_amount>.005),
      'overappliedAmount',coalesce(sum(local_overapplied_amount),0),
      'averageDso',coalesce(round(avg(days_to_collect),1),0)
    )from filtered),
    'total',(select count(*)from filtered),'page',page_number,
    'pageSize',case when export_all then(select count(*)from filtered)::integer else page_size end
  )into result;
  return result;
end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_settled_supplier_invoice_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('settled-supplier-invoices');
 begin perform report_template_private.enter('reports:accounting-reports','view');
begin perform asset_posting_private.access('reports:accounting-reports','view');return supplier_invoice_private.run_settled_supplier_invoice_report(p_filters);end;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_supplier_advances_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('supplier-advances');
 declare sid bigint;uid bigint;cutoff date;requested_book bigint;effective_book bigint;book_info jsonb;primary_count bigint;
 supplier bigint;currency bigint;page_no integer:=1;page_size integer:=50;key text;filter_value text;
 account_count bigint;account_info jsonb;local_currency jsonb;snapshot jsonb;paged jsonb;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 uid:=public.app_user_id();sid:=public.active_subsidiary_id();
 if uid is null or sid is null or not exists(select 1 from public.users u join public.user_subsidiaries s using(user_id)where u.user_id=uid and u.is_active and s.subsidiary_id=sid)then
  raise exception using errcode='42501',message='La empresa activa no está autorizada.';
 end if;
 if p_filters is null or jsonb_typeof(p_filters)<>'object'or exists(select 1 from jsonb_object_keys(p_filters)k where k not in('subsidiaryIds','dateTo','bookId','supplierId','currencyId','onlyNonzero','page','pageSize'))then
  raise exception using errcode='22023',message='Los filtros del reporte no son válidos.';
 end if;
 if jsonb_typeof(p_filters->'subsidiaryIds')is distinct from'array'or jsonb_array_length(p_filters->'subsidiaryIds')<>1 or coalesce(p_filters#>>'{subsidiaryIds,0}','')!~'^[1-9][0-9]{0,18}$'then
  raise exception using errcode='22023',message='Seleccione una sola empresa.';
 end if;
 begin
  if(p_filters#>>'{subsidiaryIds,0}')::bigint<>sid then raise exception using errcode='42501',message='La empresa solicitada no coincide con la empresa activa.';end if;
  if coalesce(p_filters->>'dateTo','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'then raise exception using errcode='22023',message='La fecha de corte no es válida.';end if;
  cutoff:=(p_filters->>'dateTo')::date;
  foreach key in array array['bookId','supplierId','currencyId']loop
   filter_value:=p_filters->>key;
   if filter_value is not null and filter_value!~'^[1-9][0-9]{0,18}$'then raise exception using errcode='22023',message='El identificador de un filtro no es válido.';end if;
   case key when'bookId'then requested_book:=filter_value::bigint;when'supplierId'then supplier:=filter_value::bigint;else currency:=filter_value::bigint;end case;
  end loop;
  if p_filters?'onlyNonzero'and jsonb_typeof(p_filters->'onlyNonzero')<>'boolean'then raise exception using errcode='22023',message='El filtro de saldos no es válido.';end if;
  foreach key in array array['page','pageSize']loop
   if p_filters?key then filter_value:=p_filters->>key;
    if filter_value is null or filter_value!~'^[1-9][0-9]{0,9}$'then raise exception using errcode='22023',message='La paginación no es válida.';end if;
    if key='page'then page_no:=filter_value::integer;else page_size:=filter_value::integer;end if;
   end if;
  end loop;
 exception when numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode='22023',message='Los filtros del reporte no son válidos.';
 end;
 if page_size>250 then raise exception using errcode='22023',message='El tamaño de página no es válido.';end if;
 if requested_book is null then
  select count(*)into primary_count from public.accounting_books where subsidiary_id=sid and is_primary;
  if primary_count<>1 then raise exception using errcode='22023',message='Seleccione un libro contable; la empresa no tiene un único libro principal.';end if;
  select accounting_book_id,jsonb_build_object('id',accounting_book_id,'name',book_name,'isPrimary',is_primary)into effective_book,book_info
  from public.accounting_books where subsidiary_id=sid and is_primary;
 else
  select accounting_book_id,jsonb_build_object('id',accounting_book_id,'name',book_name,'isPrimary',is_primary)into effective_book,book_info
  from public.accounting_books where accounting_book_id=requested_book and subsidiary_id=sid;
  if effective_book is null then raise exception using errcode='42501',message='El libro no pertenece a la empresa activa.';end if;
 end if;
 select count(*),jsonb_build_object('id',min(account_id),'number','115004','name',min(account_name))into account_count,account_info from public.chart_accounts where account_number='115004';
 if account_count>1 then raise exception using errcode='55000',message='La cuenta 115004 no tiene una identificación única.';end if;
 select jsonb_build_object('id',c.currency_id,'code',c.currency_code)into local_currency from public.subsidiaries s left join public.currencies c on c.currency_id=s.currency_id where s.subsidiary_id=sid;
 snapshot:=supplier_advances_report_private.pending_sources(sid,cutoff,effective_book,supplier,currency);
 select coalesce(jsonb_agg(r.value order by r.position),'[]')into paged from jsonb_array_elements(snapshot->'rows')with ordinality r(value,position)
 where r.position>((page_no::bigint-1)*page_size)and r.position<=page_no::bigint*page_size;
 return jsonb_build_object('reportMode','UNAPPLIED_ADVANCES','context',jsonb_build_object('subsidiaryId',sid,'dateTo',cutoff,'bookId',requested_book,'supplierId',supplier,'currencyId',currency,'onlyNonzero',true),
  'book',book_info,'effectiveBookId',effective_book,'account',account_info,'localCurrency',local_currency,'rows',paged,'total',snapshot->'total','page',page_no,'pageSize',page_size,
  'dataFingerprint',snapshot->'dataFingerprint','filterOptions',snapshot->'filterOptions','currencyTotals',snapshot->'currencyTotals','supplierTotals',snapshot->'supplierTotals','exceptions',snapshot->'exceptions','summary',snapshot->'summary');
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.run_vat_declaration_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('vat-declaration');
 begin perform report_template_private.enter('reports:accounting-reports','view');

declare
 sid bigint:=active_subsidiary_id();
 requested_sid bigint:=nullif(p_filters->>'subsidiaryId','')::bigint;
 period_value text:=coalesce(nullif(p_filters->>'periodMonth',''),to_char(current_date,'YYYY-MM'));
 period_start date;
 period_end date;
 include_adjustments boolean:=case when lower(coalesce(p_filters->>'includeAdjustments','true'))in('false','0','no')then false else true end;
 selected_statuses text[]:=array(
  select upper(value)
  from jsonb_array_elements_text(
   case when jsonb_typeof(p_filters->'documentStatuses')='array' then p_filters->'documentStatuses'
        when jsonb_typeof(p_filters->'statuses')='array' then p_filters->'statuses'
        else jsonb_build_array('APROBADO')end
  )value
 );
 prior_credit numeric:=greatest(coalesce(nullif(p_filters->>'priorPeriodCredit','')::numeric,0),0);
 company_country_id bigint;
 result jsonb;
begin
 if app_user_id() is null or sid is null or not exists(
  select 1 from user_subsidiaries where user_id=app_user_id()and subsidiary_id=sid
 )then
  raise exception using errcode='42501',message='No tiene acceso a la subsidiaria activa.';
 end if;
 if not app_is_admin()and not exists(
  select 1 from role_permissions grant_record
  join permissions permission_record using(permission_id)
  where grant_record.role_id=app_active_role_id()and permission_record.code='tax:vat-report:view'
 )then
  raise exception using errcode='42501',message='No tiene permiso para consultar reportes fiscales.';
 end if;
 if requested_sid is not null and requested_sid<>sid then
  raise exception using errcode='42501',message='El informe fiscal solo puede generarse para la empresa activa.';
 end if;
 if period_value!~'^[0-9]{4}-(0[1-9]|1[0-2])$'then
  raise exception 'Seleccione un periodo fiscal válido.';
 end if;
 if prior_credit>999999999999999999::numeric then raise exception 'El saldo a favor anterior supera el límite permitido.';end if;
 if cardinality(selected_statuses)=0 then selected_statuses:=array['APROBADO'];end if;
 if exists(
  select 1 from unnest(selected_statuses)requested_status
  where requested_status in('ANULADO','CANCELADO','BORRADOR')
   or not exists(select 1 from status configured_status where upper(configured_status.code)=requested_status)
 )then
  raise exception 'La selección contiene un estado documental no permitido para la declaración fiscal.';
 end if;

 period_start:=to_date(period_value||'-01','YYYY-MM-DD');
 period_end:=(period_start+interval'1 month'-interval'1 day')::date;
 select country_id into company_country_id from subsidiaries where subsidiary_id=sid;

 with tax_catalog as(
  select tc.tax_code_id,tc.code_name,tc.rate_percentage,tc.country_id,tc.is_purchase_creditable,tc.is_import_tax,tc.tax_treatment,
   tt.type_name,tt.applies_to,tt.is_indirect_tax
  from tax_codes tc join tax_types tt using(tax_type_id)
  where not tc.is_withholding
 ),
 detail_source as(
  select 'SALES'::text side,'INVOICE'::text document_type,'Factura de venta'::text document_type_label,
   i.invoice_id document_id,i.invoice_number document_number,coalesce(i.invoice_date,transaction_record.tran_date)document_date,
   'Cliente'::text party_type,customer.customer_id party_id,customer.company_name party_name,customer.tax_id party_tax_id,
   line.tax_code_id,coalesce(tax.code_name,'SIN_CODIGO')tax_code,
   case when line.tax_code_id is null then'Sin código fiscal / No gravada'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'Código fiscal no disponible para el país de la empresa'
        when not tax.is_indirect_tax then'Operación no sujeta a IVA/GCT · '||tax.code_name
        when tax.applies_to not in('Ventas','Ambos')then'Código no aplicable a ventas · '||tax.code_name
        when tax.tax_treatment in('Exento','No sujeto','Tasa cero') then tax.type_name||' · '||tax.tax_treatment
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Sin clasificar (0%)'
        else tax.type_name||' · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'end tax_description,
   case when line.tax_code_id is null or tax.tax_code_id is null or tax.country_id<>company_country_id
          or not tax.is_indirect_tax or tax.applies_to not in('Ventas','Ambos')then 0
        else coalesce(line.tax_rate,tax.rate_percentage,0)end::numeric tax_rate,
   line.amount::numeric original_base,line.tax_amount::numeric original_tax,line.gross_amount::numeric original_gross,
   coalesce(i.exchange_rate,transaction_record.exchange_rate,1)::numeric exchange_rate,
   currency.currency_code,line.line_id source_line_id,i.journal_id,upper(document_status.code)status,
   1::numeric sign,
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.applies_to in('Ventas','Ambos'),false)tax_reportable,
   false is_import_tax,
   case when line.tax_code_id is null then'NO_CODE'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'INVALID_COUNTRY'
        when not tax.is_indirect_tax then'NON_INDIRECT'
        when tax.applies_to not in('Ventas','Ambos')then'NOT_APPLICABLE'
        when tax.tax_treatment='Exento' then'EXEMPT'
        when tax.tax_treatment='No sujeto' then'NON_SUBJECT'
        when tax.tax_treatment='Tasa cero' then'ZERO_RATE'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'UNCLASSIFIED'
        else'DOMESTIC'end tax_classification
  from invoice i join sales_invoice_line line using(invoice_id)
  join customers customer using(customer_id)
  join "transaction" transaction_record using(transaction_id)
  join status document_status using(status_id)
  join currencies currency on currency.currency_id=coalesce(i.currency_id,transaction_record.currency_id)
  left join journal on journal.journal_id=i.journal_id
  left join tax_catalog tax on tax.tax_code_id=line.tax_code_id
  where i.subsidiary_id=sid and coalesce(i.invoice_date,transaction_record.tran_date)between period_start and period_end
   and not coalesce(i.is_opening_balance,false)
   and upper(document_status.code)=any(selected_statuses)
   and journal.journal_id is not null and upper(journal.status)='CONTABILIZADO'

  union all
  select 'SALES',case when line.note_kind='CREDIT'then'CREDIT_NOTE'else'DEBIT_NOTE'end,
   case when line.note_kind='CREDIT'then'Nota de crédito de cliente'else'Nota de débito de cliente'end,
   case when line.note_kind='CREDIT'then credit.cn_id else debit.dn_id end,
   case when line.note_kind='CREDIT'then credit.cn_number else debit.dn_number end,
   coalesce(case when line.note_kind='CREDIT'then credit.note_date else debit.note_date end,transaction_record.tran_date),
   'Cliente',customer.customer_id,customer.company_name,customer.tax_id,line.tax_code_id,coalesce(tax.code_name,'SIN_CODIGO'),
   case when line.tax_code_id is null then'Sin código fiscal / No gravada'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'Código fiscal no disponible para el país de la empresa'
        when not tax.is_indirect_tax then'Operación no sujeta a IVA/GCT · '||tax.code_name
        when tax.applies_to not in('Ventas','Ambos')then'Código no aplicable a ventas · '||tax.code_name
        when tax.tax_treatment in('Exento','No sujeto','Tasa cero') then tax.type_name||' · '||tax.tax_treatment
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Sin clasificar (0%)'
        else tax.type_name||' · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'end,
   case when line.tax_code_id is null or tax.tax_code_id is null or tax.country_id<>company_country_id
          or not tax.is_indirect_tax or tax.applies_to not in('Ventas','Ambos')then 0
        else coalesce(line.tax_rate,tax.rate_percentage,0)end,line.amount,line.tax_amount,line.gross_amount,
   coalesce(case when line.note_kind='CREDIT'then credit.exchange_rate else debit.exchange_rate end,transaction_record.exchange_rate,1),
   currency.currency_code,line.line_id,
   case when line.note_kind='CREDIT'then credit.journal_id else debit.journal_id end,
   upper(document_status.code),case when line.note_kind='CREDIT'then-1 else 1 end,
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.applies_to in('Ventas','Ambos'),false),
   false,
   case when line.tax_code_id is null then'NO_CODE'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'INVALID_COUNTRY'
        when not tax.is_indirect_tax then'NON_INDIRECT'
        when tax.applies_to not in('Ventas','Ambos')then'NOT_APPLICABLE'
        when tax.tax_treatment='Exento' then'EXEMPT'
        when tax.tax_treatment='No sujeto' then'NON_SUBJECT'
        when tax.tax_treatment='Tasa cero' then'ZERO_RATE'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'UNCLASSIFIED'
        else'DOMESTIC'end
  from sales_note_line line
  left join credit_note credit on line.note_kind='CREDIT'and credit.cn_id=line.note_id
  left join debit_note debit on line.note_kind='DEBIT'and debit.dn_id=line.note_id
  join invoice original_invoice on original_invoice.invoice_id=coalesce(credit.invoice_id,debit.invoice_id)
  join customers customer on customer.customer_id=coalesce(credit.customer_id,debit.customer_id)
  join "transaction" transaction_record on transaction_record.transaction_id=coalesce(credit.transaction_id,debit.transaction_id)
  join status document_status using(status_id)
  join currencies currency on currency.currency_id=coalesce(credit.currency_id,debit.currency_id,transaction_record.currency_id)
  left join journal on journal.journal_id=coalesce(credit.journal_id,debit.journal_id)
  left join tax_catalog tax on tax.tax_code_id=line.tax_code_id
  where include_adjustments and original_invoice.subsidiary_id=sid
   and coalesce(case when line.note_kind='CREDIT'then credit.note_date else debit.note_date end,transaction_record.tran_date)between period_start and period_end
   and upper(document_status.code)=any(selected_statuses)
   and journal.journal_id is not null and upper(journal.status)='CONTABILIZADO'

  union all
  select 'PURCHASES','INVOICE','Factura de proveedor',i.invoice_id,i.invoice_number,
   coalesce(i.invoice_date,transaction_record.tran_date),'Proveedor',supplier.supplier_id,supplier.company_name,supplier.tax_id,
   line.tax_code_id,coalesce(tax.code_name,'SIN_CODIGO'),
   case when line.tax_code_id is null then'Sin código fiscal / No gravada'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'Código fiscal no disponible para el país de la empresa'
        when not tax.is_indirect_tax then'Compra no sujeta a IVA/GCT · '||tax.code_name
        when tax.applies_to not in('Compras','Ambos')then'Código no aplicable a compras · '||tax.code_name
        when tax.tax_treatment in('Exento','No sujeto','Tasa cero') then tax.type_name||' · '||tax.tax_treatment
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Sin clasificar (0%)'
        when not tax.is_purchase_creditable then tax.type_name||' · Impuesto no acreditable'
        when tax.is_import_tax then tax.type_name||' · Importación / Aduana · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'
        when tax.tax_treatment in('Exento','No sujeto','Tasa cero') then tax.type_name||' · '||tax.tax_treatment
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Sin clasificar (0%)'
        else tax.type_name||' · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'end,
   case when line.tax_code_id is null or tax.tax_code_id is null or tax.country_id<>company_country_id
          or not tax.is_indirect_tax or tax.applies_to not in('Compras','Ambos')then 0
        else coalesce(line.tax_rate,tax.rate_percentage,0)end,line.amount,line.tax_amount,line.gross_amount,
   coalesce(i.exchange_rate,transaction_record.exchange_rate,1),currency.currency_code,line.line_id,i.journal_id,
   upper(document_status.code),1,
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.applies_to in('Compras','Ambos')and tax.is_purchase_creditable,false),
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.is_import_tax,false),
   case when line.tax_code_id is null then'NO_CODE'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'INVALID_COUNTRY'
        when not tax.is_indirect_tax then'NON_INDIRECT'
        when tax.applies_to not in('Compras','Ambos')then'NOT_APPLICABLE'
        when tax.tax_treatment='Exento' then'EXEMPT'
        when tax.tax_treatment='No sujeto' then'NON_SUBJECT'
        when tax.tax_treatment='Tasa cero' then'ZERO_RATE'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'UNCLASSIFIED'
        when not tax.is_purchase_creditable then'NON_CREDITABLE'
        when tax.is_import_tax then'IMPORT'
        when tax.tax_treatment='Exento' then'EXEMPT'
        when tax.tax_treatment='No sujeto' then'NON_SUBJECT'
        when tax.tax_treatment='Tasa cero' then'ZERO_RATE'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'UNCLASSIFIED'
        else'DOMESTIC'end
  from supplier_invoice i join supplier_invoice_line line using(invoice_id)
  join suppliers supplier using(supplier_id)
  join "transaction" transaction_record using(transaction_id)
  join status document_status using(status_id)
  join currencies currency on currency.currency_id=coalesce(i.currency_id,transaction_record.currency_id)
  left join journal on journal.journal_id=i.journal_id
  left join tax_catalog tax on tax.tax_code_id=line.tax_code_id
  where i.subsidiary_id=sid and coalesce(i.invoice_date,transaction_record.tran_date)between period_start and period_end
   and not coalesce(i.is_opening_balance,false)
   and upper(document_status.code)=any(selected_statuses)
   and journal.journal_id is not null and upper(journal.status)='CONTABILIZADO'

  union all
  select 'PURCHASES',case when line.note_kind='CREDIT'then'CREDIT_NOTE'else'DEBIT_NOTE'end,
   case when line.note_kind='CREDIT'then'Nota de crédito de proveedor'else'Nota de débito de proveedor'end,
   case when line.note_kind='CREDIT'then credit.cn_id else debit.dn_id end,
   case when line.note_kind='CREDIT'then credit.cn_number else debit.dn_number end,
   coalesce(case when line.note_kind='CREDIT'then credit.note_date else debit.note_date end,transaction_record.tran_date),
   'Proveedor',supplier.supplier_id,supplier.company_name,supplier.tax_id,line.tax_code_id,coalesce(tax.code_name,'SIN_CODIGO'),
   case when line.tax_code_id is null then'Sin código fiscal / No gravada'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'Código fiscal no disponible para el país de la empresa'
        when not tax.is_indirect_tax then'Compra no sujeta a IVA/GCT · '||tax.code_name
        when tax.applies_to not in('Compras','Ambos')then'Código no aplicable a compras · '||tax.code_name
        when tax.tax_treatment in('Exento','No sujeto','Tasa cero') then tax.type_name||' · '||tax.tax_treatment
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Sin clasificar (0%)'
        when not tax.is_purchase_creditable then tax.type_name||' · Impuesto no acreditable'
        when tax.is_import_tax then tax.type_name||' · Importación / Aduana · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'
        when tax.tax_treatment in('Exento','No sujeto','Tasa cero') then tax.type_name||' · '||tax.tax_treatment
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then tax.type_name||' · Sin clasificar (0%)'
        else tax.type_name||' · '||trim(to_char(coalesce(line.tax_rate,tax.rate_percentage,0),'FM990D999999'))||'%'end,
   case when line.tax_code_id is null or tax.tax_code_id is null or tax.country_id<>company_country_id
          or not tax.is_indirect_tax or tax.applies_to not in('Compras','Ambos')then 0
        else coalesce(line.tax_rate,tax.rate_percentage,0)end,line.amount,line.tax_amount,line.gross_amount,
   coalesce(case when line.note_kind='CREDIT'then credit.exchange_rate else debit.exchange_rate end,transaction_record.exchange_rate,1),
   currency.currency_code,line.line_id,
   case when line.note_kind='CREDIT'then credit.journal_id else debit.journal_id end,
   upper(document_status.code),case when line.note_kind='CREDIT'then-1 else 1 end,
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.applies_to in('Compras','Ambos')and tax.is_purchase_creditable,false),
   coalesce(tax.country_id=company_country_id and tax.is_indirect_tax and tax.is_import_tax,false),
   case when line.tax_code_id is null then'NO_CODE'
        when tax.tax_code_id is null or tax.country_id<>company_country_id then'INVALID_COUNTRY'
        when not tax.is_indirect_tax then'NON_INDIRECT'
        when tax.applies_to not in('Compras','Ambos')then'NOT_APPLICABLE'
        when tax.tax_treatment='Exento' then'EXEMPT'
        when tax.tax_treatment='No sujeto' then'NON_SUBJECT'
        when tax.tax_treatment='Tasa cero' then'ZERO_RATE'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'UNCLASSIFIED'
        when not tax.is_purchase_creditable then'NON_CREDITABLE'
        when tax.is_import_tax then'IMPORT'
        when tax.tax_treatment='Exento' then'EXEMPT'
        when tax.tax_treatment='No sujeto' then'NON_SUBJECT'
        when tax.tax_treatment='Tasa cero' then'ZERO_RATE'
        when coalesce(line.tax_rate,tax.rate_percentage,0)=0 then'UNCLASSIFIED'
        else'DOMESTIC'end
  from supplier_note_line line
  left join supplier_credit_note credit on line.note_kind='CREDIT'and credit.cn_id=line.note_id
  left join supplier_debit_note debit on line.note_kind='DEBIT'and debit.dn_id=line.note_id
  join supplier_invoice original_invoice on original_invoice.invoice_id=coalesce(credit.invoice_id,debit.invoice_id)
  join suppliers supplier on supplier.supplier_id=coalesce(credit.supplier_id,debit.supplier_id)
  join "transaction" transaction_record on transaction_record.transaction_id=coalesce(credit.transaction_id,debit.transaction_id)
  join status document_status using(status_id)
  join currencies currency on currency.currency_id=coalesce(credit.currency_id,debit.currency_id,transaction_record.currency_id)
  left join journal on journal.journal_id=coalesce(credit.journal_id,debit.journal_id)
  left join tax_catalog tax on tax.tax_code_id=line.tax_code_id
  where include_adjustments and original_invoice.subsidiary_id=sid
   and coalesce(case when line.note_kind='CREDIT'then credit.note_date else debit.note_date end,transaction_record.tran_date)between period_start and period_end
   and upper(document_status.code)=any(selected_statuses)
   and journal.journal_id is not null and upper(journal.status)='CONTABILIZADO'
 ),
 details as(
  select side,document_type,document_type_label,document_id,document_number,document_date,party_type,party_id,party_name,party_tax_id,
   tax_code_id,tax_code,tax_description,tax_rate,tax_reportable,is_import_tax,tax_classification,
   sign*original_base*exchange_rate base_amount,
   sign*case when tax_reportable then original_tax else 0 end*exchange_rate tax_amount,
   sign*case when not tax_reportable then original_tax else 0 end*exchange_rate excluded_tax_amount,
   sign*original_gross*exchange_rate gross_amount,currency_code,exchange_rate,
   sign*original_base original_base,sign*original_tax original_tax,sign*original_gross original_gross,
   source_line_id,journal_id,status,
   side||':'||coalesce(tax_code_id::text,'NONE')||':'||tax_classification||':'||trim(to_char(tax_rate,'FM999999990D999999'))key
  from detail_source
 ),
 grouped as(
  select side,key,tax_code_id,tax_code,tax_description description,tax_rate rate,tax_reportable,is_import_tax,tax_classification,
   sum(base_amount)base_amount,sum(tax_amount)tax_amount,sum(gross_amount)gross_amount,
   sum(excluded_tax_amount)excluded_tax_amount,
   coalesce(sum(base_amount)filter(where document_type<>'INVOICE'),0)adjustment_base_amount,
   coalesce(sum(tax_amount)filter(where document_type<>'INVOICE'),0)adjustment_tax_amount,
   count(distinct(document_type,document_id))document_count,count(*)line_count
  from details group by side,key,tax_code_id,tax_code,tax_description,tax_rate,tax_reportable,is_import_tax,tax_classification
 ),
 withholding_events as(
  select 'SUFFERED'::text retention_side,i.invoice_id source_id,i.invoice_number document_number,
   coalesce(i.invoice_date,transaction_record.tran_date)event_date,customer.company_name party_name,customer.tax_id party_tax_id,
   tc.code_name tax_code,tt.type_name tax_description,w.rate_percentage,
   w.withholding_amount*coalesce(i.exchange_rate,transaction_record.exchange_rate,1)amount
  from sales_invoice_withholding w join invoice i using(invoice_id)
  join customers customer using(customer_id)join "transaction" transaction_record using(transaction_id)
  join status document_status using(status_id)join journal source_journal on source_journal.journal_id=i.journal_id
  join tax_codes tc using(tax_code_id)join tax_types tt using(tax_type_id)
  where i.subsidiary_id=sid and w.recognized_at_invoice
   and coalesce(i.invoice_date,transaction_record.tran_date)between period_start and period_end
   and upper(document_status.code)=any(selected_statuses)
   and upper(source_journal.status)='CONTABILIZADO'and tc.is_withholding and tt.is_indirect_tax
  union all
  select 'SUFFERED',payment.payment_id,payment.payment_number,payment.payment_date,customer.company_name,customer.tax_id,
   tc.code_name,tt.type_name,source.rate_percentage,w.withholding_amount*coalesce(payment.exchange_rate,1)
  from customer_payment_withholding w join customer_payment payment using(payment_id)
  join invoice i using(invoice_id)join customers customer on customer.customer_id=payment.customer_id
  join sales_invoice_withholding source using(invoice_withholding_id)
  join journal payment_journal on payment_journal.journal_id=payment.journal_id
  join tax_codes tc on tc.tax_code_id=w.tax_code_id join tax_types tt using(tax_type_id)
  where i.subsidiary_id=sid and not source.recognized_at_invoice and payment.payment_date between period_start and period_end
   and upper(coalesce(payment.status,'APROBADO'))not in('ANULADO','CANCELADO','BORRADOR')
   and upper(payment_journal.status)='CONTABILIZADO'and tc.is_withholding and tt.is_indirect_tax
  union all
  select 'PRACTICED',i.invoice_id,i.invoice_number,coalesce(i.invoice_date,transaction_record.tran_date),
   supplier.company_name,supplier.tax_id,tc.code_name,tt.type_name,w.rate_percentage,
   w.withholding_amount*coalesce(i.exchange_rate,transaction_record.exchange_rate,1)
  from supplier_invoice_withholding w join supplier_invoice i using(invoice_id)
  join suppliers supplier using(supplier_id)join "transaction" transaction_record using(transaction_id)
  join status document_status using(status_id)join journal source_journal on source_journal.journal_id=i.journal_id
  join tax_codes tc using(tax_code_id)join tax_types tt using(tax_type_id)
  where i.subsidiary_id=sid and w.recognized_at_invoice
   and coalesce(i.invoice_date,transaction_record.tran_date)between period_start and period_end
   and upper(document_status.code)=any(selected_statuses)
   and upper(source_journal.status)='CONTABILIZADO'and tc.is_withholding and tt.is_indirect_tax
  union all
  select 'PRACTICED',payment.payment_id,payment.payment_number,payment.payment_date,supplier.company_name,supplier.tax_id,
   tc.code_name,tt.type_name,source.rate_percentage,w.withholding_amount*coalesce(payment.exchange_rate,1)
  from supplier_payment_withholding w join supplier_payment payment using(payment_id)
  join supplier_invoice i using(invoice_id)join suppliers supplier on supplier.supplier_id=payment.supplier_id
  join supplier_invoice_withholding source using(invoice_withholding_id)
  join journal payment_journal on payment_journal.journal_id=payment.journal_id
  join tax_codes tc on tc.tax_code_id=w.tax_code_id join tax_types tt using(tax_type_id)
  where i.subsidiary_id=sid and not source.recognized_at_invoice and payment.payment_date between period_start and period_end
   and upper(coalesce(payment.status,'APROBADO'))not in('ANULADO','CANCELADO','BORRADOR')
   and upper(payment_journal.status)='CONTABILIZADO'and tc.is_withholding and tt.is_indirect_tax
 ),
 totals as(
  select
   coalesce(sum(base_amount)filter(where side='SALES'),0)sales_base,
   coalesce(sum(base_amount)filter(where side='SALES'and tax_reportable and tax_rate>0),0)sales_taxable_base,
   coalesce(sum(base_amount)filter(where side='SALES'and tax_classification='EXEMPT'),0)sales_exempt_base,
   coalesce(sum(base_amount)filter(where side='SALES'and tax_classification='NON_SUBJECT'),0)sales_non_subject_base,
   coalesce(sum(base_amount)filter(where side='SALES'and tax_classification='ZERO_RATE'),0)sales_zero_rate_base,
   coalesce(sum(base_amount)filter(where side='SALES'and tax_classification not in('EXEMPT','NON_SUBJECT','ZERO_RATE')and(not tax_reportable or tax_rate=0)),0)sales_unclassified_base,
   coalesce(sum(tax_amount)filter(where side='SALES'),0)sales_tax,
   coalesce(sum(excluded_tax_amount)filter(where side='SALES'),0)excluded_sales_tax,
   coalesce(sum(gross_amount)filter(where side='SALES'),0)sales_gross,
   coalesce(sum(base_amount)filter(where side='PURCHASES'),0)purchase_base,
   coalesce(sum(base_amount)filter(where side='PURCHASES'and tax_reportable and tax_rate>0),0)purchase_taxable_base,
   coalesce(sum(base_amount)filter(where side='PURCHASES'and tax_classification='EXEMPT'),0)purchase_exempt_base,
   coalesce(sum(base_amount)filter(where side='PURCHASES'and tax_classification='NON_SUBJECT'),0)purchase_non_subject_base,
   coalesce(sum(base_amount)filter(where side='PURCHASES'and tax_classification='ZERO_RATE'),0)purchase_zero_rate_base,
   coalesce(sum(base_amount)filter(where side='PURCHASES'and tax_classification not in('EXEMPT','NON_SUBJECT','ZERO_RATE')and(not tax_reportable or tax_rate=0)),0)purchase_unclassified_base,
   coalesce(sum(tax_amount)filter(where side='PURCHASES'),0)purchase_tax,
   coalesce(sum(excluded_tax_amount)filter(where side='PURCHASES'),0)excluded_purchase_tax,
   coalesce(sum(gross_amount)filter(where side='PURCHASES'),0)purchase_gross,
   count(distinct(document_type,document_id))filter(where side='SALES')sales_document_count,
   count(distinct(document_type,document_id))filter(where side='PURCHASES')purchase_document_count,
   count(*)line_count
  from details
 ),
 retention_totals as(
  select coalesce(sum(amount)filter(where retention_side='SUFFERED'),0)suffered,
   coalesce(sum(amount)filter(where retention_side='PRACTICED'),0)practiced
  from withholding_events
 ),
 settlement as(
  select totals.*,retention_totals.suffered,retention_totals.practiced,
   totals.sales_tax-totals.purchase_tax gross_tax,
   totals.sales_tax-totals.purchase_tax-retention_totals.suffered-retention_totals.practiced-prior_credit net_tax
  from totals cross join retention_totals
 )
 select jsonb_build_object(
  'header',(select jsonb_build_object(
   'subsidiaryId',company.subsidiary_id,'subsidiaryName',company.name,'legalName',company.legal_name,'taxId',company.tax_id,
   'countryCode',coalesce(country.country_code_iso3,country.country_code_iso2),'countryName',country.name,
   'taxLabel',case when exists(select 1 from tax_catalog where country_id=company_country_id and is_indirect_tax and lower(type_name)~'gct|general consumption|consumo general')then'GCT'
                   when exists(select 1 from tax_catalog where country_id=company_country_id and is_indirect_tax and lower(type_name)~'iva|valor agregado|vat|itbms|igv')then'IVA'
                   else'Impuesto indirecto'end,
   'periodMonth',period_value,'dateFrom',period_start,'dateTo',period_end,
   'currencyId',currency.currency_id,'currencyCode',currency.currency_code,'currencyName',currency.name,'currencySymbol',currency.symbol,
   'includeAdjustments',include_adjustments,'documentStatuses',to_jsonb(selected_statuses),'generatedAt',clock_timestamp()
  )from subsidiaries company join countries country using(country_id)join currencies currency using(currency_id)where company.subsidiary_id=sid),
  'summary',(select jsonb_build_object(
   'salesBase',sales_base,'salesTaxableBase',sales_taxable_base,'salesExemptBase',sales_exempt_base,'salesNonSubjectBase',sales_non_subject_base,'salesZeroRateBase',sales_zero_rate_base,'salesUnclassifiedBase',sales_unclassified_base,'salesTax',sales_tax,'salesGross',sales_gross,
   'purchaseBase',purchase_base,'purchaseTaxableBase',purchase_taxable_base,'purchaseExemptBase',purchase_exempt_base,'purchaseNonSubjectBase',purchase_non_subject_base,'purchaseZeroRateBase',purchase_zero_rate_base,'purchaseUnclassifiedBase',purchase_unclassified_base,'purchaseTax',purchase_tax,'purchaseGross',purchase_gross,
   'excludedSalesTax',excluded_sales_tax,'excludedPurchaseTax',excluded_purchase_tax,
   'grossTax',gross_tax,'vatWithheldSuffered',suffered,'vatWithheldPracticed',practiced,
   'priorPeriodCredit',prior_credit,'netTax',net_tax,
   'position',case when net_tax>.005 then'PAYABLE'when net_tax<-.005 then'FAVOR'else'ZERO'end,
   'payableAmount',greatest(net_tax,0),'favorAmount',greatest(-net_tax,0),
   'salesDocumentCount',sales_document_count,'purchaseDocumentCount',purchase_document_count,
   'documentCount',sales_document_count+purchase_document_count,'lineCount',line_count,
   'warnings',coalesce((select jsonb_agg(warning)from(values
    (case when not exists(select 1 from tax_catalog where country_id=company_country_id and is_indirect_tax)then'No hay tipos de IVA/GCT configurados para el país de la empresa.'end),
    (case when exists(select 1 from details where tax_code_id is null)then'Las líneas sin código fiscal se presentan como no gravadas para conservar la base completa.'end),
    (case when exists(select 1 from details where tax_classification='NO_CODE'and abs(excluded_tax_amount)>.005)then'Hay líneas con impuesto pero sin código fiscal; ese impuesto se excluyó de la liquidación y requiere revisión.'end),
    (case when exists(select 1 from details where tax_classification='NON_CREDITABLE'and abs(excluded_tax_amount)>.005)then'El impuesto marcado como no acreditable se informa en el detalle, pero no reduce la posición fiscal.'end),
    (case when exists(select 1 from details where tax_classification in('INVALID_COUNTRY','NON_INDIRECT','NOT_APPLICABLE')and abs(excluded_tax_amount)>.005)then'Hay impuestos con clasificación fiscal no aplicable; se conservaron para auditoría y se excluyeron del cálculo.'end),
    (case when exists(select 1 from details where tax_classification='UNCLASSIFIED')then'Hay códigos con porcentaje cero sin clasificación fiscal. Revise si son exentos, no sujetos o de tasa cero.'end),
    (case when prior_credit>0 then'El saldo a favor anterior fue informado manualmente para esta liquidación.'end)
   )warning_list(warning)where warning is not null),'[]'::jsonb)
  )from settlement),
  'sales',jsonb_build_object(
   'rows',coalesce((select jsonb_agg(jsonb_build_object(
     'key',key,'side',side,'taxCodeId',tax_code_id,'taxCode',tax_code,'description',description,'rate',rate,
     'baseAmount',base_amount,'taxAmount',tax_amount,'grossAmount',gross_amount,
     'taxReportable',tax_reportable,'isImportTax',is_import_tax,'classification',tax_classification,'excludedTaxAmount',excluded_tax_amount,
    'adjustmentBaseAmount',adjustment_base_amount,'adjustmentAmount',adjustment_tax_amount,
    'documentCount',document_count,'lineCount',line_count
   )order by rate desc,tax_code)from grouped where side='SALES'),'[]'::jsonb),
   'totals',(select jsonb_build_object('baseAmount',sales_base,'taxAmount',sales_tax,'grossAmount',sales_gross)from settlement)
  ),
  'purchases',jsonb_build_object(
   'rows',coalesce((select jsonb_agg(jsonb_build_object(
     'key',key,'side',side,'taxCodeId',tax_code_id,'taxCode',tax_code,'description',description,'rate',rate,
     'baseAmount',base_amount,'taxAmount',tax_amount,'grossAmount',gross_amount,
     'taxReportable',tax_reportable,'isImportTax',is_import_tax,'classification',tax_classification,'excludedTaxAmount',excluded_tax_amount,
    'adjustmentBaseAmount',adjustment_base_amount,'adjustmentAmount',adjustment_tax_amount,
    'documentCount',document_count,'lineCount',line_count
   )order by rate desc,tax_code)from grouped where side='PURCHASES'),'[]'::jsonb),
   'totals',(select jsonb_build_object('baseAmount',purchase_base,'taxAmount',purchase_tax,'grossAmount',purchase_gross)from settlement)
  ),
  'details',coalesce((select jsonb_agg(jsonb_build_object(
   'key',key,'side',side,'documentType',document_type,'documentTypeLabel',document_type_label,
   'documentId',document_id,'documentNumber',document_number,'documentDate',document_date,
   'partyType',party_type,'partyId',party_id,'partyName',party_name,'partyTaxId',party_tax_id,
   'taxCodeId',tax_code_id,'taxCode',tax_code,'taxDescription',tax_description,'taxRate',tax_rate,
   'taxReportable',tax_reportable,'isImportTax',is_import_tax,'classification',tax_classification,
   'baseAmount',base_amount,'taxAmount',tax_amount,'excludedTaxAmount',excluded_tax_amount,'grossAmount',gross_amount,
   'currencyCode',currency_code,'exchangeRate',exchange_rate,'originalBase',original_base,'originalTax',original_tax,'originalGross',original_gross,
   'sourceLineId',source_line_id,'journalId',journal_id,'status',status
  )order by side,document_date,document_number,source_line_id)from details),'[]'::jsonb),
  'retentions',jsonb_build_object(
   'suffered',coalesce((select jsonb_agg(jsonb_build_object('sourceId',source_id,'documentNumber',document_number,'date',event_date,'partyName',party_name,'partyTaxId',party_tax_id,'taxCode',tax_code,'description',tax_description,'rate',rate_percentage,'amount',amount)order by event_date,document_number)from withholding_events where retention_side='SUFFERED'),'[]'::jsonb),
   'practiced',coalesce((select jsonb_agg(jsonb_build_object('sourceId',source_id,'documentNumber',document_number,'date',event_date,'partyName',party_name,'partyTaxId',party_tax_id,'taxCode',tax_code,'description',tax_description,'rate',rate_percentage,'amount',amount)order by event_date,document_number)from withholding_events where retention_side='PRACTICED'),'[]'::jsonb)
  )
 )into result;

 return result;
end
;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.save_receivable_discount_operation(p_invoice_id bigint, p_creditor_id bigint, p_operation text, p_due_date date, p_expected boolean, p_expected_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('classified-receivables');
 declare uid bigint;sid bigint;old_mark report_delivery_private.receivable_discount_marks;result jsonb;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 uid:=public.app_user_id();
 select i.subsidiary_id into sid from public.invoice i join public.user_subsidiaries a on a.subsidiary_id=i.subsidiary_id and a.user_id=uid where i.invoice_id=p_invoice_id;
 if sid is null then raise exception using errcode='42501',message='Factura no disponible en sus subsidiarias autorizadas.';end if;
 if p_expected is null or p_creditor_id is null or nullif(btrim(p_operation),'') is null or length(btrim(p_operation))>120 or p_due_date is null or not isfinite(p_due_date) then raise exception using errcode='22023',message='Complete acreedor financiero, número de operación y vencimiento.';end if;
 if not exists(select 1 from public.financial_creditors c join public.financial_creditor_subsidiaries a using(financial_creditor_id) where c.financial_creditor_id=p_creditor_id and a.subsidiary_id=sid and not coalesce(c.is_inactive,false)) then raise exception using errcode='42501',message='El acreedor financiero no está activo o no pertenece a la subsidiaria de la factura.';end if;
 perform pg_advisory_xact_lock(hashtextextended('receivable-discount:'||p_invoice_id::text,0));
 select * into old_mark from report_delivery_private.receivable_discount_marks where invoice_id=p_invoice_id;
 if coalesce(old_mark.discounted,false)<>p_expected or old_mark.updated_at is distinct from p_expected_at then raise exception using errcode='40001',message='Otro usuario cambió los datos. Consulte nuevamente el informe.';end if;
 insert into report_delivery_private.receivable_discount_marks(invoice_id,discounted,updated_by,financial_creditor_id,operation_number,operation_due_date)
 values(p_invoice_id,true,uid,p_creditor_id,btrim(p_operation),p_due_date)
 on conflict(invoice_id) do update set discounted=true,updated_by=uid,updated_at=clock_timestamp(),financial_creditor_id=excluded.financial_creditor_id,operation_number=excluded.operation_number,operation_due_date=excluded.operation_due_date;
 insert into report_delivery_private.receivable_discount_history(invoice_id,discounted,changed_by,financial_creditor_id,operation_number,operation_due_date)values(p_invoice_id,true,uid,p_creditor_id,btrim(p_operation),p_due_date);
 select to_jsonb(m) into result from report_delivery_private.receivable_discount_marks m where invoice_id=p_invoice_id;
 return result;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.set_receivable_discount_mark(p_invoice_id bigint, p_discounted boolean, p_expected boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.enter('classified-receivables');
 declare current_mark boolean; result jsonb; uid bigint;
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 uid:=public.app_user_id();
 if p_discounted is null or p_expected is null then raise exception using errcode='22023',message='Seleccione una marca válida.';end if;
 if not exists(select 1 from public.invoice i join public.user_subsidiaries access on access.subsidiary_id=i.subsidiary_id and access.user_id=uid where i.invoice_id=p_invoice_id)
 then raise exception using errcode='42501',message='Factura no disponible en sus subsidiarias autorizadas.';end if;
 perform pg_advisory_xact_lock(hashtextextended('receivable-discount:'||p_invoice_id::text,0));
 select discounted into current_mark from report_delivery_private.receivable_discount_marks where invoice_id=p_invoice_id;
 current_mark:=coalesce(current_mark,false);
 if current_mark<>p_expected then raise exception using errcode='40001',message='Otro usuario cambió esta marca. Consulte nuevamente el informe.';end if;
 insert into report_delivery_private.receivable_discount_marks(invoice_id,discounted,updated_by)
 values(p_invoice_id,p_discounted,uid) on conflict(invoice_id)do update set discounted=excluded.discounted,updated_by=excluded.updated_by,updated_at=clock_timestamp();
 if current_mark<>p_discounted then
 insert into report_delivery_private.receivable_discount_history(invoice_id,discounted,changed_by)values(p_invoice_id,p_discounted,uid);
 end if;
 select jsonb_build_object('invoiceId',invoice_id,'discounted',discounted,'updatedAt',updated_at)into result from report_delivery_private.receivable_discount_marks where invoice_id=p_invoice_id;
 return result;
end;
end
$function$;

-- Report readers do not need permission to create or edit payment operations.
create or replace function customer_payment_private.access(a text)returns bigint
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 if a='view' and current_setting('erp.authorized_report_root',true)='customer-payment-fees'then
  return asset_posting_private.identity();
 end if;
 return asset_posting_private.access('sales:customer-payments',a);
end $$;
create or replace function public.run_customer_payment_fee_report(p_filters jsonb default '{}')returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare r jsonb;row jsonb;detail jsonb;rows jsonb:='[]';
begin
 perform report_access_private.enter('customer-payment-fees');
 r:=public.customer_payment_report(p_filters);
 for row in select value from jsonb_array_elements(coalesce(r->'rows','[]'))where coalesce((value->>'bankFeeTotal')::numeric,0)>0 loop
  detail:=public.customer_payment_detail((row->>'id')::bigint);
  rows:=rows||jsonb_build_array(row||jsonb_build_object('applications',coalesce(detail->'applications','[]'),'company',coalesce(detail#>>'{header,subsidiary}',detail#>>'{header,company}','')));
 end loop;
 return r||jsonb_build_object('rows',rows);
end $$;
revoke all on function public.run_customer_payment_fee_report(jsonb)from public,anon;
grant execute on function public.run_customer_payment_fee_report(jsonb)to authenticated;
create or replace function fx_revaluation_private.history_allowed()returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select fx_revaluation_private.allowed('reports:fx-revaluation','view')
 or fx_revaluation_private.allowed('accounting:fx-revaluation','view')
 or fx_revaluation_private.allowed('accounting:fx-revaluation-analysis','view')
$$;
CREATE OR REPLACE FUNCTION report_access_private.asset_analytics(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$begin perform asset_posting_private.identity();if nullif(p_filters->>'assetId','') is not null and not exists(select 1 from public.asset where asset_id=(p_filters->>'assetId')::bigint and subsidiary_id=asset_posting_private.identity()) then raise exception using errcode='42501',message='Activo no disponible.';end if;return asset_master_private.fixed_asset_analytics(p_filters);end$function$;
revoke all on function report_access_private.asset_analytics(jsonb) from public,anon,authenticated;

create or replace function public.fixed_asset_analytics(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare k text:=nullif(p_filters->>'reportKey','');r jsonb;field text;keys text[];
begin
 if k is null then
  foreach field in array array['depreciation','summary','history','movements','reconciliation','projection','impairment']loop
   perform public.security_assert_role_access('reports:asset-'||field,'view');
  end loop;
  return report_access_private.asset_analytics(p_filters);
 end if;
 keys:=case k when 'depreciation'then array['depreciations']when 'summary'then array['assets']
 when 'history'then array['assets','depreciations','movements']when 'movements'then array['movements']
 when 'reconciliation'then array['reconciliation']when 'projection'then array['projection']
 when 'impairment'then array['impairments','disposals']end;
 if keys is null then raise exception using errcode='42501',message='Informe no autorizado.';end if;
 perform report_access_private.enter('asset-'||k);
 r:=report_access_private.asset_analytics(p_filters);
 return(select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb)from jsonb_each(r)e where e.key=any(keys||array['subsidiary','assetOptions']));
end $$;

create or replace function report_access_private.delivery(p_kind text,p_owner bigint default null)returns void
language plpgsql volatile security definer set search_path=pg_catalog,public,pg_temp as $$
declare k text:=case p_kind when 'AR'then 'receivables-aging'when 'AP'then 'payables-aging'else p_kind end;
begin
 if coalesce(auth.role(),'')<>'service_role'then perform report_access_private.enter(k);return;end if;
 if p_owner is null or not exists(select 1 from public.user_roles ur join public.roles r using(role_id)
  left join public.role_access_matrix m on m.role_id=ur.role_id and m.resource_key='reports:'||k and m.can_view
  where ur.user_id=p_owner and (m.role_id is not null or lower(r.role_name)in('administrador','administrator','admin')))
 then raise exception using errcode='42501',message='El propietario no tiene permiso para este informe.';end if;
 perform set_config('erp.authorized_report_root',k,true);
end $$;
revoke all on function report_access_private.delivery(text,bigint) from public,anon,authenticated;
CREATE OR REPLACE FUNCTION public.scheduled_report_snapshot_v2(p_sid bigint, p_kind text, p_cutoff date, p_options jsonb DEFAULT '{}'::jsonb, p_owner bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 perform report_access_private.delivery(p_kind,p_owner);
 declare old_claims text:=current_setting('request.jwt.claims',true);owner_email text;filters jsonb;report jsonb;rows jsonb:='[]';result jsonb;page int:=1;count_rows int;date_from date;period_key bigint;mode text:=coalesce(p_options->>'periodMode','YEAR_TO_DATE');book_key bigint;
begin
 if coalesce(auth.role(),'')='service_role'then
 if p_owner is null or not scheduled_report_owner_allowed(p_owner,p_sid)then raise exception 'El propietario no tiene acceso a reportes de esta sociedad.';end if;
 select email into owner_email from users where user_id=p_owner;
 perform set_config('request.jwt.claims',(coalesce(nullif(old_claims,'')::jsonb,'{}')||jsonb_build_object('email',owner_email,'scheduled_report_sid',p_sid))::text,true);
 elsif p_sid is distinct from scheduled_report_access()then raise exception 'Sociedad no autorizada.';end if;
 perform scheduled_report_validate_options(p_sid,p_kind,p_options);
 if p_cutoff is null then raise exception 'Seleccione la fecha de corte.';end if;
 if p_kind in('AR','AP')then result:=scheduled_report_snapshot(p_sid,p_kind,p_cutoff);
 else
 date_from:=case mode when 'YEAR_TO_DATE'then date_trunc('year',p_cutoff)::date when 'MONTH_TO_DATE'then date_trunc('month',p_cutoff)::date when 'LAST_7_DAYS'then p_cutoff-6 when 'LAST_30_DAYS'then p_cutoff-29 end;
 if date_from is null then raise exception 'Período relativo inválido.';end if;
 book_key:=nullif(p_options->>'bookId','')::bigint;
 if book_key is null then select accounting_book_id into book_key from accounting_books where subsidiary_id=p_sid and is_active and is_primary order by accounting_book_id limit 1;end if;
 filters:=jsonb_build_object('subsidiaryIds',jsonb_build_array(p_sid),'dateFrom',date_from,'dateTo',p_cutoff,'from',date_from,'to',p_cutoff,'bookId',book_key,'bankAccountId',nullif(p_options->>'bankAccountId','')::bigint,'bankView','AUXILIARY','hierarchy',4,'excludeZero',true,'pageSize',250,'presentationCurrency',coalesce(p_options->>'presentationCurrency','LOCAL'));
 if p_kind='bank-balances'then
 select fiscal_period_id into period_key from fiscal_periods where subsidiary_id=p_sid and start_date<=p_cutoff and end_date>=p_cutoff order by end_date-start_date,fiscal_period_id limit 1;
 if period_key is null then raise exception 'No existe período contable para la fecha de corte.';end if;
 select start_date,end_date into date_from,p_cutoff from fiscal_periods where fiscal_period_id=period_key;
 filters:=filters||jsonb_build_object('periodId',period_key);
 end if;
 loop
 filters:=filters||jsonb_build_object('page',page);
 case p_kind
 when 'balance-sheet','income-statement'then
 if p_options->>'presentationCurrency'='USD'then
 report:=report_delivery_private.run_financial_statement_presentation(p_kind,filters,case when coalesce(auth.role(),'')='service_role'then p_owner else app_user_id()end);
 else report:=report_delivery_private.run_accounting_report(p_kind,filters);end if;
 when 'pending-invoice-control'then report:=report_delivery_private.run_pending_invoice_control_report(filters);
 when 'journal'then report:=report_delivery_private.run_general_journal_report(filters);
 when 'sales-transactions'then report:=report_delivery_private.run_sales_transaction_report(filters);
 when 'purchase-transactions'then report:=report_delivery_private.run_purchase_transaction_report(filters);
 when 'bank-reconciliation'then report:=report_delivery_private.run_bank_reconciliation_report(filters);
 when 'bank-balances'then report:=report_delivery_private.run_bank_balance_period_report(filters);
 when 'fx-revaluation'then report:=fx_report(filters);
 when 'asset-reconciliation','asset-projection','asset-impairment'then
 report:=fixed_asset_analytics(filters||jsonb_build_object('reportKey',substr(p_kind,7)));
 report:=case p_kind when 'asset-reconciliation'then jsonb_build_object('rows',report->'reconciliation')when 'asset-projection'then jsonb_build_object('rows',report->'projection')else jsonb_build_object('impairments',report->'impairments','disposals',report->'disposals')end;
 else report:=report_delivery_private.run_accounting_report(p_kind,filters);
 end case;
 count_rows:=jsonb_array_length(coalesce(report->'rows','[]'));
 rows:=rows||coalesce(report->'rows','[]');
 if jsonb_array_length(rows)>20000 or coalesce((report->>'total')::int,0)>20000 then raise exception 'El reporte supera 20.000 filas. No se enviará un archivo incompleto.';end if;
 exit when not(report ? 'rows') or jsonb_array_length(rows)>=coalesce((report->>'total')::int,count_rows);
 if count_rows=0 or page>=2000 then raise exception 'No fue posible recuperar todas las páginas del reporte.';end if;
 page:=page+1;
 end loop;
 if report ? 'rows'then report:=report||jsonb_build_object('rows',rows);end if;
 if p_kind='bank-reconciliation'then
 report:=jsonb_build_object('rows',rows,'summary',report->'summary','bankAccount',(select jsonb_build_object('account',b.account_number,'bank',bk.bank_name,'currency',c.currency_code)from bank_account b join banks bk using(bank_id)join currencies c using(currency_id)where b.bank_account_id=(p_options->>'bankAccountId')::bigint));
 end if;
 if p_kind in('asset-reconciliation','asset-projection')then report:=report||jsonb_build_object('scopeNote','El auxiliar utiliza las fichas actuales de activos. La proyección incluye las depreciaciones registradas a la fecha de generación.');end if;
 result:=jsonb_build_object('kind',p_kind,'cutoff',p_cutoff,'dateFrom',date_from,'company',(select name from subsidiaries where subsidiary_id=p_sid),'currency',case when p_kind in('balance-sheet','income-statement')and p_options->>'presentationCurrency'='USD'then report->>'presentationCurrencyCode'else(select c.currency_code from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=p_sid)end,'rows','[]'::jsonb,'summary','{}'::jsonb,'data',report);
 end if;
 result:=result||jsonb_build_object('title',(select name from scheduled_report_catalog where code=p_kind));
 perform set_config('request.jwt.claims',coalesce(old_claims,''),true);return result;
exception when others then perform set_config('request.jwt.claims',coalesce(old_claims,''),true);raise;
end;
end
$function$;
CREATE OR REPLACE FUNCTION public.scheduled_report_snapshot(p_sid bigint, p_kind text, p_cutoff date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
 if coalesce(auth.role(),'')<>'service_role'then perform report_access_private.delivery(p_kind);end if;
 declare report jsonb;rows jsonb:='[]';page int:=1;begin
 if coalesce(auth.role(),'')<>'service_role'and p_sid is distinct from scheduled_report_access()then raise exception 'Sociedad no autorizada.';end if;
 if p_kind not in('AR','AP')or p_kind is null or p_cutoff is null then raise exception 'Reporte o fecha de corte inválidos.';end if;
 loop
 report:=report_delivery_private.run_aging_report(p_kind,jsonb_build_object('subsidiaryIds',jsonb_build_array(p_sid),'dateTo',p_cutoff,'agingCurrencyMode','LOCAL','onlyPending',true,'page',page,'pageSize',250));
 if coalesce((report->>'total')::int,0)>20000 then raise exception 'El reporte supera 20.000 documentos. No se enviará un archivo incompleto.';end if;
 rows:=rows||coalesce(report->'rows','[]');exit when page*250>=coalesce((report->>'total')::int,0);page:=page+1;
 end loop;
 return jsonb_build_object('kind',p_kind,'cutoff',p_cutoff,'company',(select name from subsidiaries where subsidiary_id=p_sid),'currency',(select c.currency_code from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=p_sid),'rows',rows,'summary',report->'summary');
end;
end
$function$;
