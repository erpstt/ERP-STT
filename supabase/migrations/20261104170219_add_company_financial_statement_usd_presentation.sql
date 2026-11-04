-- Read-only presentation of one company's financial statements in USD.
-- Existing report calculations, balances, journals and consolidation runs are untouched.
set local lock_timeout='5s';
set local statement_timeout='60s';

create function report_delivery_private.financial_statement_rate(p_sid bigint,p_period text,p_category text)
returns jsonb language plpgsql stable set search_path=pg_catalog,public,pg_temp as $rate$
declare source_id bigint;target_id bigint;source_code text;holding_id bigint;kind text;v numeric;rid bigint;n int;
begin
 select s.currency_id,c.currency_code into source_id,source_code from public.subsidiaries s join public.currencies c using(currency_id)where s.subsidiary_id=p_sid;
 select currency_id into target_id from public.currencies where currency_code='USD';
 if source_id is null or target_id is null then raise exception 'Configure la moneda funcional y USD para presentar el estado financiero.';end if;
 kind:=case when p_category in('Activo','Pasivo')then'CIERRE'when p_category in('Ingreso','Costo','Gasto')then'PROMEDIO'when p_category in('Patrimonio','Capital','Reserva')then'HISTORICA'else null end;
 if kind is null or p_period!~'^[0-9]{4}-(0[1-9]|1[0-2])$'then raise exception 'Categoría o período de conversión inválido.';end if;
 if source_id=target_id then kind:='IDENTIDAD';v:=1;
 else
  holding_id:=public.consolidation_holding_subsidiary_id();
  select count(*),min(r.rate_id),min(case kind when'CIERRE'then r.closing_rate when'PROMEDIO'then r.average_rate else r.historical_rate end)
   into n,rid,v from public.consolidated_exchange_rates r
   where r.holding_subsidiary_id=holding_id and r.source_subsidiary_id=p_sid and r.period=p_period and r.from_currency_id=source_id and r.to_currency_id=target_id;
  if n<>1 or v is null or v<=0 or v::text in('NaN','Infinity','-Infinity')then
   raise exception 'Falta una tasa % válida y única de % a USD para el período % de la empresa seleccionada.',kind,source_code,p_period;
  end if;
 end if;
 return jsonb_build_object('period',p_period,'rateType',kind,'rate',v,'rateId',rid,'sourceSubsidiaryId',p_sid,'sourceCurrencyCode',source_code,'targetCurrencyCode','USD');
end$rate$;

create function report_delivery_private.run_financial_statement_presentation(p_report text,p_filters jsonb,p_owner bigint)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $statement$
declare
 sids bigint[];sid bigint;book_id bigint;date_from date;date_to date;year_start date;column_view text;exclude_zero boolean;
 filter_department bigint;filter_location bigint;filter_class bigint;filter_cost bigint;filter_account bigint;department_type text;
 page_no int;page_size int;offset_no int;source_code text;rec jsonb;rate_data jsonb;rates jsonb:='{}';cache_key text;v numeric;
 source_rows jsonb:='[]';converted_rows jsonb:='[]';profit_rows jsonb:='[]';rows jsonb:='[]';columns jsonb:='[]';summary jsonb;result jsonb;
 local_formal numeric:=0;formal_result numeric:=0;local_current numeric:=0;current_result numeric:=0;local_period numeric:=0;period_result numeric:=0;
 local_exercise numeric:=0;exercise_result numeric:=0;local_difference numeric:=0;usd_difference numeric:=0;translation_adjustment numeric:=0;closing_rate numeric:=0;
