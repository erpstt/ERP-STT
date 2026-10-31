-- C-04: asset master and category entry points. No financial data migration.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema asset_master_private;
revoke all on schema asset_master_private from public,anon,authenticated,service_role;
grant usage on schema asset_master_private to authenticated;

create function asset_master_private.allowed(p_resource text) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$select asset_posting_private.allowed(p_resource,'view')$$;
create function asset_master_private.asset(p_id bigint) returns public.asset language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.asset;begin select * into r from public.asset where asset_id=p_id and subsidiary_id=asset_posting_private.identity() for update;if not found then raise exception using errcode='42501',message='Activo no disponible en la subsidiaria activa.';end if;return r;end$$;
create function asset_master_private.category(p_id bigint) returns public.asset_category language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.asset_category;begin select * into r from public.asset_category where category_id=p_id and subsidiary_id=asset_posting_private.identity() for update;if not found then raise exception using errcode='42501',message='Categoría no disponible en la subsidiaria activa.';end if;return r;end$$;
create function asset_master_private.payload(p jsonb) returns void language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 if p is null or jsonb_typeof(p)<>'object' then raise exception using errcode='22023',message='Datos inválidos.';end if;
 if p?'subsidiary_id' and (p->>'subsidiary_id')::bigint is distinct from asset_posting_private.identity() then raise exception using errcode='42501',message='La subsidiaria no corresponde a la activa.';end if;
 if p ?| array['is_opening_balance','opening_run_id','opening_reversed_at'] then raise exception using errcode='42501',message='Utilice el proceso autorizado de aperturas.';end if;
end$$;

-- Move original business functions without exposing an alternate unguarded alias.
alter function public.save_fixed_asset(jsonb,bigint) set schema asset_master_private;
alter function public.fixed_asset_report(jsonb) set schema asset_master_private;
alter function public.fixed_asset_detail(bigint) set schema asset_master_private;
alter function public.fixed_asset_analytics(jsonb) set schema asset_master_private;
alter function public.asset_category_options() set schema asset_master_private;
alter function public.asset_category_report(jsonb) set schema asset_master_private;
alter function public.save_asset_category(jsonb,bigint) set schema asset_master_private;
alter function public.delete_asset_category(bigint) set schema asset_master_private;
do $$declare f regprocedure;body text;modified text;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='asset_master_private' loop execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f);end loop;
 -- Preserve capitalization's own create/manage permissions; do not require master create.
 body:=pg_get_functiondef('asset_posting_private.process_fixed_asset_proposals(jsonb)'::regprocedure);
 modified:=regexp_replace(body,'(?<![a-zA-Z0-9_.])(?:public\.)?save_fixed_asset\(','asset_master_private.save_validated_asset(','g');
 if body=modified then raise exception 'Unexpected proposal master writer';end if;execute modified;
end$$;

