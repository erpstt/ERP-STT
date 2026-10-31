-- C-04: registration of transfers, disposal and maintenance; no new ledger posting.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema asset_operation_private;
revoke all on schema asset_operation_private from public,anon,authenticated,service_role;
grant usage on schema asset_operation_private to authenticated;
create function asset_operation_private.resource(p_type text) returns text language plpgsql immutable set search_path=pg_catalog as $$begin
 return case p_type when 'TRANSFER' then 'fixed-assets:asset-transfers' when 'DISPOSAL' then 'fixed-assets:asset-disposals' when 'MAINTENANCE' then 'fixed-assets:asset-maintenances' else null end;
end$$;
create function asset_operation_private.access(p_type text,p_action text) returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare resource text:=asset_operation_private.resource(p_type);begin if resource is null then raise exception using errcode='22023',message='Tipo de operación inválido.';end if;return asset_posting_private.access(resource,p_action);end$$;
create function asset_operation_private.target(p_sid bigint,p_location bigint,p_date date) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if not exists(select 1 from public.subsidiaries s join public.user_subsidiaries u using(subsidiary_id) where s.subsidiary_id=p_sid and s.is_active and u.user_id=public.app_user_id()) then raise exception using errcode='42501',message='Subsidiaria destino no autorizada.';end if;
 if not exists(select 1 from public.locations l where l.location_id=p_location and(l.subsidiary_id=p_sid or exists(select 1 from public.location_subsidiaries s where s.location_id=l.location_id and s.subsidiary_id=p_sid))) then raise exception using errcode='42501',message='Ubicación destino no disponible.';end if;
 perform 1 from public.fiscal_periods where subsidiary_id=p_sid and p_date between start_date and end_date and not is_closed and not coalesce(gl_closed,false) and not coalesce(is_inactive,false) order by fiscal_period_id for share;
 if not found then raise exception using errcode='55000',message='El destino requiere un período abierto.';end if;
