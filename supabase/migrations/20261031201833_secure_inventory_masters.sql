-- C-04: scoped master maintenance. No balance changes or historical backfill.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema inventory_master_private;
revoke all on schema inventory_master_private from public,anon,authenticated,service_role;
grant usage on schema inventory_master_private to authenticated;
create function inventory_master_private.catalog(k text) returns table(t text,pk text,fields text[]) language sql immutable set search_path=pg_catalog as $$
 select c.t,c.pk,c.fields from (values
 ('products','products','product_id',array['display_name','item_type_id','product_usage','sales_account_id','purchase_account_id','category_id','brand_id','uom_id','purchase_cost','sales_price','is_active']),
 ('product-subsidiaries','product_subsidiaries','id',array[]::text[]),
 ('product-suppliers','product_supplier','id',array['product_id','supplier_id','supplier_part_number','is_preferred']),
 ('product-images','product_images','image_id',array['product_id','image_url','is_primary']),
 ('barcodes','barcode','barcode_id',array['product_id','barcode_value','barcode_type']),
 ('warehouse-locations','warehouse_locations','warehouse_location_id',array['location_id','zone_name','aisle','rack']),
 ('bins','bins','bin_id',array['warehouse_location_id','bin_code','max_capacity']),
 ('item-location-configurations','item_location_configuration','id',array['product_id','location_id','subsidiary_id','preferred_bin_id','safety_stock','reorder_point']),
 ('locations','locations','location_id',array['name','parent_id','country_id']),
 ('location-subsidiaries','location_subsidiaries','location_id',array[]::text[])
 ) c(k,t,pk,fields) where c.k=$1
$$;
create function inventory_master_private.allowed(k text,a text) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform asset_posting_private.identity();return exists(select 1 from inventory_master_private.catalog(k)) and asset_posting_private.allowed(case when k in('locations','location-subsidiaries') then 'organization:' else 'inventory:' end||k,a);
 exception when insufficient_privilege then return false;end$$;
create function inventory_master_private.product(id bigint,w boolean default false) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select exists(select 1 from public.product_subsidiaries p where p.product_id=$1 and p.subsidiary_id=asset_posting_private.identity()) and (not w or not exists(select 1 from public.product_subsidiaries p where p.product_id=$1 and p.subsidiary_id<>asset_posting_private.identity()))
$$;
create function inventory_master_private.location(id bigint,w boolean default false) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select inventory_balance_private.location($1) and (not w or not exists(select 1 from (select subsidiary_id from public.locations where location_id=$1 union select subsidiary_id from public.location_subsidiaries where location_id=$1)x where subsidiary_id<>asset_posting_private.identity()))
$$;
create function inventory_master_private.scope(k text,r jsonb,w boolean default false) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint:=asset_posting_private.identity();begin
 case k
 when 'products' then return inventory_master_private.product((r->>'product_id')::bigint,w);
 when 'product-subsidiaries' then return not w and (r->>'subsidiary_id')::bigint=sid and inventory_master_private.product((r->>'product_id')::bigint);
 when 'product-suppliers' then return inventory_master_private.product((r->>'product_id')::bigint,w) and exists(select 1 from public.suppliers s where s.supplier_id=(r->>'supplier_id')::bigint and s.primary_subsidiary_id=sid);
 when 'product-images','barcodes' then return inventory_master_private.product((r->>'product_id')::bigint,w);
 when 'locations' then return inventory_master_private.location((r->>'location_id')::bigint,w);
 when 'location-subsidiaries' then return not w and (r->>'subsidiary_id')::bigint=sid and inventory_master_private.location((r->>'location_id')::bigint);
 when 'warehouse-locations' then return inventory_master_private.location((r->>'location_id')::bigint,w);
 when 'bins' then return exists(select 1 from public.warehouse_locations z where z.warehouse_location_id=(r->>'warehouse_location_id')::bigint and inventory_master_private.location(z.location_id,w));
 when 'item-location-configurations' then return (r->>'subsidiary_id')::bigint=sid and inventory_master_private.product((r->>'product_id')::bigint) and inventory_master_private.location((r->>'location_id')::bigint) and ((r->>'preferred_bin_id') is null or exists(select 1 from public.bins b join public.warehouse_locations z using(warehouse_location_id) where b.bin_id=(r->>'preferred_bin_id')::bigint and z.location_id=(r->>'location_id')::bigint));
 else return false;end case;
 exception when insufficient_privilege then return false;end$$;
