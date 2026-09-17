create or replace function public.run_income_statement_matrix(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
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
end$$;
revoke all on function public.run_income_statement_matrix(jsonb)from public,anon;
grant execute on function public.run_income_statement_matrix(jsonb)to authenticated;
notify pgrst,'reload schema';
