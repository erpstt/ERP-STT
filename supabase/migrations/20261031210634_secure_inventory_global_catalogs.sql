-- C-04: global catalog actions require exact grants, never administrator/legacy bypass.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema inventory_global_private;
revoke all on schema inventory_global_private from public,anon,authenticated,service_role;
grant usage on schema inventory_global_private to authenticated;
create function inventory_global_private.catalog(k text) returns table(t text,pk text,fields text[],label text) language sql immutable set search_path=pg_catalog as $$
 select c.t,c.pk,c.fields,c.label from (values
 ('item-types','item_types','item_type_id',array['type_name','is_inventory','is_assembled'],'type_name'),
 ('product-categories','product_categories','category_id',array['category_name','parent_id'],'category_name'),
 ('product-brands','product_brands','brand_id',array['brand_name'],'brand_name'),
 ('product-groups','product_groups','group_id',array['group_name'],'group_name'),
 ('uom','uom','uom_id',array['name','symbol'],'name')
 ) c(k,t,pk,fields,label) where c.k=$1
$$;
create function inventory_global_private.allowed(k text,a text) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare resource text;begin
 perform asset_posting_private.identity();
 if not exists(select 1 from inventory_global_private.catalog(k)) or a not in('view','create','edit','delete') then return false;end if;
 resource:=case when k='uom' then 'configuration:' else 'inventory:' end||k;
 if a='view' then return asset_posting_private.allowed(resource,'view');end if;
 -- An explicit grant on this resource/action is required, including for administrators.
 return exists(select 1 from public.role_access_matrix m where m.role_id=public.app_active_role_id() and m.resource_key=resource and case a when 'create' then m.can_create when 'edit' then m.can_edit when 'delete' then m.can_delete else false end);
 exception when insufficient_privilege then return false;end$$;
create function inventory_global_private.used(t text,id bigint) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$declare fk record;found boolean;begin
 for fk in select n.nspname,c.relname,a.attname,cardinality(co.conkey) n from pg_constraint co join pg_class c on c.oid=co.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum=co.conkey[1] where co.contype='f' and co.confrelid=to_regclass('public.'||t) loop
 if fk.n<>1 then return true;end if;
 execute format('select exists(select 1 from %I.%I where %I=$1)',fk.nspname,fk.relname,fk.attname) into found using id;
 if found then return true;end if;end loop;return false;