create function inventory_master_private.visible(k text,r jsonb) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 return (inventory_master_private.allowed(k,'view') or (k='product-subsidiaries' and inventory_master_private.allowed('products','view')) or (k='location-subsidiaries' and inventory_master_private.allowed('locations','view'))) and inventory_master_private.scope(k,r);
 exception when insufficient_privilege then return false;end$$;

create function public.save_inventory_master(p_catalog text,p_payload jsonb,p_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint; c record; oldrow jsonb; rowdata jsonb; result jsonb; col text;cols text; vals text;sets text; aid bigint; expected text;
begin
 if inventory_master_private.allowed(p_catalog,case when p_id is null then 'create' else 'edit' end) is not true then raise exception using errcode='42501',message='Sin permiso para mantener este maestro.';end if;
 sid:=asset_posting_private.identity();select * into c from inventory_master_private.catalog(p_catalog);
 if cardinality(c.fields)=0 then raise exception using errcode='42501',message='Las asignaciones se administran mediante el maestro autorizado.';end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload)>32000 or exists(select 1 from jsonb_object_keys(p_payload) k where not k=any(c.fields||array['subsidiary_ids','average_cost'])) then raise exception using errcode='22023',message='Campos de maestro no permitidos.';end if;
 -- Serialize scope checks and writes on the same master family; no client-set flags.
 perform pg_advisory_xact_lock(793102,1);
 if p_id is not null then
 execute format('select to_jsonb(x) from public.%I x where %I=$1 for update',c.t,c.pk) into oldrow using p_id;
 if oldrow is null or inventory_master_private.scope(p_catalog,oldrow,true) is not true then raise exception using errcode='42501',message='Maestro ajeno o compartido; requiere mantenimiento central autorizado.';end if;
 foreach col in array array['product_id','location_id','warehouse_location_id','subsidiary_id','parent_id','country_id','item_type_id','uom_id'] loop
 if p_payload?col and p_payload->col is distinct from oldrow->col then raise exception using errcode='55000',message='La relación de origen es inmutable.';end if;end loop;
 end if;
 rowdata:=coalesce(oldrow,'{}')||p_payload;
 foreach col in array case p_catalog when 'product-suppliers' then array[]::text[] when 'product-images' then array['image_url'] when 'barcodes' then array['barcode_value','barcode_type'] when 'warehouse-locations' then array['zone_name'] when 'bins' then array['bin_code'] else array[]::text[] end loop
 if nullif(btrim(rowdata->>col),'') is null then raise exception using errcode='22023',message='Complete los campos obligatorios del maestro.';end if;end loop;
 if p_catalog in('products','locations') and p_payload->'subsidiary_ids' is distinct from jsonb_build_array(sid) then raise exception using errcode='42501',message='Seleccione únicamente la subsidiaria activa. Las asignaciones compartidas requieren mantenimiento central.';end if;
 if p_catalog='products' then
 if nullif(btrim(rowdata->>'display_name'),'') is null or (rowdata->>'product_usage') not in('Compra','Venta','Ambas') or rowdata->>'product_usage' is null then raise exception using errcode='22023',message='Nombre y uso de producto requeridos.';end if;
 foreach col in array array['sales_account_id','purchase_account_id'] loop
 aid:=nullif(rowdata->>col,'')::bigint;expected:=case col when 'sales_account_id' then 'Ingreso' else 'Costo' end;
 if aid is not null then perform asset_posting_private.account(aid);if not exists(select 1 from public.chart_accounts a where a.account_id=aid and (a.category=expected or (col='purchase_account_id' and a.category='Gasto'))) then raise exception using errcode='22023',message='Categoría de cuenta incompatible.';end if;end if;
 if aid is null and ((col='sales_account_id' and rowdata->>'product_usage' in('Venta','Ambas')) or (col='purchase_account_id' and rowdata->>'product_usage' in('Compra','Ambas'))) then raise exception using errcode='22023',message='Falta cuenta contable para el uso del producto.';end if;
 end loop;
 elsif p_catalog='locations' then
 if nullif(btrim(rowdata->>'name'),'') is null then raise exception using errcode='22023',message='Nombre de ubicación requerido.';end if;
 if rowdata->>'parent_id' is not null and inventory_master_private.location((rowdata->>'parent_id')::bigint) is not true then raise exception using errcode='42501',message='Ubicación padre fuera del alcance.';end if;
 if rowdata->>'country_id' is not null and not exists(select 1 from public.subsidiaries s where s.subsidiary_id=sid and s.country_id=(rowdata->>'country_id')::bigint) then raise exception using errcode='42501',message='País fuera del alcance.';end if;
 else
 if inventory_master_private.scope(p_catalog,rowdata,true) is not true then raise exception using errcode='42501',message='Relaciones fuera de la subsidiaria activa.';end if;
 end if;
 foreach col in array array['purchase_cost','sales_price','max_capacity','safety_stock','reorder_point','average_cost'] loop
 if p_payload->>col is not null and (not asset_posting_private.finite((p_payload->>col)::numeric) or (p_payload->>col)::numeric<0) then raise exception using errcode='22023',message='Importes y niveles deben ser finitos y no negativos.';end if;end loop;
 if p_payload?'average_cost' and coalesce((p_payload->>'average_cost')::numeric,0)<>coalesce((oldrow->>'average_cost')::numeric,0) then raise exception using errcode='42501',message='El costo promedio no es un campo de mantenimiento manual.';end if;
 if p_catalog='product-images' and (rowdata->>'image_url')!~'^https://[^[:space:]]+$' then raise exception using errcode='22023',message='La imagen requiere una URL HTTPS.';end if;
 select string_agg(format('%I',k),','),string_agg(format('v.%I',k),','),string_agg(format('%I=v.%I',k,k),',') into cols,vals,sets from unnest(c.fields) k where p_payload?k;
 if cols is null then raise exception using errcode='22023',message='No hay campos para guardar.';end if;
 if p_id is null then
 if p_catalog='locations' then cols:=cols||',subsidiary_id';vals:=vals||','||sid::text;end if;
 execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) v returning to_jsonb(%I.*)',c.t,cols,vals,c.t,c.t) into result using p_payload;
 if p_catalog='products' then insert into public.product_subsidiaries(product_id,subsidiary_id,is_active) values((result->>'product_id')::bigint,sid,true);
 elsif p_catalog='locations' then insert into public.location_subsidiaries(location_id,subsidiary_id) values((result->>'location_id')::bigint,sid);end if;
 else execute format('update public.%I x set %s from jsonb_populate_record(null::public.%I,$1) v where x.%I=$2 returning to_jsonb(x)',c.t,sets,c.t,c.pk) into result using p_payload,p_id;end if;
 return result;
