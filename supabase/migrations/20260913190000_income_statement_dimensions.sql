create index if not exists journal_line_income_dimensions_idx on public.journal_line(journal_id,account_id,department_id,class_id,location_id,cost_center_id);

create or replace function public.run_income_statement_matrix(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
 sids bigint[];date_from date;date_to date;book_id bigint;column_view text;department_type text;exclude_zero boolean;
 filter_department bigint;filter_class bigint;filter_location bigint;filter_cost bigint;result jsonb;
begin
 select coalesce(array_agg(value::bigint),array[]::bigint[])into sids from jsonb_array_elements_text(coalesce(p_filters->'subsidiaryIds','[]'::jsonb));
 if cardinality(sids)=0 then sids:=array[active_subsidiary_id()];end if;
 if sids[1] is null or exists(select 1 from unnest(sids)x where not exists(select 1 from user_subsidiaries u where u.user_id=app_user_id() and u.subsidiary_id=x))then raise exception 'No tiene acceso a una o más subsidiarias seleccionadas.';end if;
 date_from:=coalesce(nullif(p_filters->>'dateFrom','')::date,date_trunc('year',current_date)::date);date_to:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
 if date_from>date_to then raise exception 'La fecha inicial no puede ser posterior a la fecha final.';end if;
 book_id:=nullif(p_filters->>'bookId','')::bigint;column_view:=upper(coalesce(nullif(p_filters->>'columnView',''),'TOTAL'));department_type:=nullif(p_filters->>'departmentType','');exclude_zero:=coalesce((p_filters->>'excludeZero')::boolean,true);
 if column_view not in('DEPARTMENT','CLASS','LOCATION','COST_CENTER')then raise exception 'Seleccione una columna válida para el desglose.';end if;
 filter_department:=nullif(p_filters->>'departmentId','')::bigint;filter_class:=nullif(p_filters->>'classId','')::bigint;filter_location:=nullif(p_filters->>'locationId','')::bigint;filter_cost:=nullif(p_filters->>'costCenterId','')::bigint;
 with movement as(
  select a.account_id,a.account_number,a.account_name,a.account_group_id group_id,coalesce(a.category,ag.category)category,
   case column_view when'DEPARTMENT'then jl.department_id when'CLASS'then jl.class_id when'LOCATION'then jl.location_id else jl.cost_center_id end dimension_id,
   sum(jl.debit*j.exchange_rate)debit,sum(jl.credit*j.exchange_rate)credit,
   sum(case when coalesce(a.category,ag.category)='Ingreso'then(jl.credit-jl.debit)*j.exchange_rate else(jl.debit-jl.credit)*j.exchange_rate end)amount
  from journal_line jl join journal j using(journal_id) join chart_accounts a using(account_id) join account_group ag on ag.group_id=a.account_group_id
  left join lateral(select accounting_book_id from accounting_books b where b.subsidiary_id=j.subsidiary_id and b.is_primary and b.is_active order by b.accounting_book_id limit 1)primary_book on true
  where j.subsidiary_id=any(sids) and j.journal_date between date_from and date_to and j.status='CONTABILIZADO' and coalesce(a.category,ag.category)in('Ingreso','Costo','Gasto')
   and(book_id is null or primary_book.accounting_book_id=book_id)
   and(filter_department is null or jl.department_id=filter_department)and(filter_class is null or jl.class_id=filter_class)and(filter_location is null or jl.location_id=filter_location)and(filter_cost is null or jl.cost_center_id=filter_cost)
   and(department_type is null or exists(select 1 from departments selected_department where selected_department.department_id=jl.department_id and lower(selected_department.type)=lower(department_type)))
  group by a.account_id,a.account_number,a.account_name,a.account_group_id,a.category,ag.category,dimension_id
 ),dimension_catalog as(
  select distinct m.dimension_id id,
   coalesce(case column_view when'DEPARTMENT'then d.name when'CLASS'then c.name when'LOCATION'then l.name else coalesce(nullif(cc.code,'')||' · ','')||cc.name end,'Dimensión '||m.dimension_id::text)name
  from movement m
  left join departments d on column_view='DEPARTMENT'and d.department_id=m.dimension_id
  left join classes c on column_view='CLASS'and c.class_id=m.dimension_id
  left join locations l on column_view='LOCATION'and l.location_id=m.dimension_id
  left join cost_centers cc on column_view='COST_CENTER'and cc.cost_center_id=m.dimension_id
  where m.dimension_id is not null and abs(m.amount)>=0.000001
 ),account_rows as(
  select account_id,account_number,account_name,group_id,category,sum(debit)debit,sum(credit)credit,sum(amount)amount,
   jsonb_object_agg(coalesce(dimension_id::text,'unassigned'),amount order by coalesce(dimension_id::text,'unassigned'))dimensions
  from movement group by account_id,account_number,account_name,group_id,category
 ),eligible as(select * from account_rows where not exclude_zero or abs(amount)>=0.000001)
 select jsonb_build_object(
  'columns',coalesce((select jsonb_agg(jsonb_build_object('id',id::text,'name',name)order by name)from dimension_catalog),'[]'::jsonb),
  'rows',coalesce((select jsonb_agg(to_jsonb(e)order by case category when'Ingreso'then 1 when'Costo'then 2 else 3 end,account_number)from eligible e),'[]'::jsonb),
  'total',(select count(*)from eligible),'page',1,'pageSize',500,
  'summary',jsonb_build_object('periodResult',coalesce((select sum(case when category='Ingreso'then amount else-amount end)from eligible),0),'columnView',column_view,'source','MAYOR_GENERAL_CONTABILIZADO')
 )into result;
 return result;
end$$;

revoke all on function public.run_income_statement_matrix(jsonb) from public,anon;
grant execute on function public.run_income_statement_matrix(jsonb) to authenticated;

create or replace function public.income_statement_dimension_links()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
with allowed as(select subsidiary_id from user_subsidiaries where user_id=app_user_id())
select jsonb_build_object(
 'reportDepartments',coalesce((select jsonb_agg(jsonb_build_object('id',d.department_id,'name',d.name,'displayName',d.name||case when d.is_inactive then' (Inactivo · con movimientos)'else''end,'type',d.type,'subsidiaryId',ds.subsidiary_id,'isInactive',d.is_inactive)order by d.name)from departments d join department_subsidiaries ds using(department_id)join allowed a on a.subsidiary_id=ds.subsidiary_id where not d.is_inactive or exists(select 1 from journal_line jl join journal j using(journal_id)where jl.department_id=d.department_id and j.subsidiary_id=ds.subsidiary_id)),'[]'::jsonb),
 'reportClasses',coalesce((select jsonb_agg(jsonb_build_object('id',c.class_id,'name',c.name,'displayName',c.name||case when c.is_inactive then' (Inactiva · con movimientos)'else''end,'subsidiaryId',cs.subsidiary_id,'isInactive',c.is_inactive,'departmentIds',coalesce((select jsonb_agg(distinct links.department_id)from(select jl.department_id from journal_line jl join journal j using(journal_id)where jl.class_id=c.class_id and jl.department_id is not null and j.subsidiary_id=cs.subsidiary_id union select cu.department_id from cost_centers cc join customers cu using(customer_id)where cc.class_id=c.class_id and cc.subsidiary_id=cs.subsidiary_id and cu.department_id is not null)links),'[]'::jsonb))order by c.name)from classes c join class_subsidiaries cs using(class_id)join allowed a on a.subsidiary_id=cs.subsidiary_id where not c.is_inactive or exists(select 1 from journal_line jl join journal j using(journal_id)where jl.class_id=c.class_id and j.subsidiary_id=cs.subsidiary_id)),'[]'::jsonb),
 'reportCostCenters',coalesce((select jsonb_agg(jsonb_build_object('id',cc.cost_center_id,'name',cc.name,'displayName',cc.name||case when cc.is_inactive then' (Inactivo · con movimientos)'else''end,'code',cc.code,'subsidiaryId',cc.subsidiary_id,'departmentId',cu.department_id,'classId',cc.class_id,'isInactive',cc.is_inactive)order by cc.name)from cost_centers cc join allowed a using(subsidiary_id)left join customers cu using(customer_id)where not cc.is_inactive or exists(select 1 from journal_line jl join journal j using(journal_id)where jl.cost_center_id=cc.cost_center_id and j.subsidiary_id=cc.subsidiary_id)),'[]'::jsonb)
)
$$;

revoke all on function public.income_statement_dimension_links() from public,anon;
grant execute on function public.income_statement_dimension_links() to authenticated;
notify pgrst,'reload schema';