end$$;
create function asset_operation_private.record(p_type text,p_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r jsonb;again jsonb;a public.asset;sid bigint:=asset_posting_private.identity();tab text;key text;begin
 tab:=case p_type when 'TRANSFER' then 'asset_transfer' when 'DISPOSAL' then 'asset_disposal' when 'MAINTENANCE' then 'asset_maintenance' end;
 key:=case p_type when 'TRANSFER' then 'transfer_id' when 'DISPOSAL' then 'disposal_id' when 'MAINTENANCE' then 'maintenance_id' end;
 if tab is null then raise exception using errcode='22023',message='Tipo inválido.';end if;
 execute format('select to_jsonb(x) from public.%I x join public.asset a using(asset_id) where x.%I=$1 and a.subsidiary_id=$2',tab,key) into r using p_id,sid;
 if r is null or(p_type='TRANSFER' and (r->>'source_subsidiary_id')::bigint is distinct from sid) then raise exception using errcode='42501',message='Operación no disponible en la subsidiaria activa.';end if;
 a:=asset_master_private.asset((r->>'asset_id')::bigint);
 execute format('select to_jsonb(x) from public.%I x where %I=$1 for update',tab,key) into again using p_id;
 if again is null or again->>'asset_id' is distinct from r->>'asset_id' then raise exception using errcode='55000',message='La operación cambió; vuelva a consultarla.';end if;return again;
end$$;
create function asset_operation_private.date(p_asset bigint,p_date date,p_type text,p_id bigint default null) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare a public.asset;begin
 a:=asset_master_private.asset(p_asset);perform asset_posting_private.period(p_date);
 if a.opening_reversed_at is not null or p_date<a.purchase_date or(a.is_opening_balance and p_date<=(select opening_date from public.opening_balance_runs where id=a.opening_run_id)) then raise exception using errcode='55000',message='La fecha o apertura del activo impide la operación.';end if;
 if exists(select 1 from public.asset_depreciation where asset_id=p_asset and not is_opening_balance and depreciation_date>p_date)
 or exists(select 1 from public.asset_revaluation where asset_id=p_asset and revaluation_date>p_date)
 or exists(select 1 from public.asset_impairment where asset_id=p_asset and assessment_date>p_date)
 or exists(select 1 from public.asset_transfer where asset_id=p_asset and transfer_date>p_date and(p_type<>'TRANSFER' or transfer_id is distinct from p_id))
 or exists(select 1 from public.asset_disposal where asset_id=p_asset and disposal_date>p_date and(p_type<>'DISPOSAL' or disposal_id is distinct from p_id))
 or exists(select 1 from public.asset_maintenance where asset_id=p_asset and status='COMPLETADO' and coalesce(completion_date,maintenance_date)>p_date and(p_type<>'MAINTENANCE' or maintenance_id is distinct from p_id)) then raise exception using errcode='55000',message='El activo tiene movimientos posteriores; revise su historial.';end if;
end$$;
create function asset_operation_private.mutable(p_type text,r jsonb) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare dt date:=(r->>case p_type when 'TRANSFER' then 'transfer_date' when 'DISPOSAL' then 'disposal_date' else 'maintenance_date' end)::date;key bigint:=(r->>case p_type when 'TRANSFER' then 'transfer_id' when 'DISPOSAL' then 'disposal_id' else 'maintenance_id' end)::bigint;
begin
 if p_type='MAINTENANCE' and r->>'status' in('COMPLETADO','CANCELADO') then raise exception using errcode='55000',message='El mantenimiento finalizado conserva su historial.';end if;
 if p_type='DISPOSAL' and nullif(r->>'transaction_id','') is not null then raise exception using errcode='55000',message='La baja está vinculada a una transacción contable.';end if;
 perform asset_operation_private.date((r->>'asset_id')::bigint,dt,p_type,key);
 if p_type='TRANSFER' then perform asset_operation_private.target((r->>'target_subsidiary_id')::bigint,(r->>'target_location_id')::bigint,dt);end if;
end$$;
alter function public.asset_operation_number(text,text,text) set schema asset_operation_private;
alter function public.save_fixed_asset_operation(jsonb,bigint) set schema asset_operation_private;
alter function public.delete_fixed_asset_operation(text,bigint) set schema asset_operation_private;
alter function public.fixed_asset_operation_report(jsonb) set schema asset_operation_private;
alter function public.fixed_asset_operation_options() set schema asset_operation_private;
do $$declare f regprocedure;body text;modified text;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='asset_operation_private' loop execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f);end loop;
 body:=pg_get_functiondef('asset_operation_private.save_fixed_asset_operation(jsonb,bigint)'::regprocedure);
 modified:=regexp_replace(body,'(?<![a-zA-Z0-9_.])(?:public\.)?asset_operation_number\(','asset_operation_private.asset_operation_number(','g');if body=modified then raise exception 'Unexpected operation numbering caller';end if;execute modified;
 body:=pg_get_functiondef('asset_operation_private.asset_operation_number(text,text,text)'::regprocedure);
 modified:=replace(body,'p_prefix||active_subsidiary_id()','''asset-operation:''||p_prefix');if body=modified then raise exception 'Unexpected numbering lock';end if;execute modified;
 body:=pg_get_functiondef('asset_operation_private.fixed_asset_operation_report(jsonb)'::regprocedure);
 modified:=replace(body,'where x.source_subsidiary_id=sid and','where x.source_subsidiary_id=sid and a.subsidiary_id=sid and');if body=modified then raise exception 'Unexpected transfer report scope';end if;execute modified;
end$$;
create function public.save_fixed_asset_operation(p_payload jsonb,p_operation_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare kind text:=p_payload->>'type';sid bigint;aid bigint;dt date;amount numeric;a public.asset;r jsonb;supplier bigint;completion date;begin
 sid:=asset_operation_private.access(kind,case when p_operation_id is null then 'create' else 'edit' end);perform asset_master_private.payload(p_payload);
 aid:=(p_payload->>'asset_id')::bigint;dt:=nullif(p_payload->>'date','')::date;
 if p_operation_id is not null then r:=asset_operation_private.record(kind,p_operation_id);if aid is distinct from(r->>'asset_id')::bigint then raise exception using errcode='42501',message='El activo original de una operación no puede sustituirse.';end if;perform asset_operation_private.mutable(kind,r);end if;
 a:=asset_master_private.asset(aid);perform asset_operation_private.date(aid,dt,kind,p_operation_id);
 if kind='DISPOSAL' and p_operation_id is not null and a.status<>'BAJA' then raise exception using errcode='55000',message='La ficha ya no corresponde a esta baja.';end if;
 if (kind<>'DISPOSAL' or p_operation_id is null) and a.status<>'ACTIVO' then raise exception using errcode='55000',message='La operación requiere un activo vigente.';end if;
 if kind='TRANSFER' then
  if (p_payload->>'target_subsidiary_id')::bigint=sid then raise exception using errcode='22023',message='Seleccione otra subsidiaria destino.';end if;
  if nullif(p_payload->>'source_location_id','') is not null and (p_payload->>'source_location_id')::bigint is distinct from a.location_id then raise exception using errcode='42501',message='La ubicación origen no coincide con el activo.';end if;
  perform asset_operation_private.target((p_payload->>'target_subsidiary_id')::bigint,(p_payload->>'target_location_id')::bigint,dt);p_payload:=p_payload||jsonb_build_object('source_location_id',a.location_id);
 elsif kind='DISPOSAL' then
  amount:=coalesce(nullif(p_payload->>'sale_amount','')::numeric,0);
  if p_payload->>'disposal_type' is null or p_payload->>'disposal_type' not in('BAJA','VENTA','DONACION','PERDIDA') or nullif(trim(p_payload->>'note'),'') is null or not asset_posting_private.finite(amount) or amount<0 or(p_payload->>'disposal_type'<>'VENTA' and amount<>0) then raise exception using errcode='22023',message='Revise tipo, motivo e importe de la baja.';end if;
  if not asset_posting_private.finite(a.purchase_cost) or a.purchase_cost<0 or exists(select 1 from public.asset_depreciation where asset_id=aid and(not asset_posting_private.finite(depreciation_amount) or depreciation_amount<0)) then raise exception using errcode='55000',message='Revise los valores históricos del activo.';end if;
  if exists(select 1 from public.asset_revaluation where asset_id=aid) or exists(select 1 from public.asset_impairment where asset_id=aid) then raise exception using errcode='55000',message='La baja requiere revisar las valoraciones del activo antes de calcular su resultado.';end if;
  if exists(select 1 from public.asset_disposal where asset_id=aid and disposal_id is distinct from p_operation_id) or exists(select 1 from public.asset_maintenance where asset_id=aid and status in('PROGRAMADO','EN PROCESO')) then raise exception using errcode='55000',message='El activo tiene otra baja o un mantenimiento pendiente.';end if;
 else
  amount:=coalesce(nullif(p_payload->>'cost','')::numeric,0);completion:=nullif(p_payload->>'completion_date','')::date;supplier:=nullif(p_payload->>'supplier_id','')::bigint;
  if p_payload->>'maintenance_type' is null or p_payload->>'maintenance_type' not in('PREVENTIVO','CORRECTIVO') or p_payload->>'status' is null or p_payload->>'status' not in('PROGRAMADO','EN PROCESO','COMPLETADO','CANCELADO') or nullif(trim(p_payload->>'description'),'') is null or not asset_posting_private.finite(amount) or amount<0 or(p_payload->>'status'='COMPLETADO' and(completion is null or completion<dt)) or(p_payload->>'status'<>'COMPLETADO' and completion is not null) then raise exception using errcode='22023',message='Revise estado, fechas, descripción y costo del mantenimiento.';end if;
  if r->>'status'='EN PROCESO' and p_payload->>'status'='PROGRAMADO' then raise exception using errcode='55000',message='Un mantenimiento iniciado no regresa a programado.';end if;
  if completion is not null then perform asset_operation_private.date(aid,completion,kind,p_operation_id);end if;
  if supplier is not null and not exists(select 1 from public.suppliers s where s.supplier_id=supplier and not s.is_inactive and(s.primary_subsidiary_id=sid or exists(select 1 from public.entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=sid))) then raise exception using errcode='42501',message='Proveedor no disponible.';end if;
 end if;
 return asset_operation_private.save_fixed_asset_operation(p_payload,p_operation_id);
end$$;
create function public.delete_fixed_asset_operation(p_type text,p_operation_id bigint) returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r jsonb;a public.asset;begin perform asset_operation_private.access(p_type,'delete');r:=asset_operation_private.record(p_type,p_operation_id);perform asset_operation_private.mutable(p_type,r);a:=asset_master_private.asset((r->>'asset_id')::bigint);
 if p_type='DISPOSAL' and a.status<>'BAJA' then raise exception using errcode='55000',message='La ficha ya no corresponde a la baja que intenta revertir.';end if;
 return asset_operation_private.delete_fixed_asset_operation(p_type,p_operation_id);
end$$;
create function public.fixed_asset_operation_report(p_filters jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare kind text:=p_filters->>'type';res text:=asset_operation_private.resource(kind);begin perform asset_operation_private.access(kind,'view');return asset_operation_private.fixed_asset_operation_report(p_filters)||jsonb_build_object('permissions',jsonb_build_object('canCreate',asset_posting_private.allowed(res,'create'),'canEdit',asset_posting_private.allowed(res,'edit'),'canDelete',asset_posting_private.allowed(res,'delete')));end$$;
create function public.fixed_asset_operation_options() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.identity();transfer boolean:=asset_posting_private.allowed('fixed-assets:asset-transfers','view');maintenance boolean:=asset_posting_private.allowed('fixed-assets:asset-maintenances','view');result jsonb;begin
 if not(transfer or maintenance or asset_posting_private.allowed('fixed-assets:asset-disposals','view')) then raise exception using errcode='42501',message='No puede consultar opciones de operaciones.';end if;
 select jsonb_build_object('subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currency',cu.currency_code),
 'assets',coalesce((select jsonb_agg(jsonb_build_object('id',a.asset_id,'number',a.asset_number,'name',a.asset_name,'status',a.status,'locationId',a.location_id,'cost',a.purchase_cost,'accumulated',coalesce(d.total,0),'bookValue',greatest(a.purchase_cost-coalesce(d.total,0),0)) order by a.asset_number) from public.asset a left join lateral(select sum(depreciation_amount) total from public.asset_depreciation where asset_id=a.asset_id)d on true where a.subsidiary_id=sid and a.opening_reversed_at is null),'[]'),
 'subsidiaries',coalesce((select jsonb_agg(jsonb_build_object('id',x.subsidiary_id,'name',x.name) order by x.name) from public.subsidiaries x join public.user_subsidiaries u using(subsidiary_id) where transfer and x.is_active and u.user_id=public.app_user_id()),'[]'),
 'locations',coalesce((select jsonb_agg(jsonb_build_object('id',q.location_id,'name',q.name,'subsidiaryId',q.subsidiary_id) order by q.name) from(select distinct l.location_id,l.name,x.subsidiary_id from public.locations l join public.subsidiaries x on(l.subsidiary_id=x.subsidiary_id or exists(select 1 from public.location_subsidiaries ls where ls.location_id=l.location_id and ls.subsidiary_id=x.subsidiary_id)) join public.user_subsidiaries u on u.subsidiary_id=x.subsidiary_id and u.user_id=public.app_user_id() where x.subsidiary_id=sid or(transfer and x.is_active))q),'[]'),
 'suppliers',coalesce((select jsonb_agg(jsonb_build_object('id',p.supplier_id,'name',p.company_name)) from public.suppliers p where maintenance and not p.is_inactive and(p.primary_subsidiary_id=sid or exists(select 1 from public.entity_subsidiaries e where e.supplier_id=p.supplier_id and e.subsidiary_id=sid))),'[]')) into result from public.subsidiaries s join public.currencies cu using(currency_id) where s.subsidiary_id=sid;return result;
end$$;
create function asset_operation_private.visible(p_type text,p_asset bigint,p_source bigint default null) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.identity();begin return asset_posting_private.allowed(asset_operation_private.resource(p_type),'view') and(p_source is null or p_source=sid) and exists(select 1 from public.asset where asset_id=p_asset and subsidiary_id=sid);end$$;
do $$declare t text;p record;begin foreach t in array array['asset_transfer','asset_disposal','asset_maintenance'] loop
 execute format('alter table public.%I enable row level security',t);for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);execute format('grant select on public.%I to authenticated',t);
end loop;end$$;
create policy asset_transfer_read on public.asset_transfer for select to authenticated using(asset_operation_private.visible('TRANSFER',asset_id,source_subsidiary_id));
create policy asset_disposal_read on public.asset_disposal for select to authenticated using(asset_operation_private.visible('DISPOSAL',asset_id));
create policy asset_maintenance_read on public.asset_maintenance for select to authenticated using(asset_operation_private.visible('MAINTENANCE',asset_id));
create unique index asset_disposal_single_asset_idx on public.asset_disposal(asset_id);
revoke all on all functions in schema asset_operation_private from public,anon,authenticated,service_role;
grant execute on function asset_operation_private.visible(text,bigint,bigint) to authenticated;
revoke all on function public.fixed_asset_operation_options(),public.fixed_asset_operation_report(jsonb),public.save_fixed_asset_operation(jsonb,bigint),public.delete_fixed_asset_operation(text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.fixed_asset_operation_options(),public.fixed_asset_operation_report(jsonb),public.save_fixed_asset_operation(jsonb,bigint),public.delete_fixed_asset_operation(text,bigint) to authenticated;
notify pgrst,'reload schema';