end$$;

create function public.inventory_master_data(p_catalog text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare c record;sid bigint;rows jsonb;options jsonb;begin
 if inventory_master_private.allowed(p_catalog,'view') is not true then raise exception using errcode='42501',message='Sin permiso de consulta del maestro.';end if;
 sid:=asset_posting_private.identity();select * into c from inventory_master_private.catalog(p_catalog);
 execute format('select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object(''_master_editable'',inventory_master_private.scope($1,to_jsonb(x),true)) order by x.%I),''[]'') from public.%I x where inventory_master_private.visible($1,to_jsonb(x))',c.pk,c.t) into rows using p_catalog;
 if p_catalog in('products','locations') then select coalesce(jsonb_agg(x||jsonb_build_object('subsidiary_ids',jsonb_build_array(sid))),'[]') into rows from jsonb_array_elements(rows)x;end if;
 options:=jsonb_build_object('organization/subsidiaries',(select coalesce(jsonb_agg(jsonb_build_object('subsidiary_id',s.subsidiary_id,'name',s.name,'country_id',s.country_id)),'[]') from public.subsidiaries s where s.subsidiary_id=sid));
 -- Reference labels are bounded to this form; never expose full foreign masters.
 if p_catalog in('product-subsidiaries','product-suppliers','product-images','barcodes','item-location-configurations') then options:=options||jsonb_build_object('inventory/products',(select coalesce(jsonb_agg(jsonb_build_object('product_id',p.product_id,'item_code',p.item_code,'display_name',p.display_name)),'[]') from public.products p where inventory_master_private.product(p.product_id)));end if;
 if p_catalog in('locations','warehouse-locations','item-location-configurations') then options:=options||jsonb_build_object('organization/locations',(select coalesce(jsonb_agg(jsonb_build_object('location_id',l.location_id,'name',l.name)),'[]') from public.locations l where inventory_master_private.location(l.location_id)));end if;
 if p_catalog='locations' then options:=options||jsonb_build_object('core/countries',(select coalesce(jsonb_agg(jsonb_build_object('country_id',c.country_id,'name',c.name)),'[]') from public.countries c join public.subsidiaries s using(country_id) where s.subsidiary_id=sid));end if;
 if p_catalog='bins' then options:=options||jsonb_build_object('inventory/warehouse-locations',(select coalesce(jsonb_agg(jsonb_build_object('warehouse_location_id',z.warehouse_location_id,'zone_name',z.zone_name)),'[]') from public.warehouse_locations z where inventory_master_private.location(z.location_id,true)));end if;
 if p_catalog='item-location-configurations' then options:=options||jsonb_build_object('inventory/bins',(select coalesce(jsonb_agg(jsonb_build_object('bin_id',b.bin_id,'bin_code',b.bin_code,'location_id',z.location_id)),'[]') from public.bins b join public.warehouse_locations z using(warehouse_location_id) where inventory_master_private.location(z.location_id)));end if;
 if p_catalog='product-suppliers' then options:=options||jsonb_build_object('entities/suppliers',(select coalesce(jsonb_agg(jsonb_build_object('supplier_id',s.supplier_id,'supplier_number',s.supplier_number,'company_name',s.company_name)),'[]') from public.suppliers s where s.primary_subsidiary_id=sid));end if;
 if p_catalog='products' then options:=options||jsonb_build_object(
 'inventory/item-types',(select coalesce(jsonb_agg(jsonb_build_object('item_type_id',t.item_type_id,'type_code',t.type_code,'type_name',t.type_name)),'[]') from public.item_types t),
 'inventory/product-categories',(select coalesce(jsonb_agg(jsonb_build_object('category_id',t.category_id,'category_name',t.category_name)),'[]') from public.product_categories t),
 'inventory/product-brands',(select coalesce(jsonb_agg(jsonb_build_object('brand_id',t.brand_id,'brand_name',t.brand_name)),'[]') from public.product_brands t),
 'configuration/uom',(select coalesce(jsonb_agg(jsonb_build_object('uom_id',t.uom_id,'name',t.name)),'[]') from public.uom t),
 'accounting/chart-accounts',(select coalesce(jsonb_agg(jsonb_build_object('account_id',a.account_id,'account_number',a.account_number,'account_name',a.account_name,'category',a.category)),'[]') from public.chart_accounts a join public.account_subsidiaries s using(account_id) where s.subsidiary_id=sid and s.is_active and not a.is_inactive and a.accepts_entries and a.category in('Ingreso','Costo','Gasto')));end if;
 return jsonb_build_object('rows',rows,'options',options);
end$$;
do $$declare c record;p record;col record;k text;begin
 foreach k in array array['products','product-subsidiaries','product-suppliers','product-images','barcodes','warehouse-locations','bins','item-location-configurations','locations','location-subsidiaries'] loop
 select * into c from inventory_master_private.catalog(k);
 execute format('alter table public.%I enable row level security',c.t);
 for p in select policyname from pg_policies where schemaname='public' and tablename=c.t loop execute format('drop policy %I on public.%I',p.policyname,c.t);end loop;
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',c.t);
 for col in select column_name from information_schema.columns where table_schema='public' and table_name=c.t loop execute format('revoke all (%I) on public.%I from public,anon,authenticated,service_role',col.column_name,c.t);end loop;
 execute format('grant select on public.%I to authenticated',c.t);
 execute format('create policy inventory_master_read on public.%I for select to authenticated using(inventory_master_private.visible(%L,to_jsonb(%I.*)))',c.t,k,c.t);
 end loop;
end$$;
revoke all on all functions in schema inventory_master_private from public,anon,authenticated,service_role;
grant execute on function inventory_master_private.visible(text,jsonb) to authenticated;
revoke all on function public.save_inventory_master(text,jsonb,bigint),public.inventory_master_data(text) from public,anon,authenticated,service_role;
grant execute on function public.save_inventory_master(text,jsonb,bigint),public.inventory_master_data(text) to authenticated;
notify pgrst,'reload schema';
