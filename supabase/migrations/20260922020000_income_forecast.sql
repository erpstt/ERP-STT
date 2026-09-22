-- Forecasts are reporting scenarios, never accounting entries or budget changes.
alter table public.journal add column if not exists is_year_end_closing boolean not null default false;
comment on column public.journal.is_year_end_closing is 'Identifies an annual closing journal for analytical reports; does not change posting behavior.';
create table public.income_forecast_scenarios(
 id bigint generated always as identity primary key,owner_id bigint not null references users,
 subsidiary_id bigint not null references subsidiaries,name text not null check(length(trim(name))between 1 and 100),
 configuration jsonb not null,revision integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
alter table income_forecast_scenarios enable row level security;
revoke all on income_forecast_scenarios from public,anon,authenticated;

create function income_forecast_access(p_sids bigint[])returns void language plpgsql stable security definer set search_path=public,pg_temp as $$begin
 if app_user_id()is null or cardinality(p_sids)=0 or exists(select 1 from unnest(p_sids)sid where sid is null or not exists(select 1 from user_subsidiaries u where u.user_id=app_user_id()and u.subsidiary_id=sid))then raise exception 'No tiene acceso a las subsidiarias seleccionadas.';end if;
end$$;

create function income_forecast_options()returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$begin
 perform income_forecast_access(array[active_subsidiary_id()]);
 return accounting_report_options()||income_statement_dimension_links()||jsonb_build_object(
 'activeSubsidiaryId',active_subsidiary_id(),
 'years',coalesce((select jsonb_agg(jsonb_build_object('id',fiscal_year_id,'name',year_name,'start',start_date,'end',end_date)order by start_date desc)from fiscal_years),'[]'),
 'scenarios',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'revision',revision,'configuration',configuration)order by updated_at desc)from income_forecast_scenarios where owner_id=app_user_id()and subsidiary_id=active_subsidiary_id()),'[]'));
end$$;

