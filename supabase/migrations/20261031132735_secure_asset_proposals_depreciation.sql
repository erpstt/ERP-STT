-- C-04: authorization and posting integrity of proposals and depreciation.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema asset_posting_private;
revoke all on schema asset_posting_private from public,anon,authenticated,service_role;
grant usage on schema asset_posting_private to authenticated;

create function asset_posting_private.identity() returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();begin
 if auth.uid() is null or public.app_user_id() is null or public.app_active_role_id() is null or sid is null
 or not exists(select 1 from public.user_subsidiaries where user_id=public.app_user_id() and subsidiary_id=sid)
 then raise exception using errcode='42501',message='Seleccione usuario, rol y subsidiaria autorizados.';end if;return sid;
end$$;
create function asset_posting_private.access(p_resource text,p_action text) returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.identity();begin perform public.security_assert_role_access(p_resource,p_action);return sid;end$$;
create function asset_posting_private.allowed(p_resource text,p_action text) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform asset_posting_private.access(p_resource,p_action);return true;exception when insufficient_privilege then return false;end$$;
create function asset_posting_private.manage() returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select exists(select 1 from public.role_permissions rp join public.permissions p using(permission_id) where rp.role_id=public.app_active_role_id() and p.code='fixed-assets:proposals:manage')
$$;
create function asset_posting_private.finite(n numeric) returns boolean language sql immutable set search_path=pg_catalog as $$select n is not null and n::text not in('NaN','Infinity','-Infinity')$$;
create function asset_posting_private.ids(p jsonb) returns bigint[] language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $$
declare ids bigint[];begin
 if p is null or jsonb_typeof(p)<>'array' or jsonb_array_length(p) not between 1 and 1000 then raise exception using errcode='22023',message='Seleccione entre 1 y 1000 registros.';end if;
 select array_agg(distinct value::bigint order by value::bigint) into ids from jsonb_array_elements_text(p);
 if cardinality(ids)<>jsonb_array_length(p) or exists(select 1 from unnest(ids) i where i is null or i<=0) then raise exception using errcode='22023',message='Los identificadores deben ser positivos y únicos.';end if;return ids;
end$$;
create function asset_posting_private.period(p_date date) returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare id bigint;sid bigint:=asset_posting_private.identity();begin
 select fiscal_period_id into id from public.fiscal_periods where subsidiary_id=sid and p_date between start_date and end_date
 and not is_closed and not coalesce(gl_closed,false) and not coalesce(is_inactive,false) order by start_date desc,fiscal_period_id desc limit 1 for share;
 if id is null then raise exception using errcode='55000',message='La fecha requiere un período contable abierto.';end if;return id;
end$$;
create function asset_posting_private.account(p_id bigint) returns void language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin if not exists(select 1 from public.chart_accounts a join public.account_subsidiaries s using(account_id) where a.account_id=p_id and s.subsidiary_id=asset_posting_private.identity() and s.is_active and a.accepts_entries and not a.is_inactive)
 then raise exception using errcode='42501',message='La cuenta contable no está habilitada para la subsidiaria activa.';end if;end$$;
create function asset_posting_private.dimensions(p_department bigint,p_cost bigint,p_class bigint) returns void language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.identity();begin
 if p_department is not null and not exists(select 1 from public.departments d where d.department_id=p_department and not d.is_inactive and(d.subsidiary_id=sid or exists(select 1 from public.department_subsidiaries s where s.department_id=d.department_id and s.subsidiary_id=sid))) then raise exception using errcode='42501',message='Departamento no disponible.';end if;
 if p_cost is not null and not exists(select 1 from public.cost_centers c left join public.customers cu using(customer_id) where c.cost_center_id=p_cost and c.subsidiary_id=sid and not c.is_inactive and(p_department is null or cu.department_id=p_department) and(p_class is null or c.class_id=p_class)) then raise exception using errcode='42501',message='Centro de costos no disponible o incoherente.';end if;
 if p_class is not null and not exists(select 1 from public.classes c where c.class_id=p_class and not c.is_inactive and(c.subsidiary_id=sid or exists(select 1 from public.class_subsidiaries s where s.class_id=c.class_id and s.subsidiary_id=sid))) then raise exception using errcode='42501',message='Clase no disponible.';end if;
end$$;

