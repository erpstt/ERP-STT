-- C-03: financial consolidation is an explicitly authorized, complete-group operation.
-- Apply atomically. No financial data is updated by this migration.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create schema consolidation_private;
revoke all on schema consolidation_private from public, anon, authenticated, service_role;
grant usage on schema consolidation_private to authenticated;

-- Keep the reviewed calculation bodies, but remove them from the exposed API.
alter function public.consolidation_translate(bigint) set schema consolidation_private;
alter function public.consolidation_process(bigint) set schema consolidation_private;
alter function public.consolidation_worksheet_data(bigint) set schema consolidation_private;
alter function public.consolidation_publish(bigint) set schema consolidation_private;
alter function consolidation_private.consolidation_translate(bigint) set search_path=pg_catalog,public,pg_temp;
alter function consolidation_private.consolidation_process(bigint) set search_path=pg_catalog,public,pg_temp;
alter function consolidation_private.consolidation_worksheet_data(bigint) set search_path=pg_catalog,public,pg_temp;
alter function consolidation_private.consolidation_publish(bigint) set search_path=pg_catalog,public,pg_temp;

-- The legacy translation looked up a source/period without the holding or target.
do $$declare body text;original text;
begin
  original:=pg_get_functiondef('consolidation_private.consolidation_translate(bigint)'::regprocedure);
  body:=replace(original,'where source_subsidiary_id=rec.subsidiary_id and period=r.period',
    'where holding_subsidiary_id=r.holding_subsidiary_id and to_currency_id=r.presentation_currency_id and source_subsidiary_id=rec.subsidiary_id and period=r.period');
  if body=original then raise exception 'Unexpected translation definition; review before migrating.';end if;
  execute body;
end$$;

-- Preserve the existing argument name for compatibility; $1 is unambiguous.
create or replace function public.consolidation_has_permission(code text)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select public.app_user_id() is not null and exists (
    select 1 from public.user_roles ur
    join public.role_permissions rp on rp.role_id=ur.role_id
    join public.permissions p on p.permission_id=rp.permission_id
    where ur.user_id=public.app_user_id()
      and ur.role_id=public.app_active_role_id() and p.code=$1
  )
$$;

create function consolidation_private.assert_scope(p_period text default null)
returns bigint language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare uid bigint:=public.app_user_id(); hid bigint:=public.consolidation_holding_subsidiary_id();
begin
  if auth.uid() is null or uid is null or public.app_active_role_id() is null
     or hid is null or public.active_subsidiary_id() is distinct from hid
     or not exists(select 1 from public.user_subsidiaries m where m.user_id=uid and m.subsidiary_id=hid)
     or exists (
       select 1 from public.subsidiaries s
       where (s.is_active or (p_period is not null and exists (
         select 1 from public.gl_impact g where g.subsidiary_id=s.subsidiary_id
           and to_char(g.posting_date,'YYYY-MM')=p_period
       ))) and not exists (
         select 1 from public.user_subsidiaries m where m.user_id=uid and m.subsidiary_id=s.subsidiary_id
       )
     ) then
    raise exception using errcode='42501',message='La consolidación requiere la holding activa y acceso a todas las filiales incluidas.';
  end if;
  return hid;
end
$$;

create function consolidation_private.assert_access(p_action text, p_permission text default null, p_period text default null)
returns bigint language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare hid bigint;
begin
  hid:=consolidation_private.assert_scope(p_period);
  perform public.security_assert_role_access('consolidation:financial-consolidation',p_action);
  if p_permission is not null and not public.consolidation_has_permission(p_permission) then
    raise exception using errcode='42501',message='El rol activo no tiene el permiso técnico de consolidación requerido.';
  end if;
  return hid;
end
$$;

-- Authorize before returning any run data; serialize writes on the parent row.
create function consolidation_private.lock_run(p_run bigint, p_action text, p_permission text)
returns public.consolidation_runs language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.consolidation_runs; hid bigint;
begin
  hid:=consolidation_private.assert_access(p_action,p_permission);
  select * into r from public.consolidation_runs where id=p_run and holding_subsidiary_id=hid for update;
  if not found then raise exception using errcode='42501',message='Consolidación no disponible para esta sesión.';end if;
  perform consolidation_private.assert_scope(r.period);
  if exists(select 1 from public.consolidation_worksheet w where w.run_id=r.id and not exists (
    select 1 from public.user_subsidiaries m where m.user_id=public.app_user_id() and m.subsidiary_id=w.subsidiary_id
  )) then raise exception using errcode='42501',message='Consolidación no disponible para esta sesión.';end if;
  return r;
end
$$;

