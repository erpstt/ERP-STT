-- C-04: interactive manual journals; existing business posting bodies are retained.
set local lock_timeout='5s';
set local statement_timeout='30s';
create schema journal_entry_private;
revoke all on schema journal_entry_private from public,anon,authenticated,service_role;
alter function public.create_journal_entry(jsonb) set schema journal_entry_private;
alter function public.update_journal_entry(bigint,jsonb) set schema journal_entry_private;
alter function public.import_journal_csv(jsonb,boolean,bigint) set schema journal_entry_private;
alter function public.reverse_journal_entry(bigint) set schema journal_entry_private;
alter function journal_entry_private.create_journal_entry(jsonb) set search_path=pg_catalog,public,pg_temp;
alter function journal_entry_private.update_journal_entry(bigint,jsonb) set search_path=pg_catalog,public,pg_temp;
alter function journal_entry_private.import_journal_csv(jsonb,boolean,bigint) set search_path=pg_catalog,public,pg_temp;
alter function journal_entry_private.reverse_journal_entry(bigint) set search_path=pg_catalog,public,pg_temp;

-- Preserve internal asset posting without granting manual-journal rights to asset operators.
-- These module entry points still require their separate C-04 authorization review.
do $$declare f regprocedure;body text;modified text;
begin
 foreach f in array array['public.process_fixed_asset_proposals(jsonb)'::regprocedure,
   'public.run_fixed_asset_depreciation(date,jsonb)'::regprocedure] loop
  body:=pg_get_functiondef(f);
  modified:=regexp_replace(body,'\m(public[.])?create_journal_entry[[:space:]]*\(',
    'journal_entry_private.create_journal_entry(','g');
  if body=modified then raise exception 'Unexpected asset journal caller; review before migrating.';end if;
  execute modified;
 end loop;
end$$;

create function journal_entry_private.assert_access(p_action text)
returns bigint language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();
begin
 if auth.uid() is null or public.app_user_id() is null or public.app_active_role_id() is null or sid is null then
  raise exception using errcode='42501',message='Seleccione un usuario, rol y subsidiaria autorizados.';
 end if;
 perform public.security_assert_role_access('accounting:journals',p_action);
 return sid;
end$$;

create function journal_entry_private.validate_payload(payload jsonb,p_sid bigint)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare line jsonb;debit numeric;credit numeric;rate numeric;kind text;field text;reference_kind text;entity_kind text;
begin
 if payload is null or jsonb_typeof(payload)<>'object' or jsonb_typeof(payload->'lines') is distinct from 'array' then
  raise exception using errcode='22023',message='El asiento requiere un encabezado y líneas válidas.';
 end if;
 kind:=payload->>'journal_type';
 if not exists(select 1 from public.transaction_types t where t.name=kind and t.abbreviation in('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ')) then
  raise exception using errcode='22023',message='Seleccione un tipo de asiento manual configurado.';
 end if;
 if not exists(select 1 from public.fiscal_periods f where f.fiscal_period_id=(payload->>'fiscal_period_id')::bigint
   and f.subsidiary_id=p_sid and (payload->>'journal_date')::date between f.start_date and f.end_date
   and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)) then
  raise exception using errcode='55000',message='El período debe estar abierto y pertenecer a la subsidiaria y fecha del asiento.';
 end if;
 if not exists(select 1 from public.currencies c where c.currency_id=(payload->>'currency_id')::bigint and (
   exists(select 1 from public.subsidiaries s where s.subsidiary_id=p_sid and s.currency_id=c.currency_id)
   or exists(select 1 from public.subsidiary_currencies s where s.subsidiary_id=p_sid and s.currency_id=c.currency_id))) then
  raise exception using errcode='42501',message='La moneda no está habilitada para la subsidiaria.';
 end if;
 rate:=(payload->>'exchange_rate')::numeric;
 if rate is null or rate<=0 or rate::text in('NaN','Infinity','-Infinity') then
  raise exception using errcode='22023',message='El tipo de cambio debe ser positivo y finito.';
 end if;
 for line in select value from jsonb_array_elements(payload->'lines') loop
  debit:=coalesce((line->>'debit')::numeric,0);credit:=coalesce((line->>'credit')::numeric,0);
  if debit<0 or credit<0 or debit::text in('NaN','Infinity','-Infinity') or credit::text in('NaN','Infinity','-Infinity')
    or (debit>0)=(credit>0) then
   raise exception using errcode='22023',message='Cada línea requiere solo un débito o crédito positivo y finito.';
  end if;
  if not exists(select 1 from public.chart_accounts a join public.account_subsidiaries s using(account_id)
    where a.account_id=(line->>'account_id')::bigint and s.subsidiary_id=p_sid and s.is_active
      and not coalesce(a.is_inactive,false) and not coalesce(a.is_summary,false) and coalesce(a.accepts_entries,true)) then
   raise exception using errcode='42501',message='La cuenta no está habilitada para la subsidiaria activa.';
  end if;
  entity_kind:=nullif(line->>'entity_type','');
  if entity_kind is not null and entity_kind<>'Ninguna' then
   if entity_kind not in('Cliente','Proveedor','Empleado') or nullif(line->>'entity_id','') is null then
    raise exception using errcode='22023',message='Seleccione una entidad válida.';
   end if;
   perform public.journal_csv_lookup(entity_kind,'ID:'||(line->>'entity_id'));
  end if;
  for field,reference_kind in select * from (values('department_id','departamento'),('class_id','clase'),
    ('cost_center_id','centro_costos'),('financial_creditor_id','acreedor_financiero'),('related_company_id','compania_relacionada')) refs(field,kind) loop
   if nullif(line->>field,'') is not null then perform public.journal_csv_lookup(reference_kind,'ID:'||(line->>field));end if;
  end loop;
 end loop;