end$$;
create function public.inventory_global_access(p_catalog text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if inventory_global_private.allowed(p_catalog,'view') is not true then raise exception using errcode='42501',message='Sin permiso para consultar este catálogo global.';end if;
 return jsonb_build_object('canView',true,'canCreate',inventory_global_private.allowed(p_catalog,'create'),'canEdit',inventory_global_private.allowed(p_catalog,'edit'),'canDelete',inventory_global_private.allowed(p_catalog,'delete'));
end$$;
create function public.save_inventory_global(p_catalog text,p_payload jsonb,p_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c record;oldrow jsonb;rowdata jsonb;result jsonb;k text;cols text;vals text;sets text;pid bigint;cycle boolean;begin
 if inventory_global_private.allowed(p_catalog,case when p_id is null then 'create' else 'edit' end) is not true then raise exception using errcode='42501',message='Requiere permiso explícito de mantenimiento global.';end if;
 select * into c from inventory_global_private.catalog(p_catalog);
 if jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload)>16000 or exists(select 1 from jsonb_object_keys(p_payload) x where not x=any(c.fields)) or p_id<=0 then raise exception using errcode='22023',message='Campos de catálogo no permitidos.';end if;
 perform pg_advisory_xact_lock(793103,1);
 if p_id is not null then execute format('select to_jsonb(x) from public.%I x where %I=$1 for update',c.t,c.pk) into oldrow using p_id;
 if oldrow is null then raise exception using errcode='55000',message='El registro ya no existe.';end if;end if;
 rowdata:=coalesce(oldrow,'{}')||p_payload;
 if nullif(btrim(rowdata->>c.label),'') is null or length(rowdata->>c.label)>250 then raise exception using errcode='22023',message='Nombre obligatorio, máximo 250 caracteres.';end if;
 if p_catalog='item-types' then
 foreach k in array array['is_inventory','is_assembled'] loop
 if p_payload?k and jsonb_typeof(p_payload->k) is distinct from 'boolean' then raise exception using errcode='22023',message='Las clasificaciones deben ser booleanas.';end if;
 if p_id is not null and p_payload?k and p_payload->k is distinct from oldrow->k and inventory_global_private.used(c.t,p_id) then raise exception using errcode='55000',message='No se puede reclasificar un tipo utilizado.';end if;end loop;
 elsif p_catalog='uom' then
 if nullif(btrim(rowdata->>'symbol'),'') is null or length(rowdata->>'symbol')>40 then raise exception using errcode='22023',message='Símbolo de unidad obligatorio, máximo 40 caracteres.';end if;
 if p_id is not null and rowdata->'symbol' is distinct from oldrow->'symbol' and inventory_global_private.used(c.t,p_id) then raise exception using errcode='55000',message='El símbolo de una unidad utilizada es inmutable.';end if;
 elsif p_catalog='product-categories' then
 pid:=(rowdata->>'parent_id')::bigint;
 if pid is not null then
 if pid<=0 or pid=p_id or not exists(select 1 from public.product_categories where category_id=pid) then raise exception using errcode='22023',message='Categoría padre inválida.';end if;
 with recursive chain as (select category_id,parent_id,array[category_id] path,false repeated from public.product_categories where category_id=pid union all select p.category_id,p.parent_id,chain.path||p.category_id,p.category_id=any(chain.path) from public.product_categories p join chain on p.category_id=chain.parent_id where not chain.repeated)
 select coalesce(bool_or(category_id=p_id or repeated),false) into cycle from chain;
 if cycle then raise exception using errcode='22023',message='La jerarquía no permite ciclos.';end if;end if;
 end if;
 select string_agg(format('%I',x),','),string_agg(format('v.%I',x),','),string_agg(format('%I=v.%I',x,x),',') into cols,vals,sets from unnest(c.fields) x where p_payload?x;
 if cols is null then raise exception using errcode='22023',message='No hay cambios para guardar.';end if;
 if p_id is null then execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) v returning to_jsonb(%I.*)',c.t,cols,vals,c.t,c.t) into result using p_payload;
 else execute format('update public.%I x set %s from jsonb_populate_record(null::public.%I,$1) v where x.%I=$2 returning to_jsonb(x)',c.t,sets,c.t,c.pk) into result using p_payload,p_id;end if;
 return result;
end$$;
create function public.delete_inventory_global(p_catalog text,p_id bigint) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare c record;oldrow jsonb;begin
 if inventory_global_private.allowed(p_catalog,'delete') is not true then raise exception using errcode='42501',message='Requiere permiso explícito de eliminación global.';end if;
 select * into c from inventory_global_private.catalog(p_catalog);perform pg_advisory_xact_lock(793103,1);
 execute format('select to_jsonb(x) from public.%I x where %I=$1 for update',c.t,c.pk) into oldrow using p_id;
 if oldrow is null or p_id is null or p_id<=0 then raise exception using errcode='55000',message='El registro ya no existe.';end if;
 if inventory_global_private.used(c.t,p_id) then raise exception using errcode='55000',message='El catálogo tiene dependencias y no puede eliminarse.';end if;
 execute format('delete from public.%I where %I=$1',c.t,c.pk) using p_id;
end$$;
do $$declare c record;p record;col record;k text;begin
 foreach k in array array['item-types','product-categories','product-brands','product-groups','uom'] loop
 select * into c from inventory_global_private.catalog(k);execute format('alter table public.%I enable row level security',c.t);
 for p in select policyname from pg_policies where schemaname='public' and tablename=c.t loop execute format('drop policy %I on public.%I',p.policyname,c.t);end loop;
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',c.t);
 for col in select column_name from information_schema.columns where table_schema='public' and table_name=c.t loop execute format('revoke all (%I) on public.%I from public,anon,authenticated,service_role',col.column_name,c.t);end loop;
 execute format('grant select on public.%I to authenticated',c.t);
 execute format('create policy inventory_global_read on public.%I for select to authenticated using(inventory_global_private.allowed(%L,''view''))',c.t,k);
 end loop;
end$$;
revoke all on all functions in schema inventory_global_private from public,anon,authenticated,service_role;
grant execute on function inventory_global_private.allowed(text,text) to authenticated;
revoke all on function public.inventory_global_access(text),public.save_inventory_global(text,jsonb,bigint),public.delete_inventory_global(text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.inventory_global_access(text),public.save_inventory_global(text,jsonb,bigint),public.delete_inventory_global(text,bigint) to authenticated;
notify pgrst,'reload schema';