create function consolidation_private.can_read_run(p_run bigint)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.consolidation_runs; hid bigint;
begin
  hid:=consolidation_private.assert_access('view');
  select * into r from public.consolidation_runs where id=p_run and holding_subsidiary_id=hid;
  if not found then return false;end if;
  perform consolidation_private.assert_scope(r.period);
  return not exists(select 1 from public.consolidation_worksheet w where w.run_id=r.id and not exists (
    select 1 from public.user_subsidiaries m where m.user_id=public.app_user_id() and m.subsidiary_id=w.subsidiary_id
  ));
exception when insufficient_privilege then return false;
end
$$;

create or replace function public.consolidation_options()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare hid bigint; result jsonb;
begin
  hid:=consolidation_private.assert_access('view');
  select jsonb_build_object(
    'holding',(select jsonb_build_object('id',s.subsidiary_id,'name',s.name) from public.subsidiaries s where s.subsidiary_id=hid),
    'currency',(select jsonb_build_object('id',c.currency_id,'code',c.currency_code) from public.currencies c where c.currency_code='USD'),
    'periods',coalesce((select jsonb_agg(q.period order by q.period desc) from (
      select distinct to_char(f.end_date,'YYYY-MM') period from public.fiscal_periods f
      join public.user_subsidiaries m on m.subsidiary_id=f.subsidiary_id and m.user_id=public.app_user_id()
    )q),'[]'::jsonb),
    'runs',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'period',r.period,'status',r.status,
      'assets',r.total_assets,'liabilities',r.total_liabilities,'equity',r.total_equity,'cta',r.cta_oci) order by r.id desc)
      from public.consolidation_runs r where r.holding_subsidiary_id=hid and consolidation_private.can_read_run(r.id)),'[]'::jsonb),
    'canRun',public.consolidation_has_permission('ACC_CONSOLIDATION_RUN'),
    'canPublish',public.consolidation_has_permission('ACC_CONSOLIDATION_PUBLISH')
  ) into result;
  return result;
end
$$;

create or replace function public.consolidation_init(p_period varchar)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare hid bigint;usd bigint;rid bigint;r public.consolidation_runs;open_details jsonb;rate_details jsonb;
begin
  hid:=consolidation_private.assert_access('create','ACC_CONSOLIDATION_RUN',p_period);
  if p_period is null or p_period!~'^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception using errcode='22023',message='Período inválido.';
  end if;
  -- Serialize concurrent initializations of the same group and period.
  perform pg_advisory_xact_lock(hashtextextended('consolidation:'||hid||':'||p_period,0));
  select * into r from public.consolidation_runs where holding_subsidiary_id=hid and period=p_period for update;
  if found then
    if r.status in ('PUBLICADO','ANULADO') then
      raise exception using errcode='55000',message='No puede reiniciar una consolidación publicada o anulada.';
    end if;
    if not consolidation_private.can_read_run(r.id) then raise exception using errcode='42501',message='Consolidación no disponible para esta sesión.';end if;
    return jsonb_build_object('ready',true,'id',r.id,'status',r.status);
  end if;
  select currency_id into usd from public.currencies where currency_code='USD';
  if usd is null then raise exception using errcode='22023',message='Configure la moneda USD.';end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',q.subsidiary_id,'name',q.name,'period',p_period,
    'status',case when q.fiscal_period_id is null then 'PERIODO_NO_CREADO' else 'PENDIENTE_DE_CIERRE' end) order by q.name),'[]'::jsonb)
  into open_details from (
    select s.subsidiary_id,s.name,f.fiscal_period_id from public.subsidiaries s
    left join lateral(select fp.fiscal_period_id from public.fiscal_periods fp
      where fp.subsidiary_id=s.subsidiary_id and to_char(fp.end_date,'YYYY-MM')=p_period order by fp.fiscal_period_id limit 1)f on true
    where s.is_active and s.subsidiary_id<>hid and not exists(select 1 from public.fiscal_periods fp
      where fp.subsidiary_id=s.subsidiary_id and to_char(fp.end_date,'YYYY-MM')=p_period and fp.is_closed)
  )q;
  select coalesce(jsonb_agg(jsonb_build_object('id',s.subsidiary_id,'name',s.name,'period',p_period,
    'fromCurrency',c.currency_code,'toCurrency','USD','status','TASA_NO_REGISTRADA') order by s.name),'[]'::jsonb)
  into rate_details from public.subsidiaries s join public.currencies c using(currency_id)
  where s.is_active and s.subsidiary_id<>hid and s.currency_id<>usd and not exists(
    select 1 from public.consolidated_exchange_rates x where x.holding_subsidiary_id=hid
      and x.source_subsidiary_id=s.subsidiary_id and x.period=p_period and x.to_currency_id=usd
  );
  if jsonb_array_length(open_details)>0 or jsonb_array_length(rate_details)>0 then
    return jsonb_build_object('ready',false,'openSubsidiaries',jsonb_array_length(open_details),
      'missingRates',jsonb_array_length(rate_details),'openSubsidiaryDetails',open_details,'missingRateDetails',rate_details);
  end if;
  insert into public.consolidation_runs(holding_subsidiary_id,period,presentation_currency_id,status)
    values(hid,p_period,usd,'VALIDADO') returning id into rid;
  return jsonb_build_object('ready',true,'id',rid,'status','VALIDADO');