create function asset_master_private.save_validated_asset(p jsonb,p_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.identity();r public.asset;c public.asset_category;cost numeric:=(p->>'cost')::numeric;rate numeric:=coalesce(nullif(p->>'rate','')::numeric,1);purchase date:=nullif(p->>'purchase_date','')::date;service date:=coalesce(nullif(p->>'service_date','')::date,purchase);state text:=coalesce(p->>'status','ACTIVO');changed boolean;
begin
 perform asset_master_private.payload(p);
 if p_id is not null then r:=asset_master_private.asset(p_id);end if;
 if not asset_posting_private.finite(cost) or cost<0 or not asset_posting_private.finite(rate) or rate<>1 or purchase is null or service is null or service<purchase or state not in('ACTIVO','INACTIVO','BAJA') or nullif(trim(p->>'name'),'') is null then raise exception using errcode='22023',message='Revise nombre, costo, fechas, estado y cambio local.';end if;
 if (state='BAJA' and (p_id is null or r.status<>'BAJA')) or (p_id is not null and r.status='BAJA' and state<>'BAJA') then raise exception using errcode='55000',message='La baja o su reversión requieren el proceso de operaciones.';end if;
 if not exists(select 1 from public.subsidiaries s join public.subsidiary_currencies sc using(subsidiary_id) where s.subsidiary_id=sid and s.currency_id=(p->>'currency_id')::bigint and sc.currency_id=s.currency_id) then raise exception using errcode='42501',message='Utilice la moneda funcional de la subsidiaria.';end if;
 select * into c from public.asset_category where category_id=(p->>'category_id')::bigint and subsidiary_id=sid and is_active for share;
 if not found then raise exception using errcode='42501',message='Categoría no disponible en la subsidiaria activa.';end if;
 perform asset_posting_private.account(c.asset_account_id);perform asset_posting_private.account(c.depreciation_account_id);if c.depreciation_expense_account_id is not null then perform asset_posting_private.account(c.depreciation_expense_account_id);end if;
 if not exists(select 1 from public.locations l where l.location_id=(p->>'location_id')::bigint and(l.subsidiary_id=sid or exists(select 1 from public.location_subsidiaries s where s.location_id=l.location_id and s.subsidiary_id=sid))) then raise exception using errcode='42501',message='Ubicación no disponible.';end if;
 perform asset_posting_private.dimensions(nullif(p->>'department_id','')::bigint,nullif(p->>'cost_center_id','')::bigint,nullif(p->>'class_id','')::bigint);
 if p_id is not null then
  changed:=(cost,c.category_id,(p->>'currency_id')::bigint,rate,purchase,service) is distinct from(r.purchase_cost,r.category_id,r.currency_id,r.exchange_rate,r.purchase_date,r.in_service_date);
  if changed and(exists(select 1 from public.asset_depreciation where asset_id=p_id) or r.is_opening_balance or r.opening_run_id is not null) then raise exception using errcode='55000',message='Los valores históricos de un activo depreciado o de apertura no pueden cambiar.';end if;
  if exists(select 1 from public.fixed_asset_proposal_allocation where asset_id=p_id) and(cost,c.category_id,(p->>'currency_id')::bigint) is distinct from(r.purchase_cost,r.category_id,r.currency_id) then raise exception using errcode='55000',message='Los valores capitalizados no pueden cambiar.';end if;
  if r.opening_reversed_at is not null and state is distinct from r.status then raise exception using errcode='55000',message='El activo de apertura fue revertido.';end if;
 end if;
 return asset_master_private.save_fixed_asset(p,p_id);
end$$;
create function asset_master_private.save_validated_category(p jsonb,p_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.asset_category;residual numeric:=coalesce(nullif(p->>'residual','')::numeric,0);life integer:=coalesce(nullif(p->>'useful_life_months','')::integer,1);method text:=p->>'method';a bigint:=(p->>'asset_account_id')::bigint;d bigint:=(p->>'depreciation_account_id')::bigint;e bigint:=nullif(p->>'expense_account_id','')::bigint;
begin
 perform asset_master_private.payload(p);
 if p_id is not null then r:=asset_master_private.category(p_id);end if;
 if nullif(trim(p->>'name'),'') is null or nullif(trim(p->>'code'),'') is null or method is null or method not in('Línea Recta','Suma de los Dígitos de los Años','No Depreciable') or not asset_posting_private.finite(residual) or residual not between 0 and 100 or life<=0 or a is null or d is null or a=d or(e is not null and(e=a or e=d)) or(method<>'No Depreciable' and e is null) then raise exception using errcode='22023',message='Revise nombre, código, método, vida útil, residual y cuentas.';end if;
 perform asset_posting_private.account(a);perform asset_posting_private.account(d);if e is not null then perform asset_posting_private.account(e);end if;
 if not public.account_belongs_to_group(a,'propiedad.*planta.*equipo') or not public.account_belongs_to_group(d,'depreciaci.n acumulada') or(e is not null and not public.account_belongs_to_group(e,'depreciaci.n y amortizaci.n')) then raise exception using errcode='22023',message='Las cuentas no pertenecen a los grupos contables requeridos.';end if;
 if p_id is not null and exists(select 1 from public.asset where category_id=p_id) and(a,d,e,method,case when method='No Depreciable' then 1 else life end,residual) is distinct from(r.asset_account_id,r.depreciation_account_id,r.depreciation_expense_account_id,r.depreciation_method,r.useful_life_months,r.residual_value_percentage) then raise exception using errcode='55000',message='La definición contable de una categoría con activos no puede cambiar.';end if;
 return asset_master_private.save_asset_category(p,p_id);
end$$;

create function public.save_fixed_asset(p_payload jsonb,p_asset_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform asset_posting_private.access('fixed-assets:assets',case when p_asset_id is null then 'create' else 'edit' end);return asset_master_private.save_validated_asset(p_payload,p_asset_id);end$$;
create function public.save_asset_category(p_payload jsonb,p_category_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform asset_posting_private.access('fixed-assets:asset-categories',case when p_category_id is null then 'create' else 'edit' end);return asset_master_private.save_validated_category(p_payload,p_category_id);end$$;
create function public.delete_asset_category(p_category_id bigint) returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform asset_posting_private.access('fixed-assets:asset-categories','delete');perform asset_master_private.category(p_category_id);
 if exists(select 1 from public.asset where category_id=p_category_id) or exists(select 1 from public.opening_fixed_asset_lines where category_id=p_category_id) then raise exception using errcode='55000',message='La categoría está vinculada a activos o aperturas; puede inactivarla.';end if;return asset_master_private.delete_asset_category(p_category_id);end$$;
create function public.delete_fixed_asset(p_asset_id bigint) returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.asset;begin perform asset_posting_private.access('fixed-assets:assets','delete');r:=asset_master_private.asset(p_asset_id);
 if r.is_opening_balance or r.opening_run_id is not null or r.status='BAJA' or exists(select 1 from public.asset_depreciation where asset_id=p_asset_id) or exists(select 1 from public.fixed_asset_proposal_allocation where asset_id=p_asset_id) or exists(select 1 from public.asset_transfer where asset_id=p_asset_id) or exists(select 1 from public.asset_disposal where asset_id=p_asset_id) or exists(select 1 from public.asset_maintenance where asset_id=p_asset_id) or exists(select 1 from public.asset_revaluation where asset_id=p_asset_id) or exists(select 1 from public.asset_impairment where asset_id=p_asset_id) or exists(select 1 from public.opening_fixed_asset_lines where created_asset_id=p_asset_id) then raise exception using errcode='55000',message='El activo tiene historial; no puede eliminarse desde el maestro.';end if;
 delete from public.asset where asset_id=p_asset_id and subsidiary_id=asset_posting_private.identity();return true;
end$$;
create function public.fixed_asset_report(p_filters jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform asset_posting_private.access('fixed-assets:assets','view');return asset_master_private.fixed_asset_report(p_filters)||jsonb_build_object('permissions',jsonb_build_object('canCreate',asset_posting_private.allowed('fixed-assets:assets','create'),'canEdit',asset_posting_private.allowed('fixed-assets:assets','edit'),'canDelete',asset_posting_private.allowed('fixed-assets:assets','delete')));end$$;
create function public.fixed_asset_detail(p_asset_id bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform asset_posting_private.access('fixed-assets:assets','view');if not exists(select 1 from public.asset where asset_id=p_asset_id and subsidiary_id=asset_posting_private.identity()) then raise exception using errcode='42501',message='Activo no disponible.';end if;return asset_master_private.fixed_asset_detail(p_asset_id);end$$;
create function public.fixed_asset_analytics(p_filters jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform asset_posting_private.access('fixed-assets:reports','view');if nullif(p_filters->>'assetId','') is not null and not exists(select 1 from public.asset where asset_id=(p_filters->>'assetId')::bigint and subsidiary_id=asset_posting_private.identity()) then raise exception using errcode='42501',message='Activo no disponible.';end if;return asset_master_private.fixed_asset_analytics(p_filters);end$$;
create function public.asset_category_report(p_filters jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform asset_posting_private.access('fixed-assets:asset-categories','view');return asset_master_private.asset_category_report(p_filters)||jsonb_build_object('permissions',jsonb_build_object('canCreate',asset_posting_private.allowed('fixed-assets:asset-categories','create'),'canEdit',asset_posting_private.allowed('fixed-assets:asset-categories','edit'),'canDelete',asset_posting_private.allowed('fixed-assets:asset-categories','delete')));end$$;
create function public.asset_category_options() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform asset_posting_private.access('fixed-assets:asset-categories','view');return asset_master_private.asset_category_options();end$$;

-- Generic catalog routes merge only their declared fields into the same validated writer.
-- Their edit action does not require the separate view grant and preserves hidden fields.
create function public.save_fixed_asset_catalog(p_payload jsonb,p_asset_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.asset;p jsonb;k text;mapping jsonb:='{"asset_name":"name","category_id":"category_id","location_id":"location_id","currency_id":"currency_id","purchase_date":"purchase_date","purchase_cost":"cost"}';result jsonb;
begin perform asset_posting_private.access('fixed-assets:assets',case when p_asset_id is null then 'create' else 'edit' end);perform asset_master_private.payload(p_payload);
 if p_asset_id is not null then r:=asset_master_private.asset(p_asset_id);end if;
 p:=jsonb_build_object('name',r.asset_name,'description',r.description,'serial',r.serial_number,'category_id',r.category_id,'location_id',r.location_id,'currency_id',r.currency_id,'purchase_date',r.purchase_date,'service_date',r.in_service_date,'cost',r.purchase_cost,'rate',coalesce(r.exchange_rate,1),'department_id',r.department_id,'cost_center_id',r.cost_center_id,'class_id',r.class_id,'status',coalesce(r.status,'ACTIVO'));
 for k in select jsonb_object_keys(mapping) loop if p_payload?k then p:=p||jsonb_build_object(mapping->>k,p_payload->k);end if;end loop;
 result:=asset_master_private.save_validated_asset(p,p_asset_id);return(select to_jsonb(a) from public.asset a where asset_id=(result->>'id')::bigint);
end$$;
create function public.save_asset_category_catalog(p_payload jsonb,p_category_id bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.asset_category;p jsonb;k text;mapping jsonb:='{"category_name":"name","useful_life_months":"useful_life_months","depreciation_method":"method","asset_account_id":"asset_account_id","depreciation_account_id":"depreciation_account_id","depreciation_expense_account_id":"expense_account_id"}';result jsonb;
begin perform asset_posting_private.access('fixed-assets:asset-categories',case when p_category_id is null then 'create' else 'edit' end);perform asset_master_private.payload(p_payload);
 if p_category_id is not null then r:=asset_master_private.category(p_category_id);end if;
 p:=jsonb_build_object('name',r.category_name,'code',coalesce(r.category_code,'AUTO'),'description',r.description,'useful_life_months',r.useful_life_months,'method',r.depreciation_method,'residual',coalesce(r.residual_value_percentage,0),'asset_account_id',r.asset_account_id,'depreciation_account_id',r.depreciation_account_id,'expense_account_id',r.depreciation_expense_account_id,'active',coalesce(r.is_active,true));
 for k in select jsonb_object_keys(mapping) loop if p_payload?k then p:=p||jsonb_build_object(mapping->>k,p_payload->k);end if;end loop;
 result:=asset_master_private.save_validated_category(p,p_category_id);return(select to_jsonb(c) from public.asset_category c where category_id=(result->>'id')::bigint);
end$$;

do $$declare t text;p record;begin foreach t in array array['asset','asset_category'] loop
 execute format('alter table public.%I enable row level security',t);for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);execute format('grant select on public.%I to authenticated',t);
end loop;end$$;
create policy asset_master_read on public.asset for select to authenticated using(subsidiary_id=asset_posting_private.identity() and asset_master_private.allowed('fixed-assets:assets'));
create policy asset_category_read on public.asset_category for select to authenticated using(subsidiary_id=asset_posting_private.identity() and asset_master_private.allowed('fixed-assets:asset-categories'));
revoke all on all functions in schema asset_master_private from public,anon,authenticated,service_role;
grant execute on function asset_master_private.allowed(text) to authenticated;
do $$declare f regprocedure;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('save_fixed_asset','fixed_asset_report','fixed_asset_detail','fixed_asset_analytics','asset_category_options','asset_category_report','save_asset_category','delete_asset_category','delete_fixed_asset','save_fixed_asset_catalog','save_asset_category_catalog') loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;
end$$;
notify pgrst,'reload schema';
