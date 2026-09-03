alter table asset add column if not exists description text;
alter table asset add column if not exists serial_number text;
alter table asset add column if not exists exchange_rate numeric(24,10) not null default 1 check(exchange_rate>0);
alter table asset add column if not exists in_service_date date;
alter table asset add column if not exists department_id bigint references departments;
alter table asset add column if not exists cost_center_id bigint references cost_centers;
alter table asset add column if not exists class_id bigint references classes;
alter table asset add column if not exists status text not null default 'ACTIVO' check(status in('ACTIVO','INACTIVO','BAJA'));

create or replace function assign_fixed_asset_number() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare n bigint;
begin
 if nullif(trim(new.asset_number),'') is null or upper(trim(new.asset_number))='AUTO' then
  perform pg_advisory_xact_lock(hashtextextended('fixed-asset-'||new.subsidiary_id,0));
  select coalesce(max(case when asset_number~'^ACT-[0-9]+$' then substring(asset_number from '[0-9]+$')::bigint end),0)+1 into n from asset where subsidiary_id=new.subsidiary_id;
  new.asset_number:='ACT-'||lpad(n::text,6,'0');
 end if;
 if new.in_service_date is null then new.in_service_date:=new.purchase_date;end if;
 return new;
end$$;
drop trigger if exists fixed_asset_auto_number on asset;
create trigger fixed_asset_auto_number before insert on asset for each row execute function assign_fixed_asset_number();

create or replace function fixed_asset_options() returns jsonb language sql stable security definer set search_path=public as $$
select jsonb_build_object(
 'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id),
 'categories',coalesce((select jsonb_agg(jsonb_build_object('id',c.category_id,'code',c.category_code,'name',c.category_name,'life',c.useful_life_months,'method',c.depreciation_method,'residual',c.residual_value_percentage)order by c.category_name)from asset_category c where c.subsidiary_id=s.subsidiary_id and c.is_active),'[]'),
 'locations',coalesce((select jsonb_agg(jsonb_build_object('id',l.location_id,'name',l.name)order by l.name)from locations l left join location_subsidiaries ls using(location_id)where l.subsidiary_id=s.subsidiary_id or ls.subsidiary_id=s.subsidiary_id),'[]'),
 'currencies',coalesce((select jsonb_agg(jsonb_build_object('id',c.currency_id,'code',c.currency_code,'name',c.name)order by c.currency_code)from currencies c join subsidiary_currencies sc using(currency_id)where sc.subsidiary_id=s.subsidiary_id),'[]'),
 'periods',coalesce((select jsonb_agg(jsonb_build_object('id',f.fiscal_period_id,'name',f.period_name,'start',f.start_date,'end',f.end_date,'closed',f.is_closed)order by f.start_date desc)from fiscal_periods f where f.subsidiary_id=s.subsidiary_id),'[]'),
 'departments',coalesce((select jsonb_agg(jsonb_build_object('id',d.department_id,'name',d.name)order by d.name)from departments d where d.subsidiary_id=s.subsidiary_id),'[]'),
 'costs',coalesce((select jsonb_agg(jsonb_build_object('id',c.cost_center_id,'name',c.name,'departmentId',cu.department_id,'classId',c.class_id)order by c.name)from cost_centers c left join customers cu using(customer_id)where c.subsidiary_id=s.subsidiary_id),'[]'),
 'classes',coalesce((select jsonb_agg(jsonb_build_object('id',c.class_id,'name',c.name)order by c.name)from classes c where c.subsidiary_id=s.subsidiary_id),'[]')
)from subsidiaries s where s.subsidiary_id=active_subsidiary_id()$$;

create or replace function fixed_asset_report(p_filters jsonb default '{}') returns jsonb language sql stable security definer set search_path=public as $$
select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',a.asset_id,'number',a.asset_number,'name',a.asset_name,'description',a.description,'serial',a.serial_number,'categoryId',a.category_id,'category',c.category_name,'locationId',a.location_id,'location',l.name,'currencyId',a.currency_id,'currency',cu.currency_code,'purchaseDate',a.purchase_date,'serviceDate',a.in_service_date,'cost',a.purchase_cost,'rate',a.exchange_rate,'departmentId',a.department_id,'costCenterId',a.cost_center_id,'classId',a.class_id,'status',a.status,'accumulated',coalesce(d.accumulated,0),'bookValue',greatest(a.purchase_cost-coalesce(d.accumulated,0),0))order by a.asset_number),'[]'))
from asset a join asset_category c using(category_id)join locations l using(location_id)join currencies cu using(currency_id)left join lateral(select sum(depreciation_amount) accumulated from asset_depreciation where asset_id=a.asset_id)d on true
where a.subsidiary_id=active_subsidiary_id()and(coalesce(p_filters->>'status','ALL')='ALL'or a.status=p_filters->>'status')and(coalesce(p_filters->>'categoryId','')=''or a.category_id=(p_filters->>'categoryId')::bigint)and(coalesce(p_filters->>'search','')=''or concat_ws(' ',a.asset_number,a.asset_name,a.serial_number,a.description,c.category_name)ilike'%'||(p_filters->>'search')||'%')$$;