end
$$;

create function public.consolidation_translate(p_run bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.consolidation_runs;
begin
  r:=consolidation_private.lock_run(p_run,'edit','ACC_CONSOLIDATION_RUN');
  if r.status not in ('VALIDADO','CONVERTIDO') then
    raise exception using errcode='55000',message='Solo puede convertir una consolidación validada o convertida.';
  end if;
  return consolidation_private.consolidation_translate(p_run);
end
$$;

create function public.consolidation_process(p_run bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.consolidation_runs;
begin
  r:=consolidation_private.lock_run(p_run,'edit','ACC_CONSOLIDATION_RUN');
  if r.status<>'CONVERTIDO' then raise exception using errcode='55000',message='Solo puede procesar una consolidación convertida.';end if;
  return consolidation_private.consolidation_process(p_run);
end
$$;

create function public.consolidation_publish(p_run bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.consolidation_runs;
begin
  r:=consolidation_private.lock_run(p_run,'edit','ACC_CONSOLIDATION_PUBLISH');
  if r.status<>'PROCESADO' then raise exception using errcode='55000',message='Solo puede publicar una consolidación procesada.';end if;
  return consolidation_private.consolidation_publish(p_run);
end
$$;

create function public.consolidation_worksheet_data(p_run bigint)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if not consolidation_private.can_read_run(p_run) then
    raise exception using errcode='42501',message='Consolidación no disponible para esta sesión.';
  end if;
  return consolidation_private.consolidation_worksheet_data(p_run);
end
$$;

-- Protect terminal states even against accidental writes by trusted maintenance code.
create function consolidation_private.freeze_terminal_run()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if old.status in ('PUBLICADO','ANULADO') then
    raise exception using errcode='55000',message='La consolidación publicada o anulada es inmutable.';
  end if;
  if tg_op='DELETE' then return old;end if;
  return new;
end
$$;
create trigger consolidation_terminal_guard before update or delete on public.consolidation_runs
for each row execute function consolidation_private.freeze_terminal_run();

create function consolidation_private.freeze_terminal_child()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare old_run bigint;new_run bigint;r record;
begin
  if tg_op<>'INSERT' then old_run:=old.run_id;end if;
  if tg_op<>'DELETE' then new_run:=new.run_id;end if;
  for r in select status from public.consolidation_runs where id in (old_run,new_run) order by id for update loop
    if r.status in ('PUBLICADO','ANULADO') then
      raise exception using errcode='55000',message='La hoja y eliminaciones de una consolidación publicada o anulada son inmutables.';
    end if;
  end loop;
  if tg_op='DELETE' then return old;end if;
  return new;
end
$$;
create trigger consolidation_terminal_guard before insert or update or delete on public.consolidation_worksheet
for each row execute function consolidation_private.freeze_terminal_child();
create trigger consolidation_terminal_guard before insert or update or delete on public.consolidation_eliminations
for each row execute function consolidation_private.freeze_terminal_child();

-- Replace every permissive policy on these dedicated engine tables.
do $$declare p record;t text;
begin
  for p in select tablename,policyname from pg_policies where schemaname='public'
    and tablename in ('consolidation_runs','consolidation_worksheet','consolidation_eliminations') loop
    execute format('drop policy %I on public.%I',p.policyname,p.tablename);
  end loop;
  foreach t in array array['consolidation_runs','consolidation_worksheet','consolidation_eliminations'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy consolidation_read on public.%I for select to authenticated using (consolidation_private.can_read_run(%I))',
      t,case when t='consolidation_runs' then 'id' else 'run_id' end);
  end loop;
end$$;

revoke all on all functions in schema consolidation_private from public,anon,authenticated,service_role;
grant execute on function consolidation_private.can_read_run(bigint) to authenticated;
revoke all on function public.consolidation_options(),public.consolidation_init(varchar),
  public.consolidation_translate(bigint),public.consolidation_process(bigint),
  public.consolidation_worksheet_data(bigint),public.consolidation_publish(bigint),
  public.consolidation_has_permission(text) from public,anon,authenticated,service_role;
grant execute on function public.consolidation_options(),public.consolidation_init(varchar),
  public.consolidation_translate(bigint),public.consolidation_process(bigint),
  public.consolidation_worksheet_data(bigint),public.consolidation_publish(bigint),
  public.consolidation_has_permission(text) to authenticated;

notify pgrst,'reload schema';
