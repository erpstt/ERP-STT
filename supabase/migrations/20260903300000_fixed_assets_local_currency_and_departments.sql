create or replace function fixed_asset_options() returns jsonb language sql stable security definer set search_path=public as $$
select jsonb_build_object(
 'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id),
 'categories',coalesce((select jsonb_agg(jsonb_build_object('id',c.category_id,'code',c.category_code,'name',c.category_name,'life',c.useful_life_months,'method',c.depreciation_method,'residual',c.residual_value_percentage)order by c.category_name)from asset_category c where c.subsidiary_id=s.subsidiary_id and c.is_active),'[]'),
 'locations',coalesce((select jsonb_agg(distinct jsonb_build_object('id',l.location_id,'name',l.name))from locations l left join location_subsidiaries ls using(location_id)where l.subsidiary_id=s.subsidiary_id or ls.subsidiary_id=s.subsidiary_id),'[]'),
 'currency',(select jsonb_build_object('id',c.currency_id,'code',c.currency_code,'name',c.name)from currencies c where c.currency_id=s.currency_id),
 'currencies',jsonb_build_array((select jsonb_build_object('id',c.currency_id,'code',c.currency_code,'name',c.name)from currencies c where c.currency_id=s.currency_id)),
 'periods',coalesce((select jsonb_agg(jsonb_build_object('id',f.fiscal_period_id,'name',f.period_name,'start',f.start_date,'end',f.end_date,'closed',f.is_closed)order by f.start_date desc)from fiscal_periods f where f.subsidiary_id=s.subsidiary_id),'[]'),
 'departments',coalesce((select jsonb_agg(jsonb_build_object('id',d.department_id,'name',d.name,'type',d.type)order by d.type,d.name)from departments d left join department_subsidiaries ds using(department_id)where(d.subsidiary_id=s.subsidiary_id or ds.subsidiary_id=s.subsidiary_id)and not d.is_inactive),'[]'),
 'costs',coalesce((select jsonb_agg(jsonb_build_object('id',c.cost_center_id,'name',c.name,'departmentId',cu.department_id,'classId',c.class_id)order by c.name)from cost_centers c left join customers cu using(customer_id)where c.subsidiary_id=s.subsidiary_id and not c.is_inactive),'[]'),
 'classes',coalesce((select jsonb_agg(jsonb_build_object('id',c.class_id,'name',c.name)order by c.name)from classes c left join class_subsidiaries cs using(class_id)where(c.subsidiary_id=s.subsidiary_id or cs.subsidiary_id=s.subsidiary_id)and not c.is_inactive),'[]')
)from subsidiaries s where s.subsidiary_id=active_subsidiary_id()$$;

create or replace function validate_fixed_asset_local_currency()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare local_currency bigint;
begin
 select currency_id into local_currency from subsidiaries where subsidiary_id=new.subsidiary_id;
 if new.currency_id<>local_currency then raise exception 'Los activos fijos solo pueden registrarse en la moneda local de la subsidiaria.';end if;
 new.exchange_rate:=1;
 if new.department_id is not null and not exists(select 1 from departments d left join department_subsidiaries ds using(department_id)where d.department_id=new.department_id and(d.subsidiary_id=new.subsidiary_id or ds.subsidiary_id=new.subsidiary_id)and not d.is_inactive)then raise exception 'El departamento no pertenece a la subsidiaria.';end if;
 if new.cost_center_id is not null and not exists(select 1 from cost_centers cc left join customers cu using(customer_id)where cc.cost_center_id=new.cost_center_id and cc.subsidiary_id=new.subsidiary_id and cu.department_id=new.department_id and not cc.is_inactive)then raise exception 'El centro de costos no corresponde al departamento seleccionado.';end if;
 return new;
end$$;
drop trigger if exists validate_fixed_asset_local_currency_trigger on asset;
create trigger validate_fixed_asset_local_currency_trigger before insert or update of currency_id,exchange_rate,department_id,cost_center_id on asset for each row execute function validate_fixed_asset_local_currency();
grant execute on function fixed_asset_options()to authenticated;
notify pgrst,'reload schema';