-- Keep original accounting algorithms behind guarded entry points.
alter function public.process_fixed_asset_proposals(jsonb) set schema asset_posting_private;
alter function public.fixed_asset_proposal_report(jsonb) set schema asset_posting_private;
alter function public.fixed_asset_depreciation_preview(date) set schema asset_posting_private;
alter function public.run_fixed_asset_depreciation(date,jsonb) set schema asset_posting_private;
alter function public.fixed_asset_options() set schema asset_posting_private;
alter function public.fixed_asset_proposal_origins(bigint) set schema asset_posting_private;
do $$declare body text;modified text;f regprocedure;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='asset_posting_private' and p.proname in('process_fixed_asset_proposals','fixed_asset_proposal_report','fixed_asset_depreciation_preview','run_fixed_asset_depreciation','fixed_asset_options','fixed_asset_proposal_origins') loop execute format('alter function %s set search_path=pg_catalog,public,pg_temp',f);end loop;
 body:=pg_get_functiondef('asset_posting_private.fixed_asset_proposal_report(jsonb)'::regprocedure);
 modified:=replace(body,'fixed_asset_options()','asset_posting_private.fixed_asset_options()');
 modified:=replace(modified,'exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)where ur.user_id=app_user_id()and p.code=''fixed-assets:proposals:manage'')',
 '(asset_posting_private.manage() and (asset_posting_private.allowed(''fixed-assets:asset-proposals'',''create'') or asset_posting_private.allowed(''fixed-assets:asset-proposals'',''edit''))),''canCapitalize'',(asset_posting_private.manage() and asset_posting_private.allowed(''fixed-assets:asset-proposals'',''create'')),''canDiscard'',(asset_posting_private.manage() and asset_posting_private.allowed(''fixed-assets:asset-proposals'',''edit''))');
 if modified=body or position('ur.user_id=app_user_id()' in modified)>0 then raise exception 'Unexpected proposal report authorization';end if;execute modified;
 -- Deterministic period selection matches the locked period guard.
 body:=pg_get_functiondef('asset_posting_private.run_fixed_asset_depreciation(date,jsonb)'::regprocedure);
 modified:=replace(body,'and not coalesce(is_inactive,false)limit 1','and not coalesce(is_inactive,false)order by start_date desc,fiscal_period_id desc limit 1');
 if modified=body then raise exception 'Unexpected depreciation period lookup';end if;execute modified;
 body:=pg_get_functiondef('asset_posting_private.fixed_asset_depreciation_preview(date)'::regprocedure);
 modified:=replace(body,'and p_date between start_date and end_date limit 1','and p_date between start_date and end_date order by start_date desc,fiscal_period_id desc limit 1');
 modified:=replace(modified,'where a.subsidiary_id=active_subsidiary_id()and','where c.subsidiary_id=a.subsidiary_id and c.is_active and a.subsidiary_id=active_subsidiary_id()and');
 modified:=replace(modified,'''closed'',is_closed','''closed'',(is_closed or coalesce(gl_closed,false) or coalesce(is_inactive,false))');
 if modified=body then raise exception 'Unexpected depreciation preview';end if;execute modified;
end$$;
create or replace function public.fixed_asset_proposal_access(p_write boolean default false) returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.identity();begin
 if p_write then if not asset_posting_private.manage() then raise exception using errcode='42501',message='El rol activo no puede procesar propuestas.';end if;
 else perform asset_posting_private.access('fixed-assets:asset-proposals','view');end if;return sid;
end$$;
create function public.fixed_asset_options() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform asset_posting_private.identity();if not(asset_posting_private.allowed('fixed-assets:asset-proposals','view') or asset_posting_private.allowed('fixed-assets:asset-depreciations','view') or asset_posting_private.allowed('fixed-assets:assets','view') or asset_posting_private.allowed('fixed-assets:reports','view') or asset_posting_private.allowed('fixed-assets:asset-categories','view') or asset_posting_private.allowed('fixed-assets:asset-transfers','view') or asset_posting_private.allowed('fixed-assets:asset-disposals','view') or asset_posting_private.allowed('fixed-assets:asset-maintenances','view')) then raise exception using errcode='42501',message='No tiene permiso para consultar opciones de activos.';end if;return asset_posting_private.fixed_asset_options();end$$;
create function public.fixed_asset_proposal_report(p_filters jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform asset_posting_private.access('fixed-assets:asset-proposals','view');return asset_posting_private.fixed_asset_proposal_report(p_filters);end$$;
create function public.fixed_asset_proposal_origins(p_asset_id bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform asset_posting_private.access('fixed-assets:assets','view');if not exists(select 1 from public.asset where asset_id=p_asset_id and subsidiary_id=asset_posting_private.identity()) then raise exception using errcode='42501',message='Activo no disponible.';end if;return asset_posting_private.fixed_asset_proposal_origins(p_asset_id);end$$;

create function public.process_fixed_asset_proposals(p_payload jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;ids bigint[];r public.activos_fijos_propuestas;kind text:=p_payload->>'action';begin
 sid:=asset_posting_private.access('fixed-assets:asset-proposals',case when kind='DISCARD' then 'edit' else 'create' end);
 perform public.fixed_asset_proposal_access(true);
 if kind is null or kind not in('CAPITALIZE','DISCARD') then raise exception using errcode='22023',message='Acción no válida.';end if;
 ids:=asset_posting_private.ids(p_payload->'ids');
 if(select count(*) from public.activos_fijos_propuestas where proposal_id=any(ids) and subsidiary_id=sid)<>cardinality(ids) then raise exception using errcode='42501',message='Propuestas no disponibles en la subsidiaria activa.';end if;
 -- Lock source headers/lines before proposals, matching source mutation triggers.
 perform 1 from public.journal j where j.subsidiary_id=sid and exists(select 1 from public.activos_fijos_propuestas p where p.proposal_id=any(ids) and p.transaction_id=j.transaction_id) order by j.journal_id for update;
 perform 1 from public.journal_line l join public.activos_fijos_propuestas p using(journal_line_id) where p.proposal_id=any(ids) and p.subsidiary_id=sid order by l.journal_line_id for update of l;
 perform 1 from public.gl_impact g join public.activos_fijos_propuestas p using(gl_impact_id) where p.proposal_id=any(ids) and p.subsidiary_id=sid order by g.gl_impact_id for update of g;
 perform 1 from public.activos_fijos_propuestas where proposal_id=any(ids) and subsidiary_id=sid order by proposal_id for update;
 perform asset_posting_private.period(nullif(p_payload->>'date','')::date);
 perform asset_posting_private.dimensions(nullif(p_payload->>'department_id','')::bigint,nullif(p_payload->>'cost_center_id','')::bigint,nullif(p_payload->>'class_id','')::bigint);
 for r in select * from public.activos_fijos_propuestas where proposal_id=any(ids) loop
  if r.subsidiary_id<>sid or r.status<>'PENDIENTE' then raise exception using errcode='55000',message='Una propuesta ya fue procesada.';end if;
  if not asset_posting_private.finite(r.amount_local) or r.amount_local<=0 or not asset_posting_private.finite(r.amount_foreign) or r.amount_foreign<=0 then raise exception using errcode='22023',message='Importe de origen inválido.';end if;
  if r.journal_line_id is not null then
   if not exists(select 1 from public.journal_line l join public.journal j using(journal_id) where l.journal_line_id=r.journal_line_id and j.subsidiary_id=sid and j.status='CONTABILIZADO' and j.transaction_id=r.transaction_id and l.account_id=r.account_id and j.currency_id=r.currency_id and j.journal_date=r.source_date and l.debit=r.amount_foreign and round(l.debit*j.exchange_rate,6)=r.amount_local) then raise exception using errcode='55000',message='La propuesta no coincide con su documento de origen.';end if;
  elsif r.gl_impact_id is not null then
   if not exists(select 1 from public.gl_impact g where g.gl_impact_id=r.gl_impact_id and g.subsidiary_id=sid and g.transaction_id=r.transaction_id and g.account_id=r.account_id and g.posting_date=r.source_date and g.debit_amount=r.amount_local and g.debit_fx=r.amount_foreign) then raise exception using errcode='55000',message='La propuesta no coincide con su mayor de origen.';end if;
  else raise exception using errcode='55000',message='La propuesta requiere un origen contable verificable.';end if;
  perform asset_posting_private.account(r.account_id);perform asset_posting_private.dimensions(r.department_id,r.cost_center_id,r.class_id);
 end loop;
 return asset_posting_private.process_fixed_asset_proposals(p_payload);
end$$;
create function public.fixed_asset_depreciation_preview(p_date date) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform asset_posting_private.access('fixed-assets:asset-depreciations','view');return asset_posting_private.fixed_asset_depreciation_preview(p_date);end$$;
create function public.run_fixed_asset_depreciation(p_date date,p_asset_ids jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=asset_posting_private.access('fixed-assets:asset-depreciations','create');ids bigint[];r record;begin
 ids:=asset_posting_private.ids(p_asset_ids);
 if(select count(*) from public.asset where asset_id=any(ids) and subsidiary_id=sid)<>cardinality(ids) then raise exception using errcode='42501',message='Activos no disponibles en la subsidiaria activa.';end if;
 perform asset_posting_private.period(p_date);
 perform 1 from public.asset where asset_id=any(ids) and subsidiary_id=sid order by asset_id for update;
 perform 1 from public.asset_category c where exists(select 1 from public.asset a where a.asset_id=any(ids) and a.category_id=c.category_id) order by c.category_id for share;
 for r in select a.*,c.subsidiary_id category_subsidiary,c.useful_life_months,c.residual_value_percentage,c.depreciation_method,c.depreciation_account_id,c.depreciation_expense_account_id,c.is_active category_active from public.asset a join public.asset_category c using(category_id) where a.asset_id=any(ids) loop
  if r.subsidiary_id<>sid or r.category_subsidiary<>sid or not r.category_active then raise exception using errcode='42501',message='La categoría no está activa en la subsidiaria.';end if;
  if not asset_posting_private.finite(r.purchase_cost) or r.purchase_cost<0 or not asset_posting_private.finite(r.exchange_rate) or r.exchange_rate<=0 or not asset_posting_private.finite(r.residual_value_percentage) or r.residual_value_percentage not between 0 and 100 or r.useful_life_months<=0 then raise exception using errcode='22023',message='Revise costo, cambio, residual y vida útil del activo.';end if;
  perform asset_posting_private.dimensions(r.department_id,r.cost_center_id,r.class_id);
  if r.depreciation_method<>'No Depreciable' then perform asset_posting_private.account(r.depreciation_account_id);perform asset_posting_private.account(r.depreciation_expense_account_id);if r.depreciation_account_id=r.depreciation_expense_account_id then raise exception using errcode='22023',message='Las cuentas de depreciación deben ser diferentes.';end if;end if;
  if exists(select 1 from public.asset_depreciation d where d.asset_id=r.asset_id and(not asset_posting_private.finite(d.depreciation_amount) or not asset_posting_private.finite(d.accumulated_depreciation) or d.depreciation_amount<0 or d.accumulated_depreciation<0)) then raise exception using errcode='55000',message='El activo requiere revisión de su historial de depreciación.';end if;
 end loop;
 return asset_posting_private.run_fixed_asset_depreciation(p_date,to_jsonb(ids));
end$$;

-- Read-only workflow tables: all changes must use the authorized posting functions.
do $$declare t text;p record;begin foreach t in array array['activos_fijos_propuestas','fixed_asset_proposal_allocation','asset_depreciation'] loop
 execute format('alter table public.%I enable row level security',t);
 for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 execute format('grant select on public.%I to authenticated',t);
end loop;end$$;
create policy asset_proposal_read on public.activos_fijos_propuestas for select to authenticated using(subsidiary_id=asset_posting_private.identity() and asset_posting_private.allowed('fixed-assets:asset-proposals','view'));
create function asset_posting_private.asset_visible(p_id bigint,p_resource text) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin return asset_posting_private.allowed(p_resource,'view') and exists(select 1 from public.asset where asset_id=p_id and subsidiary_id=asset_posting_private.identity());end$$;
create policy asset_allocation_read on public.fixed_asset_proposal_allocation for select to authenticated using(asset_posting_private.asset_visible(asset_id,'fixed-assets:assets') or exists(select 1 from public.activos_fijos_propuestas p where p.proposal_id=fixed_asset_proposal_allocation.proposal_id));
create policy asset_depreciation_read on public.asset_depreciation for select to authenticated using(asset_posting_private.asset_visible(asset_id,'fixed-assets:asset-depreciations'));

revoke all on all functions in schema asset_posting_private from public,anon,authenticated,service_role;
grant execute on function asset_posting_private.identity(),asset_posting_private.allowed(text,text),asset_posting_private.asset_visible(bigint,text) to authenticated;
revoke all on function public.fixed_asset_proposal_access(boolean),public.capture_fixed_asset_journal_line(bigint) from public,anon,authenticated,service_role;
revoke all on function public.fixed_asset_options(),public.fixed_asset_proposal_report(jsonb),public.process_fixed_asset_proposals(jsonb),public.fixed_asset_proposal_origins(bigint),public.fixed_asset_depreciation_preview(date),public.run_fixed_asset_depreciation(date,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.fixed_asset_options(),public.fixed_asset_proposal_report(jsonb),public.process_fixed_asset_proposals(jsonb),public.fixed_asset_proposal_origins(bigint),public.fixed_asset_depreciation_preview(date),public.run_fixed_asset_depreciation(date,jsonb) to authenticated;
notify pgrst,'reload schema';
