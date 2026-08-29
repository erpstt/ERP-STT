create index if not exists gl_impact_reporting_idx on public.gl_impact(subsidiary_id,accounting_book_id,posting_date,account_id);
create index if not exists gl_impact_ledger_audit_idx on public.gl_impact(subsidiary_id,accounting_book_id,account_id,posting_date,transaction_id);
create index if not exists journal_reporting_idx on public.journal(subsidiary_id,journal_date,transaction_id);
create index if not exists journal_line_reporting_idx on public.journal_line(journal_id,account_id);

create or replace function public.accounting_report_options()
returns jsonb language sql stable security definer set search_path=public as $$
with allowed as (select subsidiary_id from user_subsidiaries where user_id=app_user_id())
select jsonb_build_object(
 'subsidiaries',coalesce((select jsonb_agg(jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id,'logoUrl',s.logo_url) order by s.name) from subsidiaries s join allowed a using(subsidiary_id) where s.is_active),'[]'::jsonb),
 'books',coalesce((select jsonb_agg(jsonb_build_object('id',b.accounting_book_id,'name',b.book_name,'subsidiaryId',b.subsidiary_id,'currencyId',b.base_currency_id) order by b.book_name) from accounting_books b join allowed a using(subsidiary_id) where b.is_active),'[]'::jsonb),
 'periods',coalesce((select jsonb_agg(jsonb_build_object('id',p.fiscal_period_id,'name',p.period_name,'start',p.start_date,'end',p.end_date,'subsidiaryId',p.subsidiary_id) order by p.start_date desc) from fiscal_periods p join allowed a using(subsidiary_id)),'[]'::jsonb),
 'currencies',coalesce((select jsonb_agg(jsonb_build_object('id',c.currency_id,'code',c.currency_code,'name',c.name,'symbol',c.symbol) order by c.currency_code) from currencies c),'[]'::jsonb),
 'departments',coalesce((select jsonb_agg(jsonb_build_object('id',d.department_id,'name',d.name,'type',d.type,'subsidiaryId',ds.subsidiary_id) order by d.name) from departments d join department_subsidiaries ds using(department_id) join allowed a on a.subsidiary_id=ds.subsidiary_id where not d.is_inactive),'[]'::jsonb),
 'locations',coalesce((select jsonb_agg(jsonb_build_object('id',l.location_id,'name',l.name,'subsidiaryId',ls.subsidiary_id) order by l.name) from locations l join location_subsidiaries ls using(location_id) join allowed a on a.subsidiary_id=ls.subsidiary_id),'[]'::jsonb),
 'classes',coalesce((select jsonb_agg(jsonb_build_object('id',c.class_id,'name',c.name,'subsidiaryId',cs.subsidiary_id,'departmentIds',coalesce((select jsonb_agg(distinct jl.department_id) from journal_line jl join journal j using(journal_id) where jl.class_id=c.class_id and jl.department_id is not null and j.subsidiary_id=cs.subsidiary_id),'[]'::jsonb)) order by c.name) from classes c join class_subsidiaries cs using(class_id) join allowed a on a.subsidiary_id=cs.subsidiary_id where not c.is_inactive),'[]'::jsonb),
 'costCenters',coalesce((select jsonb_agg(jsonb_build_object('id',c.cost_center_id,'name',c.name,'code',c.code,'subsidiaryId',c.subsidiary_id) order by c.name) from cost_centers c join allowed a using(subsidiary_id) where not c.is_inactive),'[]'::jsonb)
 ,'accountGroups',coalesce((select jsonb_agg(jsonb_build_object('id',g.group_id,'code',g.group_code,'name',g.group_name,'level',g.level,'parentId',g.parent_id,'category',g.category) order by g.group_code) from account_group g where not coalesce(g.is_inactive,false)),'[]'::jsonb),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',ca.account_id,'code',ca.account_number,'name',ca.account_name,'nature',ca.nature,'subsidiaryId',acs.subsidiary_id) order by ca.account_number) from chart_accounts ca join account_subsidiaries acs using(account_id) join allowed a on a.subsidiary_id=acs.subsidiary_id where acs.is_active and not ca.is_inactive),'[]'::jsonb),
 'thirdParties',coalesce((select jsonb_agg(jsonb_build_object('id',party.id,'type',party.type,'name',party.name,'subsidiaryId',party.subsidiary_id) order by party.name) from (select c.customer_id id,'Cliente' type,c.company_name name,es.subsidiary_id from customers c join entity_subsidiaries es using(customer_id) union all select sp.supplier_id,'Proveedor',sp.company_name,es.subsidiary_id from suppliers sp join entity_subsidiaries es using(supplier_id) union all select e.employee_id,'Empleado',concat_ws(' ',e.first_name,e.last_name),e.subsidiary_id from employees e where e.is_active) party join allowed a on a.subsidiary_id=party.subsidiary_id),'[]'::jsonb)
)$$;