create function income_forecast_source(p jsonb)returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sids bigint[];fy fiscal_years%rowtype;cutoff date;first_prior date;result jsonb;book bigint:=nullif(p->>'bookId','')::bigint;cnt int;
begin
 select array_agg(distinct value::bigint)into sids from jsonb_array_elements_text(coalesce(p->'subsidiaryIds','[]'));
 perform income_forecast_access(coalesce(sids,array[]::bigint[]));
 select * into fy from fiscal_years where fiscal_year_id=(p->>'fiscalYearId')::bigint;
 if fy.fiscal_year_id is null or fy.start_date<>date_trunc('month',fy.start_date)::date or fy.end_date<>(fy.start_date+interval '12 months'-interval '1 day')::date then raise exception 'Seleccione un ejercicio fiscal de doce meses completos.';end if;
 cutoff:=(p->>'cutoff')::date;
 if cutoff is null or cutoff<fy.start_date or cutoff>fy.end_date or cutoff<>(date_trunc('month',cutoff)+interval '1 month'-interval '1 day')::date then raise exception 'El corte real debe ser el último día de un mes del ejercicio.';end if;
 if book is not null and(cardinality(sids)<>1 or not exists(select 1 from accounting_books where accounting_book_id=book and subsidiary_id=sids[1]and is_active))then raise exception 'Seleccione un libro de la subsidiaria; en consolidado se usa el principal de cada sociedad.';end if;
 if nullif(p->>'projectId','')is not null and nullif(p->>'costCenterId','')is not null and p->>'projectId'<>p->>'costCenterId'then raise exception 'Proyecto utiliza el catálogo de centros de costo; seleccione el mismo registro.';end if;
 first_prior:=(fy.start_date-interval '1 year')::date;
 if coalesce((p->>'consolidated')::boolean,false)then
  perform income_forecast_access(array[(p->>'holdingId')::bigint]);
  if exists(select 1 from consolidation_runs r join consolidation_worksheet w on w.run_id=r.id where r.holding_subsidiary_id=(p->>'holdingId')::bigint and r.status='PUBLICADO'and r.period between to_char(case when p->>'method'='PRIOR_YEAR'then first_prior else fy.start_date end,'YYYY-MM')and to_char(cutoff,'YYYY-MM')and not(w.subsidiary_id=any(sids)))then raise exception 'Para consolidar seleccione todas las sociedades incluidas en las hojas publicadas de la holding.';end if;
 end if;
 with g as(
  select x.subsidiary_id,x.transaction_id,x.account_id,date_trunc('month',x.posting_date)::date as "month",sum(x.debit_amount)d,sum(x.credit_amount)c
  from gl_impact x join accounting_books b using(accounting_book_id)join chart_accounts a on a.account_id=x.account_id left join account_group ag on ag.group_id=a.account_group_id
  where x.subsidiary_id=any(sids)and x.posting_date between first_prior and cutoff and coalesce(a.category,ag.category)in('Ingreso','Costo','Gasto')and b.is_active
   and(case when book is null then b.is_primary else b.accounting_book_id=book end)
   and(not coalesce((p->>'excludeClosing')::boolean,true)or not exists(select 1 from journal j left join "transaction" t on t.transaction_id=j.transaction_id left join transaction_types tt using(transaction_type_id)where j.transaction_id=x.transaction_id and(j.is_year_end_closing or upper(coalesce(tt.code,''))in('CIERRE','ASI_CIE','CIERRE_ANUAL')or lower(coalesce(tt.name,''))like '%cierre%ejercicio%')))
  group by 1,2,3,4
 ),dims as(
  select j.transaction_id,l.account_id,l.department_id,l.location_id,l.class_id,l.cost_center_id,sum(l.debit*j.exchange_rate)d,sum(l.credit*j.exchange_rate)c
  from journal_line l join journal j using(journal_id)where j.subsidiary_id=any(sids)and j.status='CONTABILIZADO'and exists(select 1 from g where g.transaction_id=j.transaction_id and g.account_id=l.account_id)group by 1,2,3,4,5,6
 ),totals as(select transaction_id,account_id,sum(d)d,sum(c)c from dims group by 1,2),allocated as(
  select g.subsidiary_id,g.account_id,g.month,dim.department_id,dim.location_id,dim.class_id,dim.cost_center_id,
   case when t.d>0 then g.d*dim.d/t.d else 0 end-case when t.c>0 then g.c*dim.c/t.c else 0 end amount
  from g join totals t using(transaction_id,account_id)join dims dim using(transaction_id,account_id)
  union all select g.subsidiary_id,g.account_id,g.month,null,null,null,null,case when coalesce(t.d,0)=0 then g.d else 0 end-case when coalesce(t.c,0)=0 then g.c else 0 end from g left join totals t using(transaction_id,account_id)
 ),filtered as(
  select x.* from allocated x left join departments d using(department_id)
  where(nullif(p->>'departmentType','')is null or lower(d.type)=lower(p->>'departmentType'))
   and(nullif(p->>'departmentId','')is null or x.department_id=(p->>'departmentId')::bigint)
   and(nullif(p->>'locationId','')is null or x.location_id=(p->>'locationId')::bigint)
   and(nullif(p->>'classId','')is null or x.class_id=(p->>'classId')::bigint)
   and(coalesce(nullif(p->>'costCenterId',''),nullif(p->>'projectId',''))is null or x.cost_center_id=coalesce(nullif(p->>'costCenterId',''),nullif(p->>'projectId',''))::bigint)
 ),facts as(
  select subsidiary_id,account_id,month,department_id,location_id,class_id,cost_center_id,sum(amount)amount from filtered group by 1,2,3,4,5,6,7 having sum(amount)<>0
 )select jsonb_build_object('facts',coalesce(jsonb_agg(to_jsonb(facts)),'[]'),'count',count(*))into result from facts;
 if(result->>'count')::int>100000 then raise exception 'La selección supera 100.000 combinaciones mensuales. Reduzca el alcance.';end if;
 result:=result||jsonb_build_object('start',fy.start_date,'end',fy.end_date,'cutoff',cutoff,
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name,'category',coalesce(a.category,ag.category),'groupId',a.account_group_id))from chart_accounts a left join account_group ag on ag.group_id=a.account_group_id where coalesce(a.category,ag.category)in('Ingreso','Costo','Gasto')),'[]'),
 'groups',coalesce((select jsonb_agg(jsonb_build_object('id',group_id,'parentId',parent_id,'name',group_name,'code',group_code,'level',level))from account_group),'[]'),
 'currencies',(select jsonb_agg(jsonb_build_object('id',currency_id,'code',currency_code))from currencies),
 'companies',(select jsonb_agg(jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id,'currency',c.currency_code))from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=any(sids)),
 'budgets',coalesce((select jsonb_agg(jsonb_build_object('subsidiary_id',h.id_subsidiaria,'account_id',l.id_cuenta_contable,'month',l.periodo_mes,'amount',l.monto_presupuestado+l.monto_modificaciones,'version',h.nombre_version))from presupuestos_encabezado h join presupuestos_lineas l on l.id_presupuesto_encabezado=h.id where h.id_subsidiaria=any(sids)and h.estado='APROBADO'and l.periodo_mes between fy.start_date and fy.end_date),'[]'),
 'approvedBudgets',coalesce((select jsonb_agg(jsonb_build_object('sid',id_subsidiaria,'year',anio,'name',nombre_version))from presupuestos_encabezado where id_subsidiaria=any(sids)and estado='APROBADO'),'[]'),
 'rates',coalesce((select jsonb_agg(jsonb_build_object('from',from_currency_id,'to',to_currency_id,'date',effective_date,'rate',spot_rate))from exchange_rates where effective_date<=cutoff),'[]'),
 'consolidatedRates',coalesce((select jsonb_agg(jsonb_build_object('sid',source_subsidiary_id,'holding',holding_subsidiary_id,'to',to_currency_id,'month',period,'rate',average_rate))from consolidated_exchange_rates where source_subsidiary_id=any(sids)and period between to_char(first_prior,'YYYY-MM')and to_char(cutoff,'YYYY-MM')),'[]'));
 if coalesce((p->>'consolidated')::boolean,false)then
 result:=result||jsonb_build_object(
 'consolidationMonths',coalesce((select jsonb_agg(r.period)from consolidation_runs r join currencies c on c.currency_id=r.presentation_currency_id where r.holding_subsidiary_id=(p->>'holdingId')::bigint and r.status='PUBLICADO'and c.currency_code='USD'),'[]'),
 'eliminations',coalesce((select jsonb_agg(jsonb_build_object('month',r.period,'account_id',a.account_id,'amount',case when e.debit_account_id=a.account_id then e.amount else 0 end-case when e.credit_account_id=a.account_id then e.amount else 0 end))from consolidation_runs r join consolidation_eliminations e on e.run_id=r.id join chart_accounts a on a.account_id in(e.debit_account_id,e.credit_account_id)join currencies c on c.currency_id=r.presentation_currency_id where r.holding_subsidiary_id=(p->>'holdingId')::bigint and r.status='PUBLICADO'and c.currency_code='USD'and r.period between to_char(case when p->>'method'='PRIOR_YEAR'then first_prior else fy.start_date end,'YYYY-MM')and to_char(cutoff,'YYYY-MM')and a.category in('Ingreso','Costo','Gasto')),'[]'));
 end if;
 return result;
