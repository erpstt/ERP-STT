create or replace function public.fixed_asset_report(p_filters jsonb default '{}')
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
select jsonb_build_object(
  'rows',
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',a.asset_id,
        'number',a.asset_number,
        'name',a.asset_name,
        'description',a.description,
        'serial',a.serial_number,
        'categoryId',a.category_id,
        'category',c.category_name,
        'locationId',a.location_id,
        'location',l.name,
        'currencyId',a.currency_id,
        'currency',cu.currency_code,
        'purchaseDate',a.purchase_date,
        'serviceDate',a.in_service_date,
        'cost',a.purchase_cost,
        'rate',a.exchange_rate,
        'departmentId',a.department_id,
        'department',dep.name,
        'costCenterId',a.cost_center_id,
        'costCenter',cc.name,
        'classId',a.class_id,
        'className',cl.name,
        'status',a.status,
        'accumulated',coalesce(ad.accumulated,0),
        'bookValue',greatest(a.purchase_cost-coalesce(ad.accumulated,0),0)
      )
      order by a.asset_number
    ),
    '[]'::jsonb
  )
)
from public.asset a
join public.asset_category c using(category_id)
join public.locations l using(location_id)
join public.currencies cu using(currency_id)
left join public.departments dep on dep.department_id=a.department_id
left join public.cost_centers cc on cc.cost_center_id=a.cost_center_id
left join public.classes cl on cl.class_id=a.class_id
left join lateral(
  select sum(d.depreciation_amount) accumulated
  from public.asset_depreciation d
  where d.asset_id=a.asset_id
)ad on true
where a.subsidiary_id=public.active_subsidiary_id()
  and a.opening_reversed_at is null
  and(coalesce(p_filters->>'status','ALL')='ALL' or a.status=p_filters->>'status')
  and(coalesce(p_filters->>'categoryId','')='' or a.category_id=(p_filters->>'categoryId')::bigint)
  and(
    coalesce(p_filters->>'search','')=''
    or concat_ws(' ',a.asset_number,a.asset_name,a.serial_number,a.description,c.category_name) ilike '%'||(p_filters->>'search')||'%'
  );
$$;

revoke all on function public.fixed_asset_report(jsonb) from public, anon;
grant execute on function public.fixed_asset_report(jsonb) to authenticated;

notify pgrst,'reload schema';