begin
 if p_report is null or p_report not in('balance-sheet','income-statement')or jsonb_typeof(p_filters)is distinct from'object'
  or upper(coalesce(p_filters->>'presentationCurrency',''))<>'USD'then raise exception 'Presentación financiera inválida.';end if;
 if coalesce((p_filters->>'consolidated')::boolean,false)then raise exception 'La presentación USD corresponde a una sola empresa, sin consolidación.';end if;
 select coalesce(array_agg(value::bigint),array[]::bigint[])into sids from jsonb_array_elements_text(coalesce(p_filters->'subsidiaryIds','[]'));
 if cardinality(sids)=0 then sids:=array[public.active_subsidiary_id()];end if;
 if cardinality(sids)<>1 or sids[1]is null or p_owner is null
  or not exists(select 1 from public.users where user_id=p_owner and is_active)
  or not exists(select 1 from public.user_subsidiaries where user_id=p_owner and subsidiary_id=sids[1])then
  raise exception using errcode='42501',message='Seleccione una única empresa autorizada para presentar el estado financiero.';
 end if;
 sid:=sids[1];
 select c.currency_code into source_code from public.subsidiaries s join public.currencies c using(currency_id)where s.subsidiary_id=sid;
 if source_code is null then raise exception 'Configure la moneda funcional de la empresa seleccionada.';end if;
 date_from:=coalesce(nullif(p_filters->>'dateFrom','')::date,date_trunc('year',current_date)::date);date_to:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);year_start:=date_trunc('year',date_to)::date;
 if date_from>date_to then
  -- Balance is a cutoff report: its hidden From control may retain a later
  -- date when the user moves the cutoff into an earlier accounting year.
  if p_report='balance-sheet'then date_from:=year_start;
  else raise exception 'La fecha inicial no puede ser posterior a la fecha final.';end if;
 end if;
 book_id:=nullif(p_filters->>'bookId','')::bigint;column_view:=upper(coalesce(nullif(p_filters->>'columnView',''),'TOTAL'));
 if p_report='balance-sheet'then column_view:='TOTAL';end if;
 if column_view not in('TOTAL','DEPARTMENT','CLASS','LOCATION','COST_CENTER','ACCOUNTING_PERIOD')then raise exception 'Seleccione una columna válida para el desglose.';end if;
 exclude_zero:=coalesce((p_filters->>'excludeZero')::boolean,true);department_type:=nullif(p_filters->>'departmentType','');
 filter_department:=nullif(p_filters->>'departmentId','')::bigint;filter_location:=nullif(p_filters->>'locationId','')::bigint;filter_class:=nullif(p_filters->>'classId','')::bigint;filter_cost:=nullif(p_filters->>'costCenterId','')::bigint;filter_account:=nullif(p_filters->>'accountId','')::bigint;
 page_no:=greatest(coalesce((p_filters->>'page')::int,1),1);page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),500);offset_no:=(page_no-1)*page_size;

 if p_report='income-statement'then
  if column_view='TOTAL'then
   -- Same authoritative local GL amounts and dimension predicates as the existing TOTAL report.
   select coalesce(jsonb_agg(to_jsonb(m)),'[]')into source_rows from(
    select a.account_id,a.account_number,a.account_name,a.account_group_id group_id,coalesce(a.category,ag.category)category,
     to_char(g.posting_date,'YYYY-MM')period,'total'::text dimension_id,sum(g.debit_amount)debit,sum(g.credit_amount)credit
    from public.gl_impact g join public.chart_accounts a using(account_id)join public.account_group ag on ag.group_id=a.account_group_id
    where g.subsidiary_id=sid and g.posting_date between date_from and date_to and coalesce(a.category,ag.category)in('Ingreso','Costo','Gasto')
     and(book_id is null or g.accounting_book_id=book_id)and(filter_account is null or g.account_id=filter_account)
     and(filter_department is null or exists(select 1 from public.journal jx join public.journal_line lx using(journal_id)where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.department_id=filter_department))
     and(filter_location is null or exists(select 1 from public.journal jx join public.journal_line lx using(journal_id)where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.location_id=filter_location))
     and(filter_class is null or exists(select 1 from public.journal jx join public.journal_line lx using(journal_id)where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.class_id=filter_class))
     and(filter_cost is null or exists(select 1 from public.journal jx join public.journal_line lx using(journal_id)where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.cost_center_id=filter_cost))
    group by a.account_id,a.account_number,a.account_name,a.account_group_id,a.category,ag.category,to_char(g.posting_date,'YYYY-MM')
   )m;
  else
   -- Keep the existing matrix's local calculation, posted-journal scope and primary-book convention.
   select coalesce(jsonb_agg(to_jsonb(m)),'[]')into source_rows from(
    select a.account_id,a.account_number,a.account_name,a.account_group_id group_id,coalesce(a.category,ag.category)category,to_char(j.journal_date,'YYYY-MM')period,
     case column_view when'DEPARTMENT'then jl.department_id::text when'CLASS'then jl.class_id::text when'LOCATION'then jl.location_id::text when'COST_CENTER'then jl.cost_center_id::text else to_char(j.journal_date,'YYYY-MM')end dimension_id,
     sum(jl.debit*j.exchange_rate)debit,sum(jl.credit*j.exchange_rate)credit
    from public.journal_line jl join public.journal j using(journal_id)join public.chart_accounts a using(account_id)join public.account_group ag on ag.group_id=a.account_group_id
    left join lateral(select b.accounting_book_id from public.accounting_books b where b.subsidiary_id=j.subsidiary_id and b.is_primary and b.is_active order by b.accounting_book_id limit 1)primary_book on true
    where j.subsidiary_id=sid and j.journal_date between date_from and date_to and j.status='CONTABILIZADO'and coalesce(a.category,ag.category)in('Ingreso','Costo','Gasto')
     and(book_id is null or primary_book.accounting_book_id=book_id)
     and(filter_department is null or jl.department_id=filter_department)and(filter_class is null or jl.class_id=filter_class)and(filter_location is null or jl.location_id=filter_location)and(filter_cost is null or jl.cost_center_id=filter_cost)
     and(department_type is null or exists(select 1 from public.departments d where d.department_id=jl.department_id and lower(d.type)=lower(department_type)))
    group by a.account_id,a.account_number,a.account_name,a.account_group_id,a.category,ag.category,to_char(j.journal_date,'YYYY-MM'),dimension_id
   )m;
  end if;
  -- Resolve each period/category once; convert the full movement set with one
  -- aggregate instead of repeatedly copying an ever-growing JSON array.
  for rec in select distinct jsonb_build_object('period',value->>'period','category',value->>'category')from jsonb_array_elements(source_rows)
   where coalesce((value->>'debit')::numeric,0)<>0 or coalesce((value->>'credit')::numeric,0)<>0 loop
   cache_key:=(rec->>'period')||'|'||(rec->>'category');rate_data:=report_delivery_private.financial_statement_rate(sid,rec->>'period',rec->>'category');rates:=rates||jsonb_build_object(cache_key,rate_data);
  end loop;
  select coalesce(jsonb_agg(value||jsonb_build_object('debit',case when coalesce((value->>'debit')::numeric,0)=0 then 0 else(value->>'debit')::numeric*(rates->((value->>'period')||'|'||(value->>'category'))->>'rate')::numeric end,'credit',case when coalesce((value->>'credit')::numeric,0)=0 then 0 else(value->>'credit')::numeric*(rates->((value->>'period')||'|'||(value->>'category'))->>'rate')::numeric end)),'[]')into converted_rows from jsonb_array_elements(source_rows);
  with movement as(
   select account_id,account_number,account_name,group_id,category,coalesce(dimension_id,'unassigned')dimension_id,
    sum(debit)debit,sum(credit)credit,sum(case when category='Ingreso'then credit-debit else debit-credit end)amount
   from jsonb_to_recordset(converted_rows)as x(account_id bigint,account_number text,account_name text,group_id bigint,category text,dimension_id text,debit numeric,credit numeric)
   group by account_id,account_number,account_name,group_id,category,dimension_id
  ),account_rows as(
   select account_id,account_number,account_name,group_id,category,0::numeric opening,sum(debit)debit,sum(credit)credit,sum(debit-credit)closing,sum(amount)amount,
    jsonb_object_agg(dimension_id,amount order by dimension_id)dimensions
   from movement group by account_id,account_number,account_name,group_id,category
  )select coalesce(jsonb_agg(to_jsonb(a)order by case category when'Ingreso'then 1 when'Costo'then 2 else 3 end,account_number),'[]')into rows from account_rows a where not exclude_zero or amount<>0;
  if column_view<>'TOTAL'then
   if column_view='ACCOUNTING_PERIOD'then
    select coalesce(jsonb_agg(jsonb_build_object('id',to_char(m,'YYYY-MM'),'name',case extract(month from m)::int when 1 then'Enero'when 2 then'Febrero'when 3 then'Marzo'when 4 then'Abril'when 5 then'Mayo'when 6 then'Junio'when 7 then'Julio'when 8 then'Agosto'when 9 then'Septiembre'when 10 then'Octubre'when 11 then'Noviembre'else'Diciembre'end||' '||to_char(m,'YYYY'))order by m),'[]')into columns
    from generate_series(date_trunc('month',date_from),date_trunc('month',date_to),interval'1 month')m;
   else
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name)order by name),'[]')into columns from(
     select distinct x.dimension_id id,coalesce(case column_view when'DEPARTMENT'then d.name when'CLASS'then c.name when'LOCATION'then l.name else coalesce(nullif(cc.code,'')||' · ','')||cc.name end,'Dimensión '||x.dimension_id)name
     from jsonb_to_recordset(converted_rows)as x(dimension_id text,debit numeric,credit numeric)
     left join public.departments d on column_view='DEPARTMENT'and d.department_id::text=x.dimension_id
     left join public.classes c on column_view='CLASS'and c.class_id::text=x.dimension_id
     left join public.locations l on column_view='LOCATION'and l.location_id::text=x.dimension_id
     left join public.cost_centers cc on column_view='COST_CENTER'and cc.cost_center_id::text=x.dimension_id
     where x.dimension_id is not null and x.debit<>x.credit
    )catalog;
   end if;
  end if;
  select coalesce(sum((value->>'credit')::numeric-(value->>'debit')::numeric),0)into period_result from jsonb_array_elements(rows);
  summary:=jsonb_build_object('periodResult',period_result,'columnView',column_view,'source','MAYOR_GENERAL_CONTABILIZADO');
 else
  select coalesce(jsonb_agg(to_jsonb(b)),'[]')into source_rows from(
   select a.account_id,a.account_number,a.account_name,a.account_group_id group_id,a.cash_flow_activity,coalesce(a.category,ag.category,'Sin clasificar')category,coalesce(a.nature,ag.nature,'Deudora')nature,s.name subsidiary,
    sum(case when g.posting_date<date_from then g.debit_amount-g.credit_amount else 0 end)opening,
    sum(case when g.posting_date between date_from and date_to then g.debit_amount else 0 end)debit,
    sum(case when g.posting_date between date_from and date_to then g.credit_amount else 0 end)credit,
    sum(case when g.posting_date<=date_to then g.debit_amount-g.credit_amount else 0 end)closing
   from public.gl_impact g join public.chart_accounts a using(account_id)join public.account_group ag on ag.group_id=a.account_group_id join public.subsidiaries s using(subsidiary_id)
   where g.subsidiary_id=sid and coalesce(a.category,ag.category)in('Activo','Pasivo','Patrimonio')and(book_id is null or g.accounting_book_id=book_id)and(filter_account is null or g.account_id=filter_account)
    and(filter_department is null or exists(select 1 from public.journal jx join public.journal_line lx using(journal_id)where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.department_id=filter_department))
    and(filter_location is null or exists(select 1 from public.journal jx join public.journal_line lx using(journal_id)where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.location_id=filter_location))
    and(filter_class is null or exists(select 1 from public.journal jx join public.journal_line lx using(journal_id)where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.class_id=filter_class))
    and(filter_cost is null or exists(select 1 from public.journal jx join public.journal_line lx using(journal_id)where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.cost_center_id=filter_cost))
   group by a.account_id,a.account_number,a.account_name,a.account_group_id,a.cash_flow_activity,a.category,ag.category,a.nature,ag.nature,s.name
  )b where not exclude_zero or opening<>0 or debit<>0 or credit<>0 or closing<>0;
  for rec in select distinct jsonb_build_object('category',value->>'category')from jsonb_array_elements(source_rows)
   where(value->>'opening')::numeric<>0 or(value->>'debit')::numeric<>0 or(value->>'credit')::numeric<>0 or(value->>'closing')::numeric<>0 loop
   cache_key:=to_char(date_to,'YYYY-MM')||'|'||(rec->>'category');rate_data:=report_delivery_private.financial_statement_rate(sid,to_char(date_to,'YYYY-MM'),rec->>'category');rates:=rates||jsonb_build_object(cache_key,rate_data);
  end loop;
  select coalesce(jsonb_agg(value||jsonb_build_object('opening',round((value->>'opening')::numeric*coalesce((rates->(to_char(date_to,'YYYY-MM')||'|'||(value->>'category'))->>'rate')::numeric,0),4),'debit',round((value->>'debit')::numeric*coalesce((rates->(to_char(date_to,'YYYY-MM')||'|'||(value->>'category'))->>'rate')::numeric,0),4),'credit',round((value->>'credit')::numeric*coalesce((rates->(to_char(date_to,'YYYY-MM')||'|'||(value->>'category'))->>'rate')::numeric,0),4),'closing',round((value->>'closing')::numeric*coalesce((rates->(to_char(date_to,'YYYY-MM')||'|'||(value->>'category'))->>'rate')::numeric,0),4))),'[]')into converted_rows from jsonb_array_elements(source_rows);
  -- Preserve the existing balance report's result scope (company/book, independently of row filters).
  select coalesce(sum(g.credit_amount-g.debit_amount),0)into local_formal from public.gl_impact g join public.chart_accounts a using(account_id)
   where g.subsidiary_id=sid and g.posting_date<=date_to and(book_id is null or g.accounting_book_id=book_id)and lower(a.account_name)like'%resultado del ejercicio%';
  if local_formal<>0 then
   cache_key:=to_char(date_to,'YYYY-MM')||'|Patrimonio';rate_data:=rates->cache_key;
   if rate_data is null then rate_data:=report_delivery_private.financial_statement_rate(sid,to_char(date_to,'YYYY-MM'),'Patrimonio');rates:=rates||jsonb_build_object(cache_key,rate_data);end if;
   formal_result:=round(local_formal*(rate_data->>'rate')::numeric,4);
  end if;
  select coalesce(jsonb_agg(to_jsonb(p)),'[]')into profit_rows from(
   select to_char(g.posting_date,'YYYY-MM')period,coalesce(a.category,ag.category)category,
    sum(case when g.posting_date>=year_start then g.credit_amount-g.debit_amount else 0 end)current_amount,
    sum(case when g.posting_date>=date_from then g.credit_amount-g.debit_amount else 0 end)period_amount
   from public.gl_impact g join public.chart_accounts a using(account_id)join public.account_group ag on ag.group_id=a.account_group_id
   where g.subsidiary_id=sid and g.posting_date between least(date_from,year_start)and date_to and(book_id is null or g.accounting_book_id=book_id)and coalesce(a.category,ag.category)in('Ingreso','Costo','Gasto')
   group by to_char(g.posting_date,'YYYY-MM'),a.category,ag.category
  )p;
  for rec in select value from jsonb_array_elements(profit_rows)loop
   v:=0;
   if(rec->>'current_amount')::numeric<>0 or(rec->>'period_amount')::numeric<>0 then
    cache_key:=(rec->>'period')||'|'||(rec->>'category');rate_data:=rates->cache_key;
    if rate_data is null then rate_data:=report_delivery_private.financial_statement_rate(sid,rec->>'period',rec->>'category');rates:=rates||jsonb_build_object(cache_key,rate_data);end if;
    v:=(rate_data->>'rate')::numeric;
   end if;
   local_current:=local_current+(rec->>'current_amount')::numeric;local_period:=local_period+(rec->>'period_amount')::numeric;
   current_result:=current_result+(rec->>'current_amount')::numeric*v;period_result:=period_result+(rec->>'period_amount')::numeric*v;
  end loop;
  current_result:=round(current_result,4);period_result:=round(period_result,4);
  local_exercise:=case when abs(local_current)>.005 then local_current else local_formal end;exercise_result:=case when abs(local_current)>.005 then current_result else formal_result end;
  select coalesce(sum((value->>'closing')::numeric),0)-local_exercise into local_difference from jsonb_array_elements(source_rows)where lower(value->>'account_name')not like'%resultado del ejercicio%';
  select coalesce(sum((value->>'closing')::numeric),0)-exercise_result into usd_difference from jsonb_array_elements(converted_rows)where lower(value->>'account_name')not like'%resultado del ejercicio%';
  if local_difference<>0 or usd_difference<>0 then
   cache_key:=to_char(date_to,'YYYY-MM')||'|Activo';rate_data:=rates->cache_key;
   if rate_data is null then rate_data:=report_delivery_private.financial_statement_rate(sid,to_char(date_to,'YYYY-MM'),'Activo');rates:=rates||jsonb_build_object(cache_key,rate_data);end if;
   closing_rate:=(rate_data->>'rate')::numeric;translation_adjustment:=round(usd_difference-local_difference*closing_rate,4);
  end if;
  rows:=converted_rows;
  if translation_adjustment<>0 then rows:=rows||jsonb_build_array(jsonb_build_object('account_id',null,'account_number','','account_name','Diferencia de conversión de presentación','group_id',null,'cash_flow_activity',null,'category','Patrimonio','nature','Acreedora','subsidiary',(select name from public.subsidiaries where subsidiary_id=sid),'opening',0,'debit',0,'credit',0,'closing',-translation_adjustment,'is_presentation_adjustment',true));end if;
  select jsonb_build_object('opening',coalesce(sum((value->>'opening')::numeric),0),'debit',coalesce(sum((value->>'debit')::numeric),0),'credit',coalesce(sum((value->>'credit')::numeric),0),'closing',coalesce(sum((value->>'closing')::numeric),0),'resultExercise',formal_result,'currentPeriodResult',current_result,'periodResult',period_result,'exerciseResult',exercise_result,'translationAdjustment',translation_adjustment,'localBalanceDifference',local_difference,'sourceBalanced',abs(local_difference)<.005,'balanced',abs(usd_difference-translation_adjustment)<.005)into summary from jsonb_array_elements(rows);
 end if;
 if p_report='income-statement'and column_view<>'TOTAL'then
  result:=jsonb_build_object('rows',rows,'columns',columns,'total',jsonb_array_length(rows),'page',1,'pageSize',500,'summary',summary);
 else
  select coalesce(jsonb_agg(value order by ord),'[]')into converted_rows from(
   select value,row_number()over(order by case value->>'category'when'Activo'then 1 when'Pasivo'then 2 when'Patrimonio'then 3 when'Ingreso'then 4 when'Costo'then 5 else 6 end,coalesce((value->>'is_presentation_adjustment')::boolean,false),value->>'account_number')ord
   from jsonb_array_elements(rows)
  )ordered where ord>offset_no and ord<=offset_no+page_size;
  result:=jsonb_build_object('rows',converted_rows,'total',jsonb_array_length(rows),'page',page_no,'pageSize',page_size,'summary',summary);
 end if;
 return result||jsonb_build_object('presentationCurrency','USD','presentationCurrencyCode','USD','localCurrencyCode',source_code,'conversionBasis','CONSOLIDATED_RATES','consolidated',false,'periodMovementOnly',p_report='income-statement','ratesUsed',(select coalesce(jsonb_agg(value order by value->>'period',value->>'rateType',value->>'sourceCurrencyCode'),'[]')from(select distinct value from jsonb_each(rates))r));
end$statement$;

create function public.run_financial_statement_presentation(p_report text,p_filters jsonb default'{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $public$
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
end$public$;

revoke all on function report_delivery_private.financial_statement_rate(bigint,text,text),report_delivery_private.run_financial_statement_presentation(text,jsonb,bigint)from public,anon,authenticated,service_role;
revoke all on function public.run_financial_statement_presentation(text,jsonb)from public,anon,authenticated,service_role;
grant execute on function public.run_financial_statement_presentation(text,jsonb)to authenticated;
notify pgrst,'reload schema';