end$$;

create function income_forecast_save(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();sids bigint[];r income_forecast_scenarios%rowtype;begin
 select array_agg(value::bigint)into sids from jsonb_array_elements_text(p->'configuration'->'subsidiaryIds');perform income_forecast_access(coalesce(sids,array[]::bigint[]));perform income_forecast_access(array[sid]);
 if length(coalesce(p->>'name',''))not between 1 and 100 or pg_column_size(p)>2000000 then raise exception 'Nombre o tamaño del escenario inválido.';end if;
 if p->>'id'is null then insert into income_forecast_scenarios(owner_id,subsidiary_id,name,configuration)values(app_user_id(),sid,trim(p->>'name'),p->'configuration')returning * into r;
 else update income_forecast_scenarios set name=trim(p->>'name'),configuration=p->'configuration',revision=revision+1,updated_at=now()where id=(p->>'id')::bigint and owner_id=app_user_id()and subsidiary_id=sid and revision=(p->>'revision')::int returning * into r;
 if r.id is null then raise exception 'El escenario cambió o no pertenece al usuario y sociedad activos.';end if;end if;return to_jsonb(r);
end$$;
revoke all on function income_forecast_access(bigint[]),income_forecast_options(),income_forecast_source(jsonb),income_forecast_save(jsonb)from public,anon,authenticated;
grant execute on function income_forecast_options(),income_forecast_source(jsonb),income_forecast_save(jsonb)to authenticated;
notify pgrst,'reload schema';
