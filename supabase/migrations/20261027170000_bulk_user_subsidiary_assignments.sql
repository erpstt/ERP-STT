-- Asignación masiva y atómica de subsidiarias por usuario.

create or replace function public.security_user_subsidiary_assignments()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  actor_id bigint:=public.app_user_id();
  result jsonb;
begin
  if actor_id is null then
    raise exception using errcode='42501',message='Debe iniciar sesión para administrar empresas por usuario.';
  end if;
  perform public.security_assert_role_access('security:user-subsidiaries','view');

  select coalesce(jsonb_agg(item.payload order by item.sort_active,item.sort_name,item.sort_id),'[]'::jsonb)
    into result
  from(
    select
      case when account.is_active then 0 else 1 end sort_active,
      lower(concat_ws(' ',account.first_name,account.last_name,account.email)) sort_name,
      account.user_id sort_id,
      jsonb_build_object(
        'id',account.user_id,
        'user_id',account.user_id,
        'email',account.email,
        'first_name',account.first_name,
        'last_name',account.last_name,
        'display_name',concat_ws(' ',account.first_name,account.last_name),
        'is_active',account.is_active,
        'subsidiary_ids',coalesce((
          select jsonb_agg(link.subsidiary_id order by company.name,link.subsidiary_id)
          from public.user_subsidiaries link
          join public.subsidiaries company using(subsidiary_id)
          where link.user_id=account.user_id
        ),'[]'::jsonb),
        'subsidiary_count',(select count(*) from public.user_subsidiaries link where link.user_id=account.user_id),
        'subsidiary_names',coalesce((
          select string_agg(company.name,', ' order by company.name,company.subsidiary_id)
          from public.user_subsidiaries link
          join public.subsidiaries company using(subsidiary_id)
          where link.user_id=account.user_id
        ),'Sin empresas asignadas')
      ) payload
    from public.users account
  )item;
  return result;
end;
$$;

drop function if exists public.security_sync_user_subsidiaries(bigint,bigint[]);

create function public.security_sync_user_subsidiaries(
  p_user_id bigint,
  p_subsidiary_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  actor_id bigint:=public.app_user_id();
  active_sid bigint:=public.active_subsidiary_id();
  requested_ids bigint[];
  invalid_id bigint;
  target public.users%rowtype;
begin
  if actor_id is null then
    raise exception using errcode='42501',message='Debe iniciar sesión para administrar empresas por usuario.';
  end if;
  perform public.security_assert_role_access('security:user-subsidiaries','edit');
  if p_user_id is null or p_user_id<=0 then
    raise exception using errcode='22023',message='Seleccione un usuario válido.';
  end if;
  if p_subsidiary_ids is null then
    raise exception using errcode='22023',message='Seleccione al menos una subsidiaria para el usuario.';
  end if;

  select array_agg(selected.id order by selected.id)
    into requested_ids
  from(
    select distinct chosen.id
    from unnest(coalesce(p_subsidiary_ids,'{}'::bigint[]))chosen(id)
  )selected;
  requested_ids:=coalesce(requested_ids,'{}'::bigint[]);
  if cardinality(requested_ids)=0 then
    raise exception using errcode='22023',message='Seleccione al menos una subsidiaria para el usuario.';
  end if;
  if exists(select 1 from unnest(requested_ids)item(id) where item.id is null or item.id<=0)then
    raise exception using errcode='22023',message='La selección contiene una subsidiaria inválida.';
  end if;

  select * into target
  from public.users
  where user_id=p_user_id
  for update;
  if not found then
    raise exception using errcode='22023',message='El usuario seleccionado no existe.';
  end if;

  if not public.app_is_admin()and exists(
    select 1
    from public.user_roles membership
    join public.roles role_record using(role_id)
    where membership.user_id=p_user_id
      and lower(btrim(role_record.role_name))in('administrador','administrator','admin')
  )then
    raise exception using errcode='42501',message='Solo un administrador puede modificar las empresas de otro administrador.';
  end if;

  select item.id into invalid_id
  from unnest(requested_ids)item(id)
  left join public.subsidiaries company on company.subsidiary_id=item.id
  where company.subsidiary_id is null
  limit 1;
  if invalid_id is not null then
    raise exception using errcode='22023',message=format('La subsidiaria %s no existe.',invalid_id);
  end if;

  if p_user_id=actor_id and not public.app_is_admin()then
    raise exception using errcode='42501',message='No puede modificar sus propias empresas autorizadas.';
  end if;
  if p_user_id=actor_id and active_sid is not null and not(active_sid=any(requested_ids))then
    raise exception using errcode='22023',message='No puede retirar la subsidiaria que está utilizando actualmente. Cambie de empresa e intente nuevamente.';
  end if;

  delete from public.user_subsidiaries existing
  where existing.user_id=p_user_id
    and not(existing.subsidiary_id=any(requested_ids));

  insert into public.user_subsidiaries(user_id,subsidiary_id)
  select p_user_id,item.id
  from unnest(requested_ids)item(id)
  on conflict(user_id,subsidiary_id)do nothing;

  delete from public.user_company_sessions selected
  where selected.user_id=p_user_id
    and not exists(
      select 1 from public.user_subsidiaries access
      where access.user_id=selected.user_id
        and access.subsidiary_id=selected.subsidiary_id
    );

  return jsonb_build_object(
    'id',target.user_id,
    'user_id',target.user_id,
    'email',target.email,
    'first_name',target.first_name,
    'last_name',target.last_name,
    'display_name',concat_ws(' ',target.first_name,target.last_name),
    'is_active',target.is_active,
    'subsidiary_ids',coalesce((
      select jsonb_agg(link.subsidiary_id order by company.name,link.subsidiary_id)
      from public.user_subsidiaries link
      join public.subsidiaries company using(subsidiary_id)
      where link.user_id=target.user_id
    ),'[]'::jsonb),
    'subsidiary_count',(select count(*) from public.user_subsidiaries link where link.user_id=target.user_id),
    'subsidiary_names',coalesce((
      select string_agg(company.name,', ' order by company.name,company.subsidiary_id)
      from public.user_subsidiaries link
      join public.subsidiaries company using(subsidiary_id)
      where link.user_id=target.user_id
    ),'Sin empresas asignadas')
  );
end;
$$;

create or replace function public.security_user_subsidiary_options()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  actor_id bigint:=public.app_user_id();
  result jsonb;
begin
  if actor_id is null then
    raise exception using errcode='42501',message='Debe iniciar sesión para consultar las subsidiarias.';
  end if;
  perform public.security_assert_role_access('security:user-subsidiaries','view');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',company.subsidiary_id,
    'subsidiary_id',company.subsidiary_id,
    'name',company.name,
    'legal_name',company.legal_name,
    'is_active',company.is_active
  )order by case when company.is_active then 0 else 1 end,lower(company.name),company.subsidiary_id),'[]'::jsonb)
    into result
  from public.subsidiaries company;

  return result;