exception when raise_exception then
 raise exception using errcode='42501',message='Una entidad o dimensión no está disponible en la subsidiaria activa.';
end$$;

create function public.create_journal_entry(payload jsonb)
returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 sid:=journal_entry_private.assert_access('create');
 perform journal_entry_private.validate_payload(payload,sid);
 return journal_entry_private.create_journal_entry(payload);
end$$;

create function public.update_journal_entry(target_journal_id bigint,payload jsonb)
returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;r public.journal;
begin
 sid:=journal_entry_private.assert_access('edit');
 select * into r from public.journal where journal_id=target_journal_id and subsidiary_id=sid for update;
 if not found then raise exception using errcode='42501',message='El asiento no está disponible en la subsidiaria activa.';end if;
 if r.status is null or r.status not in('CONTABILIZADO','BORRADOR') or not exists(
   select 1 from public.transaction_types t where t.name=r.journal_type and t.abbreviation in('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ')) then
  raise exception using errcode='55000',message='Utilice el proceso de origen para modificar asientos automáticos, anulados o tipos históricos no identificados.';
 end if;
 if not exists(select 1 from public.fiscal_periods f where f.fiscal_period_id=r.fiscal_period_id and f.subsidiary_id=sid
   and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)) then
  raise exception using errcode='55000',message='El período original del asiento está cerrado o inactivo.';
 end if;
 perform journal_entry_private.validate_payload(payload,sid);
 return journal_entry_private.update_journal_entry(target_journal_id,payload);
end$$;

create function public.import_journal_csv(p_rows jsonb,p_preview boolean,p_subsidiary_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 sid:=journal_entry_private.assert_access(case when p_preview then 'view' else 'create' end);
 if sid is distinct from p_subsidiary_id then raise exception using errcode='42501',message='La importación debe usar la subsidiaria activa.';end if;
 return journal_entry_private.import_journal_csv(p_rows,p_preview,p_subsidiary_id);
end$$;

create function public.reverse_journal_entry(target_journal_id bigint)
returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;r public.journal;
begin
 sid:=journal_entry_private.assert_access('edit');
 if not exists(select 1 from public.user_roles ur join public.role_permissions rp using(role_id)
   join public.permissions p using(permission_id) where ur.user_id=public.app_user_id()
   and ur.role_id=public.app_active_role_id() and p.code='accounting:journal:reverse') then
  raise exception using errcode='42501',message='El rol activo no tiene permiso técnico para reversar asientos.';
 end if;
 select * into r from public.journal where journal_id=target_journal_id and subsidiary_id=sid for update;
 if not found then raise exception using errcode='42501',message='El asiento no está disponible en la subsidiaria activa.';end if;
 if r.status is distinct from 'CONTABILIZADO' or not exists(select 1 from public.transaction_types t
   where t.name=r.journal_type and t.abbreviation in('ASI_DIA','ASI_NOM','ASI_LIQ')) then
  raise exception using errcode='55000',message='Utilice el proceso de origen para reversar pendientes, asientos automáticos o tipos históricos no identificados.';
 end if;
 if not exists(select 1 from public.fiscal_periods f where f.fiscal_period_id=r.fiscal_period_id and f.subsidiary_id=sid
   and not coalesce(f.is_closed,false) and not coalesce(f.gl_closed,false) and not coalesce(f.is_inactive,false)) then
  raise exception using errcode='55000',message='El período original del asiento está cerrado o inactivo.';
 end if;
 return journal_entry_private.reverse_journal_entry(target_journal_id);
end$$;

-- Historic helpers are implementation details, not alternate public APIs.
do $$declare f regprocedure;
begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and (p.proname like 'create_journal_entry\_%' escape '\'
   or p.proname like 'update_journal_entry\_%' escape '\' or p.proname like 'import_journal_csv\_%' escape '\'
   or p.proname in('journal_csv_lookup','journal_csv_dimensions','next_manual_journal_number')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end$$;
revoke all on all functions in schema journal_entry_private from public,anon,authenticated,service_role;
revoke all on function public.create_journal_entry(jsonb),public.update_journal_entry(bigint,jsonb),
 public.import_journal_csv(jsonb,boolean,bigint),public.reverse_journal_entry(bigint) from public,anon,authenticated,service_role;
grant execute on function public.create_journal_entry(jsonb),public.update_journal_entry(bigint,jsonb),
 public.import_journal_csv(jsonb,boolean,bigint),public.reverse_journal_entry(bigint) to authenticated;

do $$declare t text;p record;
begin
 foreach t in array array['journal','journal_line','journal_csv_imports'] loop
  execute format('alter table public.%I enable row level security',t);
  for p in select policyname from pg_policies where schemaname='public' and tablename=t and cmd<>'SELECT' loop
   execute format('drop policy %I on public.%I',p.policyname,t);
  end loop;
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  if t<>'journal_csv_imports' then execute format('grant select on public.%I to authenticated',t);end if;
 end loop;
end$$;
notify pgrst,'reload schema';
