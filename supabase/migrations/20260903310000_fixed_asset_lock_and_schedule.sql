create or replace function protect_depreciated_asset_values()returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if exists(select 1 from asset_depreciation where asset_id=old.asset_id)and(
  new.purchase_cost is distinct from old.purchase_cost or
  new.category_id is distinct from old.category_id or
  new.currency_id is distinct from old.currency_id or
  new.exchange_rate is distinct from old.exchange_rate or
  new.purchase_date is distinct from old.purchase_date or
  new.in_service_date is distinct from old.in_service_date
 )then raise exception 'No se pueden modificar costo, categoría, moneda ni fechas porque el activo ya tiene depreciaciones contabilizadas.';end if;
 return new;
end$$;
drop trigger if exists protect_depreciated_asset_values_trigger on asset;
create trigger protect_depreciated_asset_values_trigger before update on asset for each row execute function protect_depreciated_asset_values();

create or replace function fixed_asset_detail(p_asset_id bigint)returns jsonb language sql stable security definer set search_path=public as $$
with header as(
 select a.*,c.category_code,c.category_name,c.useful_life_months,c.depreciation_method,c.residual_value_percentage,l.name location_name,cu.currency_code,d.name department_name,cc.name cost_center_name,cl.name class_name
 from asset a join asset_category c using(category_id)join locations l using(location_id)join currencies cu using(currency_id)left join departments d on d.department_id=a.department_id left join cost_centers cc on cc.cost_center_id=a.cost_center_id left join classes cl on cl.class_id=a.class_id
 where a.asset_id=p_asset_id and a.subsidiary_id=active_subsidiary_id()
),months as(
 select h.*,series.n,(date_trunc('month',h.in_service_date)+(series.n||' months')::interval)::date month_date,round((h.purchase_cost-(h.purchase_cost*h.residual_value_percentage/100))/greatest(h.useful_life_months,1),6) scheduled
 from header h cross join lateral generate_series(0,h.useful_life_months-1)series(n)
),schedule as(
 select m.*,ad.depreciation_id,ad.depreciation_date,ad.depreciation_amount,ad.accumulated_depreciation,coalesce(ad.depreciation_amount,m.scheduled) period_amount
 from months m left join asset_depreciation ad on ad.asset_id=m.asset_id and date_trunc('month',ad.depreciation_date)=m.month_date
),calculated as(
 select s.*,least(sum(period_amount)over(order by n),purchase_cost-(purchase_cost*residual_value_percentage/100)) projected_accumulated from schedule s
)
select jsonb_build_object(
 'asset',(select jsonb_build_object('id',asset_id,'number',asset_number,'name',asset_name,'description',description,'serial',serial_number,'category',category_code||' · '||category_name,'method',depreciation_method,'life',useful_life_months,'residual',residual_value_percentage,'location',location_name,'currency',currency_code,'purchaseDate',purchase_date,'serviceDate',in_service_date,'cost',purchase_cost,'department',department_name,'costCenter',cost_center_name,'class',class_name,'status',status,'hasDepreciations',exists(select 1 from asset_depreciation where asset_id=p_asset_id))from header),
 'schedule',coalesce((select jsonb_agg(jsonb_build_object('month',n+1,'period',to_char(month_date,'YYYY-MM'),'date',depreciation_date,'amount',period_amount,'accumulated',projected_accumulated,'bookValue',greatest(purchase_cost-projected_accumulated,0),'status',case when depreciation_id is null then 'PROYECTADA'else'CONTABILIZADA'end)order by n)from calculated),'[]')
)$$;
grant execute on function fixed_asset_detail(bigint)to authenticated;
notify pgrst,'reload schema';
