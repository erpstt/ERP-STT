create or replace function fixed_asset_operation_options()
returns jsonb language sql stable security definer set search_path=public as $$
select jsonb_build_object(
 'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currency',cu.currency_code),
 'assets',coalesce((select jsonb_agg(jsonb_build_object('id',a.asset_id,'number',a.asset_number,'name',a.asset_name,'locationId',a.location_id,'cost',a.purchase_cost,'accumulated',coalesce(d.total,0),'bookValue',greatest(a.purchase_cost-coalesce(d.total,0),0))order by a.asset_number)from asset a left join lateral(select sum(depreciation_amount)total from asset_depreciation where asset_id=a.asset_id)d on true where a.subsidiary_id=s.subsidiary_id and a.status='ACTIVO'),'[]'),
 'subsidiaries',coalesce((select jsonb_agg(jsonb_build_object('id',x.subsidiary_id,'name',x.name)order by x.name)from subsidiaries x where x.is_active),'[]'),
 'locations',coalesce((select jsonb_agg(jsonb_build_object('id',q.location_id,'name',q.name,'subsidiaryId',q.subsidiary_id)order by q.name)from(select distinct l.location_id,l.name,coalesce(ls.subsidiary_id,l.subsidiary_id)subsidiary_id from locations l left join location_subsidiaries ls using(location_id))q),'[]'),
 'suppliers',coalesce((select jsonb_agg(distinct jsonb_build_object('id',p.supplier_id,'name',p.company_name))from suppliers p left join entity_subsidiaries es using(supplier_id)where p.primary_subsidiary_id=s.subsidiary_id or es.subsidiary_id=s.subsidiary_id),'[]')
)from subsidiaries s join currencies cu using(currency_id)where s.subsidiary_id=active_subsidiary_id()
$$;

create or replace function delete_fixed_asset_operation(p_type text,p_operation_id bigint)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare aid bigint;
begin
 if p_type='TRANSFER' then
  delete from asset_transfer where transfer_id=p_operation_id and source_subsidiary_id=active_subsidiary_id();
 elsif p_type='DISPOSAL' then
  select a.asset_id into aid from asset_disposal d join asset a using(asset_id) where d.disposal_id=p_operation_id and a.subsidiary_id=active_subsidiary_id();
  if aid is null then raise exception 'La baja o venta no existe o no pertenece a la subsidiaria activa.'; end if;
  delete from asset_disposal where disposal_id=p_operation_id;
  update asset set status='ACTIVO' where asset_id=aid;
 else
  delete from asset_maintenance m using asset a where m.maintenance_id=p_operation_id and a.asset_id=m.asset_id and a.subsidiary_id=active_subsidiary_id();
 end if;
 if not found then raise exception 'El registro no existe o no pertenece a la subsidiaria activa.'; end if;
 return true;
end$$;

grant execute on function fixed_asset_operation_options(),delete_fixed_asset_operation(text,bigint) to authenticated;
notify pgrst,'reload schema';