end;
$$;

comment on function public.security_user_subsidiary_assignments() is
  'Lista una fila por usuario con todas sus subsidiarias para la matriz de selección masiva.';
comment on function public.security_sync_user_subsidiaries(bigint,bigint[]) is
  'Sincroniza atómicamente las subsidiarias seleccionadas y elimina contextos de empresa obsoletos.';
comment on function public.security_user_subsidiary_options() is
  'Lista todas las subsidiarias para la matriz de asignación, sin limitarla a las empresas actuales del actor.';

revoke all on function public.security_user_subsidiary_assignments() from public,anon;
revoke all on function public.security_sync_user_subsidiaries(bigint,bigint[]) from public,anon;
revoke all on function public.security_user_subsidiary_options() from public,anon;
grant execute on function public.security_user_subsidiary_assignments() to authenticated;
grant execute on function public.security_sync_user_subsidiaries(bigint,bigint[]) to authenticated;
grant execute on function public.security_user_subsidiary_options() to authenticated;

-- La matriz masiva es el único punto de escritura. Evita que un cliente
-- autenticado salte la sincronización atómica modificando vínculos sueltos por
-- PostgREST; la lectura directa se conserva para el selector de empresa.
drop policy if exists user_subsidiaries_access on public.user_subsidiaries;
drop policy if exists user_subsidiaries_insert_authorized on public.user_subsidiaries;
drop policy if exists user_subsidiaries_update_authorized on public.user_subsidiaries;
drop policy if exists user_subsidiaries_delete_authorized on public.user_subsidiaries;
revoke insert,update,delete,truncate,references,trigger on table public.user_subsidiaries from public,anon,authenticated;
revoke usage,select,update on sequence public.user_subsidiaries_id_seq from public,anon,authenticated;
grant select on table public.user_subsidiaries to authenticated;

-- El recurso ya no crea ni elimina filas individuales. Conserva el alcance de
-- edición ya otorgado sin convertir permisos históricos en privilegios nuevos.
update public.role_access_matrix
set can_create=false,
    can_delete=false
where resource_key='security:user-subsidiaries';

notify pgrst,'reload schema';