create or replace function public.run_accounting_report(p_report text,p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
 sids bigint[]; book_id bigint; date_from date; date_to date; page_no int; page_size int; offset_no int;
 hierarchy int; exclude_zero boolean; result jsonb; allowed_count int; requested_count int;
 filter_department_id bigint; filter_location_id bigint; filter_class_id bigint; filter_cost_center_id bigint; filter_account_id bigint; filter_account_from text; filter_account_to text; filter_entity_type text; filter_entity_id bigint; filter_account_ids bigint[];
begin
 if p_report not in ('balance-sheet','income-statement','cash-flow','equity-changes','trial-balance','general-ledger','journal','receivables-payables','bank-reconciliation') then raise exception 'Reporte no válido.'; end if;
 select coalesce(array_agg(value::bigint),array[]::bigint[]) into sids from jsonb_array_elements_text(coalesce(p_filters->'subsidiaryIds','[]'::jsonb));
 if cardinality(sids)=0 then sids:=array[active_subsidiary_id()]; end if;
 if sids[1] is null or exists(select 1 from unnest(sids) selected_id where not exists(select 1 from user_subsidiaries access where access.user_id=app_user_id() and access.subsidiary_id=selected_id)) then raise exception 'No tiene acceso a una o más subsidiarias seleccionadas.'; end if;
 book_id:=nullif(p_filters->>'bookId','')::bigint; date_from:=coalesce(nullif(p_filters->>'dateFrom','')::date,date_trunc('year',current_date)::date); date_to:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
 page_no:=greatest(coalesce((p_filters->>'page')::int,1),1); page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),500); offset_no:=(page_no-1)*page_size;
 hierarchy:=least(greatest(coalesce((p_filters->>'hierarchy')::int,4),1),4); exclude_zero:=coalesce((p_filters->>'excludeZero')::boolean,true);
 filter_department_id:=nullif(p_filters->>'departmentId','')::bigint; filter_location_id:=nullif(p_filters->>'locationId','')::bigint; filter_class_id:=nullif(p_filters->>'classId','')::bigint; filter_cost_center_id:=nullif(p_filters->>'costCenterId','')::bigint;
 filter_account_id:=nullif(p_filters->>'accountId','')::bigint;
 filter_account_from:=nullif(p_filters->>'accountFrom','');filter_account_to:=nullif(p_filters->>'accountTo','');filter_entity_type:=nullif(p_filters->>'entityType','');filter_entity_id:=nullif(p_filters->>'entityId','')::bigint;
 select coalesce(array_agg(value::bigint),array[]::bigint[]) into filter_account_ids from jsonb_array_elements_text(coalesce(p_filters->'accountIds','[]'::jsonb));

 if p_report='general-ledger' then
  with detail_base as (
   select g.gl_impact_id id,g.account_id,g.posting_date date,t.tran_number transaction_number,tt.code transaction_code,tt.name transaction_type,a.account_number,a.account_name,coalesce(a.nature,ag.nature,'Deudora') nature,s.name subsidiary,g.debit_amount debit,g.credit_amount credit,jx.journal_id,jx.journal_number,
    coalesce(line_data.entity_name,customer.company_name,supplier.company_name,'—') entity_name,coalesce(line_data.entity_type,case when t.customer_id is not null then 'Cliente' when t.supplier_id is not null then 'Proveedor' end,'—') entity_type,coalesce(line_data.cost_center,'—') cost_center,coalesce(line_data.note,jx.memo,tt.name) concept,
    coalesce((select sum(case when coalesce(a.nature,ag.nature)='Acreedora' then previous.credit_amount-previous.debit_amount else previous.debit_amount-previous.credit_amount end) from gl_impact previous where previous.account_id=g.account_id and previous.subsidiary_id=g.subsidiary_id and previous.posting_date<date_from and (book_id is null or previous.accounting_book_id=book_id)),0) opening_balance,
    case when coalesce(a.nature,ag.nature)='Acreedora' then g.credit_amount-g.debit_amount else g.debit_amount-g.credit_amount end signed_movement
   from gl_impact g join chart_accounts a using(account_id) join account_group ag on ag.group_id=a.account_group_id join subsidiaries s using(subsidiary_id) join "transaction" t using(transaction_id) join transaction_types tt using(transaction_type_id) left join journal jx using(transaction_id)
   left join customers customer on customer.customer_id=t.customer_id left join suppliers supplier on supplier.supplier_id=t.supplier_id
   left join lateral(select jl.entity_type,coalesce(c.company_name,sp.company_name,concat_ws(' ',e.first_name,e.last_name)) entity_name,cc.code cost_center,jl.note,jl.customer_id,jl.supplier_id,jl.employee_id,jl.cost_center_id from journal_line jl left join customers c using(customer_id) left join suppliers sp using(supplier_id) left join employees e using(employee_id) left join cost_centers cc using(cost_center_id) where jl.journal_id=jx.journal_id and jl.account_id=g.account_id order by jl.journal_line_id limit 1) line_data on true
   where g.subsidiary_id=any(sids) and g.posting_date between date_from and date_to and (book_id is null or g.accounting_book_id=book_id) and (filter_account_id is null or g.account_id=filter_account_id) and (cardinality(filter_account_ids)=0 or g.account_id=any(filter_account_ids)) and (filter_account_from is null or a.account_number>=filter_account_from) and (filter_account_to is null or a.account_number<=filter_account_to)
   and (filter_entity_type is null or coalesce(line_data.entity_type,case when t.customer_id is not null then 'Cliente' when t.supplier_id is not null then 'Proveedor' end)=filter_entity_type) and (filter_entity_id is null or filter_entity_id in(coalesce(line_data.customer_id,t.customer_id),coalesce(line_data.supplier_id,t.supplier_id),line_data.employee_id)) and (filter_cost_center_id is null or line_data.cost_center_id=filter_cost_center_id)
  ), detail as(select *,opening_balance+sum(signed_movement) over(partition by account_id order by date,id) running_balance,sum(debit) over(partition by account_id) account_debit_total,sum(credit) over(partition by account_id) account_credit_total,opening_balance+sum(signed_movement) over(partition by account_id) account_final_balance,count(*) over() total_count from detail_base), numbered as(select * from detail order by account_number,date,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(numbered)-'total_count'-'signed_movement'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,'summary',jsonb_build_object('debit',coalesce(sum(debit),0),'credit',coalesce(sum(credit),0))) into result from numbered;
 elsif p_report='journal' then
  with detail as (
   select g.gl_impact_id as id,g.posting_date as date,t.tran_number as transaction_number,tt.name as transaction_type,
    a.account_number,a.account_name,s.name as subsidiary,g.debit_amount as debit,g.credit_amount as credit,
    sum(g.debit_amount-g.credit_amount) over(partition by g.account_id,g.subsidiary_id order by g.posting_date,g.gl_impact_id) as balance,
    j.journal_id
   from gl_impact g join chart_accounts a using(account_id) join subsidiaries s using(subsidiary_id)
   join "transaction" t using(transaction_id) join transaction_types tt using(transaction_type_id) left join journal j using(transaction_id)
   where g.subsidiary_id=any(sids) and g.posting_date between date_from and date_to and (book_id is null or g.accounting_book_id=book_id)
   and (filter_account_id is null or g.account_id=filter_account_id)
   and (filter_department_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.department_id=filter_department_id))
   and (filter_location_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.location_id=filter_location_id))
   and (filter_class_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.class_id=filter_class_id))
   and (filter_cost_center_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.cost_center_id=filter_cost_center_id))
  ), numbered as (select *,count(*) over() total_count from detail order by date,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(numbered)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,
   'summary',jsonb_build_object('debit',coalesce(sum(debit),0),'credit',coalesce(sum(credit),0))) into result from numbered;
 elsif p_report='receivables-payables' then
  with detail as (
   select g.gl_impact_id id,g.posting_date date,t.tran_number transaction_number,tt.name transaction_type,a.account_number,a.account_name,s.name subsidiary,
    case when a.category='Activo' then 'Por cobrar' else 'Por pagar' end auxiliary,
    greatest(date_to-g.posting_date,0) age_days,g.debit_amount debit,g.credit_amount credit,(g.debit_amount-g.credit_amount) balance
   from gl_impact g join chart_accounts a using(account_id) join subsidiaries s using(subsidiary_id) join "transaction" t using(transaction_id) join transaction_types tt using(transaction_type_id)
   where g.subsidiary_id=any(sids) and g.posting_date<=date_to and (book_id is null or g.accounting_book_id=book_id) and (lower(a.account_name) like '%cobrar%' or lower(a.account_name) like '%pagar%')
  ), aged as (select *,case when age_days<=30 then '0-30' when age_days<=60 then '31-60' when age_days<=90 then '61-90' else '+90' end age_bucket,count(*) over() total_count from detail order by date desc,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(aged)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,'summary',jsonb_build_object('balance',coalesce(sum(balance),0))) into result from aged;
 elsif p_report='bank-reconciliation' then
  with detail as (
   select g.gl_impact_id id,g.posting_date date,t.tran_number transaction_number,a.account_number,a.account_name,s.name subsidiary,g.debit_amount debit,g.credit_amount credit,(g.debit_amount-g.credit_amount) balance
   from gl_impact g join chart_accounts a using(account_id) join subsidiaries s using(subsidiary_id) join "transaction" t using(transaction_id)
   where g.subsidiary_id=any(sids) and g.posting_date between date_from and date_to and (book_id is null or g.accounting_book_id=book_id) and (lower(a.account_name) like '%banco%' or lower(a.account_name) like '%caja%')
  ), numbered as (select *,count(*) over() total_count from detail order by date desc,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(numbered)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,'summary',jsonb_build_object('balance',coalesce(sum(balance),0))) into result from numbered;
 else
  with balances as (
   select a.account_id,a.account_number,a.account_name,a.account_group_id as group_id,a.cash_flow_activity,coalesce(a.category,ag.category,'Sin clasificar') category,coalesce(a.nature,ag.nature,'Deudora') nature,s.name subsidiary,
    sum(case when g.posting_date<date_from then g.debit_amount-g.credit_amount else 0 end) opening,
    sum(case when g.posting_date between date_from and date_to then g.debit_amount else 0 end) debit,
    sum(case when g.posting_date between date_from and date_to then g.credit_amount else 0 end) credit,
    sum(case when g.posting_date<=date_to then g.debit_amount-g.credit_amount else 0 end) closing
   from gl_impact g join chart_accounts a using(account_id) join account_group ag on ag.group_id=a.account_group_id join subsidiaries s using(subsidiary_id)
   where g.subsidiary_id=any(sids) and (book_id is null or g.accounting_book_id=book_id) and (filter_account_id is null or g.account_id=filter_account_id)
   and (filter_department_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.department_id=filter_department_id))
   and (filter_location_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.location_id=filter_location_id))
   and (filter_class_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.class_id=filter_class_id))
   and (filter_cost_center_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.cost_center_id=filter_cost_center_id))
   group by a.account_id,a.account_number,a.account_name,a.account_group_id,a.cash_flow_activity,a.category,ag.category,a.nature,ag.nature,s.name
  ), eligible as (select * from balances where
   (not exclude_zero or opening<>0 or debit<>0 or credit<>0 or closing<>0) and
   (p_report in('trial-balance','cash-flow') or p_report='balance-sheet' and category in('Activo','Pasivo','Patrimonio') or p_report='income-statement' and category in('Ingreso','Costo','Gasto') or p_report='equity-changes' and category='Patrimonio')
  ), filtered as (select *,count(*) over() total_count from eligible
   order by case category when 'Activo' then 1 when 'Pasivo' then 2 when 'Patrimonio' then 3 when 'Ingreso' then 4 when 'Costo' then 5 when 'Gasto' then 6 else 9 end,account_number limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(filtered)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,
   'summary',jsonb_build_object('opening',coalesce((select sum(opening) from eligible),0),'debit',coalesce((select sum(debit) from eligible),0),'credit',coalesce((select sum(credit) from eligible),0),'closing',coalesce((select sum(closing) from eligible),0),'openingDebtor',coalesce((select sum(greatest(opening,0)) from eligible),0),'openingCreditor',coalesce((select sum(greatest(-opening,0)) from eligible),0),'finalDebtor',coalesce((select sum(greatest(closing,0)) from eligible),0),'finalCreditor',coalesce((select sum(greatest(-closing,0)) from eligible),0),'balanced',abs(coalesce((select sum(debit) from eligible),0)-coalesce((select sum(credit) from eligible),0))<0.005,'resultExercise',coalesce((select sum(rx.credit_amount-rx.debit_amount) from gl_impact rx join chart_accounts ax using(account_id) where rx.subsidiary_id=any(sids) and rx.posting_date<=date_to and (book_id is null or rx.accounting_book_id=book_id) and lower(ax.account_name) like '%resultado del ejercicio%'),0),'currentPeriodResult',coalesce((select sum(case when coalesce(ax.category,gx.category)='Ingreso' then rx.credit_amount-rx.debit_amount when coalesce(ax.category,gx.category) in('Costo','Gasto') then rx.credit_amount-rx.debit_amount else 0 end) from gl_impact rx join chart_accounts ax using(account_id) join account_group gx on gx.group_id=ax.account_group_id where rx.subsidiary_id=any(sids) and rx.posting_date between date_trunc('year',date_to)::date and date_to and (book_id is null or rx.accounting_book_id=book_id)),0),'periodResult',coalesce((select sum(case when coalesce(ax.category,gx.category)='Ingreso' then rx.credit_amount-rx.debit_amount when coalesce(ax.category,gx.category) in('Costo','Gasto') then rx.credit_amount-rx.debit_amount else 0 end) from gl_impact rx join chart_accounts ax using(account_id) join account_group gx on gx.group_id=ax.account_group_id where rx.subsidiary_id=any(sids) and rx.posting_date between date_from and date_to and (book_id is null or rx.accounting_book_id=book_id)),0))) into result from filtered;
 end if;
 return coalesce(result,jsonb_build_object('rows','[]'::jsonb,'total',0,'page',page_no,'pageSize',page_size,'summary','{}'::jsonb));
end$$;

grant execute on function public.accounting_report_options() to authenticated;
grant execute on function public.run_accounting_report(text,jsonb) to authenticated;
