-- Consolida el contexto inicial autenticado en una sola transacción y evita
-- que el navegador realice múltiples consultas secuenciales a Supabase.

create or replace function public.auth_bootstrap_context(
  p_preferred_role_id bigint default null,
  p_preferred_subsidiary_id bigint default null
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  current_user_id bigint:=public.app_user_id();
  current_session_id text:=public.app_session_id();
  account public.users%rowtype;
  selected_role_id bigint;
  selected_subsidiary_id bigint;
  company_count integer:=0;
  language_data jsonb;
  roles_data jsonb:='[]'::jsonb;
  active_role_data jsonb;
  grants_data jsonb:='[]'::jsonb;
  companies_data jsonb:='[]'::jsonb;
  active_company_data jsonb;
  administrator_role boolean:=false;
  preferred_subsidiary_rejected boolean:=false;
begin
  if current_user_id is null or nullif(btrim(coalesce(current_session_id,'')),'') is null then
    raise exception using errcode='42501',message='No fue posible identificar la sesión autenticada.';
  end if;

  select * into account
  from public.users
  where user_id=current_user_id and is_active;
  if account.user_id is null then
    raise exception using errcode='42501',message='El usuario autenticado no está activo en el ERP.';
  end if;
  if exists(
    select 1 from public.user_role_sessions
    where session_id=current_session_id and user_id<>current_user_id
  ) or exists(
    select 1 from public.user_company_sessions
    where session_id=current_session_id and user_id<>current_user_id
  ) then
    raise exception using errcode='42501',message='La sesión activa no pertenece al usuario autenticado.';
  end if;

  -- Una preferencia nunca amplía privilegios: solo se acepta cuando existe la
  -- asignación. Si quedó obsoleta se usa la selección vigente o un rol seguro.
  if p_preferred_role_id is not null and exists(
    select 1 from public.user_roles
    where user_id=current_user_id and role_id=p_preferred_role_id
  ) then
    selected_role_id:=p_preferred_role_id;
  else
    select selected.role_id into selected_role_id
    from public.user_role_sessions selected
    join public.user_roles membership
      on membership.user_id=current_user_id and membership.role_id=selected.role_id
    where selected.session_id=current_session_id and selected.user_id=current_user_id
    limit 1;
  end if;

  if selected_role_id is null then
    select assigned.role_id into selected_role_id
    from public.user_roles assigned
    join public.roles role on role.role_id=assigned.role_id
    where assigned.user_id=current_user_id
    order by case when lower(btrim(role.role_name)) in('administrador','administrator','admin') then 0 else 1 end,
      role.role_name,role.role_id
    limit 1;
  end if;

  if selected_role_id is not null then
    insert into public.user_role_sessions(session_id,user_id,role_id,selected_at)
    values(current_session_id,current_user_id,selected_role_id,clock_timestamp())
    on conflict(session_id) do update
      set role_id=excluded.role_id,selected_at=excluded.selected_at
      where user_role_sessions.user_id=excluded.user_id;
    if not exists(
      select 1 from public.user_role_sessions
      where session_id=current_session_id and user_id=current_user_id and role_id=selected_role_id
    ) then
      raise exception using errcode='42501',message='No fue posible asociar el rol a la sesión autenticada.';
    end if;
  else
    delete from public.user_role_sessions
    where session_id=current_session_id and user_id=current_user_id;
  end if;
  selected_role_id:=public.app_active_role_id();

  select count(*)::integer into company_count
  from public.user_subsidiaries membership
  join public.subsidiaries subsidiary
    on subsidiary.subsidiary_id=membership.subsidiary_id and subsidiary.is_active
  where membership.user_id=current_user_id;

  if p_preferred_subsidiary_id is not null then
    if exists(
      select 1
      from public.user_subsidiaries membership
      join public.subsidiaries subsidiary
        on subsidiary.subsidiary_id=membership.subsidiary_id and subsidiary.is_active
      where membership.user_id=current_user_id
        and membership.subsidiary_id=p_preferred_subsidiary_id
    ) then
      selected_subsidiary_id:=p_preferred_subsidiary_id;
    else
      preferred_subsidiary_rejected:=true;
    end if;
  else
    select selected.subsidiary_id into selected_subsidiary_id
    from public.user_company_sessions selected
    join public.user_subsidiaries membership
      on membership.user_id=current_user_id and membership.subsidiary_id=selected.subsidiary_id
    join public.subsidiaries subsidiary
      on subsidiary.subsidiary_id=selected.subsidiary_id and subsidiary.is_active
    where selected.session_id=current_session_id and selected.user_id=current_user_id
    limit 1;
  end if;

  if selected_subsidiary_id is null and company_count=1 and not preferred_subsidiary_rejected then
    select membership.subsidiary_id into selected_subsidiary_id
    from public.user_subsidiaries membership
    join public.subsidiaries subsidiary
      on subsidiary.subsidiary_id=membership.subsidiary_id and subsidiary.is_active
    where membership.user_id=current_user_id
    limit 1;
  end if;

  if selected_subsidiary_id is not null then
    insert into public.user_company_sessions(session_id,user_id,subsidiary_id,selected_at)
    values(current_session_id,current_user_id,selected_subsidiary_id,clock_timestamp())
    on conflict(session_id) do update
      set subsidiary_id=excluded.subsidiary_id,selected_at=excluded.selected_at
      where user_company_sessions.user_id=excluded.user_id;
    if not exists(
      select 1 from public.user_company_sessions
      where session_id=current_session_id and user_id=current_user_id and subsidiary_id=selected_subsidiary_id
    ) then
      raise exception using errcode='42501',message='No fue posible asociar la empresa a la sesión autenticada.';
    end if;
  else
    delete from public.user_company_sessions
    where session_id=current_session_id and user_id=current_user_id;
  end if;
  selected_subsidiary_id:=public.active_subsidiary_id();

  language_data:=public.user_language_preference();

  select coalesce(jsonb_agg(jsonb_build_object(
    'roleId',role.role_id,
    'name',role.role_name,
    'description',coalesce(role.description,'')
  ) order by role.role_name,role.role_id),'[]'::jsonb)
  into roles_data
  from public.user_roles membership
  join public.roles role on role.role_id=membership.role_id
  where membership.user_id=current_user_id;

  if selected_role_id is not null then
    select jsonb_build_object(
      'roleId',role.role_id,
      'name',role.role_name,
      'description',coalesce(role.description,'')
    )
    into active_role_data
    from public.roles role
    where role.role_id=selected_role_id;

    administrator_role:=public.app_is_admin();

    select coalesce(jsonb_agg(jsonb_build_object(
      'resourceKey',access.resource_key,
      'canView',access.can_view,
      'canCreate',access.can_create,
      'canEdit',access.can_edit,
      'canDelete',access.can_delete
    ) order by access.resource_key),'[]'::jsonb)
    into grants_data
    from public.role_access_matrix access
    where access.role_id=selected_role_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'subsidiaryId',subsidiary.subsidiary_id,
    'name',subsidiary.name,
    'legalName',subsidiary.legal_name,
    'logoUrl',null,
    'currencyCode',currency.currency_code
  ) order by subsidiary.name,subsidiary.subsidiary_id),'[]'::jsonb)
  into companies_data
  from public.user_subsidiaries membership
  join public.subsidiaries subsidiary
    on subsidiary.subsidiary_id=membership.subsidiary_id and subsidiary.is_active
  join public.currencies currency on currency.currency_id=subsidiary.currency_id
  where membership.user_id=current_user_id;

  if selected_subsidiary_id is not null then
    select jsonb_build_object(
      'subsidiaryId',subsidiary.subsidiary_id,
      'name',subsidiary.name,
      'legalName',subsidiary.legal_name,
      'logoUrl',subsidiary.logo_url,
      'currencyCode',currency.currency_code,
      'allowedCurrencyIds',(
        select coalesce(jsonb_agg(allowed.currency_id order by allowed.priority,allowed.currency_id),'[]'::jsonb)
        from(
          select candidate.currency_id,min(candidate.priority) priority
          from(
            select subsidiary.currency_id,0 priority
            union all
            select link.currency_id,case when link.is_primary then 0 else 1 end
            from public.subsidiary_currencies link
            where link.subsidiary_id=subsidiary.subsidiary_id
          ) candidate
          group by candidate.currency_id
        ) allowed
      )
    ) into active_company_data
    from public.subsidiaries subsidiary
    join public.currencies currency on currency.currency_id=subsidiary.currency_id
    where subsidiary.subsidiary_id=selected_subsidiary_id and subsidiary.is_active;
  end if;

  return jsonb_build_object(
    'bootstrapVersion',1,
    'user',jsonb_build_object(
      'name',coalesce(nullif(btrim(concat_ws(' ',account.first_name,account.last_name)),''),split_part(account.email,'@',1)),
      'email',account.email
    ),
    'locale',coalesce(language_data->>'locale','es'),
    'languages',coalesce(language_data->'languages','[]'::jsonb),
    'roles',roles_data,
    'activeRole',active_role_data,
    'roleAccess',jsonb_build_object(
      'isAdmin',administrator_role,
      'grants',grants_data
    ),
    'companies',companies_data,
    'activeCompany',active_company_data,
    'requiresCompanySelection',(company_count>0 and active_company_data is null)
  );
end;
$$;

revoke all on function public.auth_bootstrap_context(bigint,bigint) from public,anon;
grant execute on function public.auth_bootstrap_context(bigint,bigint) to authenticated;

comment on function public.auth_bootstrap_context(bigint,bigint) is
  'Construye y selecciona atómicamente el contexto inicial del usuario desde su JWT, sin aceptar identidad ni sesión proporcionadas por el cliente.';

notify pgrst,'reload schema';
