CREATE OR REPLACE FUNCTION public.security_assert_role_access(p_resource_key text, p_action text DEFAULT 'view'::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare allowed boolean:=false;
begin
 if public.app_is_admin()then return;end if;
 if p_action not in('view','create','edit','delete')then raise exception'La acción solicitada no es válida.';end if;
 select exists(select 1 from public.role_access_matrix m where m.role_id=public.app_active_role_id()and(
   m.resource_key='legacy:all' or(m.resource_key=p_resource_key and case p_action when'view'then m.can_view when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end)
 ))into allowed;
 if not allowed then raise exception using errcode='42501',message='El rol activo no tiene permiso para realizar esta acción.';end if;
end$function$;
CREATE OR REPLACE FUNCTION public.security_audit_user_password_notification(p_actor_user_id bigint, p_target_user_id bigint, p_subsidiary_id bigint, p_result text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  normalized_result text:=upper(trim(coalesce(p_result,'')));
  subsidiary_path text:=format(
    'security/users/%s/password-recovery?subsidiary=%s&scope=subsidiary',
    p_target_user_id,
    p_subsidiary_id
  );
  global_path text:=format(
    'security/users/%s/password-recovery?subsidiary=%s&scope=global_admin',
    p_target_user_id,
    p_subsidiary_id
  );
  authorized_path text;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception using errcode='42501',message='Operacion reservada al servicio.';
  end if;
  if normalized_result not in('ENVIADO','ENVIADO_CON_ADVERTENCIA','ERROR') then
    raise exception using errcode='22023',message='El resultado de la notificacion no es valido.';
  end if;
  if not exists(select 1 from public.users where user_id=p_actor_user_id)
    or not exists(select 1 from public.users where user_id=p_target_user_id)
    or not exists(select 1 from public.subsidiaries where subsidiary_id=p_subsidiary_id) then
    raise exception using errcode='22023',message='No fue posible validar el contexto de la notificacion.';
  end if;

  -- La fila SOLICITUD_* solo puede ser creada por la RPC actor-scoped. De este
  -- modo el servicio no reconstruye permisos usando asignaciones mutables y la
  -- auditoria refleja el alcance que fue autorizado al iniciar el envio.
  select log.path_accessed
    into authorized_path
  from public.activity_log log
  where log.user_id=p_actor_user_id
    and log.activity_type='SOLICITUD_RECUPERACION_USUARIO'
    and log.path_accessed in(subsidiary_path,global_path)
    and log."timestamp">=clock_timestamp()-interval '1 hour'
  order by log."timestamp" desc
  limit 1;

  if authorized_path is null then
    raise exception using errcode='22023',message='No fue posible validar el contexto de la notificacion.';
  end if;

  insert into public.activity_log(user_id,activity_type,path_accessed)
  values(
    p_actor_user_id,
    'ENVIO_RECUPERACION_USUARIO_'||normalized_result,
    authorized_path
  );
  return true;
end;
$function$;
CREATE OR REPLACE FUNCTION public.security_create_user(p_email text, p_auth_user_id uuid, p_first_name text, p_last_name text, p_timezone_id bigint DEFAULT NULL::bigint, p_is_active boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  canonical_email text:=lower(btrim(coalesce(p_email,'')));
  identity_email text;
  created_user public.users%rowtype;
begin
  if public.app_user_id() is null then
    raise exception using errcode='42501',message='No fue posible identificar al usuario responsable.';
  end if;
  perform public.security_assert_role_access('security:users','create');
  if p_email is null or p_email<>canonical_email or length(canonical_email)>254 then
    raise exception using errcode='22023',message='El correo electrónico no es válido o no está normalizado.';
  end if;
  if nullif(btrim(p_first_name),'') is null or length(btrim(p_first_name))>120
    or nullif(btrim(p_last_name),'') is null or length(btrim(p_last_name))>120 then
    raise exception using errcode='22023',message='El nombre y los apellidos son obligatorios y no pueden exceder 120 caracteres.';
  end if;
  select lower(btrim(identity.email))
    into identity_email
  from auth.users identity
  where identity.id=p_auth_user_id;
  if identity_email is null or identity_email<>canonical_email then
    raise exception using errcode='22023',message='La identidad de acceso no corresponde al correo solicitado.';
  end if;
  insert into public.users(
    email,password_hash,auth_user_id,first_name,last_name,timezone_id,is_active,invitation_sent_at
  ) values(
    canonical_email,'auth:'||p_auth_user_id::text,p_auth_user_id,
    btrim(p_first_name),btrim(p_last_name),p_timezone_id,coalesce(p_is_active,true),null
  )
  returning * into created_user;
  return jsonb_build_object(
    'user_id',created_user.user_id,
    'email',created_user.email,
    'first_name',created_user.first_name,
    'last_name',created_user.last_name,
    'timezone_id',created_user.timezone_id,
    'is_active',created_user.is_active,
    'invitation_sent_at',created_user.invitation_sent_at,
    'invitation_accepted_at',created_user.invitation_accepted_at
  );
exception
  when unique_violation then
    raise exception using errcode='23505',message='Ya existe un usuario con ese correo electrónico o identidad de acceso.';
end;
$function$;
CREATE OR REPLACE FUNCTION public.security_mark_user_invitation_sent(p_user_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if public.app_user_id() is null then
    raise exception using errcode='42501',message='No fue posible identificar al usuario responsable.';
  end if;
  perform public.security_assert_role_access('security:users','create');
  update public.users
  set invitation_sent_at=now()
  where user_id=p_user_id
    and auth_user_id is not null;
  if not found then
    raise exception using errcode='22023',message='El usuario indicado no existe o no tiene identidad de acceso.';
  end if;
  return true;
end;
$function$;
CREATE OR REPLACE FUNCTION public.security_my_role_access()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select jsonb_build_object(
  'isAdmin',public.app_is_admin(),
  'grants',coalesce((select jsonb_agg(jsonb_build_object('resourceKey',m.resource_key,'canView',m.can_view,'canCreate',m.can_create,'canEdit',m.can_edit,'canDelete',m.can_delete))from public.role_access_matrix m where m.role_id=public.app_active_role_id()),'[]'::jsonb)
 )
$function$;
CREATE OR REPLACE FUNCTION public.security_prepare_user_password_recovery(p_user_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  actor_id bigint:=public.app_user_id();
  sid bigint:=public.active_subsidiary_id();
  target public.users%rowtype;
  target_in_active_subsidiary boolean:=false;
  global_administrator boolean:=false;
  authorization_scope text;
  recovery_path text;
begin
  if actor_id is null or sid is null then
    raise exception using errcode='42501',message='Debe iniciar sesion y seleccionar una subsidiaria autorizada.';
  end if;

  -- Se conserva la autorizacion de edicion existente. app_is_admin() solo es
  -- verdadero cuando el rol Administrador es el rol activo de la sesion.
  perform public.security_assert_role_access('security:users','edit');
  global_administrator:=coalesce(public.app_is_admin(),false);

  select account.*
    into target
  from public.users account
  where account.user_id=p_user_id
    and account.is_active;

  if not found then
    raise exception using errcode='22023',message='El usuario no esta disponible para recuperar su acceso.';
  end if;

  select exists(
    select 1
    from public.user_subsidiaries access
    where access.user_id=target.user_id
      and access.subsidiary_id=sid
  ) into target_in_active_subsidiary;

  if not global_administrator and not target_in_active_subsidiary then
    -- El mismo mensaje se utiliza para inexistentes, inactivos y fuera de
    -- alcance, evitando que un gestor delegado enumere usuarios por la RPC.
    raise exception using errcode='22023',message='El usuario no esta disponible para recuperar su acceso.';
  end if;

  authorization_scope:=case
    when target_in_active_subsidiary then 'SUBSIDIARY'
    else 'GLOBAL_ADMIN'
  end;
  recovery_path:=format(
    'security/users/%s/password-recovery?subsidiary=%s&scope=%s',
    target.user_id,
    sid,
    lower(authorization_scope)
  );

  if(
    select count(*)
    from public.activity_log
    where user_id=actor_id
      and activity_type='SOLICITUD_RECUPERACION_USUARIO'
      and "timestamp">=clock_timestamp()-interval '15 minutes'
  )>=10 then
    raise exception using errcode='22023',message='Se alcanzo el limite temporal de correos de recuperacion. Intente nuevamente mas tarde.';
  end if;
  if(
    select count(*)
    from public.activity_log
    where user_id=actor_id
      and activity_type='SOLICITUD_RECUPERACION_USUARIO'
      and path_accessed=recovery_path
      and "timestamp">=clock_timestamp()-interval '15 minutes'
  )>=3 then
    raise exception using errcode='22023',message='Ya se enviaron varias solicitudes para este usuario. Intente nuevamente mas tarde.';
  end if;

  insert into public.activity_log(user_id,activity_type,path_accessed)
  values(actor_id,'SOLICITUD_RECUPERACION_USUARIO',recovery_path);

  return jsonb_build_object(
    'actor_user_id',actor_id,
    -- La plantilla de correo sigue perteneciendo a la subsidiaria activa del
    -- administrador. No se concede acceso empresarial al destinatario.
    'subsidiary_id',sid,
    'authorization_scope',authorization_scope,
    'user_id',target.user_id,
    'email',target.email,
    'first_name',target.first_name,
    'last_name',target.last_name
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.security_resource_allowed(p_resource_key text, p_action text DEFAULT 'view'::text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select public.app_user_id() is not null
    and p_action in('view','create','edit','delete')
    and(
      public.app_is_admin()
      or exists(
        select 1
        from public.role_access_matrix access
        where access.role_id=public.app_active_role_id()
          and(
            access.resource_key='legacy:all'
            or(
              access.resource_key=p_resource_key
              and case p_action
                when 'view' then access.can_view
                when 'create' then access.can_create
                when 'edit' then access.can_edit
                when 'delete' then access.can_delete
                else false
              end
            )
          )
      )
    )
$function$;
CREATE OR REPLACE FUNCTION public.security_role_access_matrix_data(p_role_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare selected_role bigint:=p_role_id;result jsonb;
begin
 if not public.app_is_admin() then raise exception using errcode='42501',message='Solo un administrador puede configurar permisos por rol.';end if;
 if selected_role is null then select role_id into selected_role from public.roles order by case when lower(role_name)='contabilidad' then 0 else 1 end,role_name limit 1;end if;
 if not exists(select 1 from public.roles where role_id=selected_role)then raise exception'El rol seleccionado no existe.';end if;
 select jsonb_build_object(
  'roles',coalesce((select jsonb_agg(jsonb_build_object('roleId',r.role_id,'name',r.role_name,'description',r.description,'isSystemRole',r.is_system_role)order by r.role_name)from public.roles r),'[]'::jsonb),
  'selectedRoleId',selected_role,
  'grants',coalesce((select jsonb_agg(jsonb_build_object('resourceKey',m.resource_key,'canView',m.can_view,'canCreate',m.can_create,'canEdit',m.can_edit,'canDelete',m.can_delete)order by m.resource_key)from public.role_access_matrix m where m.role_id=selected_role),'[]'::jsonb),
  'specialPermissions',coalesce((select jsonb_agg(jsonb_build_object('permissionId',p.permission_id,'code',p.code,'module',p.module,'description',p.description,'enabled',rp.id is not null)order by p.module,p.code)from public.permissions p left join public.role_permissions rp on rp.permission_id=p.permission_id and rp.role_id=selected_role where p.is_operational),'[]'::jsonb),
  'isAdministratorRole',coalesce((select lower(trim(role_name)) in('administrador','administrator','admin')from public.roles where role_id=selected_role),false)
 )into result;
 return result;
end$function$;
CREATE OR REPLACE FUNCTION public.security_role_is_assignable(p_role_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists(
    select 1
    from public.roles role_record
    where role_record.role_id=p_role_id
      and not role_record.is_system_role
      and lower(btrim(role_record.role_name)) not in('administrador','administrator','admin')
  )
$function$;
CREATE OR REPLACE FUNCTION public.security_save_role_access_matrix(p_role_id bigint, p_entries jsonb, p_permission_ids bigint[] DEFAULT NULL::bigint[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare item jsonb;count_saved integer:=0;
begin
 if not public.app_is_admin()then raise exception using errcode='42501',message='Solo un administrador puede configurar permisos por rol.';end if;
 if not exists(select 1 from public.roles where role_id=p_role_id)then raise exception'El rol seleccionado no existe.';end if;
 if jsonb_typeof(coalesce(p_entries,'[]'::jsonb))<>'array'then raise exception'La matriz de permisos no es válida.';end if;
 delete from public.role_access_matrix where role_id=p_role_id and resource_key<>'legacy:all';
 for item in select value from jsonb_array_elements(coalesce(p_entries,'[]'::jsonb))loop
  if coalesce(item->>'resourceKey','')!~'^[a-z0-9-]+:[a-z0-9-]+$'then raise exception'La opción de permiso no es válida.';end if;
  insert into public.role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete,updated_by,updated_at)
  values(p_role_id,item->>'resourceKey',coalesce((item->>'canView')::boolean,false),coalesce((item->>'canCreate')::boolean,false),coalesce((item->>'canEdit')::boolean,false),coalesce((item->>'canDelete')::boolean,false),public.app_user_id(),now());
  count_saved:=count_saved+1;
 end loop;
 delete from public.role_access_matrix where role_id=p_role_id and resource_key='legacy:all';
 if p_permission_ids is not null then
  if exists(select 1 from unnest(p_permission_ids)requested where not exists(select 1 from public.permissions p where p.permission_id=requested and p.is_operational))then raise exception'La selección contiene un permiso técnico no válido.';end if;
  delete from public.role_permissions target using public.permissions permission where target.role_id=p_role_id and permission.permission_id=target.permission_id and permission.is_operational;
  insert into public.role_permissions(role_id,permission_id)select p_role_id,requested from unnest(p_permission_ids)requested on conflict do nothing;
 end if;
 return jsonb_build_object('success',true,'saved',count_saved,'specialSaved',coalesce(array_length(p_permission_ids,1),0));
end$function$;
CREATE OR REPLACE FUNCTION public.security_sync_user_subsidiaries(p_user_id bigint, p_subsidiary_ids bigint[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.security_user_subsidiary_assignments()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.security_user_subsidiary_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