create or replace function save_fixed_asset(p_payload jsonb,p_asset_id bigint default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();id bigint:=p_asset_id;
begin
 if nullif(trim(p_payload->>'name'),'')is null then raise exception 'El nombre del activo es obligatorio.';end if;
 if not exists(select 1 from asset_category where category_id=(p_payload->>'category_id')::bigint and subsidiary_id=sid and is_active)then raise exception 'Seleccione una categoría activa de la subsidiaria.';end if;
 if not exists(select 1 from subsidiary_currencies where subsidiary_id=sid and currency_id=(p_payload->>'currency_id')::bigint)then raise exception 'La moneda no pertenece a la subsidiaria.';end if;
 if id is null then
  insert into asset(asset_number,asset_name,description,serial_number,category_id,subsidiary_id,location_id,currency_id,purchase_date,in_service_date,purchase_cost,exchange_rate,department_id,cost_center_id,class_id,status)
  values('AUTO',trim(p_payload->>'name'),p_payload->>'description',nullif(trim(p_payload->>'serial'),''),(p_payload->>'category_id')::bigint,sid,(p_payload->>'location_id')::bigint,(p_payload->>'currency_id')::bigint,(p_payload->>'purchase_date')::date,coalesce(nullif(p_payload->>'service_date','')::date,(p_payload->>'purchase_date')::date),(p_payload->>'cost')::numeric,coalesce(nullif(p_payload->>'rate','')::numeric,1),nullif(p_payload->>'department_id','')::bigint,nullif(p_payload->>'cost_center_id','')::bigint,nullif(p_payload->>'class_id','')::bigint,coalesce(p_payload->>'status','ACTIVO'))returning asset_id into id;
 else
  update asset set asset_name=trim(p_payload->>'name'),description=p_payload->>'description',serial_number=nullif(trim(p_payload->>'serial'),''),category_id=(p_payload->>'category_id')::bigint,location_id=(p_payload->>'location_id')::bigint,currency_id=(p_payload->>'currency_id')::bigint,purchase_date=(p_payload->>'purchase_date')::date,in_service_date=coalesce(nullif(p_payload->>'service_date','')::date,(p_payload->>'purchase_date')::date),purchase_cost=(p_payload->>'cost')::numeric,exchange_rate=coalesce(nullif(p_payload->>'rate','')::numeric,1),department_id=nullif(p_payload->>'department_id','')::bigint,cost_center_id=nullif(p_payload->>'cost_center_id','')::bigint,class_id=nullif(p_payload->>'class_id','')::bigint,status=coalesce(p_payload->>'status','ACTIVO')where asset_id=id and subsidiary_id=sid;
  if not found then raise exception 'Activo no encontrado.';end if;
 end if;
 return jsonb_build_object('id',id,'number',(select asset_number from asset where asset_id=id),'message','Activo guardado correctamente.');
end$$;

create or replace function fixed_asset_depreciation_preview(p_date date) returns jsonb language sql stable security definer set search_path=public as $$
with period as(select * from fiscal_periods where subsidiary_id=active_subsidiary_id()and p_date between start_date and end_date limit 1),items as(
 select a.asset_id,a.asset_number,a.asset_name,c.category_name,c.depreciation_method,c.useful_life_months,a.purchase_cost,a.exchange_rate,coalesce(sum(ad.depreciation_amount),0) accumulated,
 greatest(least(round((a.purchase_cost-(a.purchase_cost*c.residual_value_percentage/100)-coalesce(sum(ad.depreciation_amount),0))/greatest(c.useful_life_months-count(ad.depreciation_id),1),6),a.purchase_cost-(a.purchase_cost*c.residual_value_percentage/100)-coalesce(sum(ad.depreciation_amount),0)),0) amount,
 exists(select 1 from asset_depreciation x,period p where x.asset_id=a.asset_id and x.fiscal_period_id=p.fiscal_period_id) processed
 from asset a join asset_category c using(category_id)left join asset_depreciation ad using(asset_id)
 where a.subsidiary_id=active_subsidiary_id()and a.status='ACTIVO'and a.in_service_date<=p_date and c.depreciation_method<>'No Depreciable'group by a.asset_id,c.category_id)
select jsonb_build_object('period',(select jsonb_build_object('id',fiscal_period_id,'name',period_name,'closed',is_closed)from period),'rows',coalesce((select jsonb_agg(jsonb_build_object('id',asset_id,'number',asset_number,'name',asset_name,'category',category_name,'method',depreciation_method,'cost',purchase_cost,'accumulated',accumulated,'amount',amount,'processed',processed)order by asset_number)from items),'[]'))$$;

create or replace function run_fixed_asset_depreciation(p_date date,p_asset_ids jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();pid bigint;cur bigint;aid bigint;rec record;amt numeric;jid bigint;impact bigint;count_done int:=0;
begin
 select fiscal_period_id into pid from fiscal_periods where subsidiary_id=sid and p_date between start_date and end_date and not is_closed limit 1;
 if pid is null then raise exception 'No existe un período contable abierto para la fecha.';end if;
 select currency_id into cur from subsidiaries where subsidiary_id=sid;
 for aid in select value::text::bigint from jsonb_array_elements(p_asset_ids)loop
  select a.*,c.useful_life_months,c.residual_value_percentage,c.depreciation_method,c.depreciation_account_id,c.depreciation_expense_account_id,coalesce((select sum(depreciation_amount)from asset_depreciation where asset_id=a.asset_id),0) accumulated,coalesce((select count(*)from asset_depreciation where asset_id=a.asset_id),0) months into rec from asset a join asset_category c using(category_id)where a.asset_id=aid and a.subsidiary_id=sid and a.status='ACTIVO'and a.in_service_date<=p_date;
  if rec.asset_id is null or rec.depreciation_method='No Depreciable'then continue;end if;
  if exists(select 1 from asset_depreciation where asset_id=aid and fiscal_period_id=pid)then continue;end if;
  amt:=greatest(least(round((rec.purchase_cost-(rec.purchase_cost*rec.residual_value_percentage/100)-rec.accumulated)/greatest(rec.useful_life_months-rec.months,1),6),rec.purchase_cost-(rec.purchase_cost*rec.residual_value_percentage/100)-rec.accumulated),0);
  if amt<=0 then continue;end if;
  select create_journal_entry(jsonb_build_object('journal_date',p_date,'currency_id',cur,'fiscal_period_id',pid,'exchange_rate',1,'journal_type','Estándar','memo','Depreciación '||rec.asset_number||' · '||rec.asset_name,'lines',jsonb_build_array(jsonb_build_object('account_id',rec.depreciation_expense_account_id,'debit',amt*rec.exchange_rate,'credit',0,'note','Depreciación '||rec.asset_number,'department_id',rec.department_id,'cost_center_id',rec.cost_center_id,'class_id',rec.class_id),jsonb_build_object('account_id',rec.depreciation_account_id,'debit',0,'credit',amt*rec.exchange_rate,'note','Depreciación acumulada '||rec.asset_number,'department_id',rec.department_id,'cost_center_id',rec.cost_center_id,'class_id',rec.class_id))))into jid;
  perform sync_journal_gl_impacts(jid);
  select min(g.gl_impact_id)into impact from journal j join gl_impact g on g.transaction_id=j.transaction_id where j.journal_id=jid;
  insert into asset_depreciation(depreciation_date,asset_id,fiscal_period_id,gl_impact_id,depreciation_amount,accumulated_depreciation)values(p_date,aid,pid,impact,amt,rec.accumulated+amt);
  count_done:=count_done+1;
 end loop;
 return jsonb_build_object('processed',count_done,'message',count_done||' depreciación(es) contabilizada(s) correctamente.');
end$$;

grant execute on function fixed_asset_options(),fixed_asset_report(jsonb),save_fixed_asset(jsonb,bigint),fixed_asset_depreciation_preview(date),run_fixed_asset_depreciation(date,jsonb)to authenticated;
notify pgrst,'reload schema';
